import { and, eq, gte, isNull, sql } from 'drizzle-orm'
import { addDays } from '../../shared/utils/dates'
import { validDate } from '../../shared/utils/release'
import { today } from './clock'
import type { DbOrTx } from './db'
import { schema } from './db'
import { factTexts, projectMemoryTexts } from './plan-guard'

type Workspace = typeof schema.workspaces.$inferSelect

export interface ReleaseHint {
  project: string
  text: string
}

const RELEASE_WORDS = /\b(album|single|ep|release|erscheint|erscheinen|veröffentlich\w*|launch\w*|out on|comes out|drops?)\b/i
const ISO_DATE = /\b(20\d{2})-(\d{2})-(\d{2})\b/
const DE_DATE = /\b(\d{1,2})\.(\d{1,2})\.(20\d{2})\b/

export function releaseDateIn(text: string): string | null {
  const iso = ISO_DATE.exec(text)
  if (iso && validDate(iso[0])) return iso[0]
  const de = DE_DATE.exec(text)
  if (de) {
    const v = `${de[3]}-${de[2]!.padStart(2, '0')}-${de[1]!.padStart(2, '0')}`
    if (validDate(v)) return v
  }
  return null
}

export function upcomingReleases(texts: string[], todayIso: string, horizon = 60): { text: string, date: string }[] {
  const out: { text: string, date: string }[] = []
  for (const t of texts) {
    if (!RELEASE_WORDS.test(t)) continue
    const date = releaseDateIn(t)
    if (!date || date < todayIso || date > addDays(todayIso, horizon)) continue
    out.push({ text: t.replace(/\s+/g, ' ').trim().slice(0, 200), date })
  }
  return out
}

export async function releaseHints(db: DbOrTx, ws: Workspace): Promise<ReleaseHint[]> {
  const d = today(ws.timezone)
  const projects = await db.select().from(schema.projects).where(and(eq(schema.projects.workspaceId, ws.id), isNull(schema.projects.archivedAt)))
  const out: ReleaseHint[] = []
  for (const p of projects) {
    const found = upcomingReleases(factTexts(p, await projectMemoryTexts(db, p.id)), d)
    if (!found.length) continue
    const [planned] = await db.select({ id: schema.campaigns.id }).from(schema.campaigns).where(and(eq(schema.campaigns.projectId, p.id), sql`${schema.campaigns.name} like 'Release:%'`, gte(schema.campaigns.endDate, d))).limit(1)
    if (planned) continue
    for (const f of found.slice(0, 2)) out.push({ project: p.name, text: f.text })
  }
  return out
}
