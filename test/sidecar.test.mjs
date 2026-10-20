// The LAN sidecar over real MCP stdio, HTTP and multicast on this host. The mod's side of it is in
// lan.test.ts, under claude plugin test; this is what that kit cannot reach: sockets and processes.
// Run: node --test test/sidecar.test.mjs
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import { parseCard } from '../hooks/wire.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SIDECAR = path.join(ROOT, 'sidecar', 'lan-a2a.mjs')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lan-a2a-test-'))
const SECRET = `test-${crypto.randomBytes(8).toString('hex')}`
const OTHER = `other-${crypto.randomBytes(8).toString('hex')}`

function start(label, env = {}) {
  const inbox = path.join(TMP, label, 'inbox')
  const cwd = path.join(TMP, label)
  fs.mkdirSync(cwd, { recursive: true })
  const child = spawn(process.execPath, [SIDECAR], {
    cwd,
    env: { ...process.env, LAN_A2A_SECRET: '', LAN_A2A_NAME: '', LAN_A2A_INBOX: inbox, LAN_A2A_PORT: '0', ...env },
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
  return { label, child, rpc, call, inbox }
}

async function until(fn, ms = 12000) {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error('timed out')
    await new Promise(r => setTimeout(r, 200))
  }
}

const procs = []
after(() => { for (const p of procs) p.child.kill('SIGTERM'); fs.rmSync(TMP, { recursive: true, force: true }) })

test('two sidecars with one secret find each other, a third with another secret stays invisible', async t => {
  // The manifest's env names win over the shell's, as plugin.json sets them from the options.
  const a = start('a', { A2A_MOD_LAN_SECRET: SECRET, A2A_MOD_LAN_NAME: 'host-a/proj', LAN_A2A_SECRET: OTHER })
  const b = start('b', { LAN_A2A_SECRET: SECRET, LAN_A2A_NAME: 'host-b/proj' })
  const c = start('c', { A2A_MOD_LAN_SECRET: OTHER, A2A_MOD_LAN_NAME: 'host-c/proj' })
  procs.push(a, b, c)

  const init = await a.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } })
  assert.equal(init.result.serverInfo.name, 'lan-a2a')
  a.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
  assert.deepEqual((await a.rpc('ping')).result, {})
  const names = (await a.rpc('tools/list')).result.tools.map(x => x.name).sort()
  assert.deepEqual(names, ['inbox', 'peers', 'send', 'status'])

  const sa = await a.call('status')
  const sb = await b.call('status')
  assert.equal(sa.configured, true)
  assert.equal(sa.address, 'lan:host-a/proj')
  assert.equal(sb.address, 'lan:host-b/proj')
  assert.ok(sa.port > 0 && sb.port > 0)

  const peersOf = async p => (await p.call('peers')).peers
  await until(async () => (await peersOf(a)).some(p => p.name === 'host-b/proj') && (await peersOf(b)).some(p => p.name === 'host-a/proj'))
  // Give the third one a few announce periods to (not) show up.
  await new Promise(r => setTimeout(r, 4500))
  for (const p of [a, b]) assert.deepEqual((await peersOf(p)).map(x => x.name), [p === a ? 'host-b/proj' : 'host-a/proj'])
  assert.deepEqual(await peersOf(c), [])
  assert.equal((await a.call('status')).peers, 1)

  await t.test('a message with a file goes A to B and lands downloaded with a matching sha256', async () => {
    const file = path.join(TMP, 'payload.bin')
    const bytes = crypto.randomBytes(300 * 1024)
    fs.writeFileSync(file, bytes)
    const want = crypto.createHash('sha256').update(bytes).digest('hex')
    // A relative path resolves against the session's cwd the mod passes, not the sidecar's.
    const sent = await a.call('send', { to: 'lan:host-b/proj', text: 'hello from a', files: ['payload.bin', 'missing.txt'], cwd: TMP })
    assert.equal(sent.ok, true, JSON.stringify(sent))
    assert.equal(sent.to, 'lan:host-b/proj')
    assert.equal(sent.files[0].path, file)
    assert.equal(sent.files[0].sha256, want)
    assert.equal(sent.files[0].size, bytes.length)
    assert.match(sent.files[1].error, /ENOENT/)

    const got = await until(async () => { const m = (await b.call('inbox')).messages; return m.length ? m : undefined })
    assert.equal(got.length, 1)
    const [msg] = got
    assert.equal(msg.from, 'lan:host-a/proj')
    assert.equal(msg.text, 'hello from a')
    assert.equal(msg.files.length, 1)
    assert.equal(msg.files[0].sha256, want)
    assert.ok(msg.files[0].path.startsWith(b.inbox), msg.files[0].path)
    assert.match(path.basename(msg.files[0].path), /_payload\.bin$/)
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(msg.files[0].path)).digest('hex'), want)
    assert.deepEqual((await b.call('inbox')).messages, [], 'inbox drains')
  })

  await t.test('unknown recipient and the other group cannot be addressed', async () => {
    const r = await a.call('send', { to: 'lan:host-c/proj', text: 'x' })
    assert.equal(r.ok, false)
    assert.equal(r.isError, true)
    assert.match(r.error, /no LAN agent/)
  })

  await t.test('HTTP: card is public and parses as a2a-mod does; everything else needs the bearer', async () => {
    const base = `http://127.0.0.1:${sb.port}`
    const cardRes = await fetch(`${base}/.well-known/agent-card.json`)
    assert.equal(cardRes.status, 200)
    const cardJson = await cardRes.json()
    // a2a-mod's own reader, so /a2a add <this card> works from a non-lan client.
    const info = parseCard(cardJson, `${base}/.well-known/agent-card.json`)
    assert.equal(info.name, 'host-b/proj')
    assert.equal(info.version, '1.0')
    assert.equal(info.endpoint, `${base}/a2a`)
    assert.equal(info.needsAuth, true)

    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'SendMessage', params: { message: { messageId: 'm', role: 'ROLE_USER', parts: [{ text: 'sneaky' }] } } })
    const noAuth = await fetch(`${base}/a2a`, { method: 'POST', body, headers: { 'content-type': 'application/json' } })
    assert.equal(noAuth.status, 401)
    const wrong = await fetch(`${base}/a2a`, { method: 'POST', body, headers: { 'content-type': 'application/json', authorization: `Bearer ${OTHER}` } })
    assert.equal(wrong.status, 401)
    assert.equal((await fetch(`${base}/files/whatever`)).status, 401)

    // A non-lan A2A client (a2a-mod style, 0.3) with the secret is shown as a2a:<ip>.
    const ok03 = await fetch(`${base}/a2a`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${SECRET}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'message/send', params: { message: { kind: 'message', messageId: 'm2', role: 'user', parts: [{ kind: 'text', text: 'from a2a client' }] } } }),
    })
    const j03 = await ok03.json()
    assert.equal(j03.result.kind, 'message')
    assert.equal(j03.result.parts[0].text, 'delivered')
    const ok10 = await fetch(`${base}/a2a`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${SECRET}` }, body,
    })
    assert.equal((await ok10.json()).result.message.parts[0].text, 'delivered')
    const task = await fetch(`${base}/a2a`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${SECRET}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'GetTask', params: { id: 't' } }),
    })
    assert.equal((await task.json()).error.code, -32001)
    const msgs = await until(async () => { const m = (await b.call('inbox')).messages; return m.length >= 2 ? m : undefined })
    assert.deepEqual(msgs.map(m => [m.from, m.text]), [['a2a:127.0.0.1', 'from a2a client'], ['a2a:127.0.0.1', 'sneaky']])
  })

  await t.test('a file URL pointing at another host is refused without sending the bearer', async () => {
    const base = `http://127.0.0.1:${sb.port}`
    await fetch(`${base}/a2a`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${SECRET}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'SendMessage', params: { message: { messageId: 'm3', role: 'ROLE_USER', parts: [{ text: 'f' }, { url: 'http://192.0.2.1/files/x', filename: '../../etc/passwd' }] } } }),
    })
    const [m] = await until(async () => { const x = (await b.call('inbox')).messages; return x.length ? x : undefined })
    assert.match(m.files[0].error, /refused/)
    assert.equal(m.files[0].name, 'passwd')
  })

  await t.test('bye on exit removes the peer at once', async () => {
    c.child.stdin.end()
    a.child.kill('SIGTERM')
    await until(async () => (await peersOf(b)).length === 0, 3000)
  })
})

test('with no secret LAN mode stays off; a short one says why', async () => {
  const off = start('off'), short = start('short', { A2A_MOD_LAN_SECRET: 'short' })
  procs.push(off, short)
  const s = await off.call('status')
  assert.equal(s.configured, false)
  assert.equal(s.port, 0, 'no socket is opened')
  assert.equal(s.problem, undefined)
  assert.match((await short.call('status')).problem, /at least 8/)
  const r = await off.call('send', { to: 'lan:x', text: 'hi' })
  assert.equal(r.isError, true)
  assert.match(r.error, /not configured/)
})

test('the default name is <hostname>/<cwd folder>', async () => {
  const d = start('named-by-cwd', { A2A_MOD_LAN_SECRET: OTHER })
  procs.push(d)
  assert.equal((await d.call('status')).name, `${os.hostname()}/named-by-cwd`)
})
