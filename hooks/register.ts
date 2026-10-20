import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer, UiCopyResult } from 'claude-code'
import type { LanPeer, LanView, PaneView, RecentState, RecentTask, SentReply, Worker } from '../types/index.d.ts'
import { A2AError, cancelTask, getTask, send } from './client.ts'
import { runCommand, USAGE } from './command.ts'
import { describeOutcome, FULL_MAX, wakeDetail, wakeLine } from './format.ts'
import { agentSections, EMPTY_LAN, framed, isA2a, isLan, LAN_SERVER, LanDown, messagesOf, nextView, offText, peerSection, peersOf, POLL_LAN_MS, resultOf, sendFileResult, sentText, SIDECAR_DENY, toastText, type LanStatus, type Sidecar } from './lan.ts'
import { addWorkerTool, removeWorkerTool, type Confirm } from './manage.ts'
import { changeRecent, isOpen, isWaiting, noteCall, noteSent, noteState, readRecent, visible } from './recent.ts'
import { loadWorkers, noteFailure, own, parseTokens, targetOf, workerOr, type Host, type SettingTokens } from './registry.ts'
import { resume, showStatus, track } from './tracker.ts'
import { palette, type Palette } from './ui/color.ts'
import { bandRows, bandTree, nextRedraw } from './ui/band.tsx'
import { resultCard, textOf, useCard } from './ui/cards.tsx'
import { paneTree, type PaneActions } from './ui/pane.tsx'
import { parseSettings, type UiSettings } from './ui/settings.ts'
import { isLive } from './wire.ts'

type Engine = EngineInterface

const TASKS = { plugin: 'a2a-mod', key: 'tasks' } as const
const RECENT = { plugin: 'a2a-mod', key: 'recent' } as const
const CALLS = { plugin: 'a2a-mod', key: 'calls' } as const
const PANE = { id: 'a2a-workers', title: 'A2A workers' } as const
// Wanted sizes: a slim dock beside /diff, a short block when inline.
const PANE_COLUMNS = 32
const PANE_ROWS = 12
// -1, not 0: a clock that starts at 0 can end a task at 0, and Clear done at that moment still has to hide it.
const EMPTY_VIEW: PaneView = { open: [], replying: [], collapsed: [], all: [], clearedAt: -1 }
const paneView = atom({ plugin: 'a2a-mod', key: 'pane' } as const, EMPTY_VIEW)
const replies = atom({ plugin: 'a2a-mod', key: 'replies' } as const, [] as SentReply[])
const played = atom({ plugin: 'a2a-mod', key: 'played' } as const, [] as string[])
const PLAYED_MAX = 200
const lanView = atom({ plugin: 'a2a-mod', key: 'lan' } as const, EMPTY_LAN as LanView)
const TOKEN_CMD_TIMEOUT_MS = 10_000
// A pane button's own deadline for the worker calls it makes.
const PRESS_MS = 9000
const NOT_COPIED: Record<Extract<UiCopyResult, { isCopied: false }>['reason'], string> = {
  'no-surface': 'nothing is drawing',
  'no-clipboard': 'this surface has no clipboard Claude Code can write to',
  refused: 'another mod refused it',
}

// The status line and the band age by this clock, so a test's mock clock moves them. Another mod's
// clock.now hook may refuse; the wall clock is the fallback.
async function nowOf($: Engine): Promise<number> {
  try { return await $.clock.now() } catch { return Date.now() }
}

// A wake is shown as `text` alone; its detail waits here for our own prompt.submit hook, which
// attaches it as context. Whether the engine runs that hook for this mod's own submit is unverified
// (the test kit does not), and a reload empties the list. Either way Claude gets the line alone, so
// the send result tells it to fetch the result with the task tool.
const pendingWakes: { text: string; detail: string }[] = []

function hostOf($: Engine, settingTokens: SettingTokens, ui: UiSettings): Host {
  return {
    fetch: (url, init) => $.http.fetch(url, init),
    readWorkers: () => $.store.get('workers'),
    writeWorkers: all => $.store.set('workers', all),
    settingTokens,
    run: argv => $.process.run(argv, { timeoutMs: TOKEN_CMD_TIMEOUT_MS }),
    readFile: path => $.fs.read(path),
    readTasks: () => $.state.get(TASKS),
    writeTasks: async (tasks, ifVersion) => (await $.state.set(TASKS, tasks, { ifVersion })).isSet,
    readRecent: () => $.state.get(RECENT),
    writeRecent: async (recent, ifVersion) => (await $.state.set(RECENT, recent, { ifVersion })).isSet,
    readCalls: () => $.state.get(CALLS),
    writeCalls: async (calls, ifVersion) => (await $.state.set(CALLS, calls, { ifVersion })).isSet,
    readDurations: async () => ((await $.store.get('durations')) as Record<string, number[]> | undefined) ?? {},
    writeDurations: all => $.store.set('durations', all),
    status: text => $.ui.status(text),
    anim: ui.animations,
    now: () => nowOf($),
    every: (ms, fn) => $.clock.every(ms, fn),
    sleep: ms => $.clock.sleep(ms),
    wake: async (text, detail) => {
      const entry = { text, detail }
      pendingWakes.push(entry)
      try { await $.prompt.submit({ text, asUser: true }) } finally {
        const at = pendingWakes.indexOf(entry)
        if (at >= 0) pendingWakes.splice(at, 1)
      }
    },
  }
}

const TOOLS = [
  { name: 'workers', description: 'List the A2A worker agents the user registered, with their skills. Call before send to pick a worker.', inputSchema: { type: 'object', properties: {} } },
  {
    name: 'send',
    description: 'Send a task to an A2A worker agent. Returns the answer if it finishes within a few seconds; otherwise returns a task id, and you get a message when it finishes. Do not poll. Pass taskId to answer a worker that asked for input, contextId to continue a conversation.',
    inputSchema: {
      type: 'object',
      properties: {
        worker: { type: 'string', description: 'Worker alias from the workers tool' },
        message: { type: 'string', description: 'What the worker should do, self-contained' },
        taskId: { type: 'string' },
        contextId: { type: 'string' },
      },
      required: ['worker', 'message'],
    },
  },
  {
    name: 'task',
    description: 'Get the state and full result of an A2A task, or cancel it.',
    inputSchema: {
      type: 'object',
      properties: { worker: { type: 'string' }, taskId: { type: 'string' }, cancel: { type: 'boolean' } },
      required: ['worker', 'taskId'],
    },
  },
  {
    name: 'add_worker',
    description: 'Register an A2A worker from its URL. The user is asked to approve it first. Tokens set by command or file, and --trust-endpoint, need the user to run /a2a add themselves.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The worker base URL, or its Agent Card URL' },
        alias: { type: 'string', description: 'Short name to call it by; defaults to the card name' },
      },
      required: ['url'],
    },
  },
  {
    name: 'remove_worker',
    description: 'Forget a registered A2A worker. The user is asked to approve it first.',
    inputSchema: { type: 'object', properties: { alias: { type: 'string', description: 'Worker alias from the workers tool' } }, required: ['alias'] },
  },
]

// Registered in LAN mode where this build has no SendFile tool of its own.
const SEND_FILE_TOOL = {
  name: 'send_file',
  description: 'Send files, with an optional message, to a Claude Code session on the LAN (a lan:<name> address from ListAgents). They are saved in its inbox folder and it is told where.',
  inputSchema: {
    type: 'object',
    properties: {
      to: { type: 'string', description: 'lan:<name> from ListAgents' },
      files: { type: 'array', items: { type: 'string' }, description: 'Paths, absolute or relative to the working directory' },
      message: { type: 'string' },
    },
    required: ['to', 'files'],
  },
}

// The dialog shows on every call, whatever the permission mode. A reply that is not exactly the
// Add/Remove label (free text under Other) is a no.
const confirmOf = ($: Engine): Confirm => async (question, yes) => {
  try { return (await $.ui.ask(question, { header: 'a2a', options: [yes, 'Cancel'] })) === yes ? 'yes' : 'no' } catch { return 'none' }
}

export const INLINE_POLLS_MS = [500, 1000, 2000, 4000]
type SendInput = { worker?: string; message?: string; taskId?: string; contextId?: string }
/** What sendTask reads of a hook's `next`: the time left and the abort. */
type Deadline = { readonly budget: { readonly remainingMs: number }; readonly signal: AbortSignal }

// Sleeps count against the hook's 10 s budget; this keeps the last getTask and the reply inside it.
const BUDGET_RESERVE_MS = 1500
// What a bounded call leaves of the budget for tracking the task and replying.
const REPLY_MS = 500

// Waiting on $.http.fetch does not spend the hook budget, so a silent worker would hold Claude's turn
// with no limit. Race it against what is left of the budget.
async function bounded<T>($: Engine, remainingMs: number, signal: AbortSignal, alias: string, work: Promise<T>): Promise<T> {
  const stop = new AbortController()
  const onAbort = () => stop.abort()
  signal.addEventListener('abort', onAbort)
  const ms = Math.max(0, remainingMs - REPLY_MS)
  try {
    return await Promise.race([
      work,
      // An aborted or failed timer leaves the race to the work.
      $.clock.sleep(ms, { signal: stop.signal }).then(
        (): never => { throw new A2AError(`worker ${alias} did not answer within ${Math.round(ms / 1000)} s. Try again later, or ask the user to check it.`) },
        () => new Promise<never>(() => {}),
      ),
    ])
  } finally {
    signal.removeEventListener('abort', onAbort)
    stop.abort()
  }
}

async function paletteOf($: Engine): Promise<Palette> {
  // Another mod's config.list hook may refuse or fail; the dark palette is the fallback.
  try { return palette((await $.config.list()).find(row => row.key === 'theme')?.value) } catch { return palette(undefined) }
}

const without = (ids: string[], id: string) => ids.filter(x => x !== id)
const toggled = (ids: string[] | undefined, id: string) => ((ids ?? []).includes(id) ? without(ids ?? [], id) : [...(ids ?? []), id])

// The card is indented two columns, so this leaves two spare on the right.
const cardWidth = (columns: number | undefined) => Math.max(1, Math.min(100, (columns ?? 80) - 4))

async function cancelFromPane($: Engine, host: Host, t: RecentTask): Promise<void> {
  const w = own(await loadWorkers(host), t.worker)
  if (!w) { $.ui.toast(`a2a: ${t.worker} was removed.`); return }
  await changeRecent(host, t.taskId, held => held && { ...held, canceling: true })
  const until = Date.now() + PRESS_MS
  const never = new AbortController().signal
  try {
    const target = await bounded($, until - Date.now(), never, w.alias, targetOf(host, w))
    await bounded($, until - Date.now(), never, w.alias, cancelTask(host.fetch, target, t.taskId))
    // A waiting task is not polled. Tracking it again lets the next poll report the end and wake Claude.
    if (isWaiting(t.state)) await track(host, { worker: w.alias, taskId: t.taskId, contextId: t.contextId, state: 'working', startedAt: t.startedAt })
  } catch (err) {
    noteFailure(w, err)
    await changeRecent(host, t.taskId, held => { if (!held) return held; const { canceling, ...rest } = held; return rest })
    if (err instanceof A2AError) $.ui.toast(`a2a: ${err.message}`)
    else throw err
  }
}

async function replyFromPane($: Engine, host: Host, t: RecentTask, text: string): Promise<boolean> {
  const w = own(await loadWorkers(host), t.worker)
  if (!w) { $.ui.toast(`a2a: ${t.worker} was removed.`); return false }
  const until = Date.now() + PRESS_MS
  const never = new AbortController().signal
  try {
    const target = await bounded($, until - Date.now(), never, w.alias, targetOf(host, w))
    const out = await bounded($, until - Date.now(), never, w.alias, send(host.fetch, target, { text, taskId: t.taskId, contextId: t.contextId }))
    const state = out.kind === 'task' ? out.state : 'completed'
    await noteSent(host, { worker: w.alias, taskId: t.taskId, contextId: out.contextId, text, state }, 'user')
    if (out.kind === 'task' && isLive(out.state)) {
      await track(host, { worker: w.alias, taskId: t.taskId, contextId: out.contextId, state: out.state, startedAt: t.startedAt })
      return true
    }
    // Claude heard the question, not this answer, so an answer that ends the task wakes it.
    await noteState(host, w.alias, t.taskId, state, out.text)
    await showStatus(host)
    const item = { worker: w.alias, taskId: t.taskId, state, body: describeOutcome(w.alias, out) }
    await host.wake(wakeLine([item]), wakeDetail([item]))
    return true
  } catch (err) {
    noteFailure(w, err)
    if (err instanceof A2AError) { $.ui.toast(`a2a: ${err.message}`); return false }
    throw err
  }
}

// A send to a worker: the send tool's, and SendMessage's for an a2a:<alias> recipient. `callId` keys
// the call's card; `limit` is the calling hook's own deadline.
async function sendTask($: Engine, host: Host, callId: string, limit: Deadline, input: SendInput): Promise<string> {
  const w = await workerOr(host, input.worker)
  if (typeof w === 'string') return w
  const startedAt = await host.now()
  const call = (state: RecentState, taskId?: string) => noteCall(host, callId, { worker: w.alias, state, startedAt, ...(taskId ? { taskId } : {}) })
  await call('submitted')
  try {
    const fetch = host.fetch
    const t = await bounded($, limit.budget.remainingMs, limit.signal, w.alias, targetOf(host, w))
    let out = await bounded($, limit.budget.remainingMs, limit.signal, w.alias, send(fetch, t, { text: String(input.message ?? ''), taskId: input.taskId, contextId: input.contextId }))
    // A send answered with a message has no task id; its row is keyed by the call instead.
    const id = out.kind === 'task' ? out.taskId : callId
    await noteSent(host, { worker: w.alias, taskId: id, contextId: out.contextId, text: String(input.message ?? ''), state: out.kind === 'task' ? out.state : 'working' }, 'claude')
    for (const ms of INLINE_POLLS_MS) {
      if (out.kind !== 'task' || !isLive(out.state)) break
      if (limit.budget.remainingMs - ms < BUDGET_RESERVE_MS) break
      try { await $.clock.sleep(ms, { signal: limit.signal }) } catch { break }
      // A slow poll keeps the last state, so the task is still tracked below.
      try { out = await bounded($, limit.budget.remainingMs, limit.signal, w.alias, getTask(fetch, t, out.taskId)) } catch (err) { if (err instanceof A2AError) { noteFailure(w, err); break } throw err }
    }
    if (out.kind === 'task' && isLive(out.state)) {
      await track(host, { worker: w.alias, taskId: out.taskId, contextId: out.contextId, state: out.state, startedAt })
      await noteState(host, w.alias, out.taskId, out.state, out.text)
      await call(out.state, out.taskId)
      return `${w.alias} is working on it (task ${out.taskId}, ${out.state}). You will get a message when it finishes, reading "a2a: ${w.alias} task ${out.taskId.slice(0, 4)}… completed". It comes from this mod, not the user. If it carries no result, call the task tool with this task id; do not poll. Carry on with other work.`
    }
    const state = out.kind === 'task' ? out.state : 'completed'
    await noteState(host, w.alias, id, state, out.text)
    await call(state, out.kind === 'task' ? out.taskId : undefined)
    await showStatus(host)
    return describeOutcome(w.alias, out)
  } catch (err) {
    noteFailure(w, err)
    await call('failed')
    if (err instanceof A2AError) return `a2a: ${err.message}`
    throw err
  }
}

// The loader refuses $ passed across an import, so the sidecar's calls are built here.
const sidecarOf = ($: Engine): Sidecar => async (tool, args = {}) => {
  const c = await $.mcp.connect(LAN_SERVER)
  if (!c.isConnected) throw new LanDown(c.message)
  return resultOf(await $.mcp.call(c.server, tool, args))
}

const why = (err: unknown) => (err instanceof Error ? err.message : String(err))

/** LAN mode as the sidecar has it now, or why it could not be asked. */
async function lanNow($: Engine): Promise<{ status?: LanStatus; peers: LanPeer[]; down?: string }> {
  const sc = sidecarOf($)
  try {
    const status = (await sc('status')) as LanStatus
    return { status, peers: status.configured ? peersOf((await sc('peers')).peers) : [] }
  } catch (err) {
    return { peers: [], down: why(err) }
  }
}

/** A send through the sidecar; its error is a sentence for Claude. Relative paths are the session's. */
async function lanSend($: Engine, args: { to: string; text: string; files?: string[] }): Promise<Record<string, any>> {
  try {
    const out = await sidecarOf($)('send', { ...args, cwd: await $.session.cwd() })
    if (out.ok === true) return out
    return { ...out, error: /^not configured/.test(String(out.error)) ? offText(undefined) : `a2a lan: ${String(out.error ?? 'the send failed')}` }
  } catch (err) {
    return { ok: false, error: offText(undefined, why(err)) }
  }
}

let lanTimer: Timer | undefined
let lanBusy = false

// Drains the sidecar's inbox. Each message is a toast and a row in the pane, and together they are one
// prompt, framed, never asUser: another agent wrote them, not the person.
async function pollLan($: Engine, address: string): Promise<void> {
  if (lanBusy) return
  lanBusy = true
  try {
    const sc = sidecarOf($)
    const [box, seen] = await Promise.all([sc('inbox'), sc('peers')])
    const fresh = messagesOf(box.messages)
    const peers = peersOf(seen.peers)
    const was = await read($, lanView)
    if (nextView(was, address, peers, fresh) !== was) await update($, lanView, v => nextView(v, address, peers, fresh))
    for (const m of fresh) $.ui.toast(toastText(m))
    if (fresh.length) $.prompt.submit({ text: fresh.map(framed).join('\n\n') }).catch(() => {})
  } catch {
    // A sidecar that went away is tried again on the next tick.
  } finally {
    lanBusy = false
  }
}

// With no secret the sidecar opens no socket and nothing here runs, so the mod behaves as upstream's.
async function startLan($: Engine): Promise<void> {
  const { status } = await lanNow($)
  const address = status?.configured ? status.address : ''
  if ((await read($, lanView)).address !== address) await update($, lanView, v => ({ ...v, address }))
  lanTimer?.cancel()
  lanTimer = undefined
  if (!address) return
  lanTimer = $.clock.every(POLL_LAN_MS, () => void pollLan($, address))
  if (!(await $.tool.list()).some(t => t.name === 'SendFile')) await $.tool.register(SEND_FILE_TOOL)
}

export const register: Register = (on, options) => {
  const settingTokens = parseTokens(options.tokens)
  const ui = parseSettings(options)
  // Set means the person wants LAN mode, so a sidecar that is not there is worth a line in ListAgents.
  const lanWanted = String(options.lanSecret ?? '') !== ''
  // Not in $.state: a write per keystroke would redraw the pane under the person's typing.
  const drafts = new Map<string, string>()
  let paneExpiry: Timer | undefined
  let bandExpiry: Timer | undefined

  on('session.start', async ($, e, next) => {
    await Promise.all([
      ...TOOLS.map(t => $.tool.register(t)),
      $.command.register({ name: 'a2a', description: 'Manage A2A worker agents', argumentHint: 'add <url> [alias] [--token-setting | --token-cmd "<cmd>" | --token-file <path>] | list | remove <alias>' }),
    ])
    await resume(hostOf($, settingTokens, ui))
    // The engine keeps a pane open across reloads, so one opened under another layout would stay.
    if (ui.layout === 'minimal') try { await $.ui.close({ id: PANE.id }) } catch {}
    try { await startLan($) } catch {}
    return next(e)
  })

  on('command.run', { command: 'a2a' }, async ($, e) => {
    const sub = e.args.trim().split(/\s+/)[0]
    if (sub === 'lan') {
      const { status, peers, down } = await lanNow($)
      return { text: status?.configured ? `This session is ${status.address}, listening on port ${status.port}.\n\n${peerSection(status.address, peers)}` : offText(status, down) }
    }
    if (sub) {
      const text = await runCommand(hostOf($, settingTokens, ui), e.args)
      const lan = sub === 'list' ? await read($, lanView) : EMPTY_LAN
      return { text: lan.address ? `${text}\n\n${peerSection(lan.address, lan.peers)}` : text }
    }
    // Only the person opens the pane, so a running task never switches the dock away from /diff.
    // Asked, it is placed at any width; another mod's ui.open hook may still deny it.
    if (ui.layout !== 'minimal') try { await $.ui.open({ ...PANE, columns: PANE_COLUMNS, rows: PANE_ROWS }) } catch {}
    return { text: USAGE }
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'plugin' && e.origin.name === 'a2a-mod') {
      const at = pendingWakes.findIndex(w => w.text === e.text)
      if (at < 0) return next(e)
      const [wake] = pendingWakes.splice(at, 1)
      return next({ ...e, context: [...(e.context ?? []), wake!.detail] })
    }
    if (e.origin.kind !== 'composer') return next(e)
    const sent = await read($, replies)
    if (!sent.length) return next(e)
    await update($, replies, () => [])
    const told = sent.map(r => `You answered ${r.worker}'s question on task ${r.taskId}: "${r.text}"`)
    return next({ ...e, context: [...(e.context ?? []), ...told] })
  })

  on('ui.render', { component: 'ToolUse', props: { tool: 'mcp__a2a-mod__send' } }, async ($, e, next) => {
    if (ui.layout !== 'full') return next(e)
    const host = hostOf($, settingTokens, ui)
    const input = (e.props.input ?? {}) as { worker?: unknown; message?: unknown }
    const alias = String(input.worker ?? '')
    const [workers, calls, pal] = await Promise.all([loadWorkers(host), host.readCalls(), paletteOf($)])
    const now = await nowOf($)
    return useCard($.ui.resolve(e), {
      surface: e.surface, width: cardWidth(e.viewport?.columns), anim: ui.animations, pal, now, alias, worker: own(workers, alias),
      message: String(input.message ?? ''), isRunning: e.props.isRunning, startedAt: calls.value?.[e.props.tool_use_id]?.startedAt ?? now,
    })
  })

  on('ui.render', { component: 'ToolResult', props: { tool: 'mcp__a2a-mod__send' } }, async ($, e, next) => {
    if (ui.layout !== 'full') return next(e)
    const host = hostOf($, settingTokens, ui)
    const [calls, done, list] = await Promise.all([host.readCalls(), read($, played), readRecent(host)])
    const call = calls.value?.[e.props.tool_use_id]
    const playId = call?.taskId ?? e.props.tool_use_id
    // The output is what Claude was told at the time; the task may have moved on since.
    const now = call?.taskId ? list.find(t => t.taskId === call.taskId) : undefined
    const moved = now !== undefined && now.state !== call?.state
    return resultCard($.ui.resolve(e), {
      surface: e.surface, width: cardWidth(e.viewport?.columns), anim: ui.animations,
      state: moved ? now.state : call?.state, isErrored: e.props.isErrored, text: moved ? (now.result ?? '') : textOf(e.props.output),
      playId, played: done.includes(playId), taskId: call?.taskId,
    })
  })

  // The band is shared: another mod may draw there, and the first tree in the chain wins. So it
  // draws only while a task runs or waits (and for the return packet after), yields to surveys,
  // and stacks next(e)'s tree under its own.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (ui.layout !== 'full' || e.props.hasSurvey) return next(e)
    const now = await nowOf($)
    const rows = bandRows(await readRecent(hostOf($, settingTokens, ui)), now)
    if (!rows.length) return next(e)
    // The return packet rests with no state change to redraw the band, so a timer does it.
    bandExpiry?.cancel()
    const due = nextRedraw(rows, now, true)
    bandExpiry = due === undefined ? undefined : $.clock.after(due, () => $.ui.invalidate('ui.render'))
    const [pal, theirs] = await Promise.all([paletteOf($), next(e)])
    return bandTree($.ui.resolve(e), { surface: e.surface, width: e.props.bodyColumns, now, anim: ui.animations, pal, rows }, theirs)
  })

  on('ui.message', async ($, e) => {
    const id = (e.data as { played?: unknown } | null)?.played
    if (typeof id === 'string') await update($, played, ids => (ids.includes(id) ? ids : [...ids, id].slice(-PLAYED_MAX)))
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: 'a2a-workers' }, async ($, e) => {
    const host = hostOf($, settingTokens, ui)
    const now = await nowOf($)
    const [workers, list, stored, durations, pal, lan] = await Promise.all([loadWorkers(host), readRecent(host), read($, paneView), host.readDurations(), paletteOf($), read($, lanView)])
    // State saved by an earlier version lacks the newer fields.
    const view: PaneView = { ...EMPTY_VIEW, ...stored }
    const act: PaneActions = {
      cancel: t => cancelFromPane($, host, t),
      // One row open at a time keeps the pane under the engine's 100,000-character tree limit.
      toggleOpen: t => update($, paneView, v => ({ ...v, open: v.open.includes(t.taskId) ? [] : [t.taskId] })),
      toggleBox: alias => update($, paneView, v => ({ ...v, collapsed: toggled(v.collapsed, alias) })),
      toggleAll: alias => update($, paneView, v => ({ ...v, all: toggled(v.all, alias) })),
      // Hides what ended by now from the pane only; the recent list keeps it for the cards.
      clearDone: async () => { const at = await nowOf($); await update($, paneView, v => ({ ...v, clearedAt: at })) },
      copy: async (t, press) => {
        const copied = await $.ui.copy({ text: t.result ?? '', surface: press.surface })
        if (!copied.isCopied) $.ui.toast(`a2a: nothing was copied: ${NOT_COPIED[copied.reason]}.`)
      },
      startReply: async t => {
        await update($, paneView, v => ({ ...v, replying: [...without(v.replying, t.taskId), t.taskId] }))
        // autoFocus applies only when the pane takes the keyboard, and a press does not hand it over.
        // The field shows either way: claude plugin test 2.1.288 rejects every $.ui.focus.
        try { await $.ui.focus({ requestId: PANE.id, key: `input:${t.taskId}` }) } catch {}
      },
      draft: (t, text) => { drafts.set(t.taskId, text) },
      send: async (t, text) => {
        if (!text.trim() || !(await replyFromPane($, host, t, text))) return
        drafts.delete(t.taskId)
        await update($, paneView, v => ({ ...v, replying: without(v.replying, t.taskId) }))
        await update($, replies, r => [...r, { worker: t.worker, taskId: t.taskId, text }])
      },
      discard: async t => {
        drafts.delete(t.taskId)
        await update($, paneView, v => ({ ...v, replying: without(v.replying, t.taskId) }))
      },
    }
    const shown = Object.values(workers).sort((a, b) => a.addedAt - b.addedAt)
    const aging = visible(list, now)
    // A row ages out with no state change to redraw the pane, so a timer does it.
    paneExpiry?.cancel()
    const due = nextRedraw(aging, now, false)
    paneExpiry = due === undefined ? undefined : $.clock.after(due, () => $.ui.invalidate('ui.render'))
    const rows = aging.filter(t => isOpen(t) || (t.endedAt ?? t.startedAt) > view.clearedAt)
    return paneTree($.ui.resolve(e), { surface: e.surface, width: e.props.bodyColumns, height: e.props.scroll.bodyRows, now, anim: ui.animations, pal, workers: shown, rows, durations, view, drafts, ...(lan.address ? { lan } : {}) }, act)
  })

  on('tool.call', { tool: 'mcp__a2a-mod__workers' }, async $ => {
    const all = Object.values(await loadWorkers(hostOf($, settingTokens, ui)))
    const lan = await read($, lanView)
    const text = all.length
      ? all.map(w => `${w.alias}: ${w.name}. ${w.description}\n  skills: ${w.skills.map(s => `${s.id} (${s.description || s.name})`).join('; ') || 'none listed'}`).join('\n')
      : 'No workers registered. Ask the user to run /a2a add <url>.'
    return { result: lan.address ? `${text}\n\n${peerSection(lan.address, lan.peers)}` : text }
  })

  // The sidecar's tools are the mod's own plumbing: the model draining the inbox would lose messages.
  on('tool.check', { tool: ['mcp__plugin_a2a-mod_lan__status', 'mcp__plugin_a2a-mod_lan__peers', 'mcp__plugin_a2a-mod_lan__inbox', 'mcp__plugin_a2a-mod_lan__send'] },
    (_$, _e, next) => (next.origin.plugin === 'a2a-mod' ? { decision: 'allow' } : { decision: 'deny', reason: SIDECAR_DENY }))

  // The listing is the engine's; ours goes after it, and a sidecar that fails costs one line at most.
  on('tool.call', { tool: 'ListAgents' }, async ($, e, next) => {
    const out = await next(e)
    if (out.deny !== undefined || out.isError || typeof out.result?.listing !== 'string') return out
    const workers = Object.values(await loadWorkers(hostOf($, settingTokens, ui))).sort((a, b) => a.addedAt - b.addedAt)
    const lan = await lanNow($)
    const sections = agentSections(lanWanted ? lan : { ...lan, down: undefined }, workers)
    if (!sections.length) return out
    // A fresh object: the one next gave carries core's ref, and core would send its own listing.
    return { result: { ...out.result, listing: [out.result.listing, ...sections].join('\n\n') } }
  })

  on('tool.call', { tool: 'SendMessage' }, async ($, e, next) => {
    const to = e.to
    if (!isA2a(to) && !isLan(to)) return next(e)
    // The tool's structured messages (shutdown requests and the like) are for teammates, not peers.
    const message = typeof e.message === 'string' ? e.message : JSON.stringify(e.message)
    if (isA2a(to)) return { result: await sendTask($, hostOf($, settingTokens, ui), e.tool_use_id, next, { worker: to.slice('a2a:'.length), message }) }
    return { result: sentText(to, await lanSend($, { to, text: message })) }
  })

  on('tool.call', { tool: 'SendFile' }, async ($, e, next) => {
    if (!isLan(e.to)) return next(e)
    return { result: sendFileResult(e.to, await lanSend($, { to: e.to, text: e.message ?? '', files: e.files })) }
  })

  on('tool.call', { tool: 'mcp__a2a-mod__send_file' }, async ($, e) => {
    const input = e as unknown as { to?: unknown; files?: unknown; message?: unknown }
    const to = String(input.to ?? '')
    if (!isLan(to)) return { result: `a2a lan: send_file takes a lan:<name> address from ListAgents, not ${to || 'nothing'}.` }
    const files = Array.isArray(input.files) ? input.files.map(String) : []
    return { result: sendFileResult(to, await lanSend($, { to, text: String(input.message ?? ''), files })) }
  })

  on('tool.call', { tool: 'mcp__a2a-mod__add_worker' }, async ($, e) =>
    ({ result: await addWorkerTool(hostOf($, settingTokens, ui), confirmOf($), e as unknown as { url?: unknown; alias?: unknown }) }))

  on('tool.call', { tool: 'mcp__a2a-mod__remove_worker' }, async ($, e) =>
    ({ result: await removeWorkerTool(hostOf($, settingTokens, ui), confirmOf($), e as unknown as { alias?: unknown }) }))

  on('tool.call', { tool: 'mcp__a2a-mod__send' }, async ($, e, next) => {
    const input = e as unknown as SendInput
    return { result: await sendTask($, hostOf($, settingTokens, ui), e.tool_use_id, next, input) }
  })

  on('tool.call', { tool: 'mcp__a2a-mod__task' }, async ($, e, next) => {
    const input = e as unknown as { worker?: string; taskId?: string; cancel?: boolean }
    const host = hostOf($, settingTokens, ui)
    const w = await workerOr(host, input.worker)
    if (typeof w === 'string') return { result: w }
    try {
      const fetch = host.fetch
      const t = await bounded($, next.budget.remainingMs, next.signal, w.alias, targetOf(host, w))
      const out = await bounded($, next.budget.remainingMs, next.signal, w.alias, input.cancel ? cancelTask(fetch, t, String(input.taskId)) : getTask(fetch, t, String(input.taskId)))
      return { result: describeOutcome(w.alias, out, FULL_MAX) }
    } catch (err) {
      noteFailure(w, err)
      if (err instanceof A2AError) return { result: `a2a: ${err.message}` }
      throw err
    }
  })
}
