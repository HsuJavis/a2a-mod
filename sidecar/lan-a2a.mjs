#!/usr/bin/env node
// a2a-mod LAN mode sidecar: a stdio MCP server (newline-delimited JSON-RPC 2.0) that the mod
// drives, plus an A2A JSON-RPC endpoint over HTTP and discovery on the LAN: UDP multicast and subnet
// broadcast out of every IPv4 interface, and a TCP hello (POST /lan/hello) to static peers, which works
// wherever plain TCP does (a firewall dropping UDP, a VPN taking the multicast route, a router that
// does not forward multicast between wired and Wi-Fi).
// A mod cannot listen on a socket, so this process does. The engine starts one per session from
// plugin.json's mcpServers; the switch, secret and name come in its env from the lan, lanSecret and
// lanName options (LAN_A2A_SECRET / LAN_A2A_NAME in the shell when those are empty).
// Modes: off (lan false, or a secret under 8 characters: no socket), open (no secret: a public group,
// no bearer anywhere) and secret (the bearer is the shared secret, the group a hash of it).
// Zero dependencies, Node >= 22. stdout carries JSON-RPC only; logs go to stderr.
import crypto from 'node:crypto'
import dgram from 'node:dgram'
import dns from 'node:dns'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { pipeline } from 'node:stream/promises'

const VERSION = '0.6.0'
const APP = 'a2a-mod-lan'
const MCAST_ADDR = '239.255.41.99'
const MCAST_PORT = 41399
const ANNOUNCE_MS = 4000
const EXPIRE_MS = 15000
const FILE_TTL_MS = 60 * 60 * 1000
const MAX_FILE = 512 * 1024 * 1024
const MAX_BODY = 1024 * 1024
const SEND_TIMEOUT_MS = 10000
const DEFAULT_PORTS = '41400-41499'
const OPEN_GROUP = 'open' // not 16 hex digits, so never a secret's group
const HELLO_TIMEOUT_MS = 1500
const SCAN_PORTS = [41400, 41401, 41402, 41403, 41404, 41405, 41406, 41407, 41408, 41409] // a static host with no port
const RESCAN_TICKS = 8 // a portless static host's full range is tried again every 8 periods
const VIAS = ['multicast', 'broadcast', 'hello', 'static']

const log = (...a) => process.stderr.write(`[lan-a2a] ${a.join(' ')}\n`)

const self = { id: crypto.randomUUID(), mode: 'off', name: '', secret: '', group: '', port: 0, problem: '' }
const peers = new Map() // id -> { id, name, host, hosts, port, lastSeen, via }: host the latest source, hosts all of them, via how it was found
const inbox = []
const served = new Map() // file id -> { path, size, expires }
let server
let disco
const senders = new Map() // interface address -> send socket
// Static peers: host[:port] from A2A_MOD_LAN_PEERS (the lanPeers option) and from the static tool (/a2a lan add).
let envStatics = []
let toolStatics = []
const staticState = new Map() // spec -> { ports: Set of ports that answered, legacy: Set of ports with no /lan/hello }
let tick = 0

// ---------- helpers ----------

const groupOf = secret => crypto.createHash('sha256').update(`${APP}:${secret}`).digest('hex').slice(0, 16)
// Letters, digits and . _ / - only: a name is shown to Claude, so it must not carry markup or a line.
const cleanName = s => String(s ?? '').replace(/[^\p{L}\p{N}._/-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 64)
const safeFile = s => (path.basename(String(s ?? '')).replace(/[^\w.\-]+/g, '_').replace(/^\.+/, '').slice(0, 100) || 'file')
const bareIp = a => String(a ?? '').replace(/^::ffff:/, '')
const digest = s => crypto.createHash('sha256').update(String(s)).digest()

const isOn = () => self.mode !== 'off'
// The Authorization header a request to a peer carries: none in open mode.
const authHeader = () => (self.mode === 'secret' ? { authorization: `Bearer ${self.secret}` } : {})

function isAuthorized(req) {
  if (self.mode === 'open') return true
  const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')
  // Hash both sides so timingSafeEqual sees equal lengths whatever was sent.
  return !!self.secret && !!m && crypto.timingSafeEqual(digest(m[1]), digest(self.secret))
}

function peerList() {
  const counts = new Map()
  for (const p of peers.values()) counts.set(p.name, (counts.get(p.name) ?? 0) + 1)
  return [...peers.values()].map(p => ({
    address: `lan:${p.name}${counts.get(p.name) > 1 || p.name === self.name ? `#${p.id.slice(0, 4)}` : ''}`,
    name: p.name, id: p.id, host: p.host, port: p.port, lastSeen: p.lastSeen, via: VIAS.filter(v => p.via.has(v)),
  }))
}

function findPeer(to) {
  const want = String(to ?? '').replace(/^lan:/, '')
  const list = peerList()
  const exact = list.find(p => p.address === `lan:${want}`)
  if (exact) return exact
  const [name, id4] = want.split('#')
  const hits = list.filter(p => p.name === name && (!id4 || p.id.startsWith(id4)))
  return hits.length === 1 ? hits[0] : undefined
}

// The address of this host as seen from `host`: the source address the kernel would pick.
function localAddressFor(host) {
  return new Promise(resolve => {
    const s = dgram.createSocket('udp4')
    s.on('error', () => { s.close(); resolve('127.0.0.1') })
    s.connect(9, host, () => { const a = s.address().address; s.close(); resolve(a) })
  })
}

async function sha256File(file) {
  const h = crypto.createHash('sha256')
  await pipeline(fs.createReadStream(file), h)
  return h.digest('hex')
}

const MIME = { '.txt': 'text/plain', '.md': 'text/markdown', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.pdf': 'application/pdf', '.zip': 'application/zip', '.html': 'text/html', '.csv': 'text/csv' }
const mimeOf = f => MIME[path.extname(f).toLowerCase()] ?? 'application/octet-stream'

// ---------- discovery ----------

const announceOf = (kind, via) => ({ app: APP, v: 1, kind, id: self.id, name: self.name, port: self.port, group: self.group, ...(via ? { via } : {}) })

// The subnet-directed broadcast address of a non-loopback IPv4 interface, or undefined (a /32, a /31).
function broadcastOf(address, netmask) {
  const n = s => s.split('.').reduce((a, b) => (a << 8) | Number(b), 0) >>> 0
  const mask = n(netmask)
  if (mask >>> 0 >= 0xfffffffe) return undefined
  const b = (n(address) | ~mask) >>> 0
  return [b >>> 24, (b >>> 16) & 255, (b >>> 8) & 255, b & 255].join('.')
}

function interfaces() {
  const out = new Map([['127.0.0.1', undefined]])
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4') out.set(a.address, a.internal ? undefined : broadcastOf(a.address, a.netmask))
  }
  return out // address -> broadcast address (none for loopback)
}

// Multicast out of every IPv4 interface, and to every LAN interface's subnet broadcast address.
function announce(kind) {
  if (!disco || !self.group) return Promise.resolve()
  const mcast = Buffer.from(JSON.stringify(announceOf(kind, 'multicast')))
  const bcast = Buffer.from(JSON.stringify(announceOf(kind, 'broadcast')))
  const ifs = refreshInterfaces()
  const sendOne = (s, msg, to) => new Promise(r => { try { s.send(msg, MCAST_PORT, to, () => r()) } catch { r() } })
  return Promise.all([...senders].flatMap(([addr, s]) => [
    sendOne(s, mcast, MCAST_ADDR),
    ...(ifs.get(addr) ? [sendOne(s, bcast, ifs.get(addr))] : []),
  ]))
}

// One send socket per IPv4 interface (loopback included), so an announce reaches the LAN and
// also the other sessions on this host even where a firewall drops multicast on the LAN NIC.
function refreshInterfaces() {
  const now = interfaces()
  for (const addr of now.keys()) {
    if (senders.has(addr)) continue
    try { disco.addMembership(MCAST_ADDR, addr) } catch {}
    const s = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    s.on('error', e => { log('send socket', addr, e.message); s.close(); senders.delete(addr) })
    senders.set(addr, s)
    s.bind({ port: 0, address: addr }, () => {
      try { s.setMulticastInterface(addr); s.setMulticastTTL(1); s.setMulticastLoopback(true); s.setBroadcast(true) } catch (e) { log('mcast opts', addr, e.message) }
    })
  }
  for (const [addr, s] of senders) if (!now.has(addr)) { try { s.close() } catch {} senders.delete(addr) }
  return now
}

// The one check every way in shares (multicast, broadcast, a hello either way): the right app and group,
// another session's id, a port. Returns why not, or registers the peer and returns the record.
function admit(m, host, via) {
  if (m?.app !== APP || m.v !== 1) return { status: 400, why: 'not an a2a-mod-lan announce' }
  if (m.group !== self.group) return { status: 403, why: 'another group' }
  if (typeof m.id !== 'string' || m.id === self.id || !/^[\w-]{1,64}$/.test(m.id)) return { status: 400, why: 'bad id' }
  if (m.kind === 'bye') { peers.delete(m.id); return { bye: true } }
  if (m.kind !== 'hello' || !Number.isInteger(m.port) || m.port <= 0 || m.port > 65535) return { status: 400, why: 'bad kind or port' }
  return { peer: remember({ id: m.id, name: m.name, host, port: m.port }, via) }
}

function remember({ id, name, host, port }, via) {
  const was = peers.get(id)
  // A session announces from each interface, so one peer is heard from several addresses.
  const hosts = new Set([...(was?.hosts ?? []), host].slice(-8))
  const p = { id, name: cleanName(name) || 'unnamed', host, hosts, port, lastSeen: Date.now(), via: new Set([...(was?.via ?? []), via]) }
  peers.set(id, p)
  // A 0.5.1 peer first known from its card is the same session once it announces for real.
  if (!id.startsWith('card-')) peers.delete(cardId(host, port))
  return { p, isNew: !was }
}

let lastReply = 0
function onAnnounce(buf, rinfo) {
  let m
  try { m = JSON.parse(String(buf)) } catch { return }
  const via = m?.via === 'broadcast' ? 'broadcast' : 'multicast'
  const r = admit(m, bareIp(rinfo.address), via)
  // Answer a newcomer at once so it need not wait a full period; rate-limited against storms.
  if (r.peer?.isNew && Date.now() - lastReply > 300) { lastReply = Date.now(); void announce('hello') }
}

function startDiscovery() {
  return new Promise((resolve, reject) => {
    disco = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    disco.on('message', onAnnounce)
    disco.once('error', reject)
    disco.bind(MCAST_PORT, () => {
      disco.off('error', reject)
      disco.on('error', e => log('discovery', e.message))
      disco.setMulticastLoopback(true)
      refreshInterfaces()
      resolve()
    })
  })
}

// ---------- static peers: a TCP hello, or a 0.5.1 peer's agent card ----------

// host or host:port: a hostname or IPv4 address, letters, digits, dots and dashes.
function parseStatic(spec) {
  const m = /^([A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?)(?::(\d{1,5}))?$/.exec(String(spec ?? '').trim())
  if (!m) return undefined
  const port = m[2] ? Number(m[2]) : undefined
  if (port !== undefined && (port < 1 || port > 65535)) return undefined
  return { host: m[1], port, spec: port ? `${m[1]}:${port}` : m[1] }
}

function setStatics(list) {
  const ok = [], refused = []
  for (const x of Array.isArray(list) ? list : []) {
    const p = parseStatic(x)
    if (p && !ok.includes(p.spec)) ok.push(p.spec)
    else if (!p) refused.push(String(x).slice(0, 100))
  }
  return { ok, refused }
}

const statics = () => [...new Set([...envStatics, ...toolStatics])]
const cardId = (host, port) => `card-${host.replace(/[^\w]/g, '-')}-${port}`.slice(0, 64)

async function postJson(url, body) {
  const r = await fetch(url, {
    method: 'POST', body: JSON.stringify(body), signal: AbortSignal.timeout(HELLO_TIMEOUT_MS),
    headers: { 'content-type': 'application/json', ...authHeader() },
  })
  return { status: r.status, json: r.status === 200 ? await r.json() : undefined }
}

// A 0.5.1 sidecar has no /lan/hello: its card, if it is an open one, is enough to message it.
// The card is the only thing fetched; nothing is sent to the session.
async function fromCard(ip, port) {
  const r = await fetch(`http://${ip}:${port}/.well-known/agent-card.json`, { signal: AbortSignal.timeout(HELLO_TIMEOUT_MS) })
  if (r.status !== 200) return false
  const c = await r.json()
  const wantsAuth = Array.isArray(c?.security) && c.security.length > 0 || !!c?.securitySchemes
  // A card with no auth is an open-mode peer, so only an open-mode session takes it; secret mode needs a hello.
  if (self.mode !== 'open' || wantsAuth || (c?.lanA2a && c.lanA2a.mode !== 'open')) return false
  const id = typeof c?.lanA2a?.id === 'string' && /^[\w-]{1,64}$/.test(c.lanA2a.id) ? c.lanA2a.id : cardId(ip, port)
  if (id === self.id) return false
  remember({ id, name: c?.lanA2a?.name ?? c?.name, host: ip, port }, 'static')
  return true
}

// One host:port: the hello, which both sides learn from; a 404 (0.5.1) falls back to the card.
async function helloOne(ip, port, st) {
  try {
    if (!st.legacy.has(port)) {
      const r = await postJson(`http://${ip}:${port}/lan/hello`, announceOf('hello', 'hello'))
      if (r.status === 200) { if (admit(r.json, ip, 'static').peer) { st.ports.add(port); return true } return false }
      if (r.status !== 404) return false
      st.legacy.add(port)
    }
    if (await fromCard(ip, port)) { st.ports.add(port); return true }
    return false
  } catch {
    return false
  }
}

async function helloStatics() {
  if (!isOn()) return
  const live = statics()
  for (const k of staticState.keys()) if (!live.includes(k)) staticState.delete(k)
  await Promise.all(live.map(async spec => {
    const { host, port } = parseStatic(spec)
    let st = staticState.get(spec)
    if (!st) staticState.set(spec, st = { ports: new Set(), legacy: new Set() })
    let ip = host
    try { ip = (await dns.promises.lookup(host, { family: 4 })).address } catch { return }
    // A portless host: the ports that answered, and the whole range now and then (and until one does).
    const ports = port ? [port] : (st.ports.size && tick % RESCAN_TICKS ? [...st.ports] : SCAN_PORTS)
    await Promise.all(ports.map(async p => { if (!(await helloOne(ip, p, st))) st.ports.delete(p) }))
  }))
}

function everyPeriod() {
  tick++
  const cut = Date.now() - EXPIRE_MS
  for (const [id, p] of peers) if (p.lastSeen < cut) peers.delete(id)
  for (const [id, f] of served) if (f.expires < Date.now()) served.delete(id)
  void announce('hello')
  void helloStatics()
}

// ---------- HTTP / A2A ----------

function card(req) {
  const base = `http://${req.headers.host ?? `127.0.0.1:${self.port}`}`
  const url = `${base}/a2a`
  return {
    name: self.name,
    description: `Claude Code session ${self.name} on the LAN (a2a-mod LAN mode, ${self.mode}${self.mode === 'open' ? ': no authentication' : ''}). Messages reach the session as untrusted text.`,
    version: VERSION,
    supportedInterfaces: [
      { url, protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
      { url, protocolBinding: 'JSONRPC', protocolVersion: '0.3' },
    ],
    url,
    preferredTransport: 'JSONRPC',
    protocolVersion: '0.3.0',
    capabilities: { streaming: false, pushNotifications: false },
    defaultInputModes: ['text/plain', 'application/octet-stream'],
    defaultOutputModes: ['text/plain'],
    skills: [{ id: 'message', name: 'Message', description: 'Deliver a message (and files) to this Claude Code session.', tags: ['chat', 'files'] }],
    // For a static peer's fallback. Never a secret-mode group: it is a hash of the secret, and the card is public.
    lanA2a: { app: APP, v: 1, id: self.id, name: self.name, mode: self.mode, ...(self.mode === 'open' ? { group: OPEN_GROUP } : {}) },
    ...(self.mode === 'secret' ? {
      securitySchemes: { bearer: { type: 'http', scheme: 'bearer', httpAuthSecurityScheme: { scheme: 'Bearer' } } },
      security: [{ bearer: [] }],
      securityRequirements: [{ schemes: { bearer: { list: [] } } }],
    } : {}),
  }
}

const send = (res, status, body, type = 'application/json') => {
  res.writeHead(status, { 'content-type': type })
  res.end(typeof body === 'string' ? body : JSON.stringify(body))
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let n = 0
    req.on('data', c => { n += c.length; if (n > MAX_BODY) { reject(new Error('too large')); req.destroy() } else chunks.push(c) })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

// Text and file parts of a 1.0 or 0.3 message.
function partsOf(message) {
  const texts = []
  const files = []
  for (const p of Array.isArray(message?.parts) ? message.parts : []) {
    if (typeof p?.text === 'string') texts.push(p.text)
    else if (typeof p?.url === 'string') files.push({ url: p.url, name: p.filename, mediaType: p.mediaType })
    else if (p?.kind === 'file' && typeof p.file?.uri === 'string') files.push({ url: p.file.uri, name: p.file.name, mediaType: p.file.mimeType })
    else if (p?.data !== undefined) texts.push(JSON.stringify(p.data))
  }
  return { text: texts.join('\n'), files }
}

const inboxDir = () => process.env.LAN_A2A_INBOX || path.join(os.homedir(), '.claude', 'lan-a2a', 'inbox')

function download(file, senderIp) {
  return new Promise(resolve => {
    let u
    try { u = new URL(file.url) } catch { return resolve({ name: safeFile(file.name), error: 'bad file URL' }) }
    const name = safeFile(file.name || path.basename(u.pathname))
    // The file is fetched only from the host the message came from (and the bearer, if any, goes only there).
    if (u.protocol !== 'http:' || bareIp(u.hostname.replace(/^\[|\]$/g, '')) !== senderIp) {
      return resolve({ name, error: `refused: file URL host ${u.hostname} is not the sender ${senderIp}` })
    }
    fs.mkdirSync(inboxDir(), { recursive: true, mode: 0o700 })
    const dest = path.join(inboxDir(), `${new Date().toISOString().replace(/[:.]/g, '-')}_${crypto.randomBytes(2).toString('hex')}_${name}`)
    const fail = error => { fs.rm(dest, { force: true }, () => resolve({ name, error })) }
    const req = http.get(u, { headers: authHeader(), timeout: 30000 }, res => {
      if (res.statusCode !== 200) { res.resume(); return fail(`download failed: HTTP ${res.statusCode}`) }
      if (Number(res.headers['content-length'] ?? 0) > MAX_FILE) { res.destroy(); return fail('refused: larger than 512 MB') }
      const h = crypto.createHash('sha256')
      const out = fs.createWriteStream(dest, { mode: 0o600 })
      let size = 0
      res.on('data', c => {
        size += c.length
        if (size > MAX_FILE) { res.destroy(new Error('refused: larger than 512 MB')); return }
        h.update(c)
      })
      pipeline(res, out).then(
        () => resolve({ name, path: dest, size, sha256: h.digest('hex'), mediaType: file.mediaType }),
        e => fail(String(e.message ?? e)),
      )
    })
    req.on('timeout', () => req.destroy(new Error('download timed out')))
    req.on('error', e => fail(e.message))
  })
}

async function receive(message, senderIp) {
  const meta = message?.metadata?.lanA2a
  // A peer's name only for a message from an address that peer announced from: anyone can put its id in metadata.
  const known = peers.get(meta?.fromId)?.hosts.has(senderIp) ? peerList().find(p => p.id === meta.fromId) : undefined
  const from = known?.address ?? `a2a:${senderIp}`
  const { text, files } = partsOf(message)
  const saved = await Promise.all(files.map(f => download(f, senderIp)))
  inbox.push({
    from, fromName: cleanName(meta?.fromName) || undefined, host: senderIp, authenticated: self.mode === 'secret', text,
    contextId: typeof message?.contextId === 'string' ? message.contextId : undefined,
    files: saved, receivedAt: Date.now(),
  })
}

async function onRpc(req, res) {
  let rpc
  try { rpc = JSON.parse(await readBody(req)) } catch { return send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) }
  const id = rpc?.id ?? null
  const err = (code, message) => send(res, 200, { jsonrpc: '2.0', id, error: { code, message } })
  const method = rpc?.method
  if (method === 'SendMessage' || method === 'message/send') {
    const message = rpc.params?.message
    if (!message || !Array.isArray(message.parts)) return err(-32602, 'Invalid params: message.parts required')
    const senderIp = bareIp(req.socket.remoteAddress)
    // Files download in the background; the entry reaches the inbox once they have.
    receive(message, senderIp).catch(e => log('receive', e.message))
    const contextId = message.contextId || crypto.randomUUID()
    const reply = method === 'SendMessage'
      ? { message: { messageId: crypto.randomUUID(), role: 'ROLE_AGENT', contextId, parts: [{ text: 'delivered' }] } }
      : { kind: 'message', messageId: crypto.randomUUID(), role: 'agent', contextId, parts: [{ kind: 'text', text: 'delivered' }] }
    return send(res, 200, { jsonrpc: '2.0', id, result: reply })
  }
  if (['GetTask', 'tasks/get', 'CancelTask', 'tasks/cancel'].includes(method)) return err(-32001, 'Task not found: this agent answers with messages, never tasks')
  return err(-32601, `Method not found: ${method}`)
}

// A TCP hello: the sender is registered at the address it connected from, with the port its body
// names, and the answer is this session's announce, so one call teaches both sides.
async function onHello(req, res) {
  let m
  try { m = JSON.parse(await readBody(req)) } catch { return send(res, 400, { error: 'bad JSON' }) }
  if (m?.kind !== 'hello') return send(res, 400, { error: 'bad kind' })
  const r = admit(m, bareIp(req.socket.remoteAddress), 'hello')
  if (!r.peer) return send(res, r.status ?? 400, { error: r.why ?? 'refused' })
  return send(res, 200, announceOf('hello', 'hello'))
}

function onHttp(req, res) {
  const u = new URL(req.url ?? '/', 'http://x')
  if (!isOn()) return send(res, 503, { error: 'not configured' })
  if (req.method === 'GET' && u.pathname === '/.well-known/agent-card.json') return send(res, 200, card(req))
  if (!isAuthorized(req)) { res.setHeader('www-authenticate', 'Bearer'); return send(res, 401, { error: 'unauthorized' }) }
  if (req.method === 'POST' && (u.pathname === '/a2a' || u.pathname === '/')) return void onRpc(req, res).catch(e => send(res, 500, { error: e.message }))
  if (req.method === 'POST' && u.pathname === '/lan/hello') return void onHello(req, res).catch(e => send(res, 500, { error: e.message }))
  const fm = /^\/files\/([\w-]+)$/.exec(u.pathname)
  if (req.method === 'GET' && fm) {
    const f = served.get(fm[1])
    if (!f || f.expires < Date.now()) return send(res, 404, { error: 'no such file' })
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': f.size })
    return void pipeline(fs.createReadStream(f.path), res).catch(() => res.destroy())
  }
  return send(res, 404, { error: 'not found' })
}

function portCandidates() {
  const spec = process.env.LAN_A2A_PORT || DEFAULT_PORTS
  const m = /^(\d+)(?:-(\d+))?$/.exec(spec.trim())
  if (!m) return [0]
  const lo = Number(m[1]), hi = Number(m[2] ?? m[1])
  const out = []
  for (let p = lo; p <= hi && out.length < 1000; p++) out.push(p)
  return process.env.LAN_A2A_PORT ? out : [...out, 0] // the default range falls back to a random port
}

async function startHttp() {
  server = http.createServer(onHttp)
  for (const port of portCandidates()) {
    const ok = await new Promise(resolve => {
      server.once('error', () => resolve(false))
      server.listen(port, '0.0.0.0', () => resolve(true))
    })
    if (ok) { server.removeAllListeners('error'); server.on('error', e => log('http', e.message)); self.port = server.address().port; return }
  }
  throw new Error(`no free port in LAN_A2A_PORT=${process.env.LAN_A2A_PORT}`)
}

// ---------- outbound ----------

async function sendTo({ to, text, files, contextId, cwd }) {
  if (!isOn()) return { ok: false, error: 'not configured: LAN mode is off' }
  const peer = findPeer(to)
  if (!peer) return { ok: false, error: `no LAN agent ${to}; known: ${peerList().map(p => p.address).join(', ') || 'none'}` }
  const local = await localAddressFor(peer.host)
  const parts = []
  if (text) parts.push({ text: String(text) })
  const outFiles = []
  for (const f of Array.isArray(files) ? files : []) {
    const p = path.resolve(String(cwd || process.cwd()), String(f))
    try {
      const st = fs.statSync(p)
      if (!st.isFile()) throw new Error('not a regular file')
      if (st.size > MAX_FILE) throw new Error('larger than 512 MB')
      const sha256 = await sha256File(p)
      const id = crypto.randomUUID()
      served.set(id, { path: p, size: st.size, expires: Date.now() + FILE_TTL_MS })
      parts.push({ url: `http://${local}:${self.port}/files/${id}`, filename: path.basename(p), mediaType: mimeOf(p) })
      outFiles.push({ path: p, size: st.size, sha256 })
    } catch (e) {
      outFiles.push({ path: p, error: String(e.message ?? e) })
    }
  }
  if (!parts.length) return { ok: false, error: 'nothing to send', files: outFiles }
  const messageId = crypto.randomUUID()
  const body = JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'SendMessage',
    params: { message: { messageId, role: 'ROLE_USER', parts, ...(contextId ? { contextId } : {}), metadata: { lanA2a: { fromId: self.id, fromName: self.name } } } },
  })
  try {
    const r = await fetch(`http://${peer.host}:${peer.port}/a2a`, {
      method: 'POST', body, signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      headers: { 'content-type': 'application/json', ...authHeader() },
    })
    if (r.status === 401) return { ok: false, error: `${peer.address} refused the secret (401)`, files: outFiles }
    const j = await r.json()
    if (j.error) return { ok: false, error: `${peer.address}: ${j.error.message}`, files: outFiles }
    return { ok: true, to: peer.address, messageId, contextId: j.result?.message?.contextId, files: outFiles }
  } catch (e) {
    return { ok: false, error: `${peer.address} did not answer: ${e.message}`, files: outFiles }
  }
}

// ---------- MCP ----------

const obj = { type: 'object' }
const TOOLS = [
  { name: 'status', description: 'This session\'s LAN address, port and peer count.', inputSchema: { ...obj, properties: {} } },
  { name: 'peers', description: 'LAN agents seen in the last 15 seconds.', inputSchema: { ...obj, properties: {} } },
  { name: 'inbox', description: 'Drain received LAN messages.', inputSchema: { ...obj, properties: {} } },
  { name: 'static', description: 'Set the static LAN peers (host or host:port) to hello over TCP every period.', inputSchema: { ...obj, properties: { hosts: { type: 'array', items: { type: 'string' } } }, required: ['hosts'] } },
  { name: 'send', description: 'Send a message and optional files to a LAN agent (lan:<name>).', inputSchema: { ...obj, properties: { to: { type: 'string' }, text: { type: 'string' }, files: { type: 'array', items: { type: 'string' } }, contextId: { type: 'string' }, cwd: { type: 'string', description: 'Relative file paths resolve against this' } }, required: ['to'] } },
]

const status = () => ({ configured: isOn(), mode: self.mode, ...(self.problem ? { problem: self.problem } : {}), id: self.id, name: self.name, address: self.name ? `lan:${self.name}` : '', port: self.port, peers: peers.size, static: statics(), multicast: !!disco })

// The options arrive as env, set once per process: a new secret or name takes a new session.
// The lan option: only an explicit false turns LAN mode off (an unset option may arrive empty).
const lanOff = v => /^(false|0|off|no)$/i.test(String(v ?? '').trim())

async function configure() {
  if (lanOff(process.env.A2A_MOD_LAN)) return
  const secret = process.env.A2A_MOD_LAN_SECRET || process.env.LAN_A2A_SECRET || ''
  // A short secret is a mistake, never a request for open mode.
  if (secret && secret.length < 8) { self.problem = 'the LAN shared secret must be at least 8 characters; clear it for open mode'; return }
  self.mode = secret ? 'secret' : 'open'
  self.secret = secret
  self.name = cleanName(process.env.A2A_MOD_LAN_NAME || process.env.LAN_A2A_NAME) || cleanName(`${os.hostname()}/${path.basename(process.cwd())}`) || 'unnamed'
  self.group = secret ? groupOf(secret) : OPEN_GROUP
  envStatics = setStatics(String(process.env.A2A_MOD_LAN_PEERS ?? '').split(/[\s,]+/).filter(Boolean)).ok
  await startHttp()
  // LAN_A2A_NO_MCAST: no UDP at all (tests, or a network where only TCP gets through): static peers only.
  if (!/^(1|true|yes|on)$/i.test(process.env.LAN_A2A_NO_MCAST ?? '')) await startDiscovery()
  setInterval(everyPeriod, ANNOUNCE_MS).unref()
  await announce('hello')
  void helloStatics()
}

async function callTool(name, args) {
  switch (name) {
    case 'status': return status()
    case 'peers': return { peers: peerList() }
    case 'inbox': return { messages: inbox.splice(0) }
    case 'send': return sendTo(args)
    case 'static': {
      const { ok, refused } = setStatics(args?.hosts)
      toolStatics = ok
      void helloStatics()
      return { static: statics(), ...(refused.length ? { refused } : {}) }
    }
    default: return { error: `unknown tool ${name}` }
  }
}

const write = msg => process.stdout.write(JSON.stringify(msg) + '\n')

async function onLine(line) {
  if (!line.trim()) return
  let msg
  try { msg = JSON.parse(line) } catch { return write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) }
  const { id, method, params } = msg
  if (id === undefined || id === null) return // notifications
  const ok = result => write({ jsonrpc: '2.0', id, result })
  try {
    if (method === 'initialize') return ok({ protocolVersion: params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'lan-a2a', version: VERSION } })
    if (method === 'ping') return ok({})
    if (method === 'tools/list') return ok({ tools: TOOLS })
    if (method === 'tools/call') {
      const out = await callTool(params?.name, params?.arguments ?? {})
      const isError = typeof out?.error === 'string' || out?.ok === false
      return ok({ content: [{ type: 'text', text: JSON.stringify(out) }], structuredContent: out, isError })
    }
    write({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } })
  } catch (e) {
    write({ jsonrpc: '2.0', id, error: { code: -32603, message: String(e?.message ?? e) } })
  }
}

let exiting = false
async function shutdown() {
  if (exiting) return
  exiting = true
  const t = setTimeout(() => process.exit(0), 1000)
  try { await announce('bye') } catch {}
  clearTimeout(t)
  process.exit(0)
}

const ready = configure().catch(e => { self.mode = 'off'; self.secret = ''; self.problem = `LAN mode could not start: ${e.message}`; log(self.problem) })
readline.createInterface({ input: process.stdin }).on('line', l => { void ready.then(() => onLine(l)) }).on('close', shutdown)
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
