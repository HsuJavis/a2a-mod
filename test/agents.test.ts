import { test, expect, mock, type Engine } from 'claude-code/testing'
import { fixtures as f } from './fixtures.ts'
import { fakeNet, STORE, WITH_TOKEN, type On } from './kit.ts'

const NATIVE = 'Sessions on this machine:\n  main'
const WORKERS = 'A2A workers (a2a-mod; SendMessage with to: "a2a:<alias>"):\n  a2a:fake  Fake Worker. test double'

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
