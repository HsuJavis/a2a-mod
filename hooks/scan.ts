import type { ScanHit, ScanState } from '../types/index.d.ts'
import type { Fetcher } from './client.ts'

const todo = (): never => { throw new Error('not implemented') }

export const DEFAULT_PORTS = [80, 443, 8000, 8080, 41241] as const
export const MAX_PROBES = 0
export const CONCURRENCY = 0
export const MAX_IN_FLIGHT = 0
export const PROBE_TIMEOUT_MS = 0
export type Hosts = { first: number; last: number; count: number }
export type Plan = { target: string; hosts: Hosts; ports: number[]; https: boolean; total: number }
export type Progress = { done: number; total: number; hits: ScanHit[]; stopped: boolean; finished: boolean }
export type PumpDeps = {
  fetch: Fetcher; sleep(ms: number, signal?: AbortSignal): Promise<void>; now(): number; known: ReadonlyMap<string, string>
  stopped(): boolean; onProgress(p: Progress): unknown; concurrency?: number; maxInFlight?: number; timeoutMs?: number; progressMs?: number
}
export const parseTarget = (_s: string): Hosts | string => todo()
export const parsePorts = (_s: string): number[] | string => todo()
export const ipText = (_n: number): string => todo()
export const planScan = (_w: string[]): Plan | string => todo()
export const probeBase = (_p: Plan, _i: number): string => todo()
export const runScan = async (_p: Plan, _d: PumpDeps): Promise<Progress> => todo()
export const progressLine = (_s: ScanState): string => todo()
export const aliasesFor = (_h: readonly ScanHit[], _a: readonly string[], _t: Readonly<Record<string, string>>): Map<string, string> => todo()
export const resultsText = (_s: ScanState, _a: readonly string[], _t: Readonly<Record<string, string>>): string => todo()
