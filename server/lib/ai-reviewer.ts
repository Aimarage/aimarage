import { and, asc, desc, eq, gte, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import { isListeningTask } from '../../shared/utils/listening'
import { platformRule } from '../../shared/utils/social'
import { markOf, type PlatformKey, type TaskType } from '../../shared/utils/drafting'
import { langName, wrongLang } from '../../shared/utils/convo-tone'
import { logActivity } from './activity'
import { now } from './clock'
import type { Db, DbOrTx } from './db'
import { schema } from './db'
import { chatJson, LlmError, modelPrice, PRESETS, type ChatResult, type LlmConfig } from './llm'
import { approvedToday, checkLinks, goesOut, mcpConfig, revert, reviewForMcp } from './mcp-approve'
import type { FetchLike } from './outlets'
import { plannedAt, PublishError, schedulePost } from './publish'
import { updateTask } from './tasks'

type Workspace = typeof schema.workspaces.$inferSelect

export const REVIEWER_KINDS = ['social', 'community', 'verzeichnis'] as const
export const REVIEWER_ACTION = 'reviewer_approved'
export const LESSON_KIND = 'lehre'
export const MAX_LESSONS = 15

// Neue Arbeitsbereiche starten mit { enabled: false, ask: true }; ältere ohne Eintrag behalten "an".
export function reviewerEnabled(ws: Pick<Workspace, 'settings'>): boolean {
  return ws.settings?.aiReviewer?.enabled !== false
}

// Noch keine bewusste Wahl: Aimarage fragt beim ersten Projekt.
export function reviewerAsk(ws: Pick<Workspace, 'settings'>): boolean {
  return !!ws.settings?.aiReviewer?.ask
}

export interface ReviewerLlm {
  cfg: LlmConfig
  strong: boolean
}

// Prüfer-Modell aus der Konfiguration für die Nachprüfung: eingestelltes starkes Modell, sonst das starke Modell des Anbieters
// (gehostet Anthropic: Sonnet). Eigener Schlüssel: dessen großes Modell, wenn es sich vom schnellen unterscheidet. Ohne starkes Modell
// (oder Tarif ohne starkes Modell) null, dann bleibt es bei der einfachen Nachprüfung ohne Freigabe.
export function reviewerFrom(base: LlmConfig, strongAllowed = true): ReviewerLlm | null {
  if (base.blocked) return null
  if (base.own) {
    if (!base.model || base.model === base.modelFast) return null
    return { cfg: { ...base, modelFast: base.model, role: 'stark' }, strong: true }
  }
  if (!strongAllowed) return null
  if (base.role === 'stark') return { cfg: { ...base, modelFast: base.model }, strong: true }
  const model = PRESETS[base.provider]?.strongModel
  if (!model || (!base.apiKey && base.needsKey)) return null
  const price = modelPrice(model)
  return {
    cfg: { ...base, model, modelFast: model, role: 'stark', reasoning: false, timeoutMs: Math.max(base.timeoutMs, 180_000), priceInEur: price?.inEur ?? base.priceInEur, priceOutEur: price?.outEur ?? base.priceOutEur, fallback: base },
    strong: true,
  }
}

export interface ReviewInput {
  task: { title: string, description: string | null, category: string, channel: string | null, language: string | null }
  type: TaskType
  platform: PlatformKey | null
  kind: string
  draft: { subject: string | null, body: string, variants: Record<string, string>, recipient: string | null }
  platforms: string[]
  rules: string | null
  facts: { known: string[], avoid: string[] }
  projectData: string
  release: string | null
  subreddit: string | null
  recent: string[]
  lessons: string[]
}

export type Verdict = 'ok' | 'korrigiert' | 'verwerfen' | 'frage'

export interface AiReview {
  verdict: Verdict
  reason: string
  fix: { subject: string | null, body: string, variants: Record<string, string> } | null
  question: string | null
  obsolete: boolean
  lesson: string | null
  model: string
  strongUsed: boolean
}

const nullStr = z.string().nullable().optional().catch(null)

const verdictSchema = z.object({
  verdict: z.enum(['ok', 'korrigiert', 'verwerfen', 'frage']),
  reason: z.string().catch(''),
  subject: nullStr,
  body: nullStr,
  variants: z.record(z.string(), z.string()).nullable().optional().catch(null),
  question: nullStr,
  taskObsolete: z.boolean().optional().catch(false),
  lesson: nullStr,
  solvesProblem: z.boolean().nullable().optional().catch(null),
  wrongLanguage: z.boolean().nullable().optional().catch(null),
})

// Antwort auf einen Thread, Post oder eine Frage in einer Community (nicht eigener Beitrag).
export function isCommunityReply(i: Pick<ReviewInput, 'type' | 'platform' | 'task'>): boolean {
  if (/^[\p{L} ]{1,20}: Antwort an @/u.test(i.task.title)) return false
  return i.task.category === 'community' && (i.type === 'reply' || ((i.platform === 'reddit' || i.platform === 'forum') && /thread/i.test(i.task.title)))
}

export const NO_HELP = 'Löst das konkrete Problem der Person nicht'
export const WRONG_LANG = 'Nicht in der Sprache des Beitrags'

// Antwort unter einem fremden Beitrag: Sprache ist Pflicht, kein Hinweis.
function replyLangOf(i: Pick<ReviewInput, 'type' | 'platform' | 'task'>): string | null {
  return i.task.category === 'community' && i.task.language && (i.type === 'reply' || isCommunityReply(i) || /: Kommentar unter Beitrag von @|: Antwort (an @|auf ")/.test(i.task.title)) ? i.task.language : null
}

const dash = (v: string) => v.replace(/[–—]/g, '-').trim()

export function reviewerPrompt(i: ReviewInput): string {
  const d = i.draft
  const variants = Object.entries(d.variants ?? {})
  return [
    'Du bist der Schlussprüfer für diesen Marketing-Entwurf. Was du mit "ok" oder "korrigiert" durchlässt, kann ohne weiteren Blick eines Menschen veröffentlicht werden. Prüfe gründlich und streng, aber ohne Stil-Geschmack.',
    'Prüfe: 1. Projekt-Regeln und Nicht-sagen-Liste eingehalten? 2. Jede Tatsache (Namen, Titel, Daten, Zahlen, Eigenschaften, Zitate, Links) durch die Projektdaten gedeckt? Nichts erfunden? 3. Passt der Text zu Aufgabe, Kanal und Plattformregeln (Länge, Hashtags, Ton, Subreddit-Regeln)? 4. Aktuelles Release statt älterem? 5. Sprache, Rechtschreibung, keine Platzhalter, keine langen Striche (nur "-"). 6. Wiederholt er Einstiege oder das Gerüst früherer Beiträge (z.B. immer "Track N of 12" oder dieselbe Aufzählung von Anzahl, Dauer, Datum)? Dann mit anderem Einstieg korrigieren.',
    'Deutungen und Beschreibungen von Inhalten (was ein Song, Text, Bild oder Kapitel erzählt) sind erlaubt, wenn sie sich auf Texte in den Projektdaten stützen (z.B. Lyrics oder Seitentexte der öffentlichen Seiten); dann nicht streichen. Wörtliche Zitate müssen dort genau so stehen. Streiche nur Erfundenes: Zeilen, Themen, Ereignisse oder Fakten, die nirgends in den Projektdaten stehen. Lehren, die Deutungen allgemein verbieten, gelten nicht für belegte Deutungen.',
    'Urteile:',
    '- "ok": alles passt.',
    '- "korrigiert": kleine, sichere Korrekturen (Fakt streichen, Regel einhalten, kürzen, Tippfehler). Gib dann den vollständigen korrigierten Text in "body" (und "subject", "variants" für jede vorhandene Fassung) zurück. Links und UTM-Parameter unverändert lassen, außer ein Link verstößt gegen eine Projekt-Regel; nichts Neues erfinden.',
    'Korrekturen widersprechen den Projekt-Regeln nie: Schreiben die Regeln ein Link-Ziel vor (z.B. Musik-Links auf eine bestimmte Domain), geht das vor dem Projekt-Link aus den Projektdaten und vor Aufgabe oder Beschreibung. Einen regelkonformen Link nie durch einen anderen ersetzen. "Link in bio" bzw. "Link im Profil" nur einsetzen, wenn Regeln oder Projektdaten belegen, dass im Profil ein passender Link steht; sonst die Seite beim Namen nennen (z.B. "on beispiel.com") oder ohne Verweis lassen.',
    '- "verwerfen": Text ist grundsätzlich falsch (falsches Thema, verletzt Regeln so, dass Umschreiben ein neuer Text wäre, Spam). "taskObsolete": true nur, wenn die Aufgabe selbst überflüssig ist (doppelt, Termin vorbei, passt nicht mehr).',
    '- "frage": nur wenn eine Tatsache fehlt, die nur der Mensch kennt und ohne die der Text nicht geht. Dann eine kurze Frage in "question".',
    '"lesson": nur wenn der Fehler typisch ist und wiederkommen wird (ein Satz als Regel für künftige Entwürfe, z.B. "Keine Tourdaten nennen, die nicht im Gedächtnis stehen"). Sonst null. Nicht wiederholen, was schon in Regeln oder Lehren steht. Nie eine Lehre, die belegte Deutungen oder Beschreibungen von Inhalten allgemein verbietet; Grenze ist immer "nur, was in den Projektdaten steht".',
    isCommunityReply(i) ? 'Ton bei Community-Antworten: Klingt der Text nach KI (Floskeln wie "Great point", zu glatt, Aufzählung)? Belehrt, rät oder warnt er ungefragt? Würde ein echter Fan oder Kollege das so schreiben? Bei KI-Ton oder ungefragtem Rat kürzer und persönlicher korrigieren oder verwerfen.' : '',
    isCommunityReply(i) ? 'Pflichtfrage, weil es eine Community-Antwort ist: Löst diese Antwort das konkrete Problem der Person? Benenne das Problem für dich und prüfe, ob die Person danach wirklich weiter ist. Nur Präsenz zeigen, ein kluger Allgemeinplatz, am Problem vorbei oder nur das gleiche Thema: "solvesProblem": false (dann wird die Aufgabe verworfen, nicht korrigieren). Sonst true. Die Antwort muss in der Sprache des Threads sein.' : '',
    replyLangOf(i) ? `Pflicht bei Antworten unter fremden Beiträgen: Der Text muss auf ${langName(replyLangOf(i)!)} sein, in der Sprache des Beitrags. Ist er in einer anderen Sprache: "wrongLanguage": true (dann wird der Entwurf verworfen, nicht korrigieren). Sonst false.` : '',
    `Antworte nur mit JSON: {"verdict": "ok|korrigiert|verwerfen|frage", "reason": "ein bis zwei Sätze, deutsch, was du geprüft oder geändert hast", "subject": null, "body": null, "variants": null, "question": null, "taskObsolete": false, "lesson": null${isCommunityReply(i) ? ', "solvesProblem": true|false' : ''}${replyLangOf(i) ? ', "wrongLanguage": true|false' : ''}}`,
    '',
    `Aufgabe: ${i.task.title}${i.task.description ? `\n${i.task.description.slice(0, 1500)}` : ''}`,
    `Art: ${i.type}, Kategorie: ${i.task.category}${i.task.channel ? `, Kanal: ${i.task.channel}` : ''}${i.platform ? `, Plattform: ${i.platform}` : ''}${i.task.language ? `, Sprache: ${i.task.language}` : ''}`,
    i.platforms.length ? `Plattformen dieses Beitrags:\n${i.platforms.map((p) => {
      const r = platformRule(p)
      return `- ${p} (${r.label}): max. ${r.max} Zeichen, ${r.hashtags} Hashtags`
    }).join('\n')}` : '',
    i.platform === 'reddit' || i.platform === 'forum' ? 'Community-Beitrag: wie ein Mensch aus der Community, kein Werbeton; eigenes Produkt nur mit Offenlegung; ein fehlender Produkt-Link ist richtig.' : '',
    i.subreddit ? `${i.subreddit}` : '',
    i.rules?.trim() ? `Projekt-Regeln (verbindlich):\n${i.rules.trim()}` : '',
    i.facts.avoid.length ? `Nicht sagen:\n${i.facts.avoid.map(f => `- ${f}`).join('\n')}` : '',
    i.lessons.length ? `Lehren aus früheren Prüfungen:\n${i.lessons.map(f => `- ${f}`).join('\n')}` : '',
    i.release ? i.release : '',
    i.recent.length ? `Einstiege früherer Beiträge:\n${i.recent.slice(0, 8).map(r => `- ${r}`).join('\n')}` : '',
    `Projektdaten (Webseite, Unterlagen, Gedächtnis):\n${i.projectData.slice(0, i.type === 'article' ? 40_000 : 16_000)}`,
    '',
    `Entwurf (${i.kind}):${d.recipient ? `\nAn: ${d.recipient}` : ''}${d.subject ? `\nBetreff/Titel: ${d.subject}` : ''}\n${d.body}`,
    ...variants.map(([p, v]) => `\nFassung ${p}:\n${v}`),
  ].filter(Boolean).join('\n')
}

// Ein Prüflauf je Fassung. Fehler oder Ausweichen auf das schwache Modell liefern null bzw. strongUsed=false (dann keine Freigabe).
export async function aiReview(rv: ReviewerLlm, input: ReviewInput, usage: ChatResult[], log: string[], fetchImpl?: FetchLike): Promise<AiReview | null> {
  try {
    const res = await chatJson(rv.cfg, {
      messages: [{ role: 'system', content: 'Du bist ein gründlicher Lektor und Regelprüfer für Marketing-Texte. Antworte nur mit JSON.' }, { role: 'user', content: reviewerPrompt(input) }],
      maxTokens: input.kind === 'article' ? 8000 : 2500,
    }, verdictSchema, fetchImpl)
    usage.push(...res.usage)
    const r = res.data
    const model = res.usage.at(-1)?.model ?? rv.cfg.model
    const strongUsed = rv.strong && !res.usage.some(u => u.note?.startsWith('Starkes Modell'))
    const body = r.body?.trim() ? dash(r.body) : null
    const fix = r.verdict === 'korrigiert' && body
      ? { subject: r.subject?.trim() ? dash(r.subject) : input.draft.subject, body, variants: Object.fromEntries(Object.keys(input.draft.variants ?? {}).map(k => [k, r.variants?.[k]?.trim() ? dash(r.variants[k]!) : input.draft.variants[k]!])) }
      : null
    const want = replyLangOf(input)
    const langBad = !!want && (r.wrongLanguage === true || !!wrongLang(input.draft.body, want))
    const noHelp = langBad || (isCommunityReply(input) && r.solvesProblem !== true)
    const verdict: Verdict = noHelp ? 'verwerfen' : r.verdict === 'korrigiert' && !fix ? 'ok' : r.verdict
    const said = dash(r.reason).slice(0, 500)
    const reason = langBad ? `${WRONG_LANG} (${langName(want!)})${wrongLang(input.draft.body, want) ? `: ${wrongLang(input.draft.body, want)}` : ''}`.slice(0, 500) : noHelp ? `${NO_HELP}${r.solvesProblem === false ? '' : ' (Prüfer hat die Pflichtfrage nicht bejaht)'}: ${said || 'ohne Begründung'}`.slice(0, 500) : said || (verdict === 'ok' ? 'Keine Beanstandung.' : 'Ohne Begründung.')
    const lesson = r.lesson?.trim() ? dash(r.lesson).slice(0, 300) : null
    log.push(`KI-Prüfer (${model}): ${verdict} - ${reason}`)
    return { verdict, reason, fix: noHelp ? null : fix, question: noHelp ? null : r.question?.trim() ? dash(r.question).slice(0, 300) : null, obsolete: noHelp || (verdict === 'verwerfen' && r.taskObsolete === true), lesson, model, strongUsed }
  }
  catch (err) {
    const extra = (err as { usage?: ChatResult[] }).usage
    if (extra) usage.push(...extra)
    if (!(err instanceof LlmError) && !(err instanceof z.ZodError)) throw err
    log.push(`KI-Prüfer übersprungen: ${(err as Error).message.slice(0, 200)}`)
    return null
  }
}

export async function projectLessons(db: Db, projectId: string): Promise<string[]> {
  const rows = await db.select({ text: schema.projectMemory.text }).from(schema.projectMemory)
    .where(and(eq(schema.projectMemory.projectId, projectId), eq(schema.projectMemory.kind, LESSON_KIND))).orderBy(asc(schema.projectMemory.createdAt))
  return rows.map(r => r.text)
}

// Sparsam merken: keine Doppelten, höchstens MAX_LESSONS je Projekt.
export async function rememberLesson(db: Db, projectId: string, lesson: string): Promise<boolean> {
  const have = await projectLessons(db, projectId)
  const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
  if (have.length >= MAX_LESSONS || have.some(h => norm(h) === norm(lesson))) return false
  await db.insert(schema.projectMemory).values({ projectId, kind: LESSON_KIND, text: lesson })
  return true
}

export type ReleaseResult = { ok: true, releaseAt: Date, goesOut: boolean } | { ok: false, reason: string }

// Freigabe durch den KI-Prüfer: wie "Claude darf freigeben" (Prüfungen, Einspruchsfrist, Tageslimit), aber nur Social, Community und Verzeichnisse.
export async function releaseByReviewer(db: Db, wsIn: Workspace, input: { draftId: string, reason: string, model: string }, fetchImpl: FetchLike = fetch): Promise<ReleaseResult> {
  const [ws] = await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, wsIn.id))
  if (!ws) return { ok: false, reason: 'Arbeitsbereich nicht gefunden' }
  if (!reviewerEnabled(ws)) return { ok: false, reason: 'KI-Prüfer darf nicht freigeben (Einstellungen > Veröffentlichen)' }
  const cfg = mcpConfig(ws)
  const used = await approvedToday(db, ws, REVIEWER_ACTION)
  if (used >= cfg.perDay) return { ok: false, reason: `Tageslimit erreicht (${cfg.perDay} Freigaben durch den KI-Prüfer pro Tag)` }
  const [row] = await db.select({ draft: schema.drafts, task: schema.tasks }).from(schema.drafts).innerJoin(schema.tasks, eq(schema.tasks.id, schema.drafts.taskId))
    .where(and(eq(schema.drafts.id, input.draftId), eq(schema.tasks.workspaceId, ws.id)))
  if (!row) return { ok: false, reason: 'Entwurf nicht gefunden' }
  const { draft, task } = row
  if (draft.status !== 'offen') return { ok: false, reason: `Entwurf ist ${draft.status}` }
  const project = task.projectId ? (await db.select().from(schema.projects).where(eq(schema.projects.id, task.projectId)))[0] ?? null : null
  if (isListeningTask(task)) return { ok: false, reason: 'Social-Listening-Antworten gibt der Mensch frei' }
  const review = await reviewForMcp(db, ws, task, draft, project, { via: 'reviewer', kinds: REVIEWER_KINDS })
  if (!review.allowed) return { ok: false, reason: review.blockers.join('; ') }
  const broken = await checkLinks(review.links, fetchImpl)
  if (broken.length) return { ok: false, reason: `Links nicht erreichbar: ${broken.join(', ')}` }

  const t2 = await db.transaction(async (tx) => {
    const [cur] = await tx.select().from(schema.tasks).where(eq(schema.tasks.id, task.id)).for('update')
    const [fresh] = await tx.select().from(schema.drafts).where(eq(schema.drafts.id, draft.id))
    if (!cur || cur.status !== 'entwurf_fertig' || fresh?.status !== 'offen' || fresh.version !== draft.version || fresh.body !== draft.body) return null
    await tx.update(schema.drafts).set({ status: 'freigegeben', approvedAt: now(), approvedVia: 'reviewer' }).where(eq(schema.drafts.id, draft.id))
    return updateTask(tx as unknown as Db, cur, { status: 'freigegeben' }, { type: 'agent' })
  })
  if (!t2) return { ok: false, reason: 'Entwurf wurde während der Prüfung geändert' }
  const earliest = new Date(now().getTime() + cfg.delayMin * 60_000)
  const planned = plannedAt(t2, ws.timezone)
  let releaseAt = planned.getTime() > earliest.getTime() ? planned : earliest
  const out = goesOut(ws, project, t2, draft)
  try {
    if (out) releaseAt = (await schedulePost(db, ws, { task: t2, draft: { ...draft, status: 'freigegeben' }, project, mode: 'manual', at: releaseAt })).scheduledAt
  }
  catch (err) {
    await revert(db, t2, draft.id)
    if (err instanceof PublishError) return { ok: false, reason: err.message }
    throw err
  }
  await db.transaction(async (tx) => {
    await tx.update(schema.drafts).set({ releaseAt }).where(eq(schema.drafts.id, draft.id))
    await tx.insert(schema.taskNotes).values({ taskId: task.id, byAgent: true, text: `Vom KI-Prüfer freigegeben (v${draft.version}, ${input.model})${out ? '' : ', bitte selbst posten'}: ${input.reason.slice(0, 1000)}`, createdAt: now() })
    await logActivity(tx, { workspaceId: ws.id, projectId: task.projectId, taskId: task.id, actor: 'agent', action: REVIEWER_ACTION, detail: { title: task.title, version: draft.version, kind: draft.kind, releaseAt: releaseAt.toISOString(), goesOut: out, reason: input.reason.slice(0, 300) }, at: now() })
  })
  return { ok: true, releaseAt, goesOut: out }
}

// Prüfer hält die Aufgabe für überflüssig (doppelt, vorbei, passt nicht mehr): Entwurf verwerfen, Aufgabe entfällt.
export async function dropByReviewer(db: Db, ws: Workspace, taskId: string, draftId: string, reason: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [cur] = await tx.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)).for('update')
    const [draft] = await tx.select().from(schema.drafts).where(eq(schema.drafts.id, draftId))
    if (!cur || cur.status !== 'entwurf_fertig' || draft?.status !== 'offen') return false
    await tx.update(schema.drafts).set({ status: 'verworfen' }).where(eq(schema.drafts.id, draftId))
    await tx.insert(schema.taskNotes).values({ taskId, byAgent: true, text: `Entwurf v${draft.version} vom KI-Prüfer verworfen, Aufgabe entfällt: ${reason}`, createdAt: now() })
    await updateTask(tx as unknown as Db, cur, { status: 'verworfen' }, { type: 'agent' })
    await logActivity(tx, { workspaceId: ws.id, projectId: cur.projectId, taskId, actor: 'agent', action: 'reviewer_dropped', detail: { title: cur.title, version: draft.version, reason: reason.slice(0, 300) }, at: now() })
    return true
  })
}

export interface ReviewerRelease {
  draftId: string
  taskId: string
  projectId: string | null
  title: string
  platform: string | null
  releaseAt: Date | null
  approvedAt: Date | null
  // Noch nicht raus: Stoppen geht (Login nötig, Knopf auf dem Entwurf).
  stoppable: boolean
}

// Vom KI-Prüfer freigegebene Entwürfe, gesammelt für Tagesmail, Dashboard und App (keine Einzelmeldung je Freigabe).
export async function reviewerReleases(db: DbOrTx, workspaceId: string, opts: { since?: Date, onlyStoppable?: boolean, cond?: SQL } = {}): Promise<ReviewerRelease[]> {
  const rows = await db.select({ draft: schema.drafts, task: schema.tasks }).from(schema.drafts).innerJoin(schema.tasks, eq(schema.tasks.id, schema.drafts.taskId))
    .where(and(eq(schema.tasks.workspaceId, workspaceId), eq(schema.drafts.approvedVia, 'reviewer'), eq(schema.drafts.status, 'freigegeben'), opts.since ? gte(schema.drafts.approvedAt, opts.since) : undefined, opts.cond))
    .orderBy(asc(schema.drafts.releaseAt), desc(schema.drafts.approvedAt)).limit(50)
  return rows.map(({ draft, task }) => ({
    draftId: draft.id,
    taskId: task.id,
    projectId: task.projectId,
    title: task.title,
    platform: markOf({ ...task, draftKind: task.draftKind ?? draft.kind }) ?? draft.platforms[0] ?? null,
    releaseAt: draft.releaseAt,
    approvedAt: draft.approvedAt,
    stoppable: task.status === 'freigegeben' && !task.doneAt,
  })).filter(r => !opts.onlyStoppable || r.stoppable)
}

// Ton-Prüfung für Kommentare und Antworten unter Beiträgen anderer (Listening, Mitreden): klingt nach KI? belehrt ungefragt? echt?

export interface ToneInput {
  platform: string
  kind: 'search' | 'mention' | 'conversation'
  author: string
  post: string
  examples: string[]
  variants: string[]
  rules: string | null
  lang?: string | null
}

export interface ToneVerdict {
  ok: number[]
  reason: string
}

const toneSchema = z.object({
  items: z.array(z.object({
    i: z.coerce.number(),
    ai: z.boolean().catch(true),
    lecture: z.boolean().catch(true),
    real: z.boolean().catch(false),
    ok: z.boolean().catch(false),
    sameLang: z.boolean().catch(false),
    why: z.string().catch(''),
  })).catch([]),
  best: z.coerce.number().nullable().optional().catch(null),
})

export function tonePrompt(i: ToneInput): string {
  return [
    `Wir wollen auf ${i.platform} ${i.kind === 'conversation' ? 'unter einen fremden Beitrag einen Kommentar setzen' : 'auf einen Beitrag antworten'}. Prüfe jede Fassung streng:`,
    '- "ai": Klingt sie nach KI? (Floskeln wie "Great point", "Love this", "Spannender Beitrag", zu glatt oder ausgewogen, wiederholt nur den Beitrag, typische KI-Wörter, Aufzählung, anbiedernde Rückfrage am Ende.)',
    '- "lecture": Belehrt, rät oder warnt sie ungefragt? (Negativbeispiel: unter einem Post über einen neuen MCP-Server "pass auf, dass niemand deinen Server hackt".)' + (i.kind === 'search' ? ' Ausnahme: Die Person hat ausdrücklich nach einer Empfehlung gefragt, dann ist die Empfehlung kein ungefragter Rat.' : ''),
    '- "real": Würde ein echter Fan oder Kollege das genau so hinschreiben? Passt Länge und Ton zu den anderen Kommentaren dort?',
    `- "sameLang": Ist sie in derselben Sprache wie der Beitrag${i.lang ? ` (${langName(i.lang)})` : ''}? Andere Sprache: sameLang=false, dann nie ok.`,
    '- "ok" nur, wenn ai=false, lecture=false, real=true und sameLang=true, sie zum Beitrag passt und nichts erfindet. Im Zweifel ok=false: lieber gar kein Kommentar als ein schlechter.',
    '"best": Index der natürlichsten Fassung unter den ok, sonst null. "why": ein kurzer Satz auf Deutsch.',
    i.rules?.trim() ? `Projekt-Regeln (verbindlich):\n${i.rules.trim()}` : '',
    '',
    `Beitrag von @${i.author}:\n"${i.post.replace(/\s+/g, ' ').slice(0, 1200)}"`,
    i.examples.length ? `So klingen die anderen Kommentare dort:\n${i.examples.slice(0, 12).map(e => `- ${e.replace(/\s+/g, ' ').slice(0, 200)}`).join('\n')}` : '',
    '',
    'Fassungen:',
    ...i.variants.map((v, n) => `[${n}] ${v}`),
    '',
    'Antworte nur mit JSON: {"items": [{"i": 0, "ai": false, "lecture": false, "real": true, "sameLang": true, "ok": true, "why": "..."}], "best": 0}',
  ].filter(s => s !== '').join('\n')
}

// Fehler oder unlesbare Antwort: nichts ist ok (bei Zweifel überspringen).
export async function toneReview(cfg: LlmConfig, input: ToneInput, usage: ChatResult[], log: string[], fetchImpl?: FetchLike): Promise<ToneVerdict> {
  if (!input.variants.length) return { ok: [], reason: 'keine Fassung' }
  try {
    const res = await chatJson(cfg, {
      messages: [{ role: 'system', content: 'Du prüfst Social-Media-Kommentare darauf, ob sie wie von echten Menschen klingen. Antworte nur mit JSON.' }, { role: 'user', content: tonePrompt(input) }],
      maxTokens: 300 + input.variants.length * 120,
      fast: true,
    }, toneSchema, fetchImpl)
    usage.push(...res.usage)
    const good = res.data.items.filter(x => x.i >= 0 && x.i < input.variants.length && x.ok && !x.ai && !x.lecture && x.real && x.sameLang && !wrongLang(input.variants[x.i]!, input.lang ?? null)).map(x => x.i)
    const uniq = [...new Set(good)]
    const best = res.data.best != null && uniq.includes(res.data.best) ? res.data.best : null
    const ok = best == null ? uniq : [best, ...uniq.filter(x => x !== best)]
    const why = res.data.items.map(x => x.why).filter(Boolean)
    return { ok, reason: dash(why.join(' ')).slice(0, 400) }
  }
  catch (err) {
    const extra = (err as { usage?: ChatResult[] }).usage
    if (extra) usage.push(...extra)
    if (!(err instanceof LlmError) && !(err instanceof z.ZodError)) throw err
    log.push(`Ton-Prüfung fehlgeschlagen: ${(err as Error).message.slice(0, 200)}`)
    return { ok: [], reason: 'Ton-Prüfung fehlgeschlagen' }
  }
}
