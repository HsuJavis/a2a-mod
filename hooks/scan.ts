import type { Timer } from 'claude-code'
import type { ScanHit, ScanState, Worker } from '../types/index.d.ts'
import { A2AError } from './client.ts'
import { fetchWorker, slug, tokenNotes } from './command.ts'
import { plain } from './format.ts'
import { NEEDS_NODE, type Sidecar } from './inbound.ts'
import { loadWorkers, saveWorker, type Host } from './registry.ts'
import { clock } from './ui/fx.ts'
import { parseCard } from './wire.ts'

/** The ports A2A workers commonly use, then 41400-41409: the first ten Claude Code sessions on a host. */
export const DEFAULT_PORTS = [80, 443, 8000, 8080, 41241, 41400, 41401, 41402, 41403, 41404, 41405, 41406, 41407, 41408, 41409] as const
/** A /16: the widest target one scan takes. */
const MAX_HOSTS = 65536
/** Hosts × ports: a /16 on 16 ports, so a /16 on the default ports fits. */
export const MAX_PROBES = MAX_HOSTS * 16
/** The scan's progress is read from the sidecar this often: at most four updates a second. */
export const PROGRESS_MS = 250
/** Hits kept: the pane lists them all, and its tree has a 100,000-character limit. */
export const MAX_HITS = 100
/** Progress reads that may fail in a row before the scan is given up as stopped. */
const MAX_MISSES = 20

const SCAN_USAGE = [
  'Usage:',
  '  /a2a scan <target> [--ports <list>] [--https]',
  '      target: a CIDR (192.168.1.0/24, up to /16), one IP, or a range 10.0.0.10-10.0.0.50; private addresses only',
  '      ports: default 80,443,8000,8080,41241 (A2A workers) and 41400-41409 (Claude Code sessions);',
  '      a list like 8000,9000-9010; --https tries https on every port',
  '  /a2a scan          where the scan is, or what it found',
  '  /a2a scan stop     cancel it',
].join('\n')

// ---- targets and ports ----

const BLOCKS: [string, number][] = [['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['100.64.0.0', 10], ['169.254.0.0', 16], ['127.0.0.0', 8]]
const ALLOWED = '10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 100.64.0.0/10 (CGNAT, Tailscale), 169.254.0.0/16 (link-local) and 127.0.0.0/8'

/** 12345 as 12,345: the mod runtime is not promised Intl. */
export const count = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')

const maskOf = (prefix: number) => (prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0)

function ipNum(s: string): number | undefined {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s)
  if (!m) return undefined
  const parts = m.slice(1).map(Number)
  if (parts.some(p => p > 255)) return undefined
  return parts.reduce((n, p) => n * 256 + p, 0)
}

export const ipText = (n: number) => [24, 16, 8, 0].map(s => (n >>> s) & 255).join('.')

const blockOf = (n: number) => BLOCKS.findIndex(([base, prefix]) => ((n & maskOf(prefix)) >>> 0) === ipNum(base))

export type Hosts = { first: number; last: number; count: number }

const tooWide = (what: string, n: number) =>
  `a2a: ${what} is ${count(n)} addresses; /a2a scan takes at most a /16 (65,536 addresses) at a time, so a scan stays short and light on the network. Scan the /16s you need one at a time.`
const notPrivate = (t: string) => `a2a: ${t} is not all on a private network. /a2a scan takes only private addresses: ${ALLOWED}.`

/** A CIDR, one IPv4 address, or a range `a.b.c.d-e.f.g.h`; a string says why it is refused. */
export function parseTarget(raw: string): Hosts | string {
  const t = raw.trim()
  const bad = `a2a: ${t || '(none)'} is not a target. Give an IPv4 CIDR (192.168.1.0/24), one address (192.168.1.20) or a range (192.168.1.10-192.168.1.50).`
  let first: number
  let last: number
  const dash = t.indexOf('-')
  if (dash >= 0) {
    const a = ipNum(t.slice(0, dash))
    const b = ipNum(t.slice(dash + 1))
    if (a === undefined || b === undefined) return bad
    if (a > b) return `a2a: the range ${t} ends before it starts.`
    if (b - a + 1 > MAX_HOSTS) return tooWide(`that range`, b - a + 1)
    first = a
    last = b
  } else {
    const [ip, prefixText, ...more] = t.split('/')
    const n = ipNum(ip ?? '')
    if (n === undefined || more.length || (prefixText !== undefined && !/^\d{1,2}$/.test(prefixText))) return bad
    const prefix = prefixText === undefined ? 32 : Number(prefixText)
    if (prefix > 32) return bad
    if (prefix < 16) return tooWide(`a /${prefix}`, 2 ** (32 - prefix))
    const network = (n & maskOf(prefix)) >>> 0
    const size = 2 ** (32 - prefix)
    // A /31 and a /32 have no network or broadcast address to leave out.
    first = prefix <= 30 ? network + 1 : network
    last = prefix <= 30 ? network + size - 2 : network + size - 1
  }
  const block = blockOf(first)
  if (block < 0 || blockOf(last) !== block) return notPrivate(t)
  return { first, last, count: last - first + 1 }
}

/** `8000,9000-9010`: deduped, in the order given. */
export function parsePorts(raw: string): number[] | string {
  const bad = `a2a: ${raw || '(none)'} is not a port list. Give ports 1-65535, separated by commas, with ranges like 9000-9010.`
  const out = new Set<number>()
  for (const part of raw.split(',')) {
    const m = /^(\d{1,5})(?:-(\d{1,5}))?$/.exec(part)
    if (!m) return bad
    const lo = Number(m[1])
    const hi = m[2] === undefined ? lo : Number(m[2])
    if (lo < 1 || hi > 65535 || lo > hi) return bad
    for (let p = lo; p <= hi; p++) out.add(p)
  }
  return [...out]
}

export type Plan = { target: string; hosts: Hosts; ports: number[]; https: boolean; total: number }

export function planScan(words: readonly string[]): Plan | string {
  let target: string | undefined
  let ports: number[] = [...DEFAULT_PORTS]
  let https = false
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!
    if (word === '--https') https = true
    else if (word === '--ports') {
      const list = words[++i]
      if (list === undefined) return `a2a: --ports needs a list, like 8000,9000-9010.\n\n${SCAN_USAGE}`
      const parsed = parsePorts(list)
      if (typeof parsed === 'string') return parsed
      ports = parsed
    } else if (word.startsWith('--')) return `a2a: unknown option ${word}.\n\n${SCAN_USAGE}`
    else if (target === undefined) target = word
    else return `a2a: give one target, not ${target} and ${word}.\n\n${SCAN_USAGE}`
  }
  if (target === undefined) return SCAN_USAGE
  const hosts = parseTarget(target)
  if (typeof hosts === 'string') return hosts
  const total = hosts.count * ports.length
  if (total > MAX_PROBES) {
    return `a2a: that is ${count(total)} probes (${count(hosts.count)} hosts × ${ports.length} ports); one scan makes at most ${count(MAX_PROBES)}. Give a smaller target or fewer ports.`
  }
  return { target, hosts, ports, https, total }
}

/** The base URL of probe `i`: hosts in order, each on every port. https on 443, or everywhere with --https. */
export function probeBase(plan: Plan, i: number): string {
  const port = plan.ports[i % plan.ports.length]!
  const ip = ipText(plan.hosts.first + Math.floor(i / plan.ports.length))
  return `${plan.https || port === 443 ? 'https' : 'http'}://${ip}:${port}`
}

// ---- the sidecar's hits ----

// One line per field: the card is whoever answered's own text.
const line = (s: unknown, max: number) => plain(String(s)).replace(/\s+/g, ' ').trim().slice(0, max)
const SKILLS_KEPT = 6

/**
 * The sidecar's hits as the mod keeps them: each card through parseCard, so a hit is a card the rest
 * of the mod accepts; one it refuses is left out. `known` maps a card URL to its registered alias.
 */
export function hitsOf(raw: unknown, known: ReadonlyMap<string, string>): ScanHit[] {
  const out: ScanHit[] = []
  for (const h of Array.isArray(raw) ? raw : []) {
    if (out.length >= MAX_HITS) break
    try {
      const url = new URL(String(h?.url)).origin
      const cardUrl = String(h?.cardUrl)
      const card = parseCard(h?.card, cardUrl)
      const alias = known.get(cardUrl)
      out.push({
        url, cardUrl, name: line(card.name, 80), version: card.version,
        skills: card.skills.slice(0, SKILLS_KEPT).map(s => line(s.id || s.name, 40)),
        ...(card.kind ? { kind: card.kind } : {}),
        ...(alias ? { known: alias } : {}),
      })
    } catch {
      // Not a card the mod could add.
    }
  }
  return out
}

// ---- what the person reads ----

/** `250/1,000 · 25% · 1 found · 0:10 · ETA 0:30` */
export function progressLine(s: ScanState): string {
  const elapsed = Math.max(0, s.at - s.startedAt)
  const pct = s.total ? Math.floor((s.done * 100) / s.total) : 100
  const eta = s.done ? clock((elapsed * (s.total - s.done)) / s.done) : '--'
  return `${count(s.done)}/${count(s.total)} · ${pct}% · ${s.hits.length} found · ${clock(elapsed)} · ETA ${eta}`
}

/** The alias each hit would be added under: its card name's slug, never one in use or holding a token. */
export function aliasesFor(hits: readonly ScanHit[], taken: readonly string[], tokens: Readonly<Record<string, string>>): Map<string, string> {
  const used = new Set([...taken, ...Object.keys(tokens)])
  const out = new Map<string, string>()
  for (const h of hits) {
    if (h.known) { out.set(h.url, h.known); continue }
    const base = slug(h.name)
    let alias = base
    for (let n = 2; used.has(alias); n++) alias = `${base.slice(0, 40 - String(n).length - 1)}-${n}`
    used.add(alias)
    out.set(h.url, alias)
  }
  return out
}

const heading = (s: ScanState, live: boolean) =>
  `${live ? 'Scanning' : s.phase === 'done' ? 'Scan done:' : 'Scan stopped:'} ${s.target}, ports ${s.ports.length > 6 ? `${s.ports.slice(0, 6).join(', ')}… (${s.ports.length})` : s.ports.join(', ')}`

const kindOf = (h: ScanHit) => (h.kind === 'claude-session' ? 'Claude Code session' : 'A2A worker')
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`

/** What the scan found, as text with an /a2a add line each: it works where no pane draws. */
export function resultsText(s: ScanState, taken: readonly string[], tokens: Readonly<Record<string, string>>, live = false): string {
  const head = `${heading(s, live)}\n${progressLine(s)}`
  if (live) return `${head}\n/a2a scan stop cancels it.`
  if (!s.hits.length) return `${head}\n\nNo Claude Code session or A2A worker answered.`
  const names = aliasesFor(s.hits, taken, tokens)
  const rows = s.hits.map((h, i) => {
    const what = `  ${i + 1}. ${line(h.name, 80)}  ${h.url}  (${kindOf(h)}, A2A ${h.version})${h.skills.length ? `  skills: ${h.skills.map(k => line(k, 40)).join(', ')}` : ''}`
    return h.known ? `${what}\n     already added as ${h.known}` : `${what}\n     /a2a add ${h.url} ${names.get(h.url)}`
  })
  const capped = s.hits.length >= MAX_HITS ? `\n(only the first ${MAX_HITS} are kept)` : ''
  const sessions = s.hits.filter(h => h.kind === 'claude-session').length
  const kinds = `${plural(sessions, 'Claude Code session')} and ${plural(s.hits.length - sessions, 'A2A worker')}`
  return `${head}\n\nFound ${s.hits.length} (${kinds}):\n${rows.join('\n')}${capped}\n\nTick the ones to add in the A2A scan pane, or run their /a2a add lines. Nothing is added until you do.`
}

// ---- running it in the session ----

/** What a scan needs from the session; register.ts builds it from $. */
export type ScanEnv = {
  /** The sidecar's tools; throws SidecarDown when it is not running. */
  sidecar: Sidecar
  every(ms: number, fn: () => void): Timer
  read(): Promise<ScanState | null>
  write(change: (s: ScanState | null) => ScanState | null): Promise<void>
  /** The scan's status line; undefined hands the line back to the tasks. */
  status(text: string | undefined): void
  log(text: string): void
  /** Opens the scan pane. */
  open(): Promise<void>
  toast(text: string): void
}

// Module state: a reload drops it, and the session.start hook marks a scan it left behind as stopped.
type Run = { timer?: Timer; known: ReadonlyMap<string, string>; busy: boolean; misses: number; ended: boolean }
let active: Run | undefined
let statusLine: string | undefined

export const isScanning = () => active !== undefined
/** While a scan runs, its line wins the status line over the tasks'. */
export const scanStatus = () => statusLine

const showProgress = (env: ScanEnv, s: ScanState) => {
  statusLine = `scan ${s.target} ${progressLine(s)}`
  env.status(statusLine)
}

const why = (err: unknown) => (err instanceof Error ? err.message : String(err))

async function end(env: ScanEnv, host: Host, run: Run, phase: 'done' | 'stopped'): Promise<void> {
  if (run.ended) return
  run.ended = true
  run.timer?.cancel()
  if (active === run) active = undefined
  statusLine = undefined
  env.status(undefined)
  await env.write(s => s && { ...s, phase: s.phase === 'running' ? phase : s.phase })
  const s = await env.read()
  if (s) env.log(resultsText(s, Object.keys(await loadWorkers(host)), host.settingTokens.map))
}

/** One read of the sidecar's progress into the state, the pane and the status line. */
async function poll(env: ScanEnv, host: Host, run: Run): Promise<void> {
  if (run.busy || run.ended) return
  run.busy = true
  try {
    const p = await env.sidecar('scan_progress')
    run.misses = 0
    const phase = p.phase === 'done' ? 'done' : p.phase === 'running' ? 'running' : 'stopped'
    const at = Date.now()
    const hits = hitsOf(p.hits, run.known)
    await env.write(s => s && { ...s, done: Math.min(Number(p.done) || 0, s.total), hits, at, phase })
    const s = await env.read()
    if (phase !== 'running') await end(env, host, run, phase)
    else if (s) showProgress(env, s)
  } catch {
    if (++run.misses >= MAX_MISSES) await end(env, host, run, 'stopped')
  } finally {
    run.busy = false
  }
}

export async function scanCommand(env: ScanEnv, host: Host, words: string[]): Promise<string> {
  const taken = async () => Object.keys(await loadWorkers(host))
  if (!words.length) {
    const s = await env.read()
    if (!s) return SCAN_USAGE
    await env.open()
    return resultsText(s, await taken(), host.settingTokens.map, isScanning())
  }
  if (words[0] === 'stop' && words.length === 1) return stopScan(env, host)
  if (active) {
    const s = await env.read()
    return `a2a: a scan is already running${s ? ` (${s.target}, ${progressLine(s)})` : ''}. One runs at a time; /a2a scan stop cancels it.`
  }
  const plan = planScan(words)
  if (typeof plan === 'string') return plan
  let started: Record<string, any>
  try {
    started = await env.sidecar('scan_start', { first: ipText(plan.hosts.first), last: ipText(plan.hosts.last), ports: plan.ports, https: plan.https })
  } catch (err) {
    return `a2a: /a2a scan runs in the a2a-mod sidecar, which is not running (${line(why(err), 200)}). ${NEEDS_NODE}`
  }
  if (started.ok !== true) return `a2a: the scan did not start: ${line(started.error ?? 'the sidecar refused it', 200)}.`
  const run: Run = { known: new Map(Object.values(await loadWorkers(host)).map((w: Worker) => [w.cardUrl, w.alias])), busy: false, misses: 0, ended: false }
  active = run
  const startedAt = Date.now()
  const start: ScanState = { phase: 'running', target: plan.target, ports: plan.ports, total: plan.total, done: 0, startedAt, at: startedAt, hits: [], picked: [] }
  try {
    await env.write(() => start)
    showProgress(env, start)
    await env.open()
  } catch (err) {
    active = undefined
    statusLine = undefined
    throw err
  }
  run.timer = env.every(PROGRESS_MS, () => void poll(env, host, run))
  const { hosts, ports } = plan
  const lanes = Number(started.concurrency) || 0
  const ms = Number(started.timeoutMs) || 0
  return [
    `Scanning ${plan.target}: ${count(hosts.count)} host${hosts.count === 1 ? '' : 's'} × ${ports.length} port${ports.length === 1 ? '' : 's'} = ${count(plan.total)} probes, ${count(lanes)} at once, ${ms / 1000} s a connect; a card is asked for only where a port is open.`,
    'Progress shows in the A2A scan pane and on the status line. /a2a scan shows where it is; /a2a scan stop cancels it.',
    'Only scan networks you are allowed to scan: a sweep can trip an intrusion detection system.',
  ].join('\n')
}

/** Stops the scan in the sidecar, which closes every probe at once, and settles it here. */
export async function stopScan(env: ScanEnv, host: Host): Promise<string> {
  const run = active
  if (!run) return 'No scan is running.'
  try { await env.sidecar('scan_stop') } catch {}
  run.busy = false
  await poll(env, host, run)
  if (!run.ended) await end(env, host, run, 'stopped')
  const s = await env.read()
  return `Stopped the scan${s ? `: ${progressLine(s)}` : ''}.`
}

/** A scan a reload cut short still says running in the state; it is stopped, in the sidecar too. */
export async function settleOrphan(env: ScanEnv): Promise<void> {
  if (active) return
  const s = await env.read()
  if (s?.phase !== 'running') return
  await env.write(held => held && { ...held, phase: 'stopped' })
  try { await env.sidecar('scan_stop') } catch {}
}

export const togglePick = (env: ScanEnv, url: string) =>
  env.write(s => s && { ...s, picked: s.picked.includes(url) ? s.picked.filter(u => u !== url) : [...s.picked, url] })

/** Adds the ticked hits, as /a2a add would: the same Worker record, a deduped card-name alias, the tokens setting as the token source. */
export async function addPicked(env: ScanEnv, host: Host): Promise<void> {
  const s = await env.read()
  if (!s?.picked.length) return
  const names = aliasesFor(s.hits, Object.keys(await loadWorkers(host)), host.settingTokens.map)
  const added = new Map<string, string>()
  const said: string[] = []
  for (const url of s.picked) {
    const hit = s.hits.find(h => h.url === url)
    if (!hit || hit.known) continue
    const alias = names.get(url)!
    try {
      const w = await fetchWorker(host, hit.url, alias, { kind: 'setting' })
      // The card is fetched again; one that moved since the scan is not the one the person ticked.
      if (w.cardUrl !== hit.cardUrl) throw new A2AError(`its card moved to ${w.cardUrl}`)
      await saveWorker(host, w)
      added.set(url, alias)
      said.push(...tokenNotes(host, w))
    } catch (err) {
      said.push(`Could not add ${hit.url}: ${line(err instanceof Error ? err.message : String(err), 200)}`)
    }
  }
  await env.write(held => held && {
    ...held,
    picked: [],
    hits: held.hits.map(h => (added.has(h.url) ? { ...h, known: added.get(h.url)! } : h)),
  })
  env.toast(added.size ? `a2a: added ${[...added.values()].join(', ')}.` : 'a2a: nothing was added.')
  for (const note of said) env.log(`a2a: ${note}`)
}
