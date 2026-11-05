import { z, type ZodType } from 'zod'
import { CATEGORIES } from '../../../shared/utils/domain'
import type { ChatActor, TurnDeps } from '../chat'
import type { Db } from '../db'
import type { ApiPrincipal } from './principal'
import * as svc from './service'
import type { ApiPerm } from '../../../shared/utils/api-perms'

export interface RestCtx {
  db: Db
  actor: ChatActor
  principal: ApiPrincipal
  params: Record<string, string>
  query: Record<string, unknown>
  body: Record<string, unknown>
  deps: TurnDeps
}

export interface Route {
  method: 'GET' | 'POST' | 'PATCH'
  path: string
  scope: 'read' | 'write'
  tag: string
  summary: string
  query?: z.ZodObject
  body?: z.ZodObject
  run: (c: RestCtx) => Promise<unknown>
}

const iso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD')
const time = z.string().regex(/^\d{2}:\d{2}$/, 'HH:MM')
const projectQ = z.string().max(60).optional().describe('Projekt (Slug, Name oder Kürzel)')

const taskBody = z.object({
  project: z.string().max(60).describe('Projekt (Slug, Name oder Kürzel)'),
  title: z.string().trim().min(1).max(200),
  category: z.enum(CATEGORIES),
  date: iso.optional(),
  time: time.optional(),
  description: z.string().max(4000).optional(),
  draft: z.boolean().optional().describe('Agent schreibt einen Entwurf (Standard: ja bei Beiträgen/Mails)'),
})

const taskPatch = z.object({
  date: iso.optional(),
  time: time.nullable().optional().describe('null = ganztags'),
  title: z.string().trim().min(1).max(200).optional(),
  status: z.enum(['geplant', 'erledigt', 'verworfen']).optional(),
})

const goalBody = z.object({
  label: z.string().trim().min(1).max(120).optional(),
  target: z.number().optional(),
  deadline: iso.optional(),
  metricKey: z.string().max(40).optional(),
  mode: z.enum(['sum', 'last', 'month']).optional().describe('sum = Zuwachs seit Start, last = aktueller Stand, month = pro 30 Tage'),
  active: z.boolean().optional(),
})

const draftBody = z.object({
  body: z.string().trim().min(1).max(50_000),
  subject: z.string().max(300).nullable().optional(),
  recipient: z.string().max(300).nullable().optional(),
  targetUrl: z.string().url().max(1000).nullable().optional(),
  platforms: z.array(z.string().max(40)).max(20).optional(),
  variants: z.record(z.string().max(40), z.string().max(10_000)).optional(),
})

export const ROUTES: Route[] = [
  { method: 'GET', path: '/me', scope: 'read', tag: 'Konto', summary: 'Angemeldete Person, Arbeitsbereich, Token-Bereich', run: c => svc.me(c.db, c.actor, { scope: c.principal.scope, via: c.principal.via }) },
  { method: 'GET', path: '/projects', scope: 'read', tag: 'Projekte', summary: 'Sichtbare Projekte mit Projekt-Regeln', run: c => svc.listProjects(c.db, c.actor) },
  { method: 'GET', path: '/projects/{project}', scope: 'read', tag: 'Projekte', summary: 'Stand: diese Woche, Ziele, Strategie, offene Freigaben, Ergebnisse der letzten 7 Tage', run: c => svc.projectStatus(c.db, c.actor, c.params.project!) },
  { method: 'GET', path: '/projects/{project}/goals', scope: 'read', tag: 'Ziele', summary: 'Ziele mit Fortschritt', run: c => svc.goals(c.db, c.actor, c.params.project!) },
  { method: 'POST', path: '/projects/{project}/goals', scope: 'write', tag: 'Ziele', summary: 'Ziel anlegen', body: goalBody.extend({ label: z.string().trim().min(1).max(120) }), run: c => svc.setGoal(c.db, c.actor, c.params.project!, c.body) },
  { method: 'PATCH', path: '/projects/{project}/goals/{id}', scope: 'write', tag: 'Ziele', summary: 'Ziel ändern', body: goalBody, run: c => svc.setGoal(c.db, c.actor, c.params.project!, { ...c.body, id: c.params.id }) },
  { method: 'GET', path: '/projects/{project}/strategy', scope: 'read', tag: 'Strategie', summary: 'Aktive Strategie, offener Vorschlag, Verlauf', run: c => svc.strategy(c.db, c.actor, c.params.project!) },
  {
    method: 'POST',
    path: '/projects/{project}/strategy/channels',
    scope: 'write',
    tag: 'Strategie',
    summary: 'Kanal-Takt ändern (more, less, pause, resume, new, remove)',
    body: z.object({ channel: z.string().trim().min(1).max(80), change: z.enum(['more', 'less', 'pause', 'resume', 'new', 'remove']), category: z.string().max(30).optional(), reason: z.string().max(300).optional() }),
    run: c => svc.adjustChannel(c.db, c.actor, c.params.project!, c.body as { channel: string, change: string }),
  },
  {
    method: 'PATCH',
    path: '/projects/{project}/strategy/channels/{channel}',
    scope: 'write',
    tag: 'Strategie',
    summary: 'Name, Orte, Themen oder Begründung eines Kanals ändern',
    body: z.object({ name: z.string().min(1).max(80).optional(), places: z.array(z.string().max(120)).max(20).optional(), topics: z.array(z.string().max(120)).max(20).optional(), why: z.string().max(400).optional() }),
    run: c => svc.channelDetails(c.db, c.actor, c.params.project!, { ...c.body, channel: c.params.channel! }),
  },
  {
    method: 'GET',
    path: '/projects/{project}/results',
    scope: 'read',
    tag: 'Ergebnisse',
    summary: 'Kennzahlen, Ergebnisse je Aufgabe und Ziele im Zeitraum (Standard 30 Tage)',
    query: z.object({ from: iso.optional(), to: iso.optional() }),
    run: c => svc.results(c.db, c.actor, c.params.project!, c.query),
  },
  {
    method: 'GET',
    path: '/projects/{project}/history',
    scope: 'read',
    tag: 'Ergebnisse',
    summary: 'Verlauf: was rausgegangen ist, je Aufgabe mit Zeitpunkt und Links je Plattform, neueste zuerst (Standard 30 Tage)',
    query: z.object({ from: iso.optional(), to: iso.optional() }),
    run: c => svc.history(c.db, c.actor, c.params.project!, c.query),
  },
  {
    method: 'GET',
    path: '/projects/{project}/traffic',
    scope: 'read',
    tag: 'Ergebnisse',
    summary: 'Besucher je Quelle aus den UTM-Zahlen der Projektseite: Besuche, Anmeldungen, Käufe, Umsatz, je Kampagne mit Aufgabe (Standard 30 Tage)',
    query: z.object({ from: iso.optional(), to: iso.optional() }),
    run: c => svc.traffic(c.db, c.actor, c.params.project!, c.query),
  },
  {
    method: 'GET',
    path: '/projects/{project}/search',
    scope: 'read',
    tag: 'Ergebnisse',
    summary: 'Google-Suche (Search Console): Klicks, Impressionen, Top-Suchbegriffe, Chancen, gefallene Seiten und Probleme der letzten SEO-Prüfung (Standard 28 Tage)',
    query: z.object({ from: iso.optional(), to: iso.optional() }),
    run: c => svc.searchTerms(c.db, c.actor, c.params.project!, c.query),
  },
  {
    method: 'POST',
    path: '/projects/{project}/metrics',
    scope: 'write',
    tag: 'Ergebnisse',
    summary: 'Zahl erfassen (z.B. 3 neue Registrierungen heute)',
    body: z.object({ key: z.string().trim().min(1).max(40), value: z.number().min(0), day: iso.optional() }),
    run: c => svc.recordMetric(c.db, c.actor, c.params.project!, c.body as { key: string, value: number }),
  },
  {
    method: 'GET',
    path: '/tasks',
    scope: 'read',
    tag: 'Aufgaben',
    summary: 'Aufgaben suchen',
    query: z.object({ project: projectQ, from: iso.optional(), to: iso.optional(), status: z.string().max(200).optional().describe('Kommagetrennt, z.B. geplant,entwurf_fertig'), search: z.string().max(80).optional(), limit: z.coerce.number().int().min(1).max(200).optional() }),
    run: c => svc.searchTasks(c.db, c.actor, c.query),
  },
  { method: 'POST', path: '/tasks', scope: 'write', tag: 'Aufgaben', summary: 'Aufgabe anlegen (Entwurf landet in den Freigaben, nie automatisch gepostet)', body: taskBody, run: c => svc.createTask(c.db, c.actor, c.body as unknown as svc.TaskInput, c.deps) },
  { method: 'GET', path: '/tasks/{code}', scope: 'read', tag: 'Aufgaben', summary: 'Aufgabe mit Entwürfen, Notizen und Ergebnissen', run: c => svc.getTask(c.db, c.actor, c.params.code!) },
  { method: 'PATCH', path: '/tasks/{code}', scope: 'write', tag: 'Aufgaben', summary: 'Aufgabe verschieben, umbenennen oder Status setzen', body: taskPatch, run: c => svc.updateTask(c.db, c.actor, c.params.code!, c.body) },
  { method: 'POST', path: '/tasks/{code}/drafts', scope: 'write', tag: 'Entwürfe', summary: 'Neue Entwurfsfassung speichern (Status offen, Freigabe in Aimarage)', body: draftBody, run: c => svc.saveDraft(c.db, c.actor, c.params.code!, c.body as { body: string }) },
  {
    method: 'GET',
    path: '/calendar',
    scope: 'read',
    tag: 'Aufgaben',
    summary: 'Kalender: Aufgaben und geplante Wiederholungen (Standard: diese Woche)',
    query: z.object({ project: projectQ, from: iso.optional(), days: z.coerce.number().int().min(1).max(62).optional() }),
    run: c => svc.weekPlan(c.db, c.actor, c.query),
  },
  { method: 'GET', path: '/approvals', scope: 'read', tag: 'Entwürfe', summary: 'Offene Freigaben', query: z.object({ project: projectQ }), run: c => svc.approvals(c.db, c.actor, c.query.project as string | undefined) },
  { method: 'GET', path: '/drafts/{id}', scope: 'read', tag: 'Entwürfe', summary: 'Entwurf lesen (mit Projekt-Regeln)', run: c => svc.readDraft(c.db, c.actor, { id: c.params.id }) },
  { method: 'POST', path: '/drafts/{id}/reject', scope: 'write', tag: 'Entwürfe', summary: 'Entwurf verwerfen (Aufgabe zurück auf geplant, mit dropTask ganz verwerfen)', body: z.object({ reason: z.string().max(2000).optional(), dropTask: z.boolean().optional() }), run: c => svc.rejectDraft(c.db, c.actor, c.params.id!, c.body.reason as string | undefined, c.body.dropTask as boolean | undefined) },
  {
    method: 'GET',
    path: '/agent/log',
    scope: 'read',
    tag: 'Agent',
    summary: 'Agent-Protokoll: Läufe und Aktivität',
    query: z.object({ project: projectQ, limit: z.coerce.number().int().min(1).max(100).optional() }),
    run: c => svc.agentLog(c.db, c.actor, c.query),
  },
  { method: 'GET', path: '/chat', scope: 'read', tag: 'Agent', summary: 'Gesprächsverlauf mit dem Agenten', query: z.object({ project: projectQ, limit: z.coerce.number().int().min(1).max(100).optional() }), run: c => svc.chatHistory(c.db, c.actor, c.query.project as string | undefined, c.query.limit as number | undefined) },
  {
    method: 'POST',
    path: '/chat',
    scope: 'write',
    tag: 'Agent',
    summary: 'Nachricht an den Agenten, wartet auf die Antwort',
    body: z.object({ message: z.string().trim().min(1).max(8000), project: z.string().max(60).optional() }),
    run: c => svc.talkToAgent(c.db, c.actor, c.body as { message: string }, c.deps),
  },
]

export function permOfRoute(r: Pick<Route, 'method' | 'path' | 'scope'>): ApiPerm {
  if (r.scope === 'read') return 'read'
  if (r.path === '/chat') return 'agent'
  if (/\/(?:goals|strategy|metrics)(?:\/|$)/.test(r.path)) return 'strategy'
  return 'draft'
}

export function matchRoute(method: string, path: string): { route: Route, params: Record<string, string> } | 'method' | null {
  const parts = path.split('/').filter(Boolean)
  let methodMismatch = false
  for (const r of ROUTES) {
    const segs = r.path.split('/').filter(Boolean)
    if (segs.length !== parts.length) continue
    const params: Record<string, string> = {}
    let ok = true
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i]!
      const v = parts[i]!
      if (s.startsWith('{')) {
        let dec: string
        try {
          dec = decodeURIComponent(v)
        }
        catch {
          ok = false
          break
        }
        if (!dec || dec.length > 100) {
          ok = false
          break
        }
        params[s.slice(1, -1)] = dec
      }
      else if (s !== v) {
        ok = false
        break
      }
    }
    if (!ok) continue
    if (r.method !== method) {
      methodMismatch = true
      continue
    }
    return { route: r, params }
  }
  return methodMismatch ? 'method' : null
}

function jsonSchema(s: ZodType): Record<string, unknown> {
  const out = z.toJSONSchema(s, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>
  delete out.$schema
  return out
}

export function openApi(base: string) {
  const paths: Record<string, Record<string, unknown>> = {}
  for (const r of ROUTES) {
    const params = [...r.path.matchAll(/\{(\w+)\}/g)].map(m => ({ name: m[1], in: 'path', required: true, schema: { type: 'string' } }))
    const q = r.query ? Object.entries((jsonSchema(r.query).properties ?? {}) as Record<string, Record<string, unknown>>).map(([name, schema]) => ({ name, in: 'query', required: false, schema, ...(schema.description ? { description: schema.description } : {}) })) : []
    ;(paths[r.path] ??= {})[r.method.toLowerCase()] = {
      tags: [r.tag],
      summary: r.summary,
      security: [{ bearer: [r.scope] }],
      ...(params.length || q.length ? { parameters: [...params, ...q] } : {}),
      ...(r.body ? { requestBody: { required: true, content: { 'application/json': { schema: jsonSchema(r.body) } } } } : {}),
      responses: {
        200: { description: 'OK', content: { 'application/json': { schema: { type: 'object' } } } },
        400: { description: 'Ungültige Eingabe' },
        401: { description: 'Token fehlt oder ungültig' },
        403: { description: 'Token nur zum Lesen oder keine Berechtigung' },
        404: { description: 'Nicht gefunden (auch: Projekt nicht sichtbar)' },
        429: { description: 'Zu viele Anfragen' },
      },
    }
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'Aimarage API',
      version: '1.0.0',
      description: 'REST-API von Aimarage. Anmeldung mit API-Token (Einstellungen > Profil > API und MCP) als Bearer. Bereich "read" nur lesen, "write" auch ändern. Über die API wird nie gepostet oder gesendet: Entwürfe landen in den Freigaben und werden in Aimarage freigegeben. Projekt-Regeln (Feld rules) sind verbindlich.',
    },
    servers: [{ url: `${base}/api/v1` }],
    components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer', description: 'API-Token (amk_...) oder OAuth-Zugang' } } },
    paths,
  }
}
