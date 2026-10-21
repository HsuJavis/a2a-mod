import { test, expect, mock, type Engine, type MockClock } from 'claude-code/testing'
import type { RenderSurface } from 'claude-code'
import { engineUi, heldStore, PANE_PROPS, runA2a, STORE, textUnder, type On } from './kit.ts'
import { fixtures as f } from './fixtures.ts'
import { MAX_HITS } from '../hooks/scan.ts'

// The test runtime has timers; the mod lib in tsconfig does not declare them.
declare const setTimeout: (fn: () => void, ms: number) => unknown
const wait = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

const card = (name: string) => ({ ...f.card_v1, name })

/**
 * The LAN as the host would answer it: a card at the given origins, 404 elsewhere. `hold` keeps
 * every request waiting until `open()`, so a test can look at a scan while it runs.
 */
function lan(on: On, cards: Record<string, unknown>, opts: { hold?: boolean } = {}) {
  const seen: string[] = []
  let open = () => {}
  const gate: Promise<void> = opts.hold ? new Promise(r => { open = r }) : Promise.resolve()
  on('http.fetch', async (_$, e) => {
    seen.push(e.url)
    await gate
    const hit = cards[new URL(e.url).origin]
    return { value: hit ? { status: 200, ok: true, headers: {}, text: JSON.stringify(hit) } : { status: 404, ok: false, headers: {}, text: '' } }
  })
  return { seen, open: () => open() }
}

/** Every status line the mod set. */
function statuses(on: On) {
  const seen: (string | undefined)[] = []
  on('ui.status', async (_$, e) => { seen.push(e.text); return { value: undefined } })
  return seen
}

/** Lets the scan run (the kit's clock moves only when told) until /a2a scan says it ended. */
async function finished($: Engine, clock: MockClock): Promise<string> {
  for (let i = 0; i < 200; i++) {
    const text = (await runA2a($, 'scan')).text ?? ''
    if (/Scan (done|stopped)/.test(text)) return text
    await clock.advance(250)
    await wait(5)
  }
  throw new Error('the scan never finished')
}

const mountScan = <S extends RenderSurface>($: Engine, surface: S) =>
  $.ui.mount({ plugin: 'a2a-mod', surface, component: 'Pane', requestId: 'a2a-scan', props: PANE_PROPS(72) })

test('/a2a scan refuses a public target and a prefix wider than /16, and probes nothing', async ($, on) => {
  mock.store(on)
  const net = lan(on, {})
  expect((await runA2a($, 'scan 8.8.8.0/24')).text).toContain('only private')
  expect((await runA2a($, 'scan 10.0.0.0/8')).text).toContain('/16')
  expect((await runA2a($, 'scan 10.0.0.1 --ports 0')).text).toContain('1-65535')
  await wait(30)
  expect(net.seen).toEqual([])
})

test('/a2a scan runs in the background, opens the scan pane and lists what it found with /a2a add lines', async ($, on) => {
  mock.store(on)
  const clock = mock.clock(on)
  const ui = engineUi(on)
  const net = lan(on, { 'http://10.0.0.5:8000': card('Fake Worker') })
  const started = (await runA2a($, 'scan 10.0.0.0/29 --ports 8000,9000')).text
  expect(started).toContain('12 probes')
  expect(started).toContain('/a2a scan stop')
  expect(ui.opened).toContain('a2a-scan')
  const text = await finished($, clock)
  expect(net.seen.length).toBe(12)
  expect(text).toContain('Scan done')
  expect(text).toContain('12/12')
  expect(text).toContain('1 found')
  expect(text).toContain('Fake Worker')
  expect(text).toContain('/a2a add http://10.0.0.5:8000 fake-worker')
  // Nothing is added without the person's choice.
  expect((await runA2a($, 'list')).text).toContain('No workers')
})

test('only one scan runs at a time, and /a2a scan stop ends it', async ($, on) => {
  mock.store(on)
  const clock = mock.clock(on)
  engineUi(on)
  const net = lan(on, {}, { hold: true })
  await runA2a($, 'scan 10.0.0.0/24 --ports 8000')
  expect((await runA2a($, 'scan 10.0.1.0/24')).text).toContain('already running')
  expect((await runA2a($, 'scan stop')).text).toContain('Stopping')
  net.open()
  expect(await finished($, clock)).toContain('Scan stopped')
  expect(net.seen.length).toBeLessThan(254)
  expect((await runA2a($, 'scan stop')).text).toContain('No scan is running')
})

test('the status line shows the scan progress, and is given back when it ends', async ($, on) => {
  mock.store(on)
  const clock = mock.clock(on)
  engineUi(on)
  const seen = statuses(on)
  lan(on, {})
  await runA2a($, 'scan 10.0.0.0/28 --ports 8000')
  await finished($, clock)
  const lines = seen.filter((s): s is string => typeof s === 'string' && s.includes('scan'))
  expect(lines.some(s => s.includes('/14'))).toBe(true)
  expect(lines.some(s => s.includes('%'))).toBe(true)
  expect(seen.at(-1)).toBeUndefined()
})

test('the scan pane shows progress with a Stop button while it runs', async ($, on) => {
  mock.store(on)
  const clock = mock.clock(on)
  engineUi(on)
  const net = lan(on, {}, { hold: true })
  await runA2a($, 'scan 10.0.0.0/24 --ports 8000')
  const pane = await mountScan($, 'terminal')
  await clock.advance(1)
  const drawn = textUnder(await pane.drawn())
  expect(drawn).toContain('/254')
  expect(drawn).toContain('%')
  expect(drawn).toContain('ETA')
  await pane.press({ key: 'scan-stop' })
  net.open()
  expect(await finished($, clock)).toContain('Scan stopped')
})

test('in the pane the person ticks hits and Add adds only the ticked ones, with the usual Worker record', async ($, on) => {
  const held = heldStore(on)
  const clock = mock.clock(on)
  engineUi(on)
  lan(on, { 'http://10.0.0.5:8000': card('Fake Worker'), 'http://10.0.0.6:8000': card('Other Worker') })
  await runA2a($, 'scan 10.0.0.0/29 --ports 8000')
  await finished($, clock)
  const pane = await mountScan($, 'terminal')
  expect(textUnder(await pane.drawn())).toContain('Other Worker')
  // Add is there only once something is ticked.
  expect(await pane.find({ type: 'Button', key: 'scan-add' })).toBeUndefined()
  await pane.press({ key: 'pick:http://10.0.0.5:8000' })
  await pane.press({ key: 'scan-add' })
  const workers = held('workers') ?? {}
  expect(Object.keys(workers)).toEqual(['fake-worker'])
  expect(workers['fake-worker']).toMatchObject({
    alias: 'fake-worker', name: 'Fake Worker', cardUrl: 'http://10.0.0.5:8000/.well-known/agent-card.json', auth: { kind: 'setting' }, version: '1.0',
  })
  // The added one now reads as already added, and cannot be ticked again.
  expect(textUnder(await pane.drawn())).toContain('already added as fake-worker')
  expect(await pane.find({ type: 'Button', key: 'pick:http://10.0.0.5:8000' })).toBeUndefined()
})

test('a hit ticked twice is unticked, and an alias already taken gets a suffix', async ($, on) => {
  const held = heldStore(on, { workers: { 'fake-worker': { ...STORE.workers.fake, alias: 'fake-worker', cardUrl: 'http://elsewhere.test/.well-known/agent-card.json' } } })
  const clock = mock.clock(on)
  engineUi(on)
  lan(on, { 'http://10.0.0.5:8000': card('Fake Worker'), 'http://10.0.0.6:8000': card('Fake Worker') })
  await runA2a($, 'scan 10.0.0.0/29 --ports 8000')
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
  lan(on, { 'http://10.0.0.5:8000': card('Fake Worker') })
  await runA2a($, 'scan 10.0.0.5 --ports 8000')
  const text = await finished($, clock)
  expect(text).toContain('already added as fake')
  expect(text).not.toContain('/a2a add http://10.0.0.5:8000')
  const pane = await mountScan($, 'terminal')
  expect(await pane.find({ type: 'Button', key: 'pick:http://10.0.0.5:8000' })).toBeUndefined()
})

test('a scan where every host answers keeps the first hits and its pane stays under the tree limit', async ($, on) => {
  mock.store(on)
  const clock = mock.clock(on)
  engineUi(on)
  const long = { ...f.card_v1, name: 'W'.repeat(200), skills: Array.from({ length: 10 }, (_, i) => ({ id: `${'s'.repeat(60)}${i}`, name: 'S' })) }
  on('http.fetch', async () => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify(long) } }))
  await runA2a($, 'scan 10.0.0.0/25 --ports 8000')
  const text = await finished($, clock)
  expect(text).toContain(`Found ${MAX_HITS}:`)
  expect(text).toContain(`only the first ${MAX_HITS} are kept`)
  const pane = await mountScan($, 'terminal')
  const tree = JSON.stringify(await pane.drawn())
  expect(tree).not.toContain('engine Pane')
  expect(tree.length).toBeLessThan(100_000)
})
