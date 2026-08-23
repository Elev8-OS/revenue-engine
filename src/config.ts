/**
 * Configuration. Reads names only — every value comes from the environment,
 * which on Railway means the project variables. Nothing here ever logs a value.
 */
import { z } from 'zod'

const schema = z.object({
  DATABASE_URL: z.string().min(1),

  ELEV8_API_BASE: z.string().url().optional(),
  ELEV8_API_TOKEN: z.string().optional(),

  PRICELABS_API_KEY: z.string().optional(),
  CHANNEX_API_KEY: z.string().optional(),

  /**
   * Exactly one process may refresh MDV tokens. Their refresh tokens rotate and
   * reusing a spent one revokes the WHOLE grant, not just the session — so this
   * is a mode, not a fallback chain.
   *   'mcp' → delegate to the already-deployed mydatavalue-mcp service
   *   'own' → this worker owns the refresh, and must hold the advisory lock
   */
  MDV_MODE: z.enum(['mcp', 'own']).default('mcp'),
  MDV_MCP_URL: z.string().url().optional(),
  MDV_CLIENT_ID: z.string().optional(),
  MDV_REFRESH_TOKEN: z.string().optional(),

  CHANNEX_WEBHOOK_SECRET: z.string().optional(),
  ALLOWED_EMAILS: z.string().default(''),
})

export type Config = z.infer<typeof schema>

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env)
  if (!parsed.success) {
    // Report the missing NAMES. Never the values, never the partial values.
    const missing = parsed.error.issues.map(i => i.path.join('.')).join(', ')
    throw new Error(`configuration incomplete: ${missing}`)
  }
  return parsed.data
}

/** Which sources are usable right now. Lets the worker run partially. */
export function availableSources(c: Config) {
  return {
    elev8: Boolean(c.ELEV8_API_BASE && c.ELEV8_API_TOKEN),
    pricelabs: Boolean(c.PRICELABS_API_KEY),
    channex: Boolean(c.CHANNEX_API_KEY),
    mdv: c.MDV_MODE === 'mcp' ? Boolean(c.MDV_MCP_URL) : Boolean(c.MDV_REFRESH_TOKEN),
  }
}

export const allowedEmails = (c: Config): string[] =>
  c.ALLOWED_EMAILS.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
