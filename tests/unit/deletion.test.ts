import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import * as h3 from 'h3'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createSession } from '../../server/lib/auth'
import { openTestDb, schema, type Db } from '../../server/lib/db'
import { accountDeletionPlan, deleteAccount, deleteProject, DeletionError } from '../../server/lib/deletion'
import { registerExtension, resetExtensions } from '../../server/lib/extensions'
import { resetStorage, useStorage } from '../../server/lib/storage'

// Projekt und eigenes Konto löschen: nur die eigenen Daten, fremde Projekte und Arbeitsbereiche bleiben unberührt.

const ROOT = resolve(__dirname, '../..')
const g = globalThis as Record<string, unknown>
let db: Db
let close: () => Promise<void>
let tmp: string
let web: (req: Request) => Promise<Response>
let n = 0

function walk(dir: string): string[] {
  return (readdirSync(dir, { recursive: true }) as string[]).map(f => join(dir, f)).filter(f => f.endsWith('.ts'))
}

async function call(method: string, path: string, cookie: string, body?: unknown) {
  const res = await web(new Request(`http://localhost:3210${path}`, { method, headers: { 'cookie': `ma_session=${cookie}`, 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0' }, body: body !== undefined ? JSON.stringify(body) : undefined }))
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) as Record<string, any> : {}, cookie: res.headers.get('set-cookie') ?? '' }
}

async function user(tag: string) {
  const [u] = await db.insert(schema.users).values({ email: `${tag}@test.local`, name: `User ${tag}` }).returning()
  return u!.id
}

async function workspace(owner: string, tag: string) {
  const [w] = await db.insert(schema.workspaces).values({ name: `WS ${tag}` }).returning()
  await db.insert(schema.memberships).values({ workspaceId: w!.id, userId: owner, role: 'owner' })
  return w!.id
}

async function project(ws: string, tag: string) {
  const i = ++n
  const [p] = await db.insert(schema.projects).values({ workspaceId: ws, slug: `p-${tag}-${i}`, name: `Projekt ${tag}`, code: `P${i}`, icon: 'X' }).returning()
  const pid = p!.id
  const [t] = await db.insert(schema.tasks).values({ workspaceId: ws, projectId: pid, code: `P${i}-SOC-001`, title: `Aufgabe ${tag}`, category: 'social' }).returning()
  const [d] = await db.insert(schema.drafts).values({ taskId: t!.id, body: `Entwurf ${tag}`, media: [{ id: 'm', name: 'a.png', mime: 'image/png', size: 3, file: `${ws}/${crypto.randomUUID()}/a.png` }] }).returning()
  const draftFile = d!.media[0]!.file
  await db.insert(schema.recurrences).values({ workspaceId: ws, projectId: pid, rule: 'FREQ=WEEKLY;BYDAY=MO', title: `Serie ${tag}`, category: 'social' })
  await db.insert(schema.goals).values({ workspaceId: ws, projectId: pid, label: `Ziel ${tag}`, metricKey: 'follower' })
  await db.insert(schema.strategies).values({ workspaceId: ws, projectId: pid, status: 'aktiv', summary: `Strategie ${tag}`, channels: [] })
  await db.insert(schema.contacts).values({ workspaceId: ws, projectId: pid, name: `Kontakt ${tag}`, email: `k-${tag}@x.at` } as never)
  await db.insert(schema.activity).values({ workspaceId: ws, projectId: pid, actor: 'agent', action: 'task_created', detail: { title: tag } })
  await db.insert(schema.jobs).values({ workspaceId: ws, type: 'draft_task', payload: { projectId: pid } })
  const docFile = `${ws}/docs/${pid}/u.pdf`
  const fundusFile = `${ws}/fundus/${pid}/f.png`
  await db.insert(schema.projectDocuments).values({ workspaceId: ws, projectId: pid, name: 'u.pdf', type: 'pdf', mime: 'application/pdf', size: 3, file: docFile, text: 'x', status: 'fertig' } as never)
  await db.insert(schema.mediaLibrary).values({ workspaceId: ws, projectId: pid, name: 'f.png', mime: 'image/png', size: 3, file: fundusFile } as never)
  const storage = useStorage()
  for (const f of [draftFile, docFile, fundusFile]) await storage.put(f, new TextEncoder().encode(tag))
  return { pid, task: t!.id, files: [draftFile, docFile, fundusFile] }
}

async function count(table: any, col: any, id: string) {
  return (await db.select().from(table).where(eq(col, id))).length
}

beforeAll(async () => {
  process.env.APP_SECRET = 'test-secret-del'
  tmp = mkdtempSync(join(tmpdir(), 'ma-del-'))
  process.env.MEDIA_DIR = join(tmp, 'media')
  process.env.STORAGE_DRIVER = 'local'
  resetStorage()
  ;({ db, close } = await openTestDb())
  g.__maDb = Promise.resolve({ db, close: async () => {} })
  Object.assign(g, h3)
  for (const f of walk(join(ROOT, 'shared/utils'))) Object.assign(g, await import(f))
  for (const f of walk(join(ROOT, 'server/utils'))) Object.assign(g, await import(f))
  const router = h3.createRouter()
  const api = join(ROOT, 'server/api')
  for (const [file, path, method] of [['projects/[id]/delete.post.ts', '/api/projects/:id/delete', 'post'], ['me/delete.get.ts', '/api/me/delete', 'get'], ['me/delete.post.ts', '/api/me/delete', 'post']] as const) {
    router.use(path, (await import(join(api, file))).default, method)
  }
  const app = h3.createApp()
  app.use(router)
  web = h3.toWebHandler(app)
}, 120_000)

afterEach(() => resetExtensions())

afterAll(async () => {
  for (const k of ['APP_SECRET', 'MEDIA_DIR', 'STORAGE_DRIVER']) delete process.env[k]
  g.__maDb = undefined
  resetStorage()
  await close()
  rmSync(tmp, { recursive: true, force: true })
})

describe('Projekt löschen', () => {
  it('löscht Projekt mit Aufgaben, Entwürfen, Serien, Zielen, Strategie, Kontakten, Jobs und Dateien, sonst nichts', async () => {
    const owner = await user('pa')
    const ws = await workspace(owner, 'pa')
    const doomed = await project(ws, 'weg')
    const keep = await project(ws, 'bleibt')
    const otherOwner = await user('pb')
    const other = await workspace(otherOwner, 'pb')
    const foreign = await project(other, 'fremd')

    const r = await deleteProject(db, ws, doomed.pid, { userId: owner })
    expect(r).toEqual({ name: 'Projekt weg', files: 3 })
    expect(await count(schema.projects, schema.projects.id, doomed.pid)).toBe(0)
    for (const [t, c] of [[schema.tasks, schema.tasks.projectId], [schema.recurrences, schema.recurrences.projectId], [schema.goals, schema.goals.projectId], [schema.strategies, schema.strategies.projectId], [schema.contacts, schema.contacts.projectId], [schema.activity, schema.activity.projectId], [schema.projectDocuments, schema.projectDocuments.projectId], [schema.mediaLibrary, schema.mediaLibrary.projectId]] as const) {
      expect(await count(t, c, doomed.pid)).toBe(0)
      expect(await count(t, c, keep.pid)).toBe(1)
      expect(await count(t, c, foreign.pid)).toBe(1)
    }
    expect(await count(schema.drafts, schema.drafts.taskId, doomed.task)).toBe(0)
    expect(await count(schema.drafts, schema.drafts.taskId, keep.task)).toBe(1)
    const jobs = (await db.select().from(schema.jobs)).map(j => (j.payload as { projectId?: string }).projectId)
    expect(jobs).not.toContain(doomed.pid)
    expect(jobs).toEqual(expect.arrayContaining([keep.pid, foreign.pid]))
    const storage = useStorage()
    for (const f of doomed.files) expect(await storage.stat(f)).toBeNull()
    for (const f of [...keep.files, ...foreign.files]) expect(await storage.stat(f)).not.toBeNull()
    const [log] = await db.select().from(schema.deletionLog).where(eq(schema.deletionLog.targetId, doomed.pid))
    expect(log).toMatchObject({ kind: 'project', workspaceId: ws, actorUserId: owner, counts: { tasks: 1, files: 3 } })
    const act = await db.select().from(schema.activity).where(eq(schema.activity.workspaceId, ws))
    expect(act.some(a => a.action === 'project_deleted' && (a.detail as { title: string }).title === 'Projekt weg')).toBe(true)
  })

  it('fremdes Projekt: nicht gefunden, nichts gelöscht', async () => {
    const a = await workspace(await user('fa'), 'fa')
    const b = await workspace(await user('fb'), 'fb')
    const pb = await project(b, 'fb')
    await expect(deleteProject(db, a, pb.pid, { userId: null })).rejects.toBeInstanceOf(DeletionError)
    expect(await count(schema.projects, schema.projects.id, pb.pid)).toBe(1)
  })

  it('API: nur Admins, Name muss stimmen', async () => {
    const owner = await user('api')
    const ws = await workspace(owner, 'api')
    const p = await project(ws, 'api')
    const [m] = await db.insert(schema.users).values({ email: 'mitglied-api@test.local', name: 'M' }).returning()
    await db.insert(schema.memberships).values({ workspaceId: ws, userId: m!.id, role: 'member' })
    expect((await call('POST', `/api/projects/${p.pid}/delete`, await createSession(db, m!.id, ws, { method: 'code' }), { name: 'Projekt api' })).status).toBe(403)
    const cookie = await createSession(db, owner, ws, { method: 'code' })
    expect((await call('POST', `/api/projects/${p.pid}/delete`, cookie, { name: 'Projekt falsch' })).status).toBe(400)
    expect(await count(schema.projects, schema.projects.id, p.pid)).toBe(1)
    expect((await call('POST', `/api/projects/${p.pid}/delete`, cookie, { name: 'Projekt api' })).status).toBe(200)
    expect(await count(schema.projects, schema.projects.id, p.pid)).toBe(0)
  })
})

describe('Konto löschen', () => {
  it('alleiniger Inhaber mit weiteren Mitgliedern: blockiert, nichts gelöscht', async () => {
    const owner = await user('blk')
    const ws = await workspace(owner, 'blk')
    const m = await user('blk-m')
    await db.insert(schema.memberships).values({ workspaceId: ws, userId: m, role: 'admin' })
    expect((await accountDeletionPlan(db, owner)).blocked.map(b => b.id)).toEqual([ws])
    await expect(deleteAccount(db, owner, { userId: owner })).rejects.toMatchObject({ status: 409 })
    expect(await count(schema.users, schema.users.id, owner)).toBe(1)
    expect(await count(schema.workspaces, schema.workspaces.id, ws)).toBe(1)
  })

  it('verlässt geteilte Bereiche, löscht den eigenen Bereich, Passkeys und Sitzungen; Fremdes bleibt', async () => {
    const me = await user('acc')
    const solo = await workspace(me, 'acc-solo')
    const soloP = await project(solo, 'solo')
    const shared = await workspace(await user('acc-chef'), 'acc-shared')
    await db.insert(schema.memberships).values({ workspaceId: shared, userId: me, role: 'member' })
    const coOwned = await workspace(me, 'acc-co')
    const co = await user('acc-co2')
    await db.insert(schema.memberships).values({ workspaceId: coOwned, userId: co, role: 'owner' })
    const foreign = await workspace(await user('acc-fremd'), 'acc-fremd')
    const foreignP = await project(foreign, 'fremd2')
    await db.insert(schema.passkeys).values({ userId: me, credentialId: 'cred-acc', publicKey: 'pk', name: 'Mac' })
    await createSession(db, me, solo, { method: 'code' })

    const plan = await accountDeletionPlan(db, me)
    expect(plan.remove.map(w => w.id)).toEqual([solo])
    expect(plan.leave.map(w => w.id).sort()).toEqual([shared, coOwned].sort())
    await deleteAccount(db, me, { userId: me })

    expect(await count(schema.users, schema.users.id, me)).toBe(0)
    expect(await count(schema.passkeys, schema.passkeys.userId, me)).toBe(0)
    expect(await count(schema.sessions, schema.sessions.userId, me)).toBe(0)
    expect(await count(schema.memberships, schema.memberships.userId, me)).toBe(0)
    expect(await count(schema.workspaces, schema.workspaces.id, solo)).toBe(0)
    for (const f of soloP.files) expect(await useStorage().stat(f)).toBeNull()
    for (const id of [shared, coOwned, foreign]) expect(await count(schema.workspaces, schema.workspaces.id, id)).toBe(1)
    expect(await count(schema.memberships, schema.memberships.workspaceId, coOwned)).toBe(1)
    expect(await count(schema.projects, schema.projects.id, foreignP.pid)).toBe(1)
    for (const f of foreignP.files) expect(await useStorage().stat(f)).not.toBeNull()
    const logs = await db.select().from(schema.deletionLog).where(eq(schema.deletionLog.actorUserId, me))
    expect(logs.map(l => l.kind).sort()).toEqual(['account', 'workspace'])
    const mails = (await db.select().from(schema.jobs).where(eq(schema.jobs.type, 'system_mail'))).filter(j => (j.payload as { to: string }).to === 'acc@test.local')
    expect(mails).toHaveLength(1)
  })

  it('gehostet: eigener Bereich geht über den vorhandenen Ablauf der Erweiterung', async () => {
    const calls: { workspaceId: string, notify: boolean }[] = []
    registerExtension({ name: 'test', deleteWorkspace: async (_db, input) => {
      calls.push(input)
      return true
    } })
    const me = await user('ext')
    const solo = await workspace(me, 'ext')
    await deleteAccount(db, me, { userId: me })
    expect(calls).toEqual([{ workspaceId: solo, notify: false }])
    expect(await count(schema.workspaces, schema.workspaces.id, solo)).toBe(1)
    expect(await count(schema.users, schema.users.id, me)).toBe(0)
  })

  it('API: Adresse und Step-up nötig, danach abgemeldet', async () => {
    const me = await user('apiacc')
    const ws = await workspace(me, 'apiacc')
    const old = await createSession(db, me, ws, { method: 'code', stepUpAt: null })
    expect((await call('GET', '/api/me/delete', old)).body.remove).toHaveLength(1)
    expect((await call('POST', '/api/me/delete', old, { email: 'falsch@test.local' })).status).toBe(400)
    const noStep = await call('POST', '/api/me/delete', old, { email: 'apiacc@test.local' })
    expect(noStep.status).toBe(403)
    expect(await count(schema.users, schema.users.id, me)).toBe(1)
    const res = await call('POST', '/api/me/delete', await createSession(db, me, ws, { method: 'code' }), { email: 'APIacc@test.local' })
    expect(res.status).toBe(200)
    expect(res.cookie).toMatch(/ma_session=;/)
    expect(await count(schema.users, schema.users.id, me)).toBe(0)
  })
})
