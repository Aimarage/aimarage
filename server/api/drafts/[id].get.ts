import { and, desc, eq } from 'drizzle-orm'
import { buildUtmUrl } from '~~/shared/utils/utm'
import { getDb, schema } from '~~/server/lib/db'
import { mailInfo, sentInfo } from '~~/server/lib/mail'
import { replySourceOf } from '~~/shared/utils/reply-source'
import { canPublishTask } from '~~/server/lib/outlets'
import { chosenPlatforms, plannedAt, socialTarget } from '~~/server/lib/publish'
import { taskWhereOf } from '~~/server/lib/where'
import { blogApiReady, blogHost, isArticleTask } from '~~/server/lib/blog-api'
import { cachedRules } from '~~/server/lib/subreddit-rules'
import { replyAccount } from '~~/server/lib/listen-account'
import { todoFacts } from '~~/server/lib/todo'
import { draftPrivacy } from '~~/server/lib/privacy'

export default defineEventHandler(async (event) => {
  const s = await requireAuth(event)
  const db = await getDb()
  const id = getRouterParam(event, 'id')!
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw createError({ statusCode: 404, statusMessage: 'Entwurf nicht gefunden' })
  const [row] = await db.select({ draft: schema.drafts, task: schema.tasks }).from(schema.drafts)
    .innerJoin(schema.tasks, eq(schema.tasks.id, schema.drafts.taskId))
    .where(and(eq(schema.drafts.id, id), eq(schema.tasks.workspaceId, s.workspace.id)))
  if (!row) throw createError({ statusCode: 404, statusMessage: 'Entwurf nicht gefunden' })
  await assertProjectVisible(db, s, row.task.projectId, 'Entwurf nicht gefunden')
  const project = row.task.projectId ? (await db.select().from(schema.projects).where(eq(schema.projects.id, row.task.projectId)))[0] ?? null : null
  const versions = await db.select({ id: schema.drafts.id, version: schema.drafts.version, status: schema.drafts.status, byAgent: schema.drafts.byAgent, createdAt: schema.drafts.createdAt })
    .from(schema.drafts).where(eq(schema.drafts.taskId, row.task.id)).orderBy(desc(schema.drafts.version))
  const target = project && canPublishTask(row.task) ? socialTarget(s.workspace, project) : null
  const posts = await db.select().from(schema.socialPosts).where(eq(schema.socialPosts.taskId, row.task.id)).orderBy(desc(schema.socialPosts.createdAt)).limit(5)
  const where = await taskWhereOf(db, s.workspace, { ...row.task, description: [row.task.description, row.draft.targetUrl].filter(Boolean).join('\n') }, project, row.draft.recipient)
  const rules = where.mark === 'reddit' && where.place?.startsWith('r/') ? cachedRules(s.workspace, where.place) : null
  const notes = await db.select().from(schema.taskNotes).where(eq(schema.taskNotes.taskId, row.task.id)).orderBy(desc(schema.taskNotes.createdAt)).limit(40)
  return {
    draft: { ...row.draft, media: undefined },
    task: { id: row.task.id, code: row.task.code, title: row.task.title, status: row.task.status, category: row.task.category, channel: row.task.channel, dueDate: row.task.dueDate, dueTime: row.task.dueTime, projectId: row.task.projectId, humanStep: row.task.humanStep, targetUrl: row.task.targetUrl, service: row.task.service, forClaude: row.task.forClaude, estimateMin: row.task.estimateMin, postedUrl: row.task.postedUrl, doneAt: row.task.doneAt && ['wartet', 'erledigt', 'ausgewertet'].includes(row.task.status) ? row.task.doneAt.toISOString() : null },
    project: project ? { id: project.id, slug: project.slug, name: project.name, color: project.color, url: project.url } : null,
    privacy: draftPrivacy(project, row.draft),
    utmUrl: buildUtmUrl(row.task.targetUrl ?? project?.url, row.task),
    where,
    todo: await todoFacts(db, s.workspace, project, row.task, where, row.draft.kind, notes.map(n => n.text)),
    reply: replyAccount(s.workspace, project, row.task),
    source: replySourceOf({ description: row.task.description, createdAt: row.task.createdAt, title: row.task.title, notes, notesSince: row.draft.createdAt, mailDate: row.draft.kind === 'mail' ? (await mailInfo(db, row.task.id, 0))?.date ?? null : null }),
    subreddit: rules ? { sub: rules.sub, promo: rules.promo, days: rules.days, flair: rules.flair, flairRequired: rules.flairRequired } : null,
    versions: versions.map(v => ({ ...v, createdAt: v.createdAt.toISOString() })),
    notes,
    social: {
      possible: canPublishTask(row.task),
      live: !!s.workspace.settings?.publishLive,
      accounts: target?.platforms.map(p => ({ platform: p.platform, name: p.name, postable: p.postable, via: p.via.startsWith('up:') ? 'uploadpost' : 'own' })) ?? [],
      chosen: target ? chosenPlatforms(row.draft, target, row.task) : [],
      planned: row.task.dueDate ? plannedAt(row.task, s.workspace.timezone).toISOString() : null,
      posts: posts.map(p => ({ id: p.id, status: p.status, mode: p.mode, dryRun: p.dryRun, scheduledAt: p.scheduledAt.toISOString(), updatedAt: p.updatedAt.toISOString(), postedAt: p.postedAt?.toISOString() ?? null, platforms: p.platforms, results: p.results.map(r => ({ platform: r.platform, ok: r.ok, url: r.url ?? null, error: r.error ?? null })), error: p.error })),
    },
    mail: {
      ready: !!project?.setup?.mail,
      live: !!s.workspace.settings?.sendLive,
      locked: !!s.workspace.settings?.outboundLocked,
      from: project?.setup?.mail?.from ?? null,
      sent: await sentInfo(db, row.draft.id),
      log: (await db.select().from(schema.mails).where(and(eq(schema.mails.taskId, row.task.id), eq(schema.mails.direction, 'out'))).orderBy(desc(schema.mails.createdAt)).limit(5)).map(m => ({ id: m.id, status: m.status, to: m.toAddr, at: (m.sentAt ?? m.scheduledAt ?? m.createdAt).toISOString(), error: m.error })),
    },
    blog: {
      ready: isArticleTask(row.task, row.draft) && blogApiReady(project),
      live: !!s.workspace.settings?.publishLive,
      host: blogHost(project?.setup?.blogApi),
      at: row.task.dueDate ? plannedAt(row.task, s.workspace.timezone).toISOString() : null,
    },
    media: row.draft.media.map(m => ({ id: m.id, name: m.name, mime: m.mime, size: m.size })),
  }
})
