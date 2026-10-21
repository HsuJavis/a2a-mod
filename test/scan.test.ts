import { test, expect } from 'claude-code/testing'
import type { Fetcher } from '../hooks/client.ts'
import { aliasesFor, CONCURRENCY, DEFAULT_PORTS, ipText, MAX_IN_FLIGHT, MAX_PROBES, parsePorts, parseTarget, planScan, probeBase, progressLine, PROBE_TIMEOUT_MS, resultsText, runScan, type Hosts, type Plan, type Progress, type PumpDeps } from '../hooks/scan.ts'
import type { ScanState } from '../types/index.d.ts'
import { fixtures as f } from './fixtures.ts'

// The test runtime has timers; the mod lib in tsconfig does not declare them.
declare const setTimeout: (fn: () => void, ms: number) => unknown

const hosts = (s: string) => parseTarget(s) as Hosts
const range = (s: string) => { const h = hosts(s); return [ipText(h.first), ipText(h.last), h.count] }

test('a /16 is 65,534 hosts: the network and broadcast addresses are left out', () => {
  expect(range('192.168.0.0/16')).toEqual(['192.168.0.1', '192.168.255.254', 65534])
})

test('a /24 is 254 hosts, and a host address inside it scans its whole network', () => {
  expect(range('10.0.0.0/24')).toEqual(['10.0.0.1', '10.0.0.254', 254])
  expect(range('10.0.0.77/24')).toEqual(['10.0.0.1', '10.0.0.254', 254])
})

test('a /32 and a bare IP are one host; /31 keeps both addresses; /30 drops two', () => {
  expect(range('10.0.0.7/32')).toEqual(['10.0.0.7', '10.0.0.7', 1])
  expect(range('172.16.4.9')).toEqual(['172.16.4.9', '172.16.4.9', 1])
  expect(range('10.0.0.6/31')).toEqual(['10.0.0.6', '10.0.0.7', 2])
  expect(range('10.0.0.4/30')).toEqual(['10.0.0.5', '10.0.0.6', 2])
})

test('a range a.b.c.d-e.f.g.h is every address in it, ends included', () => {
  expect(range('10.0.0.10-10.0.0.20')).toEqual(['10.0.0.10', '10.0.0.20', 11])
  expect(range('192.168.1.250-192.168.2.5')).toEqual(['192.168.1.250', '192.168.2.5', 12])
})

test('the private, CGNAT, link-local and loopback blocks are allowed', () => {
  for (const ok of ['10.1.0.0/16', '172.16.0.0/16', '172.31.255.0/24', '192.168.0.0/16', '100.64.0.0/16', '100.127.0.1', '169.254.0.0/16', '127.0.0.1']) {
    expect(typeof parseTarget(ok)).toBe('object')
  }
})

test('public addresses are refused, and the refusal says which blocks are allowed', () => {
  for (const bad of ['8.8.8.8', '1.1.1.0/24', '172.15.0.0/16', '172.32.0.1', '100.128.0.1', '192.169.0.0/24', '11.0.0.0/16']) {
    const out = parseTarget(bad)
    expect(typeof out).toBe('string')
    expect(String(out)).toContain('192.168.0.0/16')
  }
})

test('a prefix wider than /16 is refused with the reason, even inside a private block', () => {
  for (const wide of ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/15', '0.0.0.0/0']) {
    const out = String(parseTarget(wide))
    expect(out).toContain('/16')
    expect(out).toContain('65,536')
  }
})

test('a range that crosses out of its block, is reversed or is longer than a /16 is refused', () => {
  expect(typeof parseTarget('10.255.255.250-11.0.0.5')).toBe('string')
  expect(typeof parseTarget('10.0.0.20-10.0.0.10')).toBe('string')
  expect(String(parseTarget('10.0.0.0-10.1.0.0'))).toContain('65,536')
})

test('malformed targets and host names are refused', () => {
  for (const bad of ['', '1.2.3', '256.1.1.1', '10.0.0.1/33', '10.0.0.1/', 'worker.local', '10.0.0.01x', '::1', '10.0.0.0/-1']) {
    expect(typeof parseTarget(bad)).toBe('string')
  }
})

test('ports: a list with ranges, deduped and in order', () => {
  expect(parsePorts('8000,9000-9003,8000')).toEqual([8000, 9000, 9001, 9002, 9003])
  expect(parsePorts('41241')).toEqual([41241])
})

test('ports outside 1-65535, reversed ranges and junk are refused', () => {
  for (const bad of ['0', '65536', '70000', '9010-9000', 'http', '80,', '', '1-2-3']) {
    expect(typeof parsePorts(bad)).toBe('string')
  }
})

test('the default ports are 80, 443, 8000, 8080 and 41241, https on 443 alone', () => {
  const plan = planScan(['10.0.0.0/30']) as Plan
  expect(plan.ports).toEqual([...DEFAULT_PORTS])
  expect(plan.total).toBe(2 * 5)
  const urls = Array.from({ length: plan.total }, (_, i) => probeBase(plan, i))
  expect(urls).toContain('https://10.0.0.5:443')
  expect(urls).toContain('http://10.0.0.6:41241')
  expect(urls.filter(u => u.startsWith('https:'))).toEqual(['https://10.0.0.5:443', 'https://10.0.0.6:443'])
})

test('--ports overrides the defaults and --https tries https on every port', () => {
  const plan = planScan(['10.0.0.7', '--ports', '8000,9000-9001', '--https']) as Plan
  expect(Array.from({ length: plan.total }, (_, i) => probeBase(plan, i))).toEqual(['https://10.0.0.7:8000', 'https://10.0.0.7:9000', 'https://10.0.0.7:9001'])
})

test('a scan over the probe cap is refused with the numbers', () => {
  expect(MAX_PROBES).toBe(65536 * 8)
  expect((planScan(['192.168.0.0/16', '--ports', '1-8']) as Plan).total).toBe(65534 * 8)
  const out = String(planScan(['192.168.0.0/16', '--ports', '1-9']))
  expect(out).toContain('589,806')
  expect(out).toContain('524,288')
})

test('planScan refuses unknown options and a missing --ports value', () => {
  expect(typeof planScan(['10.0.0.1', '--fast'])).toBe('string')
  expect(typeof planScan(['10.0.0.1', '--ports'])).toBe('string')
  expect(typeof planScan([])).toBe('string')
})

test('the chosen limits are 128 probes at once, 192 host requests in flight, 1 s a probe', () => {
  expect([CONCURRENCY, MAX_IN_FLIGHT, PROBE_TIMEOUT_MS]).toEqual([128, 192, 1000])
})

// ---- the probe pump, with a fake Fetcher ----

const card = (name: string, skills = [{ id: 'echo', name: 'Echo' }]) => ({ ...f.card_v1, name, skills })
const wait = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

function deps(fetch: Fetcher, over: Partial<PumpDeps> = {}): PumpDeps {
  return {
    fetch,
    sleep: (ms, signal) => new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new Error('aborted'))
      setTimeout(resolve, ms)
      signal?.addEventListener('abort', () => reject(new Error('aborted')))
    }),
    now: () => Date.now(),
    known: new Map(),
    stopped: () => false,
    onProgress: () => {},
    timeoutMs: 50,
    ...over,
  }
}

/** Answers a card for the origins in `cards`, 404 for the rest, after `ms`. */
function lan(cards: Record<string, unknown>, ms = 0) {
  const seen: string[] = []
  let now = 0
  let most = 0
  const fetch: Fetcher = async url => {
    seen.push(url)
    most = Math.max(most, ++now)
    try {
      if (ms) await wait(ms)
      const hit = cards[new URL(url).origin]
      return hit ? { status: 200, ok: true, text: JSON.stringify(hit) } : { status: 404, ok: false, text: '' }
    } finally { now-- }
  }
  return { fetch, seen, most: () => most }
}

test('the pump probes every host and port once, at the card path, and keeps the hits', async () => {
  const plan = planScan(['10.0.0.0/29', '--ports', '8000,9000']) as Plan
  const net = lan({ 'http://10.0.0.3:8000': card('Alpha'), 'http://10.0.0.6:9000': card('Beta', [{ id: 'sum', name: 'Sum' }]) })
  const out = await runScan(plan, deps(net.fetch))
  expect(net.seen.length).toBe(6 * 2)
  expect(new Set(net.seen).size).toBe(12)
  expect(net.seen).toContain('http://10.0.0.3:8000/.well-known/agent-card.json')
  expect(out.done).toBe(12)
  expect(out.finished).toBe(true)
  expect(out.hits.map(h => [h.name, h.url, h.version, h.skills])).toEqual([
    ['Alpha', 'http://10.0.0.3:8000', '1.0', ['echo']],
    ['Beta', 'http://10.0.0.6:9000', '1.0', ['sum']],
  ])
})

test('no more probes run at once than the concurrency allows', async () => {
  const plan = planScan(['10.0.0.0/24', '--ports', '8000']) as Plan
  const net = lan({}, 5)
  await runScan(plan, deps(net.fetch, { concurrency: 7, timeoutMs: 1000 }))
  expect(net.most()).toBe(7)
  expect(net.seen.length).toBe(254)
})

test('a probe that outlives its timeout is a miss, and abandoned requests still count against the in-flight cap', async () => {
  const plan = planScan(['10.0.0.0/28', '--ports', '8000']) as Plan
  let open = 0
  let most = 0
  const release: (() => void)[] = []
  // Never answers until released: the host's own 30 s timeout stands in for it.
  const fetch: Fetcher = () => new Promise(resolve => {
    most = Math.max(most, ++open)
    release.push(() => { open--; resolve({ status: 404, ok: false, text: '' }) })
  })
  let finished = false
  const run = runScan(plan, deps(fetch, { concurrency: 2, maxInFlight: 5, timeoutMs: 10 })).finally(() => { finished = true })
  await wait(120)
  expect(most).toBe(5)
  // The host answers the abandoned requests at last, and the lanes move on.
  while (!finished) { for (const r of release.splice(0)) r(); await wait(5) }
  const out = await run
  expect(most).toBeLessThanOrEqual(5)
  expect(out.done).toBe(14)
  expect(out.hits).toEqual([])
})

test('connection errors, non-JSON answers and non-cards are silent misses', async () => {
  const plan = planScan(['10.0.0.0/30', '--ports', '1-3']) as Plan
  const fetch: Fetcher = async url => {
    const port = new URL(url).port
    if (port === '1') throw new Error('connect ECONNREFUSED')
    if (port === '2') return { status: 200, ok: true, text: '<html>router</html>' }
    return { status: 200, ok: true, text: JSON.stringify({ hello: 'world' }) }
  }
  const out = await runScan(plan, deps(fetch))
  expect(out.done).toBe(6)
  expect(out.hits).toEqual([])
})

test('a hit already registered is marked with its alias', async () => {
  const plan = planScan(['10.0.0.0/30', '--ports', '8000']) as Plan
  const net = lan({ 'http://10.0.0.5:8000': card('Alpha'), 'http://10.0.0.6:8000': card('Beta') })
  const known = new Map([['http://10.0.0.5:8000/.well-known/agent-card.json', 'alpha']])
  const out = await runScan(plan, deps(net.fetch, { known }))
  expect(out.hits.map(h => [h.name, h.known])).toEqual([['Alpha', 'alpha'], ['Beta', undefined]])
})

test('progress is reported at most once per interval, and always at the end', async () => {
  const plan = planScan(['10.0.0.0/24', '--ports', '8000']) as Plan
  const net = lan({ 'http://10.0.0.9:8000': card('Alpha') })
  let clock = 0
  const seen: Progress[] = []
  // Each probe moves the clock 10 ms: 254 probes span 2.54 s, so about 10 reports at 250 ms.
  const fetch: Fetcher = async (url, init) => { clock += 10; return net.fetch(url, init) }
  await runScan(plan, deps(fetch, { now: () => clock, progressMs: 250, onProgress: p => { seen.push({ ...p, hits: [...p.hits] }) } }))
  expect(seen.length).toBeGreaterThanOrEqual(5)
  expect(seen.length).toBeLessThanOrEqual(13)
  expect(seen.at(-1)).toMatchObject({ done: 254, total: 254, finished: true, stopped: false })
  expect(seen.at(-1)!.hits.length).toBe(1)
  for (let i = 1; i < seen.length; i++) expect(seen[i]!.done).toBeGreaterThanOrEqual(seen[i - 1]!.done)
})

test('a stop ends the scan early and says it was stopped', async () => {
  const plan = planScan(['10.0.0.0/24', '--ports', '8000']) as Plan
  const net = lan({}, 1)
  let stop = false
  const out = await runScan(plan, deps(net.fetch, { concurrency: 4, stopped: () => stop, onProgress: p => { if (p.done >= 20) stop = true }, progressMs: 0 }))
  expect(out.stopped).toBe(true)
  expect(out.finished).toBe(false)
  expect(out.done).toBeLessThan(254)
  expect(net.seen.length).toBeLessThan(40)
})

// ---- what the person reads ----

const state = (over: Partial<ScanState> = {}): ScanState => ({
  phase: 'running', target: '10.0.0.0/24', ports: [8000], total: 1000, done: 250, startedAt: 0, at: 10_000, hits: [], picked: [], ...over,
})

test('the progress line has done/total, percent, hits, elapsed and ETA', () => {
  const line = progressLine(state({ hits: [{ url: 'http://10.0.0.5:8000', cardUrl: 'x', name: 'A', version: '1.0', skills: [] }] }))
  expect(line).toContain('250/1,000')
  expect(line).toContain('25%')
  expect(line).toContain('1 found')
  expect(line).toContain('0:10')
  expect(line).toContain('ETA 0:30')
})

test('aliases default to the card name slug and never take a registered alias, a token alias or each other', () => {
  const hits = [
    { url: 'http://10.0.0.5:8000', cardUrl: 'a', name: 'Fake Worker', version: '1.0' as const, skills: [] },
    { url: 'http://10.0.0.6:8000', cardUrl: 'b', name: 'Fake Worker', version: '1.0' as const, skills: [] },
    { url: 'http://10.0.0.7:8000', cardUrl: 'c', name: 'Tokened', version: '1.0' as const, skills: [] },
    { url: 'http://10.0.0.8:8000', cardUrl: 'd', name: 'Mine', version: '1.0' as const, skills: [], known: 'mine-old' },
  ]
  const names = aliasesFor(hits, ['fake-worker'], { tokened: 'x' })
  expect(names.get('http://10.0.0.5:8000')).toBe('fake-worker-2')
  expect(names.get('http://10.0.0.6:8000')).toBe('fake-worker-3')
  expect(names.get('http://10.0.0.7:8000')).toBe('tokened-2')
  expect(names.get('http://10.0.0.8:8000')).toBe('mine-old')
})

test('the result text lists each hit with an /a2a add line, and marks one already added', () => {
  const text = resultsText(state({
    phase: 'done', done: 1000,
    hits: [
      { url: 'http://10.0.0.5:8000', cardUrl: 'a', name: 'Fake Worker', version: '1.0', skills: ['echo', 'sum'] },
      { url: 'http://10.0.0.6:8000', cardUrl: 'b', name: 'Other', version: '0.3', skills: [], known: 'other' },
    ],
  }), ['other'], {})
  expect(text).toContain('Fake Worker')
  expect(text).toContain('A2A 1.0')
  expect(text).toContain('echo, sum')
  expect(text).toContain('/a2a add http://10.0.0.5:8000 fake-worker')
  expect(text).toContain('already added as other')
  expect(text).not.toContain('/a2a add http://10.0.0.6:8000')
})

test('the result text drops control characters from the card name', () => {
  const text = resultsText(state({ phase: 'done', hits: [{ url: 'http://10.0.0.5:8000', cardUrl: 'a', name: '\u001b[31mEvil\nName', version: '1.0', skills: ['x\u0007'] }] }), [], {})
  expect(text).not.toContain('\u001b')
  expect(text).not.toContain('\u0007')
  expect(text).toContain('Evil Name')
})
