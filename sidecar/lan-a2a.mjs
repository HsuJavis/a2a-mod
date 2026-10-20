#!/usr/bin/env node
// a2a-mod LAN mode sidecar: a stdio MCP server (newline-delimited JSON-RPC 2.0) that the mod
// drives, plus an A2A JSON-RPC endpoint over HTTP and UDP multicast discovery on the LAN.
// A mod cannot listen on a socket, so this process does. The engine starts one per session from
// plugin.json's mcpServers; the secret and name come in its env from the lanSecret and lanName
// options (LAN_A2A_SECRET / LAN_A2A_NAME in the shell when those are empty).
// Zero dependencies, Node >= 22. stdout carries JSON-RPC only; logs go to stderr.
import crypto from 'node:crypto'
import dgram from 'node:dgram'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { pipeline } from 'node:stream/promises'

const VERSION = '0.4.0'
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

const log = (...a) => process.stderr.write(`[lan-a2a] ${a.join(' ')}\n`)

const self = { id: crypto.randomUUID(), name: '', secret: '', group: '', port: 0, problem: '' }
const peers = new Map() // id -> { id, name, host, port, lastSeen }
const inbox = []
const served = new Map() // file id -> { path, size, expires }
let server
let disco
const senders = new Map() // interface address -> send socket

// ---------- helpers ----------

const groupOf = secret => crypto.createHash('sha256').update(`${APP}:${secret}`).digest('hex').slice(0, 16)
const cleanName = s => String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, '').replace(/\s+/g, '-').slice(0, 64)
const safeFile = s => (path.basename(String(s ?? '')).replace(/[^\w.\-]+/g, '_').replace(/^\.+/, '').slice(0, 100) || 'file')
const bareIp = a => String(a ?? '').replace(/^::ffff:/, '')
const digest = s => crypto.createHash('sha256').update(String(s)).digest()

function isAuthorized(req) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')
  // Hash both sides so timingSafeEqual sees equal lengths whatever was sent.
  return !!self.secret && !!m && crypto.timingSafeEqual(digest(m[1]), digest(self.secret))
}

function ipv4Addresses() {
  const out = new Set(['127.0.0.1'])
  for (const list of Object.values(os.networkInterfaces())) for (const a of list ?? []) if (a.family === 'IPv4') out.add(a.address)
  return [...out]
}

function peerList() {
  const counts = new Map()
  for (const p of peers.values()) counts.set(p.name, (counts.get(p.name) ?? 0) + 1)
  return [...peers.values()].map(p => ({
    address: `lan:${p.name}${counts.get(p.name) > 1 || p.name === self.name ? `#${p.id.slice(0, 4)}` : ''}`,
    name: p.name, id: p.id, host: p.host, port: p.port, lastSeen: p.lastSeen,
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

function announce(kind) {
  if (!disco || !self.group) return Promise.resolve()
  const msg = Buffer.from(JSON.stringify({ app: APP, v: 1, kind, id: self.id, name: self.name, port: self.port, group: self.group }))
  refreshInterfaces()
  return Promise.all([...senders.values()].map(s => new Promise(r => s.send(msg, MCAST_PORT, MCAST_ADDR, () => r()))))
}

// One send socket per IPv4 interface (loopback included), so an announce reaches the LAN and
// also the other sessions on this host even where a firewall drops multicast on the LAN NIC.
function refreshInterfaces() {
  const now = ipv4Addresses()
  for (const addr of now) {
    if (senders.has(addr)) continue
    try { disco.addMembership(MCAST_ADDR, addr) } catch {}
    const s = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    s.on('error', e => { log('send socket', addr, e.message); s.close(); senders.delete(addr) })
    senders.set(addr, s)
    s.bind({ port: 0, address: addr }, () => {
      try { s.setMulticastInterface(addr); s.setMulticastTTL(1); s.setMulticastLoopback(true) } catch (e) { log('mcast opts', addr, e.message) }
    })
  }
  for (const [addr, s] of senders) if (!now.includes(addr)) { try { s.close() } catch {} senders.delete(addr) }
}

let lastReply = 0
function onAnnounce(buf, rinfo) {
  let m
  try { m = JSON.parse(String(buf)) } catch { return }
  if (m?.app !== APP || m.v !== 1 || m.group !== self.group || m.id === self.id || typeof m.id !== 'string') return
  if (m.kind === 'bye') { peers.delete(m.id); return }
  if (m.kind !== 'hello' || !Number.isInteger(m.port) || m.port <= 0 || m.port > 65535) return
  const isNew = !peers.has(m.id)
  peers.set(m.id, { id: m.id.slice(0, 64), name: cleanName(m.name) || 'unnamed', host: bareIp(rinfo.address), port: m.port, lastSeen: Date.now() })
  // Answer a newcomer at once so it need not wait a full period; rate-limited against storms.
  if (isNew && Date.now() - lastReply > 300) { lastReply = Date.now(); void announce('hello') }
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
      setInterval(() => {
        const cut = Date.now() - EXPIRE_MS
        for (const [id, p] of peers) if (p.lastSeen < cut) peers.delete(id)
        for (const [id, f] of served) if (f.expires < Date.now()) served.delete(id)
        void announce('hello')
      }, ANNOUNCE_MS).unref()
      resolve()
    })
  })
}

// ---------- HTTP / A2A ----------

function card(req) {
  const base = `http://${req.headers.host ?? `127.0.0.1:${self.port}`}`
  const url = `${base}/a2a`
  return {
    name: self.name,
    description: `Claude Code session ${self.name} on the LAN (a2a-mod LAN mode). Messages reach the session as untrusted text.`,
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
    securitySchemes: { bearer: { type: 'http', scheme: 'bearer', httpAuthSecurityScheme: { scheme: 'Bearer' } } },
    security: [{ bearer: [] }],
    securityRequirements: [{ schemes: { bearer: { list: [] } } }],
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
    // The bearer goes only back to the host the message came from.
    if (u.protocol !== 'http:' || bareIp(u.hostname.replace(/^\[|\]$/g, '')) !== senderIp) {
      return resolve({ name, error: `refused: file URL host ${u.hostname} is not the sender ${senderIp}` })
    }
    fs.mkdirSync(inboxDir(), { recursive: true, mode: 0o700 })
    const dest = path.join(inboxDir(), `${new Date().toISOString().replace(/[:.]/g, '-')}_${crypto.randomBytes(2).toString('hex')}_${name}`)
    const fail = error => { fs.rm(dest, { force: true }, () => resolve({ name, error })) }
    const req = http.get(u, { headers: { authorization: `Bearer ${self.secret}` }, timeout: 30000 }, res => {
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
  const known = typeof meta?.fromId === 'string' ? peerList().find(p => p.id === meta.fromId) : undefined
  const from = known?.address ?? `a2a:${senderIp}`
  const { text, files } = partsOf(message)
  const saved = await Promise.all(files.map(f => download(f, senderIp)))
  inbox.push({
    from, fromName: cleanName(meta?.fromName) || undefined, text,
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

function onHttp(req, res) {
  const u = new URL(req.url ?? '/', 'http://x')
  if (!self.secret) return send(res, 503, { error: 'not configured' })
  if (req.method === 'GET' && u.pathname === '/.well-known/agent-card.json') return send(res, 200, card(req))
  if (!isAuthorized(req)) { res.setHeader('www-authenticate', 'Bearer'); return send(res, 401, { error: 'unauthorized' }) }
  if (req.method === 'POST' && (u.pathname === '/a2a' || u.pathname === '/')) return void onRpc(req, res).catch(e => send(res, 500, { error: e.message }))
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
  if (!self.secret) return { ok: false, error: 'not configured: set the LAN shared secret' }
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
      headers: { 'content-type': 'application/json', authorization: `Bearer ${self.secret}` },
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
  { name: 'send', description: 'Send a message and optional files to a LAN agent (lan:<name>).', inputSchema: { ...obj, properties: { to: { type: 'string' }, text: { type: 'string' }, files: { type: 'array', items: { type: 'string' } }, contextId: { type: 'string' }, cwd: { type: 'string', description: 'Relative file paths resolve against this' } }, required: ['to'] } },
]

const status = () => ({ configured: !!self.secret, ...(self.problem ? { problem: self.problem } : {}), id: self.id, name: self.name, address: self.name ? `lan:${self.name}` : '', port: self.port, peers: peers.size })

// The options arrive as env, set once per process: a new secret or name takes a new session.
async function configure() {
  const secret = process.env.A2A_MOD_LAN_SECRET || process.env.LAN_A2A_SECRET || ''
  if (!secret) return
  if (secret.length < 8) { self.problem = 'the LAN shared secret must be at least 8 characters'; return }
  self.secret = secret
  self.name = cleanName(process.env.A2A_MOD_LAN_NAME || process.env.LAN_A2A_NAME) || cleanName(`${os.hostname()}/${path.basename(process.cwd())}`)
  self.group = groupOf(secret)
  await startHttp()
  await startDiscovery()
  await announce('hello')
}

async function callTool(name, args) {
  switch (name) {
    case 'status': return status()
    case 'peers': return { peers: peerList() }
    case 'inbox': return { messages: inbox.splice(0) }
    case 'send': return sendTo(args)
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

const ready = configure().catch(e => { self.secret = ''; self.problem = `LAN mode could not start: ${e.message}`; log(self.problem) })
readline.createInterface({ input: process.stdin }).on('line', l => { void ready.then(() => onLine(l)) }).on('close', shutdown)
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
