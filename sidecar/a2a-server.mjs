#!/usr/bin/env node
// a2a-mod sidecar: a stdio MCP server (newline-delimited JSON-RPC 2.0) that only the mod drives,
// plus this session's A2A endpoint over HTTP, the network scan, and the mod's own HTTP requests.
//
// A mod cannot listen on a socket or open a raw TCP connection, so this process does both. The
// engine starts one per session from plugin.json's mcpServers; the switch, token and name come in
// its env from the server, serverToken and serverName options.
//
// The endpoint: an Agent Card at /.well-known/agent-card.json and JSON-RPC at /a2a, A2A 1.0
// (SendMessage, GetTask, CancelTask) and 0.3 (message/send, tasks/get, tasks/cancel). A message
// makes a task (submitted); the mod drains it from `inbox` into the session (working); Claude's
// answer comes back through `reply` and completes it, or asks a question (input-required). Open
// mode (no token) takes anyone who reaches the port; token mode wants `Authorization: Bearer`.
//
// The scan: TCP connect probes, and an Agent Card GET only where a port is open, both with real
// timeouts, so a stop is immediate.
//
// Zero dependencies, Node >= 22. stdout carries JSON-RPC only; logs go to stderr.
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { pipeline } from 'node:stream/promises'

const VERSION = '0.9.1'
const DEFAULT_PORTS = '41400-41499'
const MiB = 1024 * 1024
/** One JSON-RPC request: room for 10 MiB of inline files as base64. */
const MAX_BODY = 24 * MiB
/** One file in, inline or by URL, and one file in a reply. */
const MAX_FILE = 64 * MiB
const MAX_FILES = 20
/** Tasks kept at once; past it a new message is refused. */
const MAX_TASKS = 500
const DOWNLOAD_TIMEOUT_MS = 30_000
const TASK_TTL_MS = Number(process.env.A2A_MOD_TASK_TTL_MS) > 0 ? Number(process.env.A2A_MOD_TASK_TTL_MS) : 60 * 60_000
const SCAN_TIMEOUT_MS = Number(process.env.A2A_SCAN_TIMEOUT_MS) > 0 ? Number(process.env.A2A_SCAN_TIMEOUT_MS) : 300
const SCAN_CONCURRENCY = Number(process.env.A2A_SCAN_CONCURRENCY) > 0 ? Number(process.env.A2A_SCAN_CONCURRENCY) : 512
const CARD_TIMEOUT_MS = 1500
const MAX_CARD = 256 * 1024
const MAX_HITS = 100

const log = (...a) => process.stderr.write(`[a2a-mod-sidecar] ${a.join(' ')}\n`)

const self = { id: crypto.randomUUID(), on: false, problem: '', name: '', token: '', port: 0 }
/** id -> task. A task: { id, contextId, state, from, authenticated, createdAt, updatedAt, history, artifacts, question, files, base } */
const tasks = new Map()
/** Messages waiting for the mod to drain them into the session. */
const queue = []
/** file id -> { path, size, name, mediaType, taskId }: the files of a reply, served at /files/<id>. */
const served = new Map()
let server

// ---------- helpers ----------

const now = () => Date.now()
const iso = t => new Date(t).toISOString()
const bareIp = a => String(a ?? '').replace(/^::ffff:/, '')
const digest = s => crypto.createHash('sha256').update(String(s)).digest()
// Letters, digits and . _ / - only: a name is shown to Claude, so it must not carry markup or a line.
const cleanName = s => String(s ?? '').replace(/[^\p{L}\p{N}._/-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 64)
const safeFile = s => (path.basename(String(s ?? '')).replace(/[^\w.\-]+/g, '_').replace(/^\.+/, '').slice(0, 100) || 'file')
const isLive = s => s === 'submitted' || s === 'working'
const isOpen = s => isLive(s) || s === 'input-required'

const MIME = { '.txt': 'text/plain', '.md': 'text/markdown', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.pdf': 'application/pdf', '.zip': 'application/zip', '.html': 'text/html', '.csv': 'text/csv' }
const mimeOf = f => MIME[path.extname(f).toLowerCase()] ?? 'application/octet-stream'

function isAuthorized(req) {
  if (!self.token) return true
  const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')
  // Hash both sides so timingSafeEqual sees equal lengths whatever was sent.
  return !!m && crypto.timingSafeEqual(digest(m[1]), digest(self.token))
}

function addresses() {
  const out = []
  for (const list of Object.values(os.networkInterfaces())) for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) out.push(a.address)
  return out
}

/** The URLs this session is reached at: its LAN addresses first, loopback last. */
const urls = () => (self.on ? [...addresses(), '127.0.0.1'].map(ip => `http://${ip}:${self.port}`) : [])

// ---------- the task store ----------

const inboxDir = () => process.env.A2A_MOD_INBOX || path.join(os.homedir(), '.claude', 'a2a-mod', 'inbox')

function savePath(name) {
  fs.mkdirSync(inboxDir(), { recursive: true, mode: 0o700 })
  return path.join(inboxDir(), `${new Date().toISOString().replace(/[:.]/g, '-')}_${crypto.randomBytes(3).toString('hex')}_${safeFile(name)}`)
}

function saveInline(f) {
  const name = safeFile(f.name)
  const bytes = Buffer.from(String(f.base64 ?? ''), 'base64')
  if (bytes.length > MAX_FILE) return { name, error: `refused: larger than ${MAX_FILE / MiB} MiB` }
  const dest = savePath(name)
  fs.writeFileSync(dest, bytes, { mode: 0o600 })
  return { name, path: dest, size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), mediaType: f.mediaType || 'application/octet-stream' }
}

// The file is fetched only from the host the message came from, with no redirect: a URL can point anywhere.
async function download(f, senderIp) {
  let u
  try { u = new URL(f.url) } catch { return { name: safeFile(f.name), error: 'bad file URL' } }
  const name = safeFile(f.name || path.basename(u.pathname))
  const host = bareIp(u.hostname.replace(/^\[|\]$/g, ''))
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || host !== senderIp) {
    return { name, error: `refused: file URL host ${u.hostname.slice(0, 80)} is not the sender ${senderIp}` }
  }
  const dest = savePath(name)
  try {
    const r = await fetch(u, { redirect: 'error', signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
    if (r.status !== 200 || !r.body) throw new Error(`download failed: HTTP ${r.status}`)
    if (Number(r.headers.get('content-length') ?? 0) > MAX_FILE) throw new Error(`refused: larger than ${MAX_FILE / MiB} MiB`)
    const h = crypto.createHash('sha256')
    const out = fs.createWriteStream(dest, { mode: 0o600 })
    let size = 0
    try {
      for await (const chunk of r.body) {
        size += chunk.length
        if (size > MAX_FILE) throw new Error(`refused: larger than ${MAX_FILE / MiB} MiB`)
        h.update(chunk)
        if (!out.write(chunk)) await new Promise(res => out.once('drain', res))
      }
    } finally {
      await new Promise(res => out.end(res))
    }
    return { name, path: dest, size, sha256: h.digest('hex'), mediaType: f.mediaType || 'application/octet-stream' }
  } catch (e) {
    fs.rmSync(dest, { force: true })
    return { name, error: String(e?.cause?.message ?? e?.message ?? e).slice(0, 200) }
  }
}

/** Text, inline files and URL files of a 1.0 or 0.3 message. */
function partsOf(message) {
  const texts = []
  const files = []
  for (const p of Array.isArray(message?.parts) ? message.parts : []) {
    if (typeof p?.text === 'string') texts.push(p.text)
    else if (typeof p?.raw === 'string') files.push({ base64: p.raw, name: p.filename, mediaType: p.mediaType })
    else if (typeof p?.url === 'string') files.push({ url: p.url, name: p.filename, mediaType: p.mediaType })
    else if (p?.kind === 'file' && typeof p.file?.bytes === 'string') files.push({ base64: p.file.bytes, name: p.file.name, mediaType: p.file.mimeType })
    else if (p?.kind === 'file' && typeof p.file?.uri === 'string') files.push({ url: p.file.uri, name: p.file.name, mediaType: p.file.mimeType })
    else if (p?.data !== undefined) texts.push(JSON.stringify(p.data))
  }
  return { text: texts.join('\n'), files }
}

function setState(t, state, question) {
  t.state = state
  t.updatedAt = now()
  t.question = question
}

// A live task left unanswered past the TTL fails; an ended one is dropped a TTL after it ended.
function sweep() {
  const cut = now() - TASK_TTL_MS
  for (const t of tasks.values()) {
    if (t.updatedAt > cut) continue
    if (isOpen(t.state)) { setState(t, 'failed', `not answered within ${Math.round(TASK_TTL_MS / 60_000) || 1} min`); continue }
    tasks.delete(t.id)
    for (const [id, f] of served) if (f.taskId === t.id) served.delete(id)
  }
  for (let i = queue.length - 1; i >= 0; i--) if (!tasks.has(queue[i].taskId)) queue.splice(i, 1)
}

// ---------- A2A wire shapes ----------

const STATE_1 = s => `TASK_STATE_${s.replace(/-/g, '_').toUpperCase()}`

function part(p, v) {
  if (p.text !== undefined) return v === '1.0' ? { text: p.text } : { kind: 'text', text: p.text }
  return v === '1.0' ? { url: p.url, filename: p.name, mediaType: p.mediaType } : { kind: 'file', file: { uri: p.url, name: p.name, mimeType: p.mediaType } }
}

function message(m, t, v) {
  const parts = m.parts.map(p => part(p, v))
  return v === '1.0'
    ? { messageId: m.messageId, role: m.role === 'user' ? 'ROLE_USER' : 'ROLE_AGENT', parts, contextId: t.contextId, taskId: t.id }
    : { kind: 'message', messageId: m.messageId, role: m.role, parts, contextId: t.contextId, taskId: t.id }
}

function wireTask(t, v) {
  const status = {
    state: v === '1.0' ? STATE_1(t.state) : t.state,
    timestamp: iso(t.updatedAt),
    ...(t.question ? { message: message({ messageId: `${t.id}-q${t.updatedAt}`, role: 'agent', parts: [{ text: t.question }] }, t, v) } : {}),
  }
  const artifacts = t.artifacts.map(a => ({ artifactId: a.artifactId, name: a.name, parts: a.parts.map(p => part(p, v)) }))
  const history = t.history.map(m => message(m, t, v))
  return v === '1.0' ? { id: t.id, contextId: t.contextId, status, artifacts, history } : { kind: 'task', id: t.id, contextId: t.contextId, status, artifacts, history }
}

/** The Host header when it is a plain host[:port], else this session's loopback address. */
function hostOf(req) {
  const h = String(req.headers.host ?? '')
  return /^[\w.\-]+(:\d+)?$|^\[[\da-fA-F:.]+\](:\d+)?$/.test(h) ? h : `127.0.0.1:${self.port}`
}

function card(req) {
  const base = `http://${hostOf(req)}`
  const url = `${base}/a2a`
  const io = ['text/plain', 'application/octet-stream']
  return {
    name: self.name,
    description: `Claude Code session ${self.name} (a2a-mod ${VERSION}). A message becomes a task that this session's Claude answers; it reads the message as untrusted input from another agent.`,
    version: VERSION,
    supportedInterfaces: [
      { url, protocolBinding: 'JSONRPC', protocolVersion: '1.0', tenant: '' },
      { url, protocolBinding: 'JSONRPC', protocolVersion: '0.3', tenant: '' },
    ],
    url,
    preferredTransport: 'JSONRPC',
    protocolVersion: '0.3.0',
    provider: { organization: 'a2a-mod', url: 'https://github.com/HsuJavis/a2a-mod' },
    capabilities: { streaming: false, pushNotifications: false, extensions: [], extendedAgentCard: false },
    defaultInputModes: io,
    defaultOutputModes: io,
    skills: [{
      id: 'claude-session', name: 'Claude Code session',
      description: 'Ask this Claude Code session something, or hand it files. The answer comes back as the task result; it may take minutes.',
      tags: ['claude-code', 'chat', 'files'], examples: [], inputModes: io, outputModes: io, securityRequirements: [],
    }],
    ...(self.token
      ? {
          securitySchemes: { bearer: { type: 'http', scheme: 'bearer', httpAuthSecurityScheme: { scheme: 'Bearer' } } },
          security: [{ bearer: [] }],
          securityRequirements: [{ schemes: { bearer: { list: [] } } }],
        }
      : { securitySchemes: {}, securityRequirements: [] }),
    signatures: [],
    a2aMod: { kind: 'claude-session', name: self.name, id: self.id, version: VERSION, auth: self.token ? 'bearer' : 'open' },
  }
}

// ---------- HTTP ----------

const sendJson = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers })
  res.end(JSON.stringify(body))
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let n = 0
    req.on('data', c => { n += c.length; if (n > MAX_BODY) { reject(Object.assign(new Error('too large'), { tooLarge: true })); req.destroy() } else chunks.push(c) })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

const VERSION_OF = { SendMessage: '1.0', GetTask: '1.0', CancelTask: '1.0', 'message/send': '0.3', 'tasks/get': '0.3', 'tasks/cancel': '0.3' }

async function onRpc(req, res) {
  let rpc
  try { rpc = JSON.parse(await readBody(req)) } catch (e) {
    if (e?.tooLarge) return
    return sendJson(res, 200, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
  }
  const id = rpc?.id ?? null
  const ok = result => sendJson(res, 200, { jsonrpc: '2.0', id, result })
  const err = (code, msg) => sendJson(res, 200, { jsonrpc: '2.0', id, error: { code, message: msg } })
  const v = VERSION_OF[rpc?.method]
  if (!v) return err(-32601, `Method not found: ${String(rpc?.method).slice(0, 60)}`)
  sweep()
  const params = rpc.params ?? {}
  if (rpc.method === 'SendMessage' || rpc.method === 'message/send') {
    const msg = params.message
    if (!msg || !Array.isArray(msg.parts)) return err(-32602, 'Invalid params: message.parts required')
    const { text, files } = partsOf(msg)
    if (!text && !files.length) return err(-32602, 'Invalid params: the message has no text or file part')
    if (files.length > MAX_FILES) return err(-32602, `Invalid params: at most ${MAX_FILES} files a message`)
    const senderIp = bareIp(req.socket.remoteAddress)
    let t
    let followUp = false
    if (typeof msg.taskId === 'string' && msg.taskId) {
      t = tasks.get(msg.taskId)
      if (!t) return err(-32001, `Task not found: ${msg.taskId.slice(0, 80)}`)
      if (!isOpen(t.state)) return err(-32004, `Task ${t.id} is ${t.state}; send a new message to start another`)
      followUp = true
      setState(t, 'submitted')
    } else {
      if (tasks.size >= MAX_TASKS) return err(-32603, 'This session has too many tasks open; try again later')
      const at = now()
      t = {
        id: crypto.randomUUID(), contextId: typeof msg.contextId === 'string' && msg.contextId ? msg.contextId.slice(0, 200) : crypto.randomUUID(),
        state: 'submitted', from: senderIp, authenticated: !!self.token, createdAt: at, updatedAt: at, history: [], artifacts: [],
        // A reply's files are served at the address the asker reached this session by.
        base: hostOf(req),
      }
      tasks.set(t.id, t)
    }
    t.history.push({ messageId: String(msg.messageId ?? crypto.randomUUID()).slice(0, 200), role: 'user', parts: text ? [{ text }] : [] })
    // Files download in the background; the message reaches the inbox once they have.
    const taskId = t.id
    void Promise.all(files.map(f => (f.url ? download(f, senderIp) : Promise.resolve(saveInline(f)))))
      .catch(e => [{ name: 'file', error: String(e?.message ?? e) }])
      .then(saved => {
        const held = tasks.get(taskId)
        if (!held || !isOpen(held.state)) return
        queue.push({ taskId, contextId: held.contextId, from: senderIp, authenticated: !!self.token, followUp, text, files: saved, receivedAt: now() })
      })
    return ok(v === '1.0' ? { task: wireTask(t, v) } : wireTask(t, v))
  }
  const t = tasks.get(String(params.id ?? ''))
  if (!t) return err(-32001, `Task not found: ${String(params.id ?? '').slice(0, 80)}`)
  if (rpc.method === 'CancelTask' || rpc.method === 'tasks/cancel') {
    if (!isOpen(t.state)) return err(-32002, `Task ${t.id} is ${t.state} and cannot be canceled`)
    setState(t, 'canceled')
  }
  return ok(wireTask(t, v))
}

function onHttp(req, res) {
  const u = new URL(req.url ?? '/', 'http://x')
  if (req.method === 'GET' && (u.pathname === '/.well-known/agent-card.json' || u.pathname === '/.well-known/agent.json')) return sendJson(res, 200, card(req))
  // A reply's file: the id is 128 random bits and lives as long as its task.
  const fm = /^\/files\/([\w-]{20,})$/.exec(u.pathname)
  if (req.method === 'GET' && fm) {
    const f = served.get(fm[1])
    if (!f || !tasks.has(f.taskId)) return sendJson(res, 404, { error: 'no such file' })
    res.writeHead(200, { 'content-type': f.mediaType, 'content-length': f.size, 'content-disposition': `attachment; filename="${f.name}"` })
    return void pipeline(fs.createReadStream(f.path), res).catch(() => res.destroy())
  }
  if (req.method === 'POST' && (u.pathname === '/a2a' || u.pathname === '/')) {
    if (!isAuthorized(req)) return sendJson(res, 401, { error: 'unauthorized' }, { 'www-authenticate': 'Bearer' })
    return void onRpc(req, res).catch(e => { log('rpc', e.message); if (!res.headersSent) sendJson(res, 500, { error: 'internal error' }) })
  }
  return sendJson(res, 404, { error: 'not found' })
}

/** The ports to try, in order, or why there are none. No random fallback: others find a session by its port. */
function portCandidates() {
  const spec = (process.env.A2A_PORT || DEFAULT_PORTS).trim()
  const m = /^(\d{1,5})(?:-(\d{1,5}))?$/.exec(spec)
  const lo = Number(m?.[1])
  const hi = Number(m?.[2] ?? m?.[1])
  if (!m || lo < 1 || hi > 65535 || lo > hi) return { spec, error: `A2A_PORT=${spec.slice(0, 40)} is not a port or a range like 41400-41499` }
  return { spec, ports: Array.from({ length: Math.min(hi - lo + 1, 1000) }, (_, i) => lo + i) }
}

async function startHttp() {
  const { spec, ports, error } = portCandidates()
  if (error) throw new Error(error)
  server = http.createServer(onHttp)
  server.requestTimeout = 60_000
  for (const port of ports) {
    const bound = await new Promise(resolve => {
      server.once('error', () => resolve(false))
      server.listen(port, '0.0.0.0', () => resolve(true))
    })
    if (bound) {
      server.removeAllListeners('error')
      server.on('error', e => log('http', e.message))
      self.port = server.address().port
      return
    }
  }
  throw new Error(`no free port in ${spec}: every one is taken (other sessions, or other programs). Close a session or set A2A_PORT`)
}

// ---------- reply ----------

async function reply({ taskId, text, files, cwd, ask }) {
  sweep()
  const t = tasks.get(String(taskId ?? ''))
  if (!t) return { ok: false, error: `no A2A task ${String(taskId ?? '').slice(0, 80)} here: it expired, or it never came to this session` }
  if (!isLive(t.state)) return { ok: false, error: `task ${t.id} is ${t.state}${t.state === 'canceled' ? ': the sender canceled it' : ''}, so the reply was not sent` }
  const parts = []
  if (text) parts.push({ text: String(text) })
  const out = []
  const base = `http://${t.base}`
  for (const f of Array.isArray(files) ? files : []) {
    const p = path.resolve(String(cwd || process.cwd()), String(f))
    try {
      const st = fs.statSync(p)
      if (!st.isFile()) throw new Error('not a regular file')
      if (st.size > MAX_FILE) throw new Error(`larger than ${MAX_FILE / MiB} MiB`)
      const h = crypto.createHash('sha256')
      await pipeline(fs.createReadStream(p), h)
      const id = crypto.randomBytes(16).toString('hex')
      served.set(id, { path: p, size: st.size, name: safeFile(path.basename(p)), mediaType: mimeOf(p), taskId: t.id })
      parts.push({ url: `${base}/files/${id}`, name: path.basename(p), mediaType: mimeOf(p) })
      out.push({ path: p, size: st.size, sha256: h.digest('hex') })
    } catch (e) {
      out.push({ path: p, error: String(e?.message ?? e) })
    }
  }
  if (!parts.length) return { ok: false, error: 'nothing to reply with: no text, and no file could be read', files: out }
  if (ask) {
    if (!text) return { ok: false, error: 'a question needs text', files: out }
    t.history.push({ messageId: crypto.randomUUID(), role: 'agent', parts: [{ text: String(text) }] })
    setState(t, 'input-required', String(text))
  } else {
    t.artifacts.push({ artifactId: crypto.randomUUID(), name: 'reply', parts })
    setState(t, 'completed')
  }
  return { ok: true, taskId: t.id, state: t.state, files: out }
}

// ---------- scan ----------

let scan = { phase: 'idle', done: 0, total: 0, hits: [], startedAt: 0, at: 0 }
let scanRun

const ipNum = s => s.split('.').reduce((n, p) => n * 256 + Number(p), 0)
const ipText = n => [24, 16, 8, 0].map(s => (n >>> s) & 255).join('.')
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

function tcpOpen(run, host, port, ms) {
  return new Promise(resolve => {
    const s = net.connect({ host, port })
    run.sockets.add(s)
    const done = open => { clearTimeout(timer); run.sockets.delete(s); s.destroy(); resolve(open) }
    const timer = setTimeout(() => done(false), ms)
    s.once('connect', () => done(true))
    s.once('error', () => done(false))
    s.once('close', () => done(false))
  })
}

// node:http, not fetch: a stop must close the socket at once, and fetch leaves an aborted one open.
function cardAt(run, base, ms) {
  return new Promise(resolve => {
    const get = base.startsWith('https:') ? https.get : http.get
    const req = get(`${base}/.well-known/agent-card.json`, { headers: { accept: 'application/json', 'A2A-Version': '1.0' }, agent: false }, res => {
      if (res.statusCode !== 200) { res.resume(); return finish() }
      const chunks = []
      let n = 0
      res.on('data', c => { n += c.length; if (n > MAX_CARD) req.destroy(); else chunks.push(c) })
      res.on('end', () => {
        try { const c = JSON.parse(Buffer.concat(chunks).toString('utf8')); finish(typeof c?.name === 'string' ? c : undefined) } catch { finish() }
      })
      res.on('error', () => finish())
    })
    run.sockets.add(req)
    const timer = setTimeout(() => req.destroy(), ms)
    function finish(card) { clearTimeout(timer); run.sockets.delete(req); req.destroy(); resolve(card) }
    req.on('error', () => finish())
    req.on('close', () => finish())
  })
}

function scanStart(args) {
  if (scan.phase === 'running') return { ok: false, error: 'a scan is already running' }
  const first = String(args?.first ?? '')
  const last = String(args?.last ?? first)
  if (!IPV4.test(first) || !IPV4.test(last) || ipNum(first) > ipNum(last)) return { ok: false, error: 'first and last must be IPv4 addresses, first <= last' }
  const ports = (Array.isArray(args?.ports) ? args.ports : []).map(Number).filter(p => Number.isInteger(p) && p >= 1 && p <= 65535)
  if (!ports.length) return { ok: false, error: 'no ports' }
  const lo = ipNum(first)
  const hosts = ipNum(last) - lo + 1
  const total = hosts * ports.length
  if (hosts > 65536 || total > 65536 * 64) return { ok: false, error: 'too many probes' }
  const timeoutMs = Number(args?.timeoutMs) > 0 ? Number(args.timeoutMs) : SCAN_TIMEOUT_MS
  const cardMs = Number(args?.cardTimeoutMs) > 0 ? Number(args.cardTimeoutMs) : CARD_TIMEOUT_MS
  const lanes = Math.min(Number(args?.concurrency) > 0 ? Number(args.concurrency) : SCAN_CONCURRENCY, total)
  const https = args?.https === true
  const run = { sockets: new Set(), abort: new AbortController(), sessions: new Set() }
  scanRun = run
  const at = now()
  scan = { phase: 'running', done: 0, total, hits: [], startedAt: at, at, open: 0, timeoutMs, concurrency: lanes }
  const state = scan
  let next = 0
  const probe = async i => {
    const port = ports[i % ports.length]
    const ip = ipText(lo + Math.floor(i / ports.length))
    if (!(await tcpOpen(run, ip, port, timeoutMs)) || run.abort.signal.aborted) return
    state.open++
    const base = `${https || port === 443 ? 'https' : 'http'}://${ip}:${port}`
    {
      const c = await cardAt(run, base, cardMs)
      if (!c || run.abort.signal.aborted) return
      const sid = c.a2aMod?.kind === 'claude-session' && typeof c.a2aMod.id === 'string' ? c.a2aMod.id : undefined
      // This session, at any of its addresses, is not a find; another one is found once.
      if (sid === self.id || (sid && run.sessions.has(sid))) return
      if (sid) run.sessions.add(sid)
      if (state.hits.length < MAX_HITS) state.hits.push({ url: base, cardUrl: `${base}/.well-known/agent-card.json`, card: c })
    }
  }
  const lane = async () => {
    while (!run.abort.signal.aborted && next < total) {
      const i = next++
      await probe(i)
      if (run.abort.signal.aborted) return
      state.done++
      state.at = now()
    }
  }
  void Promise.all(Array.from({ length: lanes }, lane)).then(() => {
    if (state.phase === 'running') { state.phase = 'done'; state.at = now() }
    if (scanRun === run) scanRun = undefined
  })
  return { ok: true, total, timeoutMs, concurrency: lanes }
}

function scanStop() {
  if (scan.phase !== 'running') return { ok: false, phase: scan.phase, done: scan.done, error: 'no scan is running' }
  scan.phase = 'stopped'
  scan.at = now()
  const run = scanRun
  if (run) {
    run.abort.abort()
    for (const s of run.sockets) s.destroy()
    run.sockets.clear()
  }
  return { ok: true, phase: 'stopped', done: scan.done }
}

const scanProgress = () => ({ phase: scan.phase, done: scan.done, total: scan.total, open: scan.open ?? 0, hits: scan.hits, startedAt: scan.startedAt, at: scan.at, elapsedMs: (scan.phase === 'running' ? now() : scan.at) - scan.startedAt })

// ---------- http: the mod's requests, for a host Claude Code itself may not reach ----------

// On macOS, Local Network privacy can keep the Claude Code process off the LAN while this node
// process reaches it; the mod sends such a request here. Text in, text out, as $.http.fetch.
const HTTP_MAX = 16 * MiB
const HTTP_TIMEOUT_MS = 30_000

async function httpRequest({ url, method = 'GET', headers = {}, body, timeoutMs } = {}) {
  let u
  try { u = new URL(String(url)) } catch { return { error: `not a URL: ${String(url).slice(0, 200)}` } }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { error: `only http and https URLs are fetched, not ${u.protocol}` }
  const ms = Number(timeoutMs) > 0 ? Math.min(Number(timeoutMs), 120_000) : HTTP_TIMEOUT_MS
  const abort = new AbortController()
  const tooBig = { error: `the response is over ${HTTP_MAX / MiB} MiB` }
  let why
  const stop = reason => { why = reason; abort.abort() }
  const timer = setTimeout(() => stop({ error: `${u.origin} did not answer within ${ms} ms` }), ms)
  try {
    const res = await fetch(u, { method: String(method), headers, body: body === undefined ? undefined : String(body), signal: abort.signal, redirect: 'follow' })
    if (Number(res.headers.get('content-length')) > HTTP_MAX) { stop(tooBig); return tooBig }
    const chunks = []
    let n = 0
    for await (const c of res.body ?? []) {
      n += c.length
      if (n > HTTP_MAX) { stop(tooBig); return tooBig }
      chunks.push(c)
    }
    return { status: res.status, headers: Object.fromEntries(res.headers), text: Buffer.concat(chunks).toString('utf8') }
  } catch (e) {
    if (why) return why
    const c = e?.cause
    return { error: c?.code ? `${c.code}: ${c.message ?? ''}`.trim() : String(e?.message ?? e) }
  } finally {
    clearTimeout(timer)
  }
}

// ---------- MCP ----------

const obj = { type: 'object' }
const TOOLS = [
  { name: 'status', description: 'a2a-mod plumbing: this session\'s A2A endpoint and its open tasks.', inputSchema: { ...obj, properties: {} } },
  { name: 'inbox', description: 'a2a-mod plumbing: drain the A2A messages that arrived.', inputSchema: { ...obj, properties: {} } },
  {
    name: 'reply', description: 'a2a-mod plumbing: answer an A2A task.',
    inputSchema: { ...obj, properties: { taskId: { type: 'string' }, text: { type: 'string' }, files: { type: 'array', items: { type: 'string' } }, cwd: { type: 'string' }, ask: { type: 'boolean' } }, required: ['taskId'] },
  },
  {
    name: 'scan_start', description: 'a2a-mod plumbing: start a network scan.',
    inputSchema: { ...obj, properties: { first: { type: 'string' }, last: { type: 'string' }, ports: { type: 'array', items: { type: 'integer' } }, https: { type: 'boolean' }, timeoutMs: { type: 'integer' }, cardTimeoutMs: { type: 'integer' }, concurrency: { type: 'integer' } }, required: ['first', 'ports'] },
  },
  { name: 'scan_progress', description: 'a2a-mod plumbing: where the scan is.', inputSchema: { ...obj, properties: {} } },
  { name: 'scan_stop', description: 'a2a-mod plumbing: stop the scan.', inputSchema: { ...obj, properties: {} } },
  {
    name: 'http', description: 'a2a-mod plumbing: one HTTP request for the mod.',
    inputSchema: { ...obj, properties: { url: { type: 'string' }, method: { type: 'string' }, headers: { type: 'object', additionalProperties: { type: 'string' } }, body: { type: 'string' }, timeoutMs: { type: 'integer' } }, required: ['url'] },
  },
]

function status() {
  sweep()
  const open = [...tasks.values()].filter(t => isOpen(t.state))
  const list = urls()
  return {
    on: self.on, ...(self.problem ? { problem: self.problem } : {}), version: VERSION, id: self.id, name: self.name, port: self.port,
    auth: self.token ? 'token' : 'open', url: list[0] ?? '', urls: list,
    open: open.length, total: tasks.size,
    tasks: open.slice(-20).map(t => ({ id: t.id, from: t.from, state: t.state, createdAt: t.createdAt })),
  }
}

function inbox() {
  sweep()
  const out = []
  for (const m of queue.splice(0)) {
    const t = tasks.get(m.taskId)
    if (!t || !isOpen(t.state)) continue
    if (t.state === 'submitted') setState(t, 'working')
    out.push(m)
  }
  return { messages: out }
}

async function callTool(name, args) {
  switch (name) {
    case 'status': return status()
    case 'inbox': return inbox()
    case 'reply': return reply(args ?? {})
    case 'scan_start': return scanStart(args)
    case 'scan_progress': return scanProgress()
    case 'scan_stop': return scanStop()
    case 'http': return httpRequest(args ?? {})
    default: return { error: `unknown tool ${String(name).slice(0, 60)}` }
  }
}

const write = msg => process.stdout.write(JSON.stringify(msg) + '\n')

async function onLine(line) {
  if (!line.trim()) return
  let msg
  try { msg = JSON.parse(line) } catch { return write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) }
  const { id, method, params } = msg
  if (id === undefined || id === null) return
  const ok = result => write({ jsonrpc: '2.0', id, result })
  try {
    if (method === 'initialize') return ok({ protocolVersion: params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'a2a-mod-sidecar', version: VERSION } })
    if (method === 'ping') return ok({})
    if (method === 'tools/list') return ok({ tools: TOOLS })
    if (method === 'tools/call') {
      const out = await callTool(params?.name, params?.arguments ?? {})
      return ok({ content: [{ type: 'text', text: JSON.stringify(out) }], structuredContent: out, isError: typeof out?.error === 'string' || out?.ok === false })
    }
    write({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } })
  } catch (e) {
    write({ jsonrpc: '2.0', id, error: { code: -32603, message: String(e?.message ?? e) } })
  }
}

// The options arrive as env, set once per process: a new token or name takes a new session.
// Only an explicit false turns the server off (an unset option may arrive empty).
const isOff = v => /^(false|0|off|no)$/i.test(String(v ?? '').trim())

async function configure() {
  self.name = cleanName(process.env.A2A_MOD_SERVER_NAME) || cleanName(`${os.hostname()}/${path.basename(process.cwd())}`) || 'claude-session'
  if (isOff(process.env.A2A_MOD_SERVER)) { self.problem = 'the server setting is off, so this session has no A2A endpoint'; return }
  self.token = String(process.env.A2A_MOD_SERVER_TOKEN ?? '')
  await startHttp()
  self.on = true
  setInterval(sweep, Math.max(100, Math.min(60_000, TASK_TTL_MS / 3))).unref()
}

const ready = configure().catch(e => { self.on = false; self.token = ''; self.problem = `the A2A server could not start: ${e.message}`; log(self.problem) })
readline.createInterface({ input: process.stdin }).on('line', l => { void ready.then(() => onLine(l)) }).on('close', () => process.exit(0))
process.on('SIGTERM', () => process.exit(0))
process.on('SIGINT', () => process.exit(0))
