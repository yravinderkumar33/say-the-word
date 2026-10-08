import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync, type StatementSync } from 'node:sqlite'

/** Opened only by the storage process (or an isolated unit test). */
export function openDatabase(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(path, { timeout: 250 })
  try {
    db.exec(
      'PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA temp_store=MEMORY; PRAGMA secure_delete=ON; PRAGMA trusted_schema=OFF; PRAGMA cache_size=-4096',
    )
    if (path !== ':memory:') chmodSync(path, 0o600)
    const check = db.prepare('PRAGMA quick_check').get()
    if (!check || Object.values(check)[0] !== 'ok')
      throw new Error('Database integrity check failed')
    return db
  } catch (error) {
    db.close()
    throw error
  }
}

export function transaction<T>(db: DatabaseSync, change: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = change()
    db.exec('COMMIT')
    return result
  } catch (error) {
    // After some failures (a full disk, an I/O error) SQLite has rolled back already, and
    // a second rollback would put its own complaint in place of the reason.
    if (db.isTransaction) db.exec('ROLLBACK')
    throw error
  }
}

const statements = new WeakMap<DatabaseSync, Map<string, StatementSync>>()
/** Statements are prepared once per connection; the cache dies with that connection. */
export function statement(db: DatabaseSync, sql: string): StatementSync {
  let cache = statements.get(db)
  if (!cache) {
    cache = new Map()
    statements.set(db, cache)
  }
  let prepared = cache.get(sql)
  if (!prepared) {
    prepared = db.prepare(sql)
    cache.set(sql, prepared)
  }
  return prepared
}
