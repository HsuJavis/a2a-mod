import { test, expect, mock } from 'claude-code/testing'
import type { HttpInit } from 'claude-code'
import { LAN_HINT } from '../hooks/lan.ts'
import { fakeSidecar, runA2a, sessionCard, workerAnswer, type On } from './kit.ts'

// macOS Local Network privacy: Claude Code's own fetch may not reach the LAN while the node sidecar
// may. Each test uses its own host: which hosts go through the sidecar is module state.

/** $.http.fetch fails as macOS fails it: the rejection's text names the code (a deny is how a kit hook rejects). */
function blockedNet(on: On, code: string) {
  const calls: { url: string; init?: HttpInit }[] = []
  on('http.fetch', async (_$, e) => {
    calls.push({ url: e.url, init: e.init })
    return { deny: `connect ${code} ${new URL(e.url).host}` }
  })
  return calls
}

/** The sidecar's http tool reaches a Claude Code session at `base`. */
const sessionAt = (base: string) => (a: Record<string, any>) => {
  const { status, headers, text } = workerAnswer({ card: sessionCard('mac/proj', base) }, String(a.url), a.body)
  return { status, headers, text }
}

test('a host Claude Code may not reach (EHOSTUNREACH) is fetched through the sidecar, and /a2a add works', async ($, on) => {
  mock.store(on)
  const direct = blockedNet(on, 'EHOSTUNREACH')
  const sc = fakeSidecar(on, { http: sessionAt('http://192.168.0.125:41400') })
  const out = await runA2a($, 'add http://192.168.0.125:41400 mac')
  expect(out.text).toContain('Added Claude Code session')
  expect(direct.length).toBe(1)
  const http = sc.calls.filter(c => c.tool === 'http')
  expect(http.length).toBe(1)
  expect(http[0]!.args).toMatchObject({ url: 'http://192.168.0.125:41400/.well-known/agent-card.json', method: 'GET' })
})

test('once a host went through the sidecar, later calls to it skip the direct attempt', async ($, on) => {
  mock.store(on)
  const direct = blockedNet(on, 'EHOSTUNREACH')
  const sc = fakeSidecar(on, { http: sessionAt('http://192.168.0.126:41400') })
  await runA2a($, 'add http://192.168.0.126:41400 mac')
  const out = await $.tool.call({ tool: 'mcp__a2a-mod__send', worker: 'mac', message: 'hi' })
  expect(String(out.result)).not.toContain('could not reach')
  expect(direct.length).toBe(1)
  const http = sc.calls.filter(c => c.tool === 'http')
  expect(http.length).toBeGreaterThanOrEqual(2)
  expect(http[1]!.args).toMatchObject({ url: 'http://192.168.0.126:41400/a2a', method: 'POST' })
  expect(JSON.parse(String(http[1]!.args.body)).method).toBe('SendMessage')
})

test('a refused connection is an answer: it is not tried through the sidecar', async ($, on) => {
  mock.store(on)
  const direct = blockedNet(on, 'ECONNREFUSED')
  const sc = fakeSidecar(on)
  const out = await runA2a($, 'add http://192.168.0.127:41400 mac')
  expect(out.text).toContain('ECONNREFUSED')
  expect(out.text).not.toContain(LAN_HINT)
  expect(direct.length).toBe(1)
  expect(sc.tools()).not.toContain('http')
})

test('with the sidecar down, the original error is shown with the macOS Local Network hint', async ($, on) => {
  mock.store(on)
  blockedNet(on, 'EHOSTUNREACH')
  fakeSidecar(on, { down: 'spawn node ENOENT' })
  const out = await runA2a($, 'add http://192.168.0.128:41400 mac')
  expect(out.text).toContain('EHOSTUNREACH')
  expect(out.text).toContain('not running')
  expect(out.text).toContain(LAN_HINT)
})

test('when the sidecar cannot reach the host either, both errors and the hint are shown', async ($, on) => {
  mock.store(on)
  blockedNet(on, 'ENETUNREACH')
  fakeSidecar(on, { http: () => ({ error: 'connect ENETUNREACH 192.168.0.129:41400' }) })
  const out = await runA2a($, 'add http://192.168.0.129:41400 mac')
  expect(out.text).toContain('through the a2a-mod sidecar too')
  expect(out.text).toContain(LAN_HINT)
})

test('a worker that answers directly never touches the sidecar', async ($, on) => {
  mock.store(on)
  on('http.fetch', async (_$, e) => ({ value: workerAnswer({}, e.url, e.init?.body) }))
  const sc = fakeSidecar(on)
  expect((await runA2a($, 'add http://worker.test fake')).text).toContain('Added worker')
  expect(sc.tools()).not.toContain('http')
})
