import type { Worker } from '../types/index.d.ts'
import type { FileIn } from './wire.ts'
import { endpointLine, waitingSection, type ServerStatus } from './inbound.ts'

// The registered workers as the engine's own agent tools see them: ListAgents and /list-agents list
// them as a2a:<alias>, and SendMessage or SendFile to one goes through this mod. Every other recipient is the engine's.

export const isA2a = (to: unknown): boolean => typeof to === 'string' && to.startsWith('a2a:')

const SEND_TO = 'SendMessage or SendFile with to: "a2a:<alias>"'

/**
 * The sections ListAgents and /list-agents gain: this session's own endpoint while it serves one,
 * the registered Claude Code sessions, the registered workers, and the tasks waiting for Claude's
 * reply. Empty when there is none of these.
 */
export function agentSections(workers: Worker[], server?: ServerStatus): string[] {
  const out: string[] = []
  if (server?.on) out.push(endpointLine(server))
  const sessions = workers.filter(w => w.kind === 'claude-session')
  const others = workers.filter(w => w.kind !== 'claude-session')
  if (sessions.length) out.push([`Claude Code sessions (a2a-mod; ${SEND_TO}):`, ...sessions.map(w => `  a2a:${w.alias}  ${w.name}`)].join('\n'))
  if (others.length) out.push([`A2A workers (a2a-mod; ${SEND_TO}):`, ...others.map(w => `  a2a:${w.alias}  ${w.name}. ${w.description}`.trimEnd())].join('\n'))
  const waiting = server?.on ? waitingSection(server) : undefined
  if (waiting) out.push(waiting)
  return out
}

/** Whether a send's answer is a send, not a refusal: the worker send's failures start so. */
export const sentOk = (text: string) => !/^(a2a: |No worker)/.test(text)

const MiB = 1024 * 1024
/** What one $.fs.read takes: the engine rejects a bigger file. */
export const FILE_MAX = 4 * MiB
/** All the files of one send, inline in one request. */
export const TOTAL_MAX = 10 * MiB

const MEDIA: Record<string, string> = {
  txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', html: 'text/html', json: 'application/json', xml: 'application/xml',
  pdf: 'application/pdf', zip: 'application/zip', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', mp3: 'audio/mpeg', wav: 'audio/wav', mp4: 'video/mp4',
}

const nameOf = (path: string) => path.split(/[\\/]/).pop() || path
const mediaOf = (name: string) => MEDIA[/\.([^.]+)$/.exec(name)?.[1]?.toLowerCase() ?? ''] ?? 'application/octet-stream'

async function sha256(base64: string): Promise<string> {
  const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0))
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('')
}

/** One file's outcome, as SendFile reports it. */
export type FileOut = { path: string; size?: number; sha256?: string; error?: string }
/** SendFile's own result shape. */
export type SendFileOut = { success: boolean; message: string; files: FileOut[] }
/** How the files are read: $.fs, handed in by register.ts. */
export type FileReader = { stat: (path: string) => Promise<{ kind: string; size: number }>; bytes: (path: string) => Promise<string> }

const why = (err: unknown) => (err instanceof Error ? err.message : String(err))

/** The files that can be sent, in order, and every path's outcome. A file that cannot be read is skipped. */
export async function readFiles(fs: FileReader, paths: string[]): Promise<{ files: FileIn[]; out: FileOut[] }> {
  const files: FileIn[] = []
  const out: FileOut[] = []
  let total = 0
  for (const path of paths) {
    try {
      const st = await fs.stat(path)
      if (st.kind !== 'file') { out.push({ path, error: 'not a file' }); continue }
      if (st.size > FILE_MAX) { out.push({ path, size: st.size, error: 'over 4 MiB, the most one file read takes' }); continue }
      if (total + st.size > TOTAL_MAX) { out.push({ path, size: st.size, error: 'past 10 MiB for the files of one send' }); continue }
      const base64 = await fs.bytes(path)
      total += st.size
      const name = nameOf(path)
      files.push({ name, mediaType: mediaOf(name), base64 })
      out.push({ path, size: st.size, sha256: await sha256(base64) })
    } catch (err) {
      out.push({ path, error: `could not read it: ${why(err)}` })
    }
  }
  return { files, out }
}

/** send_file's answer: a registered tool's result is text. */
export const sendFileText = (r: SendFileOut) =>
  [r.message, ...r.files.map(f => (f.error ? `  ${f.path}: ${f.error}` : `  ${f.path} (${f.size ?? '?'} bytes, sha256 ${f.sha256 ?? '?'})`))].join('\n')
