import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import { initials, roleAtLeast } from '~~/shared/utils/domain'
import { config } from '~~/server/lib/config'
import { getDb, schema } from '~~/server/lib/db'
import { envKeyUrl, euAvailable, euLlmForStep, euProvider, llmConfig, llmLocked, llmStatus, PRESETS, publicLlmSettings, storedKey } from '~~/server/lib/llm'
import { projectCond } from '~~/server/lib/access'
import { ownLlmFor } from '~~/server/lib/own-llm'
import { publicSocial } from '~~/server/lib/social'
import { workspaceAccessProblems } from '~~/server/lib/access-problems'
import { publicStats } from '~~/server/lib/traffic'
import { publicBlogApi } from '~~/server/lib/blog-api'
import { socialTarget } from '~~/server/lib/publish'
import { trustSuggestions } from '~~/server/lib/trust'
import { selfPerDay } from '~~/server/lib/self-limit'
import { approvalsPerDay } from '~~/server/lib/approval-limit'
import { publicFeeds } from '~~/server/lib/feeds'
import { mcpApproveConfig } from '~~/shared/utils/mcp-approve'
import { draftAheadOf } from '~~/shared/utils/plan'
import { workspaceLlm } from '~~/server/lib/agent'
import { reviewerAsk, reviewerEnabled, reviewerFrom } from '~~/server/lib/ai-reviewer'
import { strongModelAllowed } from '~~/server/lib/limits'
import { braveUsage } from '~~/server/lib/brave-usage'
import { braveSource } from '~~/server/lib/platforms/brave'
import { numLimit } from '~~/server/lib/limits'
import { serviceCostsMonth } from '~~/server/lib/service-costs'

export default defineEventHandler(async (event) => {
  const s = await requireAuth(event)
  const db = await getDb()
  const ws = s.workspace
  const own = ownLlmFor(ws)
  const euOn = !!ws.settings?.llmEu
  const cfg = own ?? (euOn ? euLlmForStep(undefined, undefined, ws.id) : llmConfig(ws.settings?.llm, undefined, ws.id))
  const stored = ws.settings?.llm?.key
  const unreadable = stored ? storedKey(ws.settings?.llm, ws.id, cfg.baseUrl).unreadable : false
  const projects = await db.select().from(schema.projects).where(and(eq(schema.projects.workspaceId, ws.id), projectCond(await accessOf(db, s), schema.projects.id, false))).orderBy(schema.projects.sortOrder, schema.projects.name)
  const members = await db.select({ id: schema.users.id, name: schema.users.name, email: schema.users.email, role: schema.memberships.role })
    .from(schema.memberships).innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId)).where(and(eq(schema.memberships.workspaceId, ws.id)))
  const admin = roleAtLeast(s.role, 'admin')
  const social = publicSocial(ws)
  const clientCount = new Map((projects.length ? await db.select({ id: schema.clientLinks.projectId, n: sql<number>`count(*)::int` }).from(schema.clientLinks).where(and(inArray(schema.clientLinks.projectId, projects.map(p => p.id)), isNull(schema.clientLinks.revokedAt))).groupBy(schema.clientLinks.projectId) : []).map(r => [r.id, r.n]))
  const trust = new Map(admin ? await Promise.all(projects.map(async p => [p.id, await trustSuggestions(db, ws, p)] as const)) : [])
  return {
    admin,
    workspace: { name: ws.name, timezone: ws.timezone, agentEnabled: ws.settings?.agentEnabled !== false, autoStrategy: ws.settings?.autoStrategy !== false, briefingTime: ws.settings?.briefingTime ?? '06:30', selfPerDay: selfPerDay(ws), approvalsPerDay: approvalsPerDay(ws) },
    llm: {
      locked: llmLocked(),
      own: !!own,
      eu: { available: euAvailable(), on: euOn, provider: euProvider() },
      saved: publicLlmSettings(ws.settings?.llm),
      effective: { provider: cfg.provider, baseUrl: cfg.baseUrl, model: cfg.model, modelFast: cfg.modelFast, reasoning: cfg.reasoning },
      key: own ? { source: 'workspace', hint: null, setAt: null, unreadable: false, needed: true } : euOn ? { source: cfg.keySource, hint: null, setAt: null, unreadable: false, needed: cfg.needsKey } : { source: cfg.keySource, hint: admin && cfg.keySource === 'workspace' ? stored?.hint ?? '' : null, setAt: cfg.keySource === 'workspace' ? stored?.setAt ?? null : null, unreadable, needed: cfg.needsKey },
      env: admin ? { baseUrl: config.llm.baseUrl || null, model: config.llm.model || null, keyUrl: config.llm.apiKey ? envKeyUrl() : null } : { baseUrl: null, model: null, keyUrl: null },
      status: own?.blocked ? { configured: false, reason: 'own_blocked' } : llmStatus(cfg),
      providers: Object.entries(PRESETS).map(([id, v]) => ({ id, baseUrl: v.baseUrl, model: v.model, needsKey: v.needsKey })),
    },
    social: admin ? social : null,
    braveUsage: admin ? await braveUsage(db, ws.id, undefined, { source: braveSource(ws), perDay: braveSource(ws) === 'hosted' ? numLimit(ws, 'braveCallsPerDay') : null }) : null,
    services: admin && config.hosted ? await serviceCostsMonth(db, ws) : null,
    appIssues: admin ? (await workspaceAccessProblems(db, ws)).filter(a => a.app).map(a => ({ app: a.app!, what: a.what, project: a.projectName, path: a.path, message: a.message })) : [],
    connected: { live: social.live },
    sendLive: !!ws.settings?.sendLive,
    outboundLocked: !!ws.settings?.outboundLocked,
    mcpApprove: mcpApproveConfig(ws.settings?.mcpApprove),
    aiReviewer: { enabled: reviewerEnabled(ws), ask: reviewerAsk(ws), by: members.find(m => m.id === ws.settings?.aiReviewer?.by)?.name ?? null, at: ws.settings?.aiReviewer?.at ?? null, model: reviewerFrom(workspaceLlm(ws, 'draft_check'), strongModelAllowed(ws))?.cfg.model ?? null },
    database: config.usePglite ? 'pglite' : 'postgres',
    workerInline: config.workerInline,
    projects: projects.map(p => ({ id: p.id, slug: p.slug, name: p.name, code: p.code, color: p.color, icon: p.icon, url: p.url, description: p.description, tonality: p.tonality, languages: p.languages, kpis: p.kpis, archived: !!p.archivedAt, autonomy: p.autonomy, rules: p.rules, facts: { known: p.setup?.facts?.known ?? [], avoid: p.setup?.facts?.avoid ?? [] }, blog: p.setup?.blog ?? null, pacing: p.setup?.pacing?.perPlatformPerDay ?? null, draftAhead: draftAheadOf(p.setup), stats: p.setup?.stats ? { ...publicStats(p.setup.stats)!, hint: admin ? p.setup.stats.secret?.hint ?? '' : '' } : null, blogApi: p.setup?.blogApi ? { ...publicBlogApi(p.setup.blogApi)!, hint: admin ? p.setup.blogApi.secret?.hint ?? '' : '' } : null, outlets: { social: !!socialTarget(ws, p)?.platforms.some(x => x.postable), mail: !!p.setup?.mail?.smtp?.host, blog: !!p.setup?.blogApi?.secret }, trust: trust.get(p.id) ?? [], feeds: publicFeeds(p.setup?.feeds), geoQuestions: p.setup?.geo?.questions?.length ?? 0, client: { okApproves: !!p.setup?.client?.okApproves, links: clientCount.get(p.id) ?? 0 } })),
    members: members.map(m => ({ ...m, initials: initials(m.name) })),
  }
})
