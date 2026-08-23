/** Applies migrations/*.sql in order, once each, inside a transaction. */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { loadConfig } from './config.js'
import { getPool } from './db.js'

const DIR = new URL('../migrations/', import.meta.url).pathname

async function main() {
  const cfg = loadConfig()
  const pool = getPool(cfg.DATABASE_URL)
  const client = await pool.connect()
  try {
    await client.query(`
      create table if not exists schema_migration (
        name text primary key,
        applied_at timestamptz not null default now()
      )`)
    const files = (await readdir(DIR)).filter(f => f.endsWith('.sql')).sort()
    for (const file of files) {
      const { rowCount } = await client.query(
        'select 1 from schema_migration where name = $1', [file],
      )
      if (rowCount) { console.log(`skip ${file}`); continue }
      const sql = await readFile(join(DIR, file), 'utf8')
      await client.query('begin')
      try {
        await client.query(sql)
        await client.query('insert into schema_migration (name) values ($1)', [file])
        await client.query('commit')
        console.log(`applied ${file}`)
      } catch (err) {
        await client.query('rollback')
        throw new Error(`migration ${file} failed: ${(err as Error).message}`)
      }
    }
  } finally {
    client.release()
    await pool.end()
  }
}

main().catch(err => { console.error(err.message); process.exit(1) })
