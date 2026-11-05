import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core'
import * as schema from '../db/schema'
import { config } from './config'

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]
export type DbOrTx = Db | Tx

interface DbHandle {
  db: Db
  close: () => Promise<void>
}

const g = globalThis as unknown as { __maDb?: Promise<DbHandle> }

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  }
  catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

// PGlite verträgt nur einen Prozess je Datenordner, sonst geht die Datenbank kaputt.
function lockDataDir(dataDir: string): () => void {
  const file = join(dataDir, 'aimarage.lock')
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(file, String(process.pid), { flag: 'wx' })
      return () => {
        try {
          if (readFileSync(file, 'utf8').trim() === String(process.pid)) rmSync(file)
        }
        catch {}
      }
    }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      let pid = 0
      try {
        pid = Number.parseInt(readFileSync(file, 'utf8'), 10)
      }
      catch {}
      if (pid === process.pid) return () => {}
      if (pid > 0 && isAlive(pid)) {
        throw new Error(`PGlite-Datenordner ${dataDir} wird schon von Prozess ${pid} benutzt. Erst diesen Prozess beenden oder DATABASE_URL auf Postgres setzen.`)
      }
      rmSync(file, { force: true })
    }
  }
  throw new Error(`PGlite-Sperre ${file} konnte nicht angelegt werden.`)
}

async function openPglite(dataDir: string | null): Promise<DbHandle> {
  const { PGlite } = await import('@electric-sql/pglite')
  const { drizzle } = await import('drizzle-orm/pglite')
  const { migrate } = await import('drizzle-orm/pglite/migrator')
  let unlock = () => {}
  if (dataDir) {
    mkdirSync(dataDir, { recursive: true })
    unlock = lockDataDir(dataDir)
    process.once('exit', unlock)
  }
  try {
    const client = dataDir ? new PGlite(dataDir) : new PGlite()
    await client.waitReady
    const db = drizzle(client, { schema })
    await migrate(db, { migrationsFolder: config.migrationsDir })
    return {
      db: db as unknown as Db,
      close: async () => {
        await client.close()
        unlock()
      },
    }
  }
  catch (err) {
    unlock()
    throw err
  }
}

async function openPostgres(url: string): Promise<DbHandle> {
  const pg = (await import('pg')).default
  const { drizzle } = await import('drizzle-orm/node-postgres')
  const { migrate } = await import('drizzle-orm/node-postgres/migrator')
  const pool = new pg.Pool({ connectionString: url, max: 10 })
  const db = drizzle(pool, { schema })
  await migrate(db, { migrationsFolder: config.migrationsDir })
  return { db: db as unknown as Db, close: () => pool.end() }
}

export function getDb(): Promise<Db> {
  g.__maDb ??= (config.usePglite ? openPglite(config.dataDir) : openPostgres(config.databaseUrl)).catch((err) => {
    g.__maDb = undefined
    throw err
  })
  return g.__maDb.then(h => h.db)
}

export async function openTestDb(): Promise<{ db: Db, close: () => Promise<void> }> {
  return openPglite(null)
}

export async function closeDb(): Promise<void> {
  const h = await g.__maDb
  g.__maDb = undefined
  await h?.close()
}

export function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string, cause?: { code?: string } }
  return e?.code === '23505' || e?.cause?.code === '23505'
}

export { schema }
