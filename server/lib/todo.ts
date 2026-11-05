import { and, eq, ilike } from 'drizzle-orm'
import { nextPromoDay, promoDayOk, subKey } from '../../shared/utils/subreddit'
import { weekday } from '../../shared/utils/dates'
import type { TodoOut } from '../../shared/utils/todo'
import type { TaskRoute } from '../../shared/utils/task-state'
import type { TaskWhere } from '../../shared/utils/where'
import type { DbOrTx } from './db'
import { schema } from './db'
import { blogApiReady, isArticleTask } from './blog-api'
import { replyAccount } from './listen-account'
import { mailReady } from './mail'
import { canPublishTask } from './outlets'
import { socialTarget, targetAccounts } from './publish'
import { routeOf } from './route'
import { cachedRules, isRedditPost } from './subreddit-rules'
import { today } from './clock'
import { isCommunitySweep } from '../../shared/utils/community-sweep'

type Workspace = typeof schema.workspaces.$inferSelect
type Project = typeof schema.projects.$inferSelect
type Task = typeof schema.tasks.$inferSelect

export interface TodoServerFacts {
  out: TodoOut
  route: TaskRoute
  flair: string | null
  flairRequired: boolean
  waitDay: number | null
  account: string | null
  accountFree: boolean
  sweep: boolean
}

const ACCOUNT_TASK = /\b(konto|konten|account|accounts|profil|profile)\b[^.]{0,40}\b(anlegen|erstellen|einrichten|registrieren|eröffnen)|\b(registrier\w*|sign ?up|create (an )?accounts?)\b|\banlegen\b[^.]{0,20}\b(konto|konten|account)/i

// Konto-Aufgaben ("Konten anlegen für Reddit/HN"): wo das Konto angelegt wird, sonst null.
export function accountPlace(t: Pick<Task, 'title' | 'humanStep' | 'channel'>, place: string | null): string | null {
  if (!ACCOUNT_TASK.test(`${t.title} ${t.humanStep ?? ''}`)) return null
  const fromTitle = /\b(?:für|bei|auf|for|on)\s+(.+)$/i.exec(t.title)?.[1]?.trim()
  return place?.trim() || t.channel?.trim() || fromTitle || ''
}

const FLAIR = /flair\s*(?:[:=]|wählen:?|auswählen:?|setzen:?|pick:?)?\s*(?:["„“'»]([^"“”'«\n]{1,40})["“”'«]|([A-Za-z0-9][^\n.,;:)("“”]{0,39}))/i
const FLAIR_SKIP = /^(pflicht|required|nötig|empfohlen|recommended|wählen|setzen|auswählen|ist|is|muss|must|the|das|ein|a|wird|nicht|not|optional)(\s|$)/i

// Flair aus freiem Text ("Flair: Wednesday Exceptions", "mit Flair \"X\"").
export function flairIn(...texts: (string | null | undefined)[]): string | null {
  for (const s of texts) {
    const m = s ? FLAIR.exec(s) : null
    const v = (m?.[1] ?? m?.[2])?.trim()
    if (v && !FLAIR_SKIP.test(v)) return v
  }
  return null
}

export function todoOut(ws: Workspace, project: Project | null, t: Task, draftKind?: string | null): TodoOut {
  if ((draftKind ?? t.draftKind) === 'mail') return mailReady(project) ? 'mail' : 'mailSelf'
  if (replyAccount(ws, project, t)?.connected) return 'reply'
  const target = project ? socialTarget(ws, project) : null
  if (canPublishTask(t) && targetAccounts(target, t).length > 0) return 'auto'
  if (isArticleTask(t, draftKind ? { kind: draftKind as never } : null) && blogApiReady(project)) return 'blog'
  return 'self'
}

// Was nur der Server weiß: wie es rausgeht, Subreddit-Flair und erlaubter Wochentag.
export async function todoFacts(db: DbOrTx, ws: Workspace, project: Project | null, t: Task, where: TaskWhere, draftKind?: string | null, texts: (string | null | undefined)[] = []): Promise<TodoServerFacts> {
  const target = project ? socialTarget(ws, project) : null
  const outlet = canPublishTask(t) && targetAccounts(target, t).length > 0
  const sub = where.mark === 'reddit' && where.place?.startsWith('r/') ? where.place : null
  const rules = sub ? cachedRules(ws, sub) : null
  let flair = rules?.flair?.trim() || flairIn(t.humanStep, t.description, ...texts)
  if (!flair && sub && project) {
    const mem = await db.select({ text: schema.projectMemory.text }).from(schema.projectMemory)
      .where(and(eq(schema.projectMemory.projectId, project.id), ilike(schema.projectMemory.text, `%${subKey(sub)}%`), ilike(schema.projectMemory.text, '%flair%'))).limit(5)
    flair = flairIn(...mem.map(m => m.text))
  }
  const day = today(ws.timezone)
  const waitDay = rules && isRedditPost({ ...t, draftKind: (draftKind ?? t.draftKind) as Task['draftKind'] }) && !promoDayOk(rules, day) ? weekday(nextPromoDay(rules, day)) : null
  const account = accountPlace(t, where.place)
  const cost = t.service?.cost ?? ''
  return { out: todoOut(ws, project, t, draftKind), route: routeOf(t, project, outlet), flair: sub ? flair : null, flairRequired: !!rules?.flairRequired, waitDay, account, accountFree: /gratis|kostenlos|free|0 ?€|€ ?0\b/i.test(cost), sweep: isCommunitySweep(t) }
}
