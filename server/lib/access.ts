import { and, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import { roleAtLeast, type Role } from '../../shared/utils/domain'
import type { DbOrTx } from './db'
import { schema } from './db'

export interface Access {
  all: boolean
  ids: string[]
}

export interface Viewer {
  workspaceId: string
  userId: string
  role: Role
}

const cache = new WeakMap<object, Promise<Access>>()

export function projectAccess(db: DbOrTx, v: Viewer, key?: object): Promise<Access> {
  const hit = key && cache.get(key)
  if (hit) return hit
  const p = (async (): Promise<Access> => {
    if (roleAtLeast(v.role, 'admin')) return { all: true, ids: [] }
    const rows = await db.select({ id: schema.projectMembers.projectId }).from(schema.projectMembers)
      .innerJoin(schema.projects, eq(schema.projects.id, schema.projectMembers.projectId))
      .where(and(eq(schema.projectMembers.userId, v.userId), eq(schema.projects.workspaceId, v.workspaceId)))
    return { all: false, ids: rows.map(r => r.id) }
  })()
  if (key) cache.set(key, p)
  return p
}

export function canSeeProject(a: Access, projectId: string | null | undefined): boolean {
  return !projectId || a.all || a.ids.includes(projectId)
}

export function projectCond(a: Access, col: AnyPgColumn, includeShared = true): SQL | undefined {
  if (a.all) return undefined
  const inIds = a.ids.length ? inArray(col, a.ids) : sql`false`
  return includeShared ? or(isNull(col), inIds) : inIds
}
