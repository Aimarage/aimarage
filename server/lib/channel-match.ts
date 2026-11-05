import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm'
import { openStaleHint, STALE_HINT, STALE_KEEP } from '../../shared/utils/stale'
import type { StrategyChannel } from '../db/schema'
import { now } from './clock'
import type { DbOrTx } from './db'
import { schema } from './db'
import { channelPlatforms, mentionedPlatforms } from './plan-guard'

export interface ChannelTask {
  category: string
  channel?: string | null
  title: string
  targetUrl?: string | null
  draftKind?: string | null
}

export interface ChannelMatch {
  // Eindeutig passender neuer Kanal, sonst null.
  channel: StrategyChannel | null
  // Gibt es die Plattform bzw. Inhaltsart in der Strategie noch (auch wenn nicht eindeutig)?
  covered: boolean
}

const CONTENT = (t: Pick<ChannelTask, 'category' | 'draftKind'>) => t.category === 'content' || t.draftKind === 'article'

function platformsOfChannel(c: Pick<StrategyChannel, 'name' | 'places'>): string[] {
  return [...new Set([...channelPlatforms(c), ...mentionedPlatforms([c.name, ...(c.places ?? [])].join(' '))])].filter(p => p !== 'reddit')
}

function words(s: string | null | undefined): string[] {
  return (s ?? '').toLowerCase().split(/[^\p{L}\d]+/u).filter(w => w.length >= 3)
}

function byName(cands: StrategyChannel[], oldName: string | null | undefined): StrategyChannel | null {
  const a = new Set(words(oldName))
  if (!a.size) return null
  const scored = cands.map(c => ({ c, n: words(c.name).filter(w => a.has(w)).length })).sort((x, y) => y.n - x.n)
  return scored[0] && scored[0].n > 0 && scored[0].n > (scored[1]?.n ?? 0) ? scored[0].c : null
}

// Neuer Kanal für eine Aufgabe, deren Kanal es nach einem Strategiewechsel nicht mehr gibt.
// Zugeordnet wird nach Plattform (Social) bzw. Inhaltsart (Kategorie), nicht nach dem Kanalnamen.
export function matchChannel(task: ChannelTask, platforms: string[], channels: StrategyChannel[], oldName?: string | null): ChannelMatch {
  const active = channels.filter(c => c.active)
  const category = CONTENT(task) ? 'content' : task.category
  const same = active.filter(c => c.category === category)
  const own = [...new Set([...platforms, ...mentionedPlatforms([task.channel ?? '', task.title, task.targetUrl ?? ''].join(' '))])].filter(p => p !== 'reddit' && p !== 'forum')
  if (category === 'social' && own.length) {
    const scored = active.map(c => ({ c, n: platformsOfChannel(c).filter(p => own.includes(p)).length })).filter(s => s.n > 0).sort((x, y) => y.n - x.n)
    if (scored.length) {
      const top = scored.filter(s => s.n === scored[0]!.n).map(s => s.c)
      return { channel: top.length === 1 ? top[0]! : byName(top, oldName), covered: true }
    }
    const generic = same.filter(c => !platformsOfChannel(c).length)
    return { channel: generic.length === 1 ? generic[0]! : null, covered: generic.length > 0 }
  }
  if (!same.length) return { channel: null, covered: false }
  return { channel: same.length === 1 ? same[0]! : byName(same, oldName), covered: true }
}

// Offene Aufgaben aus weggefallenen Kanälen auf den passenden neuen Kanal umhängen.
// Ein offener Hinweis "Passt nicht mehr zur Strategie" wird dabei mit "Behalten" erledigt.
export async function remapTasks(db: DbOrTx, projectId: string, channels: StrategyChannel[], oldNames: Map<string, string> = new Map()): Promise<string[]> {
  const keys = channels.map(c => c.key)
  if (!keys.length) return []
  const rows = await db.select().from(schema.tasks).where(and(
    eq(schema.tasks.projectId, projectId),
    inArray(schema.tasks.status, ['geplant', 'entwurf_fertig', 'freigegeben']),
    isNotNull(schema.tasks.strategyChannel),
    sql`${schema.tasks.strategyChannel} not in (${sql.join(keys.map(k => sql`${k}`), sql`, `)})`,
  )).limit(300)
  if (!rows.length) return []
  const ids = rows.map(r => r.id)
  const drafts = await db.select({ taskId: schema.drafts.taskId, platforms: schema.drafts.platforms }).from(schema.drafts).where(and(inArray(schema.drafts.taskId, ids), inArray(schema.drafts.status, ['offen', 'freigegeben']))).orderBy(desc(schema.drafts.version))
  const notes = await db.select({ taskId: schema.taskNotes.taskId, text: schema.taskNotes.text, createdAt: schema.taskNotes.createdAt }).from(schema.taskNotes).where(inArray(schema.taskNotes.taskId, ids))
  const moved: string[] = []
  for (const t of rows) {
    const oldName = oldNames.get(t.strategyChannel!) ?? null
    const platforms = drafts.find(d => d.taskId === t.id)?.platforms ?? []
    const m = matchChannel(t, platforms, channels, oldName ?? t.channel)
    if (!m.channel) continue
    const rename = !t.channel || (!!oldName && t.channel.trim().toLowerCase() === oldName.trim().toLowerCase())
    await db.update(schema.tasks).set({ strategyChannel: m.channel.key, ...(rename ? { channel: m.channel.name } : {}), updatedAt: now() }).where(eq(schema.tasks.id, t.id))
    if (openStaleHint(notes.filter(n => n.taskId === t.id))) {
      await db.insert(schema.taskNotes).values({ taskId: t.id, byAgent: true, text: `${STALE_KEEP} Kanal${oldName ? ` "${oldName}"` : ''} heißt jetzt "${m.channel.name}", Aufgabe dorthin umgehängt.`, createdAt: now() })
    }
    moved.push(t.code)
  }
  return moved
}

// Hinweis "Kanal ... steht nicht mehr in der Strategie" erledigen, wenn die Aufgabe inzwischen in einem aktiven Kanal hängt.
export async function settleChannelHints(db: DbOrTx, projectId: string, channels: StrategyChannel[]): Promise<string[]> {
  const keys = channels.filter(c => c.active).map(c => c.key)
  if (!keys.length) return []
  const rows = await db.select({ id: schema.tasks.id, code: schema.tasks.code, key: schema.tasks.strategyChannel }).from(schema.tasks)
    .innerJoin(schema.taskNotes, eq(schema.taskNotes.taskId, schema.tasks.id))
    .where(and(
      eq(schema.tasks.projectId, projectId),
      inArray(schema.tasks.status, ['geplant', 'entwurf_fertig', 'freigegeben']),
      inArray(schema.tasks.strategyChannel, keys),
      sql`${schema.taskNotes.text} like ${`${STALE_HINT}%steht nicht mehr in der Strategie%`}`,
    ))
  const done: string[] = []
  for (const t of new Map(rows.map(r => [r.id, r])).values()) {
    const notes = await db.select({ text: schema.taskNotes.text, createdAt: schema.taskNotes.createdAt }).from(schema.taskNotes).where(eq(schema.taskNotes.taskId, t.id))
    const hint = openStaleHint(notes)
    if (!hint || !/steht nicht mehr in der Strategie/.test(hint)) continue
    const name = channels.find(c => c.key === t.key)?.name
    await db.insert(schema.taskNotes).values({ taskId: t.id, byAgent: true, text: `${STALE_KEEP} Aufgabe hängt jetzt im Kanal "${name}", passt weiter zur Strategie.`, createdAt: now() })
    done.push(t.code)
  }
  return done
}

// Alte Kanalnamen je Schlüssel aus den letzten Strategie-Fassungen.
export async function oldChannelNames(db: DbOrTx, projectId: string): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  for (const v of await db.select({ channels: schema.strategies.channels }).from(schema.strategies).where(eq(schema.strategies.projectId, projectId)).orderBy(desc(schema.strategies.version)).limit(12)) {
    for (const c of v.channels) if (!out.has(c.key)) out.set(c.key, c.name)
  }
  return out
}
