import { eq } from 'drizzle-orm'
import { isValidTime } from '~~/shared/utils/dates'
import { logActivity } from '~~/server/lib/activity'
import { now } from '~~/server/lib/clock'
import { getDb, schema } from '~~/server/lib/db'
import { applyLlmUpdate, euAvailable, llmLocked, PRESETS, type Provider } from '~~/server/lib/llm'
import { applySocialUpdate } from '~~/server/lib/social'
import { APP_PROVIDERS, sealAppApiKey, sealAppSecret, updateSettings } from '~~/server/lib/connections'
import { enqueueJob } from '~~/server/lib/jobs'
import { closeRedditSetup } from '~~/server/lib/plan-guard'
import { MCP_APPROVE_KINDS, MCP_MAX_DELAY, MCP_MAX_PER_DAY, mcpApproveConfig } from '~~/shared/utils/mcp-approve'

const body = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  timezone: z.string().max(60).refine((tz) => {
    try {
      new Intl.DateTimeFormat('de', { timeZone: tz })
      return true
    }
    catch {
      return false
    }
  }).optional(),
  agentEnabled: z.boolean().optional(),
  autoStrategy: z.boolean().optional(),
  llmEu: z.boolean().optional(),
  publishLive: z.boolean().optional(),
  sendLive: z.boolean().optional(),
  briefingTime: z.string().refine(isValidTime).optional(),
  selfPerDay: z.number().int().min(1).max(20).optional(),
  approvalsPerDay: z.number().int().min(1).max(30).optional(),
  llm: z.object({
    provider: z.enum(Object.keys(PRESETS) as [Provider, ...Provider[]]).optional(),
    baseUrl: z.string().trim().max(300).optional(),
    model: z.string().max(120).optional(),
    modelFast: z.string().max(120).optional(),
    reasoning: z.boolean().optional(),
    apiKey: z.string().trim().min(8).max(512).regex(/^\S+$/).optional(),
    removeKey: z.boolean().optional(),
  }).optional(),
  app: z.object({
    provider: z.enum(APP_PROVIDERS),
    clientId: z.string().trim().max(200),
    clientSecret: z.string().trim().min(8).max(512).regex(/^\S+$/).optional(),
    redirectUri: z.string().trim().max(500).refine(v => !v || /^https?:\/\/\S+$/.test(v), 'Adresse muss mit http(s):// beginnen').optional(),
    user: z.string().trim().max(40).regex(/^(\/?u\/)?[\w-]*$/, 'Nur der Reddit-Benutzername').optional(),
    apiKey: z.string().trim().min(8).max(512).regex(/^\S+$/).optional(),
    removeKey: z.boolean().optional(),
    remove: z.boolean().optional(),
  }).optional(),
  mcpApprove: z.object({
    enabled: z.boolean().optional(),
    kinds: z.array(z.enum(MCP_APPROVE_KINDS)).max(MCP_APPROVE_KINDS.length).optional(),
    delayMin: z.number().int().min(0).max(MCP_MAX_DELAY).optional(),
    zeroDelayOk: z.boolean().optional(),
    perDay: z.number().int().min(1).max(MCP_MAX_PER_DAY).optional(),
    offProjects: z.array(z.string().uuid()).max(200).optional(),
  }).optional(),
  aiReviewer: z.object({ enabled: z.boolean() }).optional(),
  social: z.object({
    provider: z.enum(['zernio', 'uploadpost']).optional(),
    apiKey: z.string().trim().min(8).max(512).regex(/^\S+$/).optional(),
    removeKey: z.boolean().optional(),
  }).optional(),
})

export default defineEventHandler(async (event) => {
  const s = await requireAuth(event, 'admin')
  const input = await parseBody(event, body)
  if (input.llm && llmLocked()) throw createError({ statusCode: 403, statusMessage: 'KI-Einstellungen sind vom Betreiber vorgegeben' })
  if (input.llmEu && !euAvailable()) throw createError({ statusCode: 400, statusMessage: 'EU-Modus ist auf diesem Server nicht eingerichtet' })
  if (input.llm?.baseUrl && !/^https?:\/\//.test(input.llm.baseUrl)) throw createError({ statusCode: 400, statusMessage: 'Endpunkt muss mit http:// oder https:// beginnen' })
  if (input.llm?.baseUrl) await assertLlmBaseUrl(input.llm.baseUrl)
  const db = await getDb()
  const ws = s.workspace
  if (input.mcpApprove?.delayMin === 0 && !input.mcpApprove.zeroDelayOk) throw createError({ statusCode: 400, statusMessage: 'Frist 0 nur mit ausdrücklicher Bestätigung' })
  if ((input.publishLive || input.sendLive) && ws.settings?.outboundLocked) throw createError({ statusCode: 403, statusMessage: 'Posten und Senden nach außen sind vom Betreiber gesperrt' })
  const toggles: { action: 'publish_live_on' | 'publish_live_off' | 'send_live_on' | 'send_live_off' | 'mcp_approve_on' | 'mcp_approve_off' | 'ai_reviewer_on' | 'ai_reviewer_off' }[] = []
  await updateSettings(db, ws.id, (settings) => {
    if (input.agentEnabled !== undefined) settings.agentEnabled = input.agentEnabled
    if (input.autoStrategy !== undefined) settings.autoStrategy = input.autoStrategy
    if (input.llmEu !== undefined) settings.llmEu = input.llmEu
    if (input.publishLive !== undefined && input.publishLive !== !!settings.publishLive) {
      settings.publishLive = input.publishLive
      toggles.push({ action: input.publishLive ? 'publish_live_on' : 'publish_live_off' })
    }
    if (input.briefingTime) settings.briefingTime = input.briefingTime
    if (input.selfPerDay) settings.selfPerDay = input.selfPerDay
    if (input.approvalsPerDay) settings.approvalsPerDay = input.approvalsPerDay
    if (input.llm) settings.llm = applyLlmUpdate(settings.llm, input.llm, ws.id)
    if (input.sendLive !== undefined && input.sendLive !== !!settings.sendLive) {
      settings.sendLive = input.sendLive
      toggles.push({ action: input.sendLive ? 'send_live_on' : 'send_live_off' })
    }
    if (input.app) {
      const apps = { ...settings.apps }
      const a = input.app
      if (a.remove) delete apps[a.provider]
      else apps[a.provider] = { clientId: a.clientId, secret: a.clientSecret ? sealAppSecret(ws.id, a.provider, a.clientSecret) : apps[a.provider]?.secret, redirectUri: a.redirectUri || null, user: a.user?.replace(/^\/?u\//, '') || null, ...(a.apiKey ? { key: sealAppApiKey(ws.id, a.provider, a.apiKey) } : a.removeKey || !apps[a.provider]?.key ? {} : { key: apps[a.provider]!.key }) }
      settings.apps = apps
    }
    if (input.mcpApprove) {
      const cur = mcpApproveConfig(settings.mcpApprove)
      const { zeroDelayOk: _z, ...m } = input.mcpApprove
      const next = mcpApproveConfig({ ...cur, ...m })
      if (next.enabled !== cur.enabled) toggles.push({ action: next.enabled ? 'mcp_approve_on' : 'mcp_approve_off' })
      settings.mcpApprove = next
    }
    if (input.aiReviewer) {
      const cur = settings.aiReviewer
      const changed = input.aiReviewer.enabled !== (cur?.enabled !== false)
      if (changed || cur?.ask) {
        settings.aiReviewer = { enabled: input.aiReviewer.enabled, by: s.user.id, at: now().toISOString() }
        toggles.push({ action: input.aiReviewer.enabled ? 'ai_reviewer_on' : 'ai_reviewer_off' })
      }
    }
    if (input.social) settings.social = applySocialUpdate(settings.social, input.social, ws.id)
    return settings
  })
  if (input.name || input.timezone) await db.update(schema.workspaces).set({ ...(input.name ? { name: input.name } : {}), ...(input.timezone ? { timezone: input.timezone } : {}) }).where(eq(schema.workspaces.id, ws.id))
  if (input.app && !input.app.remove && ((input.app.provider === 'reddit' && input.app.clientId) || (input.app.provider === 'brave' && input.app.clientSecret))) {
    await closeRedditSetup(db, ws.id, new Date())
    await enqueueJob(db, 'draft_tasks', { workspaceId: ws.id, dedupeKey: `draft_tasks:${ws.id}:reddit:${Date.now()}` })
  }
  if (input.app && !input.app.remove && input.app.provider === 'bing' && input.app.clientSecret) {
    await enqueueJob(db, 'search_sync', { workspaceId: ws.id, payload: {}, dedupeKey: `search_sync:${ws.id}:bing:${Date.now()}`, maxAttempts: 1 })
  }
  for (const t of toggles) await logActivity(db, { workspaceId: ws.id, actor: 'user', userId: s.user.id, action: t.action, detail: {} })
  return { ok: true }
})
