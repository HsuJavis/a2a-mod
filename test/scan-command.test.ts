import { test, expect, mock, type Engine, type MockClock } from 'claude-code/testing'
import type { RenderSurface } from 'claude-code'
import { engineUi, fakeSidecar, heldStore, PANE_PROPS, runA2a, scanHit, sessionCard, STORE, textUnder, type On } from './kit.ts'
import { fixtures as f } from './fixtures.ts'
import { MAX_HITS, PROGRESS_MS } from '../hooks/scan.ts'

// The test runtime has timers; the mod lib in tsconfig does not declare them.
declare const setTimeout: (fn: () => void, ms: number) => unknown
const wait = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

const card = (name: string) => ({ ...f.card_v1, name })
const WORKER = (ip: string, name = 'Fake Worker') => scanHit(`http://${ip}:8000`, card(name))
const SESSION = (ip: string, name = 'box/proj') => scanHit(`http://${ip}:41400`, sessionCard(name, `http://${ip}:41400`))

/** Cards at the given origins for the re-fetch an Add makes, 404 elsewhere. */
function lan(on: On, cards: Record<string, unknown>) {
  const seen: string[] = []
  on('http.fetch', async (_$, e) => {
    seen.push(e.url)
    const hit = cards[new URL(e.url).origin]
    return { value: hit ? { status: 200, ok: true, headers: {}, text: JSON.stringify(hit) } : { status: 404, ok: false, headers: {}, text: '' } }
  })
  return seen
}

function statuses(on: On) {
  const seen: (string | undefined)[] = []
  on('ui.status', async (_$, e) => { seen.push(e.text); return { value: undefined } })
  return seen
}

/** Lets the mod poll the sidecar until /a2a scan says the scan ended. */
async function finished($: Engine, clock: MockClock): Promise<string> {
  for (let i = 0; i < 50; i++) {
    await clock.advance(PROGRESS_MS)
    await wait(2)
    const text = (await runA2a($, 'scan')).text ?? ''
    if (/Scan (done|stopped)/.test(text)) return text
  }
  throw new Error('the scan never finished')
}

const mountScan = <S extends RenderSurface>($: Engine, surface: S) =>
  $.ui.mount({ plugin: 'a2a-mod', surface, component: 'Pane', requestId: 'a2a-scan', props: PANE_PROPS(72) })

test('/a2a scan refuses a public target, a prefix wider than /16 and a bad port, and starts nothing', async ($, on) => {
  mock.store(on)
  const sc = fakeSidecar(on)
  expect((await runA2a($, 'scan 8.8.8.0/24')).text).toContain('only private')
  expect((await runA2a($, 'scan 10.0.0.0/8')).text).toContain('/16')
  expect((await runA2a($, 'scan 10.0.0.1 --ports 0')).text).toContain('1-65535')
  expect(sc.scanStarts()).toEqual([])
})

test('/a2a scan hands the probes to the sidecar, opens the pane, and lists sessions and workers labelled, with /a2a add lines', async ($, on) => {
  mock.store(on)
  const clock = mock.clock(on)
  const ui = engineUi(on)
  const sc = fakeSidecar(on)
  const started = (await runA2a($, 'scan 10.0.0.0/29 --ports 8000,41400')).text ?? ''
  expect(sc.scanStarts()).toEqual([{ first: '10.0.0.1', last: '10.0.0.6', ports: [8000, 41400], https: false }])
  expect(started).toContain('12 probes')
  expect(started).toContain('512 at once')
  expect(started).toContain('/a2a scan stop')
  expect(ui.opened).toContain('a2a-scan')
  sc.scanTo({ phase: 'done', hits: [WORKER('10.0.0.5'), SESSION('10.0.0.6')] })
  const text = await finished($, clock)
  expect(text).toContain('Scan done')
  expect(text).toContain('12/12')
  expect(text).toContain('2 found')
  expect(text).toMatch(/Fake Worker  http:\/\/10\.0\.0\.5:8000  \(A2A worker, A2A 1\.0\)/)
  expect(text).toMatch(/box\/proj  http:\/\/10\.0\.0\.6:41400  \(Claude Code session, A2A 1\.0\)/)
  expect(text).toContain('/a2a add http://10.0.0.5:8000 fake-worker')
  expect(text).toContain('/a2a add http://10.0.0.6:41400 box-proj')
  // Nothing is added without the person's choice.
  expect((await runA2a($, 'list')).text).toContain('No workers')
})

test('the default ports are the worker ports and 41400-41409 for Claude Code sessions', async ($, on) => {
  mock.store(on)
  const sc = fakeSidecar(on)
  await runA2a($, 'scan 10.0.0.5')
  expect(sc.scanStarts()[0]?.ports).toEqual([80, 443, 8000, 8080, 41241, 41400, 41401, 41402, 41403, 41404, 41405, 41406, 41407, 41408, 41409])
})

test('only one scan runs at a time, and /a2a scan stop stops it at once', async ($, on) => {
  mock.store(on)
  const clock = mock.clock(on)
  engineUi(on)
  const sc = fakeSidecar(on)
  await runA2a($, 'scan 10.0.0.0/24 --ports 8000')
  sc.scanTo({ done: 20 })
  expect((await runA2a($, 'scan 10.0.1.0/24')).text).toContain('already running')
  const stop = (await runA2a($, 'scan stop')).text ?? ''
  expect(stop).toContain('Stopped the scan')
  expect(stop).toContain('20/254')
  expect(sc.tools()).toContain('scan_stop')
  expect((await runA2a($, 'scan')).text).toContain('Scan stopped')
  expect((await runA2a($, 'scan stop')).text).toContain('No scan is running')
  await clock.advance(PROGRESS_MS * 4)
})

test('the status line shows the scan progress, and is given back when it ends', async ($, on) => {
  mock.store(on)
  const clock = mock.clock(on)
  engineUi(on)
  const seen = statuses(on)
  const sc = fakeSidecar(on)
  await runA2a($, 'scan 10.0.0.0/28 --ports 8000')
  sc.scanTo({ done: 7 })
  await clock.advance(PROGRESS_MS)
  await wait(2)
  sc.scanTo({ phase: 'done' })
  await finished($, clock)
  const lines = seen.filter((s): s is string => typeof s === 'string' && s.includes('scan'))
  expect(lines.some(s => s.includes('7/14') && s.includes('50%'))).toBe(true)
  expect(seen.at(-1)).toBeUndefined()
})

test('progress reaches the state at most four times a second', async ($, on) => {
  mock.store(on)
  const clock = mock.clock(on)
  engineUi(on)
  const sc = fakeSidecar(on)
  await runA2a($, 'scan 10.0.0.0/24 --ports 8000')
  const before = sc.tools().filter(t => t === 'scan_progress').length
  await clock.advance(1000)
  await wait(5)
  const polls = sc.tools().filter(t => t === 'scan_progress').length - before
  expect(polls).toBeGreaterThanOrEqual(3)
  expect(polls).toBeLessThanOrEqual(4)
  await runA2a($, 'scan stop')
})

test('the scan pane shows progress with a Stop button that stops at once', async ($, on) => {
  mock.store(on)
  const clock = mock.clock(on)
  engineUi(on)
  const sc = fakeSidecar(on)
  await runA2a($, 'scan 10.0.0.0/24 --ports 8000')
  sc.scanTo({ done: 100 })
  await clock.advance(PROGRESS_MS)
  await wait(2)
  const pane = await mountScan($, 'terminal')
  const drawn = textUnder(await pane.drawn())
  expect(drawn).toContain('100/254')
  expect(drawn).toContain('%')
  expect(drawn).toContain('ETA')
  await pane.press({ key: 'scan-stop' })
  expect(sc.tools()).toContain('scan_stop')
  expect((await runA2a($, 'scan')).text).toContain('Scan stopped')
})

test('in the pane the person ticks hits and Add adds only the ticked ones; a session is stored as one', async ($, on) => {
  const held = heldStore(on)
  const clock = mock.clock(on)
  engineUi(on)
  const sc = fakeSidecar(on)
  lan(on, { 'http://10.0.0.5:8000': card('Fake Worker'), 'http://10.0.0.6:41400': sessionCard('box/proj', 'http://10.0.0.6:41400'), 'http://10.0.0.4:8000': card('Other Worker') })
  await runA2a($, 'scan 10.0.0.0/29 --ports 8000,41400')
  sc.scanTo({ phase: 'done', hits: [WORKER('10.0.0.5'), SESSION('10.0.0.6'), WORKER('10.0.0.4', 'Other Worker')] })
  await finished($, clock)
  const pane = await mountScan($, 'terminal')
  const drawn = textUnder(await pane.drawn())
  expect(drawn).toContain('Other Worker')
  expect(drawn).toContain('Claude Code session')
  expect(await pane.find({ type: 'Button', key: 'scan-add' })).toBeUndefined()
  await pane.press({ key: 'pick:http://10.0.0.5:8000' })
  await pane.press({ key: 'pick:http://10.0.0.6:41400' })
  await pane.press({ key: 'scan-add' })
  const workers = held('workers') ?? {}
  expect(Object.keys(workers).sort()).toEqual(['box-proj', 'fake-worker'])
  expect(workers['fake-worker']).toMatchObject({ alias: 'fake-worker', cardUrl: 'http://10.0.0.5:8000/.well-known/agent-card.json', auth: { kind: 'setting' }, version: '1.0' })
  expect(workers['box-proj']).toMatchObject({ kind: 'claude-session', endpoint: 'http://10.0.0.6:41400/a2a' })
  expect(textUnder(await pane.drawn())).toContain('already added as fake-worker')
  expect(await pane.find({ type: 'Button', key: 'pick:http://10.0.0.5:8000' })).toBeUndefined()
})

test('a hit ticked twice is unticked, and an alias already taken gets a suffix', async ($, on) => {
  const held = heldStore(on, { workers: { 'fake-worker': { ...STORE.workers.fake, alias: 'fake-worker', cardUrl: 'http://elsewhere.test/.well-known/agent-card.json' } } })
  const clock = mock.clock(on)
  engineUi(on)
  const sc = fakeSidecar(on)
  lan(on, { 'http://10.0.0.5:8000': card('Fake Worker'), 'http://10.0.0.6:8000': card('Fake Worker') })
  await runA2a($, 'scan 10.0.0.0/29 --ports 8000')
  sc.scanTo({ phase: 'done', hits: [WORKER('10.0.0.5'), WORKER('10.0.0.6')] })
  await finished($, clock)
  const pane = await mountScan($, 'terminal')
  await pane.press({ key: 'pick:http://10.0.0.5:8000' })
  await pane.press({ key: 'pick:http://10.0.0.6:8000' })
  await pane.press({ key: 'pick:http://10.0.0.6:8000' })
  await pane.press({ key: 'scan-add' })
  expect(Object.keys(held('workers') ?? {}).sort()).toEqual(['fake-worker', 'fake-worker-2'])
  expect(held('workers')?.['fake-worker-2']?.cardUrl).toBe('http://10.0.0.5:8000/.well-known/agent-card.json')
})

test('an endpoint already registered is marked already added and offers no tick', async ($, on) => {
  heldStore(on, { workers: { fake: { ...STORE.workers.fake, cardUrl: 'http://10.0.0.5:8000/.well-known/agent-card.json' } } })
  const clock = mock.clock(on)
  engineUi(on)
  const sc = fakeSidecar(on)
  await runA2a($, 'scan 10.0.0.5 --ports 8000')
  sc.scanTo({ phase: 'done', hits: [WORKER('10.0.0.5')] })
  const text = await finished($, clock)
  expect(text).toContain('already added as fake')
  expect(text).not.toContain('/a2a add http://10.0.0.5:8000')
  const pane = await mountScan($, 'terminal')
  expect(await pane.find({ type: 'Button', key: 'pick:http://10.0.0.5:8000' })).toBeUndefined()
})

test('a hit that is no card the mod accepts is left out', async ($, on) => {
  mock.store(on)
  const clock = mock.clock(on)
  engineUi(on)
  const sc = fakeSidecar(on)
  await runA2a($, 'scan 10.0.0.5 --ports 8000,9000')
  sc.scanTo({ phase: 'done', hits: [scanHit('http://10.0.0.5:8000', { name: 'gRPC only', supportedInterfaces: [{ url: 'x', protocolBinding: 'GRPC', protocolVersion: '1.0' }] }), scanHit('http://10.0.0.5:9000', card('Good'))] })
  const text = await finished($, clock)
  expect(text).toContain('1 found')
  expect(text).toContain('Good')
  expect(text).not.toContain('gRPC only')
})

test('a scan where every host answers keeps the first hits and its pane stays under the tree limit', async ($, on) => {
  mock.store(on)
  const clock = mock.clock(on)
  engineUi(on)
  const sc = fakeSidecar(on)
  const long = { ...f.card_v1, name: 'W'.repeat(200), skills: Array.from({ length: 10 }, (_, i) => ({ id: `${'s'.repeat(60)}${i}`, name: 'S' })) }
  await runA2a($, 'scan 10.0.0.0/25 --ports 8000')
  sc.scanTo({ phase: 'done', hits: Array.from({ length: MAX_HITS }, (_, i) => scanHit(`http://10.0.0.${i + 1}:8000`, long)) })
  const text = await finished($, clock)
  expect(text).toContain(`Found ${MAX_HITS} (0 Claude Code sessions and ${MAX_HITS} A2A workers):`)
  expect(text).toContain(`only the first ${MAX_HITS} are kept`)
  const pane = await mountScan($, 'terminal')
  const tree = JSON.stringify(await pane.drawn())
  expect(tree).not.toContain('engine Pane')
  expect(tree.length).toBeLessThan(100_000)
})

test('with the sidecar down /a2a scan says it needs the sidecar', async ($, on) => {
  mock.store(on)
  fakeSidecar(on, { down: 'spawn node ENOENT' })
  const text = (await runA2a($, 'scan 10.0.0.0/24')).text ?? ''
  expect(text).toContain('/a2a scan runs in the a2a-mod sidecar, which is not running (spawn node ENOENT)')
})
