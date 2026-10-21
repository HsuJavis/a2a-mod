import type { Worker } from '../types/index.d.ts'

// The registered workers as the engine's own agent tools see them: ListAgents and /list-agents list
// them as a2a:<alias>, and SendMessage to one goes through this mod. Every other recipient is the engine's.

export const isA2a = (to: unknown): boolean => typeof to === 'string' && to.startsWith('a2a:')

/** The section ListAgents and /list-agents gain: the registered workers, or nothing when there are none. */
export function workersSection(workers: Worker[]): string | undefined {
  if (!workers.length) return undefined
  return [
    'A2A workers (a2a-mod; SendMessage with to: "a2a:<alias>"):',
    ...workers.map(w => `  a2a:${w.alias}  ${w.name}. ${w.description}`.trimEnd()),
  ].join('\n')
}
