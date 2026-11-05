import { and, eq, gte, lte, ne } from 'drizzle-orm'
import { addDays, diffDays, weekday } from '../../shared/utils/dates'
import { platformOf } from '../../shared/utils/drafting'
import { WEIGHT_PER_WEEK } from '../../shared/utils/plan'
import { WEEKDAY_CODES } from '../../shared/utils/recurrence'
import { promoDayOk, rulesText, subKey, type SubRules } from '../../shared/utils/subreddit'
import type { StrategyChannel } from '../db/schema'
import { today as todayIn } from './clock'
import type { DbOrTx } from './db'
import { schema } from './db'
import { activeStrategy } from './strategy'
import { cachedRules, taskSub } from './subreddit-rules'

type Workspace = typeof schema.workspaces.$inferSelect
type Task = typeof schema.tasks.$inferSelect

const DAY_SHORT = ['', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So']
const DAY_LONG = ['', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag']

export function dayLabel(d: string): string {
  const [, m, day] = d.split('-')
  return `${DAY_SHORT[weekday(d)]} ${Number(day)}.${Number(m)}.`
}

export interface SuggestInput {
  today: string
  gap: number
  days: number[]
  busy: string[]
  rules?: Pick<SubRules, 'promo' | 'days'> | null
}

// Nächster sinnvoller Tag nach heute: Abstand zu anderen Beiträgen im Kanal (und zu heute), Subreddit-Regeln, bevorzugte Wochentage.
export function suggestDay(i: SuggestInput): string {
  const taken = [i.today, ...i.busy]
  const free = (d: string) => taken.every(b => Math.abs(diffDays(d, b)) >= i.gap) && (!i.rules || promoDayOk(i.rules, d))
  for (const strict of [true, false]) {
    for (let n = 1; n <= 28; n++) {
      const d = addDays(i.today, n)
      if (strict && i.days.length && !i.days.includes(weekday(d))) continue
      if (free(d)) return d
    }
  }
  return addDays(i.today, Math.max(1, i.gap))
}

export interface MoveContext {
  today: string
  suggest: string
  text: string
}

function channelOf(channels: StrategyChannel[], task: Task): StrategyChannel | null {
  return channels.find(c => c.key === task.strategyChannel) ?? channels.find(c => !!task.channel && c.name === task.channel) ?? null
}

// Termin-Kontext für den Aufgaben-Chat: heute, Takt, Regeln, andere Beiträge im Kanal und ein Vorschlag fürs Verschieben.
export async function moveContext(db: DbOrTx, ws: Workspace, task: Task): Promise<MoveContext> {
  const today = todayIn(ws.timezone)
  const strategy = task.projectId ? await activeStrategy(db, task.projectId) : null
  const channel = channelOf((strategy?.channels ?? []) as StrategyChannel[], task)
  const perWeek = channel?.active ? WEIGHT_PER_WEEK[channel.weight] ?? 0 : 0
  const sub = taskSub(task)
  const rules = sub ? cachedRules(ws, sub) : null
  const platform = platformOf(task)
  const community = task.category === 'community' || platform === 'reddit'
  const gap = Math.min(7, Math.max(community ? 3 : 1, perWeek ? Math.floor(3.5 / perWeek) : 0))
  const days = (channel?.days ?? []).map(d => (WEEKDAY_CODES as readonly string[]).indexOf(d.toUpperCase()) + 1).filter(n => n > 0)
  const others = task.projectId
    ? await db.select({ id: schema.tasks.id, code: schema.tasks.code, title: schema.tasks.title, dueDate: schema.tasks.dueDate, status: schema.tasks.status, channel: schema.tasks.channel, strategyChannel: schema.tasks.strategyChannel, targetUrl: schema.tasks.targetUrl, category: schema.tasks.category, description: schema.tasks.description })
      .from(schema.tasks)
      .where(and(eq(schema.tasks.projectId, task.projectId), ne(schema.tasks.id, task.id), ne(schema.tasks.status, 'verworfen'), gte(schema.tasks.dueDate, addDays(today, -7)), lte(schema.tasks.dueDate, addDays(today, 35))))
    : []
  const same = others.filter((o) => {
    if (task.strategyChannel && o.strategyChannel === task.strategyChannel) return true
    if (!platform || platformOf(o) !== platform) return false
    const s = taskSub(o)
    return !sub || !s || subKey(s) === subKey(sub)
  }).sort((a, b) => a.dueDate!.localeCompare(b.dueDate!))
  const suggest = suggestDay({ today, gap, days, busy: same.map(o => o.dueDate!), rules })
  const lines = [
    `Heute: ${today} (${DAY_LONG[weekday(today)]})`,
    channel ? `Takt des Kanals "${channel.name}": etwa ${perWeek >= 1 ? `${perWeek}x pro Woche` : `alle ${Math.round(7 / (perWeek || 0.25))} Tage`}${days.length ? `, bevorzugt ${days.map(d => DAY_SHORT[d]).join('/')}` : ''}` : '',
    rules ? `Regeln von r/${rules.sub}: ${rulesText(rules).replace(/\s+/g, ' ').slice(0, 400)}` : '',
    `Mindestabstand im Kanal: ${gap} Tag${gap === 1 ? '' : 'e'}`,
    same.length ? `Andere Beiträge im Kanal:\n${same.slice(0, 8).map(o => `- ${o.dueDate} ${dayLabel(o.dueDate!)}: ${o.code} ${o.title}${o.status === 'erledigt' ? ' (erledigt)' : ''}`).join('\n')}` : 'Keine anderen Beiträge im Kanal geplant.',
    `Nächster sinnvoller Tag zum Verschieben: ${suggest} (${dayLabel(suggest)})`,
  ]
  return { today, suggest, text: lines.filter(Boolean).join('\n') }
}
