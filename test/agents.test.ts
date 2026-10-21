import { test, expect, mock, type Engine } from 'claude-code/testing'
import { fixtures as f } from './fixtures.ts'
import { fakeNet, startSession, STORE, WITH_TOKEN, type On } from './kit.ts'

const NATIVE = 'Sessions on this machine:\n  main'
const WORKERS = 'A2A workers (a2a-mod; SendMessage or SendFile with to: "a2a:<alias>"):\n  a2a:fake  Fake Worker. test double'

const listAgents = async ($: Engine) =>
  String(((await $.tool.call({ tool: 'ListAgents' })).result as { listing: string }).listing)

test('ListAgents keeps the native listing and adds the registered workers', async ($, on) => {
  mock.store(on, STORE)
  on('tool.call', { tool: 'ListAgents' }, async () => ({ result: { listing: NATIVE } }))
  expect(await listAgents($)).toBe(`${NATIVE}\n\n${WORKERS}`)
})

test('with no workers ListAgents is the engine’s own', async ($, on) => {
  mock.store(on)
  on('tool.call', { tool: 'ListAgents' }, async () => ({ result: { listing: NATIVE } }))
  expect(await listAgents($)).toBe(NATIVE)
})

test('SendMessage to a2a:<alias> is the worker send, task tracking and all', WITH_TOKEN, async ($, on) => {
  mock.store(on, STORE)
  const clock = mock.clock(on)
  const net = fakeNet(on, { send: f.v1_send_slow, get: f.v1_get_completed })
  const p = $.tool.call({ tool: 'SendMessage', to: 'a2a:fake', message: 'hi' })
  await clock.advance(7500)
  const out = await p
  const { success, message } = out.result as { success: boolean; message: string }
  expect(success).toBe(true)
  expect(message).toContain('completed')
  expect(message).toContain('echo: hi')
  const sent = net.calls.find(c => JSON.parse(c.init?.body ?? '{}').method === 'SendMessage')
  expect(sent?.init?.headers?.Authorization).toBe('Bearer s3cret')
})

test('SendMessage to a2a: with an unknown alias lists the known ones', async ($, on) => {
  mock.store(on, STORE)
  expect((await $.tool.call({ tool: 'SendMessage', to: 'a2a:nope', message: 'hi' })).result).toEqual({ success: false, message: expect.stringContaining('Known workers: fake') })
})

test('SendMessage to anyone else is left to the engine', async ($, on) => {
  mock.store(on, STORE)
  const net = fakeNet(on)
  on('tool.call', { tool: 'SendMessage' }, async (_$, e) => ({ result: `engine sent to ${String(e.to)}` }))
  expect((await $.tool.call({ tool: 'SendMessage', to: 'main', message: 'hi' })).result).toBe('engine sent to main')
  expect(net.calls).toEqual([])
})

const NATIVE_CMD = 'Agents you can message:\n  main (this session)'
const listAgentsCmd = async ($: Engine, on: On, native: () => unknown = () => ({ text: NATIVE_CMD, context: ['note for the model'] })) => {
  on('command.run', { command: 'list-agents' }, async () => native() as never)
  return $.command.run({ command: 'list-agents', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
}

test('/list-agents keeps the built-in’s output and adds the registered workers, in ListAgents’ words', async ($, on) => {
  mock.store(on, STORE)
  const out = await listAgentsCmd($, on)
  expect(out.text).toBe(`${NATIVE_CMD}\n\n${WORKERS}`)
  // The person typed it: the worker lines are for them, the model's notes are the built-in's own.
  expect(out.context).toEqual(['note for the model'])
})

test('/list-agents with no workers is the built-in’s own', async ($, on) => {
  mock.store(on)
  const out = await listAgentsCmd($, on)
  expect(out.text).toBe(NATIVE_CMD)
  expect(out.context).toEqual(['note for the model'])
})

test('/list-agents keeps the built-in’s output when the workers cannot be read', async ($, on) => {
  on('store.get', async () => { throw new Error('boom') })
  expect((await listAgentsCmd($, on)).text).toBe(NATIVE_CMD)
})

test('/list-agents that printed nothing is left alone', async ($, on) => {
  mock.store(on, STORE)
  const out = await listAgentsCmd($, on, () => ({ context: ['x'] }))
  expect(out.text).toBeUndefined()
})

// ---------- SendFile to a2a:<alias>: the files go inline, as bytes in file parts ----------

const MiB = 1024 * 1024
const ABC_SHA = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
const STORE_03 = { workers: { fake: { ...STORE.workers.fake, version: '0.3' } } }

/**
 * Answers $.fs.stat and $.fs.read from `files` (path: text); `sizes` overrides what stat says. The
 * engine hands a hook the path resolved against the session's folder, so a relative key matches its tail.
 * A path not there answers nothing, so the call rejects as a missing file does.
 */
function fakeFs(on: On, files: Record<string, string>, sizes: Record<string, number> = {}) {
  const reads: string[] = []
  const keyOf = (path: string) => Object.keys(files).find(k => path === k || path.endsWith(`/${k}`))
  on('fs.stat', async (_$, e, next) => {
    const k = keyOf(e.path)
    if (k === undefined) return next(e)
    return { value: { kind: 'file', size: sizes[k] ?? files[k]!.length, mtimeMs: 0, isLink: false } }
  })
  on('fs.read', async (_$, e, next) => {
    const k = keyOf(e.path)
    if (k === undefined) return next(e)
    reads.push(k)
    return { value: e.as === 'bytes' ? { base64: btoa(files[k]!) } : files[k]! }
  })
  return reads
}

const sentParts = (net: ReturnType<typeof fakeNet>) =>
  net.calls.map(c => JSON.parse(c.init?.body ?? '{}')).filter(b => /send/i.test(b.method)).map(b => b.params.message.parts)

test('SendFile to a2a:<alias> sends the message and the files inline, 1.0 parts', WITH_TOKEN, async ($, on) => {
  mock.store(on, STORE)
  const net = fakeNet(on)
  fakeFs(on, { 'a.txt': 'abc' })
  const out = await $.tool.call({ tool: 'SendFile', to: 'a2a:fake', files: ['a.txt'], message: 'one file' })
  expect(sentParts(net)).toEqual([[{ text: 'one file' }, { raw: 'YWJj', filename: 'a.txt', mediaType: 'text/plain' }]])
  const r = out.result as { success: boolean; message: string; files: unknown[] }
  expect(r.success).toBe(true)
  expect(r.message).toContain('fake')
  expect(r.files).toEqual([{ path: 'a.txt', size: 3, sha256: ABC_SHA }])
})

test('SendFile to a 0.3 worker uses 0.3 file parts', WITH_TOKEN, async ($, on) => {
  mock.store(on, STORE_03)
  const net = fakeNet(on, { send: f.v03_send_echo })
  fakeFs(on, { '/w/pic.png': 'abc' })
  await $.tool.call({ tool: 'SendFile', to: 'a2a:fake', files: ['/w/pic.png'], message: 'look' })
  expect(sentParts(net)).toEqual([[{ kind: 'text', text: 'look' }, { kind: 'file', file: { bytes: 'YWJj', name: 'pic.png', mimeType: 'image/png' } }]])
})

test('SendFile with no message sends only the file parts', WITH_TOKEN, async ($, on) => {
  mock.store(on, STORE)
  const net = fakeNet(on)
  fakeFs(on, { 'data.bin': 'abc' })
  await $.tool.call({ tool: 'SendFile', to: 'a2a:fake', files: ['data.bin'] })
  expect(sentParts(net)).toEqual([[{ raw: 'YWJj', filename: 'data.bin', mediaType: 'application/octet-stream' }]])
})

test('a missing file is a per-file error and the rest are still sent', WITH_TOKEN, async ($, on) => {
  mock.store(on, STORE)
  const net = fakeNet(on)
  fakeFs(on, { 'a.txt': 'abc' })
  const out = await $.tool.call({ tool: 'SendFile', to: 'a2a:fake', files: ['a.txt', 'nope.txt'] })
  expect(sentParts(net)).toEqual([[{ raw: 'YWJj', filename: 'a.txt', mediaType: 'text/plain' }]])
  const r = out.result as { success: boolean; files: { path: string; error?: string }[] }
  expect(r.success).toBe(true)
  expect(r.files[0]).toEqual({ path: 'a.txt', size: 3, sha256: ABC_SHA })
  expect(r.files[1]).toEqual({ path: 'nope.txt', error: expect.stringContaining('could not read it') })
})

test('when no file can be read nothing is sent and SendFile fails', WITH_TOKEN, async ($, on) => {
  mock.store(on, STORE)
  const net = fakeNet(on)
  fakeFs(on, {})
  const out = await $.tool.call({ tool: 'SendFile', to: 'a2a:fake', files: ['nope.txt'] })
  expect(net.calls).toEqual([])
  expect(out.result).toEqual({ success: false, message: expect.stringContaining('no file'), files: [{ path: 'nope.txt', error: expect.stringContaining('could not read it') }] })
})

test('a file over 4 MiB, or past 10 MiB in all, is refused unread', WITH_TOKEN, async ($, on) => {
  mock.store(on, STORE)
  const net = fakeNet(on)
  const reads = fakeFs(on, { 'big.bin': 'abc', 'a.bin': 'abc', 'b.bin': 'abc', 'c.bin': 'abc' }, { 'big.bin': 5 * MiB, 'a.bin': 4 * MiB, 'b.bin': 4 * MiB, 'c.bin': 4 * MiB })
  const out = await $.tool.call({ tool: 'SendFile', to: 'a2a:fake', files: ['big.bin', 'a.bin', 'b.bin', 'c.bin'] })
  const r = out.result as { success: boolean; files: { path: string; error?: string }[] }
  expect(r.files[0]?.error).toContain('4 MiB')
  expect(r.files[1]?.error).toBeUndefined()
  expect(r.files[2]?.error).toBeUndefined()
  expect(r.files[3]?.error).toContain('10 MiB')
  expect(reads).toEqual(['a.bin', 'b.bin'])
  expect(sentParts(net)[0]?.length).toBe(2)
})

test('SendFile to an unknown a2a: alias fails with the known ones and reads nothing', async ($, on) => {
  mock.store(on, STORE)
  const reads = fakeFs(on, { 'a.txt': 'abc' })
  const out = await $.tool.call({ tool: 'SendFile', to: 'a2a:nope', files: ['a.txt'] })
  expect(out.result).toEqual({ success: false, message: expect.stringContaining('Known workers: fake'), files: [{ path: 'a.txt', error: 'not sent' }] })
  expect(reads).toEqual([])
})

test('SendFile to anyone else is left to the engine', async ($, on) => {
  mock.store(on, STORE)
  const net = fakeNet(on)
  on('tool.call', { tool: 'SendFile' }, async () => ({ result: { success: true, message: 'engine', files: [] } }))
  expect((await $.tool.call({ tool: 'SendFile', to: 'main', files: ['a'] })).result).toEqual({ success: true, message: 'engine', files: [] })
  expect(net.calls).toEqual([])
})

test('where the build has no SendFile, the mod offers send_file for a2a: workers', WITH_TOKEN, async ($, on) => {
  mock.store(on, STORE)
  on('tool.list', async () => ({ value: [] }))
  const net = fakeNet(on)
  fakeFs(on, { 'a.txt': 'abc' })
  expect(await startSession($, on)).toContain('send_file')
  const out = await $.tool.call({ tool: 'mcp__a2a-mod__send_file', to: 'a2a:fake', files: ['a.txt'] })
  expect(String(out.result)).toContain(`  a.txt (3 bytes, sha256 ${ABC_SHA})`)
  expect(sentParts(net)).toHaveLength(1)
})

test('send_file refuses an address that is not a2a:', async ($, on) => {
  mock.store(on, STORE)
  expect(String((await $.tool.call({ tool: 'mcp__a2a-mod__send_file', to: 'main', files: ['a.txt'] })).result)).toContain('a2a:<alias>')
})

test('where the build has SendFile, the mod registers no send_file of its own', async ($, on) => {
  mock.store(on)
  on('tool.list', async () => ({ value: [{ name: 'SendFile' }] as never }))
  expect(await startSession($, on)).not.toContain('send_file')
})
