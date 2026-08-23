/** CLI over the demo seed. `--clear` removes it. */
import { Pool } from 'pg'
import { seedDemo, clearDemo } from './demo.js'

const pool = new Pool({ connectionString: process.env.DATABASE_URL! })
const c = await pool.connect()
try {
  if (process.argv.includes('--clear')) console.log(`removed ${await clearDemo(c)} demo entities`)
  else console.log(`seeded ${await seedDemo(c)} demo entities`)
} finally { c.release(); await pool.end() }
