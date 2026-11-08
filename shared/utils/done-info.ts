// Was zu einer erledigten Aufgabe bekannt ist: wann, wer, was gemacht wurde (Notiz oder Prüfung) und der Status davor (für den ursprünglichen "Das ist zu tun"-Satz).

export type DoneActor = 'user' | 'agent' | 'mcp' | 'system'

export interface DoneEvent {
  action: string
  actor: string
  userId: string | null
  detail: Record<string, unknown>
  createdAt: string
}

export interface DoneNote {
  text: string
  byAgent: boolean
  userId: string | null
  createdAt: string
}

export interface DoneInfo {
  at: string | null
  actor: DoneActor | null
  userId: string | null
  note: string | null
  checked: string[]
  from: string | null
}

const SLACK_MS = 2 * 60_000
const CHECKED = ['task_checked', 'task_checked_auto']
const DONE = ['status:erledigt', 'status:ausgewertet']
const ACTORS: DoneActor[] = ['user', 'agent', 'mcp', 'system']

const ms = (iso: string) => new Date(iso).getTime()

export function doneInfo(history: DoneEvent[], notes: DoneNote[], doneAt: string | null): DoneInfo {
  const byTime = [...history].sort((a, b) => ms(b.createdAt) - ms(a.createdAt))
  const ev = byTime.find(h => h.action === 'status:erledigt') ?? byTime.find(h => DONE.includes(h.action)) ?? null
  const at = doneAt ?? ev?.createdAt ?? null
  const since = at ? ms(at) - SLACK_MS : null
  const near = (iso: string) => since === null || ms(iso) >= since
  const check = byTime.find(h => CHECKED.includes(h.action) && near(h.createdAt)) ?? null
  const actorOf = (h: DoneEvent | null): DoneActor | null => (h && (ACTORS as string[]).includes(h.actor) ? h.actor as DoneActor : null)
  const actor = check?.actor === 'mcp' ? 'mcp' : actorOf(ev) ?? actorOf(check)
  const userId = actor === 'user' ? (ev?.userId ?? check?.userId ?? null) : null
  const note = [...notes].filter(n => near(n.createdAt) && n.text.trim()).sort((a, b) => ms(b.createdAt) - ms(a.createdAt))[0]?.text.trim() ?? null
  const items = Array.isArray(check?.detail.items) ? (check!.detail.items as unknown[]).filter((i): i is string => typeof i === 'string' && !!i.trim()) : []
  const change = (ev?.detail.changes as { status?: { from?: unknown } } | undefined)?.status?.from
  return { at, actor, userId, note, checked: items, from: typeof change === 'string' ? change : null }
}
