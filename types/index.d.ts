export type ProtocolVersion = '1.0' | '0.3'

export type Skill = { id: string; name: string; description: string }

/**
 * Where a worker's token comes from. The value itself is never stored here:
 * `setting` looks the alias up in the plugin's sensitive `tokens` setting.
 */
export type TokenSource =
  | { kind: 'setting' }
  | { kind: 'cmd'; cmd: string }
  | { kind: 'file'; path: string }

export type Worker = {
  alias: string
  name: string
  description: string
  cardUrl: string
  endpoint: string
  version: ProtocolVersion
  skills: Skill[]
  /** The card names a security requirement. */
  needsAuth: boolean
  auth: TokenSource
  trustedOrigin?: string
  /** The card's `provider.organization`. */
  organization?: string
  addedAt: number
}

/** A worker with its token resolved for one call. Never stored. */
export type Target = Worker & { token?: string }

export type TaskState =
  | 'submitted' | 'working' | 'completed' | 'failed' | 'canceled'
  | 'rejected' | 'input-required' | 'auth-required' | 'unknown'

export type Outcome =
  | { kind: 'message'; contextId?: string; text: string }
  | { kind: 'task'; taskId: string; contextId?: string; state: TaskState; text: string }

export type TaskOutcome = Extract<Outcome, { kind: 'task' }>

export type TrackedTask = {
  worker: string
  taskId: string
  contextId?: string
  state: TaskState
  startedAt: number
  failures: number
}

/** A task as the UI lists it: its A2A state, or `removed` when its worker was removed mid-task. */
export type RecentState = TaskState | 'removed'

export type RecentTask = {
  worker: string
  /** The A2A task id; for a send answered with a message, the tool call's id. */
  taskId: string
  contextId?: string
  /** The message that started the task. */
  text: string
  state: RecentState
  startedAt: number
  /** When `state` last changed: the row's dot pulses for a second after it. */
  changedAt: number
  endedAt?: number
  /** The result, or the worker's question while waiting; at most 10,000 characters. */
  result?: string
  /** Who answered first while the task was waiting. */
  answeredBy?: 'user' | 'claude'
  /** Set by Cancel until a poll reports how the task ended. */
  canceling?: true
  /** The last `N%` a live task's status message carried. */
  progress?: number
  /** A live task's latest status message, cut short. */
  message?: string
}

/** What one send tool call came to, keyed by its tool_use_id. */
export type CallInfo = { worker: string; taskId?: string; state: RecentState; startedAt: number }

/**
 * What the person has done to the pane. `open` holds the one task whose detail shows and `replying` the
 * tasks with a Reply field; `collapsed` and `all` hold worker aliases (box folded to one line; more than
 * three tasks listed); `clearedAt` hides tasks that finished by then.
 */
export type PaneView = { open: string[]; replying: string[]; collapsed: string[]; all: string[]; clearedAt: number }

/** A reply the user sent from the pane, told to Claude with their next prompt. */
export type SentReply = { worker: string; taskId: string; text: string }

/** A Claude Code session the LAN sidecar discovered, by the address SendMessage takes (`lan:<name>`). */
export type LanPeer = { address: string; name: string; host: string; port: number }

/** One file a LAN message carried, as the sidecar saved it: `path` and `sha256` once downloaded, `error` when not. */
export type LanFile = { name: string; path?: string; size?: number; sha256?: string; error?: string }

/**
 * A message another session sent here. `from` is `lan:<name>`, or `a2a:<ip>` for any other A2A client;
 * `host` the IP it came from; `authenticated` true only when it carried the shared secret.
 */
export type LanMessage = { from: string; host?: string; authenticated?: boolean; text: string; files: LanFile[]; receivedAt: number }

/** LAN mode as the pane draws it: this session's address (empty while off), the peers seen, the last messages in. */
export type LanView = { address: string; peers: LanPeer[]; received: LanMessage[] }

declare module 'claude-code' {
  interface PluginState {
    'a2a-mod': {
      tasks: TrackedTask[]
      recent: RecentTask[]
      calls: Record<string, CallInfo>
      /** Task ids (or tool call ids) whose result has typed itself in once. */
      played: string[]
      pane: PaneView
      replies: SentReply[]
      lan: LanView
    }
  }
}
