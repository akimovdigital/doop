import { sql } from 'drizzle-orm'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import type { Db } from './index.ts'

const forkStart = 1795436215501
const commonEnd = 1795256823668
const forkEnd = 1795466969819

/**
 * The Dev and upstream journals diverged after 0061. Drizzle uses the newest
 * timestamp as a high-water mark, so a Dev database would skip the four
 * upstream entries that predate its Browser and background migrations.
 * Reconcile just that window, using the original hashes and timestamps.
 */
export async function reconcileForkMigrations(db: Db, migrationsFolder: string): Promise<void> {
  await db.transaction(async (tx) => {
    const ledger = sql.raw('drizzle.__drizzle_migrations')
    const exists = await tx.execute<{ ledger: string | null }>(
      sql`select to_regclass('drizzle.__drizzle_migrations') as ledger`,
    )
    if (!exists.rows[0]?.ledger) return
    await tx.execute(sql`lock table ${ledger} in share row exclusive mode`)
    const { rows } = await tx.execute<{ hash: string; created_at: string }>(
      sql`select hash, created_at from ${ledger} where created_at > ${commonEnd}`,
    )
    if (!rows.some((row) => Number(row.created_at) === forkStart || Number(row.created_at) === forkEnd)) return
    const migrations = readMigrationFiles({ migrationsFolder })
    const fork = new Map(
      migrations
        .filter((migration) => migration.folderMillis === forkStart || migration.folderMillis === forkEnd)
        .map((migration) => [migration.folderMillis, migration.hash]),
    )
    for (const row of rows) {
      const expected = fork.get(Number(row.created_at))
      if (expected !== undefined && expected !== row.hash)
        throw new Error('Dev migration ledger has an unexpected hash')
    }
    const applied = new Set(rows.map((row) => row.hash))
    for (const migration of migrations) {
      if (migration.folderMillis <= commonEnd || migration.folderMillis >= forkStart || applied.has(migration.hash))
        continue
      // An unexpected entry at the same timestamp is ambiguous. Roll back
      // instead of trying SQL on a schema from an unknown migration history.
      if (rows.some((row) => Number(row.created_at) === migration.folderMillis))
        throw new Error('Upstream migration ledger has an unexpected hash')
      for (const statement of migration.sql) await tx.execute(sql.raw(statement))
      await tx.execute(
        sql`insert into ${ledger} (hash, created_at) values (${migration.hash}, ${migration.folderMillis})`,
      )
    }
  })
}
