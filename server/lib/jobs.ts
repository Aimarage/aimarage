import { sql } from 'drizzle-orm'
import type { DbOrTx } from './db'
import { schema } from './db'

export const JOB_TYPES = ['materialize_recurrences', 'draft_tasks', 'draft_task', 'followups', 'daily_briefing', 'weekly_report', 'strategy_review', 'onboard_project', 'rethink_strategy', 'reconcile_tasks', 'publish_post', 'publish_status', 'social_stats', 'mail_sync', 'send_mail', 'utm_sync', 'publish_article', 'withdraw_article', 'search_sync', 'seo_audit', 'feed_sync', 'geo_check', 'document_digest', 'system_mail', 'morning_mail', 'auth_cleanup', 'storage_usage', 'social_listening', 'listening_reply', 'conn_recheck', 'app_push', 'site_read', 'zernio_cleanup'] as const
export type JobType = typeof JOB_TYPES[number]

export interface JobRow {
  id: number
  workspace_id: string | null
  type: JobType
  payload: Record<string, unknown>
  attempts: number
  max_attempts: number
}

export async function enqueueJob(db: DbOrTx, type: JobType, opts: { workspaceId?: string | null, payload?: Record<string, unknown>, dedupeKey?: string, runAt?: Date, maxAttempts?: number } = {}): Promise<boolean> {
  const rows = await db.insert(schema.jobs).values({
    type,
    workspaceId: opts.workspaceId ?? null,
    payload: opts.payload ?? {},
    dedupeKey: opts.dedupeKey ?? null,
    maxAttempts: opts.maxAttempts ?? 3,
    ...(opts.runAt ? { runAt: opts.runAt } : {}),
  }).onConflictDoNothing().returning({ id: schema.jobs.id })
  return rows.length > 0
}

// Jobs mit festem Zeitpunkt: laufen auch, wenn im selben Workspace gerade ein anderer Job läuft, und kommen zuerst dran.
export const TIMED_JOBS: JobType[] = ['publish_post', 'publish_article', 'withdraw_article', 'publish_status', 'send_mail', 'system_mail', 'morning_mail']

const CLAIM_LOCK = 7_214_031

// Fairness: Workspaces mit laufendem Job werden übersprungen (außer Jobs mit festem Zeitpunkt),
// pausierte und gelöschte Workspaces bekommen keine Jobs (pausiert: nur der eine Vorschau-Job). Die Sperre macht die Auswahl über mehrere Schleifen eindeutig.
export async function claimJob(db: DbOrTx, workerId: string): Promise<JobRow | null> {
  const timed = sql.join(TIMED_JOBS.map(t => sql`${t}`), sql`, `)
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${CLAIM_LOCK})`)
    const res = await tx.execute(sql`
      update jobs set status = 'running', locked_at = now(), attempts = attempts + 1, worker_id = ${workerId}
      where id = (
        select j.id from jobs j
        left join workspaces w on w.id = j.workspace_id
        where j.status = 'queued' and j.run_at <= now()
          and (j.workspace_id is null or (w.deleted_at is null and (w.paused_at is null
            or (j.type = 'onboard_project' and j.payload->>'preview' = 'true' and w.preview_used_at is not null))))
          and (j.workspace_id is null or j.type in (${timed}) or not exists (
            select 1 from jobs r where r.workspace_id = j.workspace_id and r.status = 'running' and r.type not in (${timed})
          ))
        order by (j.type in (${timed})) desc, j.id
        for update of j skip locked
        limit 1
      )
      returning id, workspace_id, type, payload, attempts, max_attempts
    `)
    const row = (res as unknown as { rows: Record<string, unknown>[] }).rows[0]
    return row ? (row as unknown as JobRow) : null
  })
}

export async function completeJob(db: DbOrTx, id: number, status: 'done' | 'skipped' = 'done', note: string | null = null): Promise<void> {
  await db.execute(sql`update jobs set status = ${status}, finished_at = now(), last_error = ${note} where id = ${id}`)
}

export async function failJob(db: DbOrTx, job: JobRow, error: string): Promise<boolean> {
  const final = job.attempts >= job.max_attempts
  await db.execute(sql`
    update jobs set
      status = ${final ? 'failed' : 'queued'},
      last_error = ${error.slice(0, 2000)},
      run_at = now() + (${60 * job.attempts} * interval '1 second'),
      finished_at = ${final ? sql`now()` : sql`null`}
    where id = ${job.id}
  `)
  return final
}

export async function requeueStale(db: DbOrTx, minutes = 15): Promise<number> {
  const res = await db.execute(sql`
    update jobs set
      status = case when attempts >= max_attempts then 'failed'::job_status else 'queued'::job_status end,
      finished_at = case when attempts >= max_attempts then now() else null end,
      locked_at = null, worker_id = null,
      last_error = 'kein Ergebnis nach ' || ${minutes} || ' Minuten, ' || case when attempts >= max_attempts then 'abgebrochen' else 'erneut eingereiht' end
    where status = 'running' and locked_at < now() - (${minutes} * interval '1 minute')
    returning id
  `)
  await db.execute(sql`
    update agent_runs set status = 'error', finished_at = now(), summary = 'Abgebrochen (keine Rückmeldung)'
    where status = 'running' and started_at < now() - (${minutes} * interval '1 minute')
  `)
  return (res as unknown as { rows: unknown[] }).rows.length
}

export async function pendingJobs(db: DbOrTx, workspaceId: string): Promise<{ type: string, status: string, taskId: string | null }[]> {
  const res = await db.execute(sql`
    select type, status, payload->>'taskId' as "taskId" from jobs
    where workspace_id = ${workspaceId} and status in ('queued', 'running') and run_at <= now()
    order by id
  `)
  return (res as unknown as { rows: { type: string, status: string, taskId: string | null }[] }).rows
}
