// The a2a-mod sidecar over real MCP stdio and HTTP on this host: the A2A server every session
// exposes, its tasks, files, token mode and the network scan. The mod's side of it is in
// inbound.test.ts and scan-command.test.ts, under claude plugin test; this is what that kit cannot
// reach: sockets and processes.
// Run: timeout 180 node --test test/sidecar.test.mjs
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import { parseCard } from '../hooks/wire.ts'
import { cancelTask, discover, getTask, send } from '../hooks/client.ts'
import { startWorker } from './fake-worker.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SIDECAR = path.join(ROOT, 'sidecar', 'a2a-server.mjs')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-mod-sidecar-'))
// Away from 41400-41499, where a real session's sidecar may be listening.
const RANGE = '47400-47419'

const procs = []
const closers = []
after(async () => {
  for (const p of procs) p.child.kill('SIGTERM')
  for (const c of closers) await c()
  fs.rmSync(TMP, { recursive: true, force: true })
})

function start(label, env = {}) {
  const cwd = path.join(TMP, label)
  const inbox = path.join(cwd, 'inbox')
  fs.mkdirSync(cwd, { recursive: true })
  const child = spawn(process.execPath, [SIDECAR], {
    cwd,
    env: { ...process.env, A2A_MOD_SERVER: 'true', A2A_MOD_SERVER_TOKEN: '', A2A_MOD_SERVER_NAME: `host/${label}`, A2A_PORT: RANGE, A2A_MOD_INBOX: inbox, ...env },
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  const waiting = new Map()
  let next = 1
  readline.createInterface({ input: child.stdout }).on('line', line => {
    const msg = JSON.parse(line) // stdout must be JSON-RPC only
    waiting.get(msg.id)?.(msg)
    waiting.delete(msg.id)
  })
  const rpc = (method, params) => new Promise(resolve => {
    const id = next++
    waiting.set(id, resolve)
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
  const call = async (name, args = {}) => {
    const r = await rpc('tools/call', { name, arguments: args })
    assert.equal(r.result.content[0].type, 'text')
    assert.deepEqual(JSON.parse(r.result.content[0].text), r.result.structuredContent)
    return { ...r.result.structuredContent, isError: r.result.isError }
  }
  const p = { label, child, rpc, call, inbox, cwd }
  procs.push(p)
  return p
}

async function until(fn, ms = 10000) {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error('timed out')
    await new Promise(r => setTimeout(r, 50))
  }
}

const fetcher = async (url, init) => {
  const r = await fetch(url, init)
  return { status: r.status, ok: r.ok, text: await r.text() }
}

const sha = buf => crypto.createHash('sha256').update(buf).digest('hex')

/** A Target for client.ts, as the mod builds one from a registered worker. */
async function targetOf(url, version, token) {
  const { cardUrl, card } = await discover(fetcher, url)
  return { ...card, cardUrl, version: version ?? card.version, alias: 'peer', addedAt: 0, auth: { kind: 'setting' }, ...(token ? { token } : {}) }
}

async function rawRpc(url, method, params, headers = {}) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
  return { status: r.status, body: r.status === 200 ? await r.json() : await r.text() }
}

const inboxOf = async p => until(async () => { const m = (await p.call('inbox')).messages; return m.length ? m : undefined })

const a = start('a')
const b = start('b')
let sa
let sb

test('the MCP side: initialize, ping, the tool list and a status with the endpoint', async () => {
  const init = await a.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } })
  assert.equal(init.result.serverInfo.name, 'a2a-mod-sidecar')
  a.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
  assert.deepEqual((await a.rpc('ping')).result, {})
  const names = (await a.rpc('tools/list')).result.tools.map(x => x.name).sort()
  assert.deepEqual(names, ['inbox', 'reply', 'scan_progress', 'scan_start', 'scan_stop', 'status'])
  sa = await a.call('status')
  sb = await b.call('status')
  for (const s of [sa, sb]) {
    assert.equal(s.on, true, JSON.stringify(s))
    assert.equal(s.auth, 'open')
    assert.ok(s.port >= 47400 && s.port <= 47419, String(s.port))
    assert.match(s.url, /^http:\/\/[\d.]+:\d+$/)
    assert.ok(s.urls.includes(`http://127.0.0.1:${s.port}`))
    assert.equal(s.open, 0)
  }
  assert.notEqual(sa.port, sb.port)
  assert.equal(sb.name, 'host/b')
})

const urlOf = s => `http://127.0.0.1:${s.port}`

test('the card passes the mod’s parseCard and discover, and says it is a Claude Code session', async () => {
  const raw = await (await fetch(`${urlOf(sb)}/.well-known/agent-card.json`)).json()
  const card = parseCard(raw, `${urlOf(sb)}/.well-known/agent-card.json`)
  assert.equal(card.name, 'host/b')
  assert.equal(card.version, '1.0')
  assert.equal(card.endpoint, `${urlOf(sb)}/a2a`)
  assert.equal(card.needsAuth, false)
  assert.equal(card.kind, 'claude-session')
  assert.equal(raw.a2aMod.kind, 'claude-session')
  assert.equal(raw.a2aMod.name, 'host/b')
  assert.ok(raw.skills.some(s => s.id === 'claude-session'))
  assert.equal(raw.url, `${urlOf(sb)}/a2a`)
  assert.deepEqual(raw.supportedInterfaces.map(i => i.protocolVersion), ['1.0', '0.3'])
  const { card: found } = await discover(fetcher, urlOf(sb))
  assert.equal(found.kind, 'claude-session')
})

for (const version of ['1.0', '0.3']) {
  test(`A2A ${version}: a message makes a task; the session's reply completes it, GetTask returns it`, async () => {
    const t = await targetOf(urlOf(sb), version)
    const sent = await send(fetcher, t, { text: `hello over ${version}` })
    assert.equal(sent.kind, 'task')
    assert.equal(sent.state, 'submitted')
    assert.ok(sent.contextId)
    assert.equal((await getTask(fetcher, t, sent.taskId)).state, 'submitted')
    const [m] = await inboxOf(b)
    assert.equal(m.taskId, sent.taskId)
    assert.equal(m.contextId, sent.contextId)
    assert.equal(m.text, `hello over ${version}`)
    assert.equal(m.from, '127.0.0.1')
    assert.equal(m.authenticated, false)
    assert.equal(m.followUp, false)
    // Delivered to the session: Claude has it now.
    assert.equal((await getTask(fetcher, t, sent.taskId)).state, 'working')
    assert.equal((await b.call('status')).open, 1)
    const r = await b.call('reply', { taskId: sent.taskId, text: `hi back over ${version}` })
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(r.state, 'completed')
    const done = await getTask(fetcher, t, sent.taskId)
    assert.equal(done.state, 'completed')
    assert.equal(done.text, `hi back over ${version}`)
    assert.equal((await b.call('status')).open, 0)
    // A second reply has no open task to land on.
    const again = await b.call('reply', { taskId: sent.taskId, text: 'twice' })
    assert.equal(again.ok, false)
    assert.match(again.error, /completed/)
  })
}

test('a reply that asks a question is input-required; the follow-up on the same task reaches the session', async () => {
  const t = await targetOf(urlOf(sb))
  const sent = await send(fetcher, t, { text: 'book a room' })
  await inboxOf(b)
  assert.equal((await b.call('reply', { taskId: sent.taskId, text: 'Which day?', ask: true })).state, 'input-required')
  const asked = await getTask(fetcher, t, sent.taskId)
  assert.equal(asked.state, 'input-required')
  assert.equal(asked.text, 'Which day?')
  const more = await send(fetcher, t, { text: 'Tuesday', taskId: sent.taskId, contextId: sent.contextId })
  assert.equal(more.kind === 'task' && more.taskId, sent.taskId)
  const [m] = await inboxOf(b)
  assert.equal(m.taskId, sent.taskId)
  assert.equal(m.followUp, true)
  assert.equal(m.text, 'Tuesday')
  await b.call('reply', { taskId: sent.taskId, text: 'Booked for Tuesday.' })
  assert.equal((await getTask(fetcher, t, sent.taskId)).state, 'completed')
  // A follow-up on a finished task is refused.
  const late = await rawRpc(`${urlOf(sb)}/a2a`, 'SendMessage', { message: { messageId: 'm', role: 'ROLE_USER', taskId: sent.taskId, parts: [{ text: 'again' }] } })
  assert.equal(late.body.error.code, -32004)
})

test('CancelTask cancels an open task; the session’s reply then fails, a second cancel is refused', async () => {
  const t = await targetOf(urlOf(sb))
  const sent = await send(fetcher, t, { text: 'long job' })
  await inboxOf(b)
  assert.equal((await cancelTask(fetcher, t, sent.taskId)).state, 'canceled')
  const r = await b.call('reply', { taskId: sent.taskId, text: 'done' })
  assert.equal(r.ok, false)
  assert.match(r.error, /canceled/)
  const again = await rawRpc(`${urlOf(sb)}/a2a`, 'CancelTask', { id: sent.taskId })
  assert.equal(again.body.error.code, -32002)
  const missing = await rawRpc(`${urlOf(sb)}/a2a`, 'GetTask', { id: 'no-such-task' })
  assert.equal(missing.body.error.code, -32001)
})

test('file parts: inline bytes and a URL on the sender’s host land in the inbox with matching sha256; another host is refused', async () => {
  const inline = crypto.randomBytes(200 * 1024)
  const t = await targetOf(urlOf(sb))
  const sent = await send(fetcher, t, { text: 'two files', files: [{ name: 'in line.bin', mediaType: 'application/octet-stream', base64: inline.toString('base64') }] })
  const [m] = await inboxOf(b)
  assert.equal(m.taskId, sent.taskId)
  assert.equal(m.files.length, 1)
  assert.equal(m.files[0].sha256, sha(inline))
  assert.equal(m.files[0].size, inline.length)
  assert.ok(m.files[0].path.startsWith(b.inbox), m.files[0].path)
  assert.equal(sha(fs.readFileSync(m.files[0].path)), sha(inline))
  assert.equal(fs.statSync(m.files[0].path).mode & 0o777, 0o600)

  const served = crypto.randomBytes(300 * 1024)
  const srv = http.createServer((req, res) => { res.writeHead(200, { 'content-length': served.length }); res.end(served) })
  await new Promise(r => srv.listen(0, '127.0.0.1', r))
  closers.push(() => new Promise(r => srv.close(r)))
  const port = srv.address().port
  const parts = [
    { text: 'by url' },
    { url: `http://127.0.0.1:${port}/payload.bin`, filename: 'payload.bin', mediaType: 'application/octet-stream' },
    { url: `http://127.0.0.2:${port}/payload.bin`, filename: 'elsewhere.bin', mediaType: 'application/octet-stream' },
  ]
  const r = await rawRpc(`${urlOf(sb)}/a2a`, 'SendMessage', { message: { messageId: 'u1', role: 'ROLE_USER', parts } })
  assert.equal(r.body.result.task.status.state, 'TASK_STATE_SUBMITTED')
  const [u] = await inboxOf(b)
  assert.equal(u.text, 'by url')
  assert.equal(u.files[0].sha256, sha(served))
  assert.equal(sha(fs.readFileSync(u.files[0].path)), sha(served))
  assert.match(u.files[1].error, /not the sender/)
  assert.equal(u.files[1].path, undefined)
  // 0.3 file parts too.
  const p03 = [{ kind: 'file', file: { bytes: Buffer.from('abc').toString('base64'), name: 'a.txt', mimeType: 'text/plain' } }]
  await rawRpc(`${urlOf(sb)}/a2a`, 'message/send', { message: { kind: 'message', messageId: 'u2', role: 'user', parts: p03 } })
  const [o] = await inboxOf(b)
  assert.equal(o.files[0].sha256, sha(Buffer.from('abc')))
})

test('a reply with files completes the task with file parts the asker can fetch, sha256 intact', async () => {
  const t = await targetOf(urlOf(sb))
  const sent = await send(fetcher, t, { text: 'send me the report' })
  await inboxOf(b)
  const bytes = crypto.randomBytes(120 * 1024)
  fs.writeFileSync(path.join(b.cwd, 'report.bin'), bytes)
  const r = await b.call('reply', { taskId: sent.taskId, text: 'here it is', files: ['report.bin', 'missing.txt'], cwd: b.cwd })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(r.files[0].sha256, sha(bytes))
  assert.match(r.files[1].error, /ENOENT|no such/i)
  const raw = await rawRpc(`${urlOf(sb)}/a2a`, 'GetTask', { id: sent.taskId })
  const part = raw.body.result.artifacts[0].parts.find(p => p.url)
  assert.equal(part.filename, 'report.bin')
  const got = Buffer.from(await (await fetch(part.url)).arrayBuffer())
  assert.equal(sha(got), sha(bytes))
  assert.match((await getTask(fetcher, t, sent.taskId)).text, /here it is/)
})

test('token mode: the card is public and declares bearer; a send without the bearer, or a wrong one, is 401', async () => {
  const c = start('c', { A2A_MOD_SERVER_TOKEN: 'tok-123456' })
  const s = await c.call('status')
  assert.equal(s.auth, 'token')
  const raw = await (await fetch(`${urlOf(s)}/.well-known/agent-card.json`)).json()
  assert.equal(parseCard(raw, `${urlOf(s)}/.well-known/agent-card.json`).needsAuth, true)
  assert.ok(raw.securitySchemes.bearer)
  const body = { message: { messageId: 'x', role: 'ROLE_USER', parts: [{ text: 'hi' }] } }
  const none = await rawRpc(`${urlOf(s)}/a2a`, 'SendMessage', body)
  assert.equal(none.status, 401)
  const wrong = await rawRpc(`${urlOf(s)}/a2a`, 'SendMessage', body, { authorization: 'Bearer nope' })
  assert.equal(wrong.status, 401)
  const t = await targetOf(urlOf(s), undefined, 'tok-123456')
  const ok = await send(fetcher, t, { text: 'with the token' })
  assert.equal(ok.kind, 'task')
  const [m] = await inboxOf(c)
  assert.equal(m.authenticated, true)
  c.child.kill('SIGTERM')
})

test('server off by setting, or no free port in a pinned A2A_PORT: no socket, and status says why', async () => {
  const off = start('off', { A2A_MOD_SERVER: 'false' })
  const s = await off.call('status')
  assert.equal(s.on, false)
  assert.match(s.problem, /server setting is off/)
  const taken = start('taken', { A2A_PORT: String(sb.port) })
  const t = await taken.call('status')
  assert.equal(t.on, false)
  assert.match(t.problem, new RegExp(`no free port in ${sb.port}`))
  // The scan works with the server off.
  assert.equal((await off.call('scan_start', { first: '127.0.0.1', last: '127.0.0.1', ports: [sb.port] })).ok, true)
  const done = await until(async () => { const p = await off.call('scan_progress'); return p.phase === 'done' ? p : undefined })
  assert.equal(done.hits.length, 1)
  off.child.kill('SIGTERM')
  taken.child.kill('SIGTERM')
})

test('an unanswered task fails when it expires, and an ended one is dropped later', async () => {
  const e = start('expire', { A2A_MOD_TASK_TTL_MS: '600' })
  const s = await e.call('status')
  const t = await targetOf(urlOf(s))
  const sent = await send(fetcher, t, { text: 'anyone?' })
  const failed = await until(async () => { const o = await getTask(fetcher, t, sent.taskId); return o.state === 'failed' ? o : undefined })
  assert.match(failed.text, /not answered/)
  await until(async () => { try { await getTask(fetcher, t, sent.taskId); return false } catch (err) { return /not found/i.test(err.message) } })
  e.child.kill('SIGTERM')
})

// ---------- the scan ----------

const progress = async (p, phase) => until(async () => { const s = await p.call('scan_progress'); return s.phase === phase ? s : undefined }, 60000)

/** A port nothing listens on: bound once to get a number, then closed. */
async function closedPort() {
  const s = net.createServer()
  await new Promise(r => s.listen(0, '127.0.0.1', r))
  const port = s.address().port
  await new Promise(r => s.close(r))
  return port
}

test('a scan over 127.0.0.1 finds the other session and a fake A2A worker, labels them, and leaves this session out', async () => {
  const w = await startWorker()
  closers.push(() => w.close())
  const wport = Number(new URL(w.url).port)
  const ports = [sb.port, wport, sa.port, await closedPort()]
  const started = await a.call('scan_start', { first: '127.0.0.1', last: '127.0.0.1', ports })
  assert.equal(started.ok, true)
  assert.equal(started.total, 4)
  const done = await progress(a, 'done')
  assert.equal(done.done, 4)
  const byUrl = Object.fromEntries(done.hits.map(h => [h.url, h]))
  assert.deepEqual(Object.keys(byUrl).sort(), [`http://127.0.0.1:${sb.port}`, `http://127.0.0.1:${wport}`].sort())
  const session = parseCard(byUrl[`http://127.0.0.1:${sb.port}`].card, byUrl[`http://127.0.0.1:${sb.port}`].cardUrl)
  const worker = parseCard(byUrl[`http://127.0.0.1:${wport}`].card, byUrl[`http://127.0.0.1:${wport}`].cardUrl)
  assert.equal(session.kind, 'claude-session')
  assert.equal(session.name, 'host/b')
  assert.equal(worker.kind, undefined)
  assert.equal(worker.name, 'Fake Worker')
})

test('one session reachable at many loopback addresses is one hit', async () => {
  await a.call('scan_start', { first: '127.0.0.1', last: '127.0.0.20', ports: [sb.port] })
  const done = await progress(a, 'done')
  assert.equal(done.hits.length, 1)
})

test('127/8 refused probes are fast: a /24 on 10 closed ports and on the default ports', async () => {
  const ports = []
  while (ports.length < 10) ports.push(await closedPort())
  const t0 = Date.now()
  await a.call('scan_start', { first: '127.0.1.1', last: '127.0.1.254', ports })
  const done = await progress(a, 'done')
  const ms = Date.now() - t0
  assert.equal(done.done, 2540)
  assert.ok(ms < 5000, `${ms} ms`)
  const defaults = [80, 443, 8000, 8080, 41241, ...Array.from({ length: 10 }, (_, i) => 41400 + i)]
  const t1 = Date.now()
  await a.call('scan_start', { first: '127.0.2.1', last: '127.0.2.254', ports: defaults })
  const d2 = await progress(a, 'done')
  const ms2 = Date.now() - t1
  console.log(`# measured: 127.0.1.0/24 x 10 closed ports = 2,540 probes in ${ms} ms; 127.0.2.0/24 x 15 default ports = ${d2.done} probes in ${ms2} ms`)
})

test('scan stop is immediate, even with every probe hanging on a silent card', async () => {
  // Accepts, reads and never answers: each card fetch would wait out its timeout.
  const held = new Set()
  const tarpit = net.createServer(s => { s.resume(); held.add(s); s.on('close', () => held.delete(s)) })
  await new Promise(r => tarpit.listen(0, '0.0.0.0', r))
  closers.push(() => new Promise(r => { for (const s of held) s.destroy(); tarpit.close(r) }))
  const port = tarpit.address().port
  await a.call('scan_start', { first: '127.0.3.1', last: '127.0.3.254', ports: [port], concurrency: 16, cardTimeoutMs: 30000 })
  await until(async () => held.size >= 8)
  const running = await a.call('scan_progress')
  assert.equal(running.phase, 'running')
  // Another scan is refused while one runs.
  assert.equal((await a.call('scan_start', { first: '127.0.0.1', last: '127.0.0.1', ports: [1] })).ok, false)
  const t0 = Date.now()
  const stopped = await a.call('scan_stop')
  assert.equal(stopped.phase, 'stopped')
  assert.ok(Date.now() - t0 < 300, `${Date.now() - t0} ms`)
  assert.equal((await a.call('scan_progress')).phase, 'stopped')
  await until(async () => held.size === 0, 2000)
  const after = (await a.call('scan_progress')).done
  await new Promise(r => setTimeout(r, 300))
  assert.equal((await a.call('scan_progress')).done, after)
})

// ---------- the official SDK as the A2A worker side ----------

test('the @a2a-js/sdk client sends to the session, polls the task and reads the reply (A2A worker to Claude session)', async () => {
  const { ClientFactory } = await import('@a2a-js/sdk/client')
  const { Role, TaskState } = await import('@a2a-js/sdk')
  const client = await new ClientFactory().createFromUrl(urlOf(sb))
  const text = value => ({ content: { $case: 'text', value }, metadata: undefined, filename: '', mediaType: 'text/plain' })
  const res = await client.sendMessage({
    tenant: '', metadata: undefined, configuration: undefined,
    message: { messageId: crypto.randomUUID(), role: Role.ROLE_USER, parts: [text('from the SDK')], contextId: '', taskId: '', extensions: [], metadata: undefined, referenceTaskIds: [] },
  })
  // SendMessageResult is Message | Task: a task has an id and a status.
  assert.ok(res.id && res.status, JSON.stringify(res))
  assert.equal(res.status.state, TaskState.TASK_STATE_SUBMITTED)
  const id = res.id
  const [m] = await inboxOf(b)
  assert.equal(m.text, 'from the SDK')
  assert.equal((await client.getTask({ tenant: '', id, historyLength: undefined })).status.state, TaskState.TASK_STATE_WORKING)
  await b.call('reply', { taskId: id, text: 'hello SDK' })
  const got = await client.getTask({ tenant: '', id, historyLength: undefined })
  assert.equal(got.status.state, TaskState.TASK_STATE_COMPLETED)
  const said = got.artifacts.flatMap(x => x.parts).map(p => (p.content?.$case === 'text' ? p.content.value : '')).join('')
  assert.equal(said, 'hello SDK')
  const canceled = await client.sendMessage({
    tenant: '', metadata: undefined, configuration: undefined,
    message: { messageId: crypto.randomUUID(), role: Role.ROLE_USER, parts: [text('cancel me')], contextId: '', taskId: '', extensions: [], metadata: undefined, referenceTaskIds: [] },
  })
  assert.equal((await client.cancelTask({ tenant: '', id: canceled.id, metadata: undefined })).status.state, TaskState.TASK_STATE_CANCELED)
})
