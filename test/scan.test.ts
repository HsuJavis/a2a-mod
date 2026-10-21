import { test, expect } from 'claude-code/testing'
import { aliasesFor, DEFAULT_PORTS, ipText, MAX_PROBES, parsePorts, parseTarget, planScan, probeBase, progressLine, resultsText, type Hosts, type Plan } from '../hooks/scan.ts'
import type { ScanState } from '../types/index.d.ts'

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

test('the default ports are 80, 443, 8000, 8080, 41241 and 41400-41409, https on 443 alone', () => {
  const plan = planScan(['10.0.0.4/30']) as Plan
  expect(plan.ports).toEqual([...DEFAULT_PORTS])
  expect(plan.ports).toEqual([80, 443, 8000, 8080, 41241, 41400, 41401, 41402, 41403, 41404, 41405, 41406, 41407, 41408, 41409])
  expect(plan.total).toBe(2 * 15)
  const urls = Array.from({ length: plan.total }, (_, i) => probeBase(plan, i))
  expect(urls).toContain('https://10.0.0.5:443')
  expect(urls).toContain('http://10.0.0.6:41409')
  expect(urls.filter(u => u.startsWith('https:'))).toEqual(['https://10.0.0.5:443', 'https://10.0.0.6:443'])
})

test('--ports overrides the defaults and --https tries https on every port', () => {
  const plan = planScan(['10.0.0.7', '--ports', '8000,9000-9001', '--https']) as Plan
  expect(Array.from({ length: plan.total }, (_, i) => probeBase(plan, i))).toEqual(['https://10.0.0.7:8000', 'https://10.0.0.7:9000', 'https://10.0.0.7:9001'])
})

test('a scan over the probe cap is refused with the numbers: a /16 on the default ports fits', () => {
  expect(MAX_PROBES).toBe(65536 * 16)
  expect((planScan(['192.168.0.0/16']) as Plan).total).toBe(65534 * 15)
  expect((planScan(['192.168.0.0/16', '--ports', '1-16']) as Plan).total).toBe(65534 * 16)
  const out = String(planScan(['192.168.0.0/16', '--ports', '1-17']))
  expect(out).toContain('1,114,078')
  expect(out).toContain('1,048,576')
})

test('planScan refuses unknown options and a missing --ports value', () => {
  expect(typeof planScan(['10.0.0.1', '--fast'])).toBe('string')
  expect(typeof planScan(['10.0.0.1', '--ports'])).toBe('string')
  expect(typeof planScan([])).toBe('string')
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

test('the result text labels Claude Code sessions apart from A2A workers', () => {
  const text = resultsText(state({
    phase: 'done', done: 1000,
    hits: [
      { url: 'http://10.0.0.5:8000', cardUrl: 'a', name: 'Fake Worker', version: '1.0', skills: [] },
      { url: 'http://10.0.0.6:41400', cardUrl: 'b', name: 'box/proj', version: '1.0', skills: ['claude-session'], kind: 'claude-session' },
    ],
  }), [], {})
  expect(text).toContain('Fake Worker  http://10.0.0.5:8000  (A2A worker, A2A 1.0)')
  expect(text).toContain('box/proj  http://10.0.0.6:41400  (Claude Code session, A2A 1.0)')
  expect(text).toContain('1 Claude Code session and 1 A2A worker')
})
