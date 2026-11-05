import { AsyncLocalStorage } from 'node:async_hooks'
import type { ChatResult } from './llm'

// Zählt jeden LLM-Aufruf innerhalb eines Laufs (agent_runs), auch wenn der Aufrufer die Kosten nicht weiterreicht,
// und prüft vor jedem Aufruf das KI-Budget des Workspace.

export interface LlmMeter {
  workspaceId: string
  calls: ChatResult[]
  check?: () => Promise<void>
  blocked?: Error
  ownKeyError?: Error
  parent?: LlmMeter
}

const store = new AsyncLocalStorage<LlmMeter>()

export function withMeter<T>(meter: LlmMeter, fn: () => Promise<T>): Promise<T> {
  meter.parent ??= store.getStore()
  return store.run(meter, fn)
}

export function currentMeter(): LlmMeter | undefined {
  return store.getStore()
}

// own: Aufruf über den eigenen Schlüssel des Kunden, zählt nicht ins KI-Budget des Tarifs.
export async function meterCheck(own = false): Promise<void> {
  const m = store.getStore()
  if (!m?.check || own) return
  if (m.blocked) throw m.blocked
  try {
    await m.check()
  }
  catch (err) {
    for (let x: LlmMeter | undefined = m; x; x = x.parent) x.blocked ??= err as Error
    throw err
  }
}

export function meterRecord(res: ChatResult | ChatResult[] | undefined | null): void {
  const m = store.getStore()
  if (!m || !res) return
  for (const r of Array.isArray(res) ? res : [res]) if (r && !m.calls.includes(r)) m.calls.push(r)
}

export function unmetered(meter: LlmMeter, counted: ChatResult[]): ChatResult[] {
  const seen = new Set(counted)
  return meter.calls.filter(c => !seen.has(c))
}

export function meterOwnKeyError(err: Error): void {
  for (let x: LlmMeter | undefined = store.getStore(); x; x = x.parent) x.ownKeyError ??= err
}

export function costSplit(calls: ChatResult[]): { costEur: number, ownCostEur: number } {
  const round = (n: number) => Math.round(n * 1e6) / 1e6
  return {
    costEur: round(calls.reduce((s, c) => s + c.costEur, 0)),
    ownCostEur: round(calls.reduce((s, c) => s + (c.own ? c.costEur : 0), 0)),
  }
}
