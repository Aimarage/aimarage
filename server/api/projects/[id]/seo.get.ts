import { sql } from 'drizzle-orm'
import { groupOf, latestAudit, seoGroupTasks, shownIssues } from '~~/server/lib/seo-audit'

export default defineEventHandler(async (event) => {
  const { s, db, p } = await projectById(event)
  const audit = await latestAudit(db, p.id)
  const res = await db.execute(sql`select 1 from jobs where workspace_id = ${s.workspace.id} and type = 'seo_audit' and status in ('queued', 'running') and (payload->>'projectId' = ${p.id} or payload->>'projectId' is null) limit 1`)
  const running = (res as unknown as { rows: unknown[] }).rows.length > 0
  return {
    running,
    url: p.url,
    tasks: audit ? await seoGroupTasks(db, p.id, audit.checkedAt) : {},
    audit: audit ? { checkedAt: audit.checkedAt, pages: audit.pages.length, linksChecked: audit.linksChecked, error: audit.error, pagespeed: audit.pagespeed, issues: shownIssues(audit.issues).map(i => ({ code: i.code, group: groupOf(i.code), severity: i.severity, url: i.url, params: i.params })) } : null,
  }
})
