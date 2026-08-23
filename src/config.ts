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
   * MDV over its own HTTP API, not through an MCP wrapper. The API has 67
   * operations against the wrapper's handful, returns real HTTP status codes
   * (we need to tell writes_disabled from not_connected), pages properly, and
   * is the only way to verify a webhook signature over the raw body.
   *
   * The refresh token deliberately does NOT live here. It rotates on every
   * refresh, so an environment variable holding one goes stale the first time
   * the service runs — and the next deploy would present a spent token, which
   * revokes the entire grant. The variable below is a one-time SEED; after the
   * first refresh the oauth_token row is the only truth.
   */
  MDV_API_BASE: z.string().url().default('https://app.mydatavalue.com/api/v1'),
  MDV_CLIENT_ID: z.string().optional(),
  MDV_BOOTSTRAP_REFRESH_TOKEN: z.string().optional(),

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
    // Ready means a client is configured. Whether a live grant exists is a
    // database question, not an environment one — see oauth_token.
    mdv: Boolean(c.MDV_CLIENT_ID),
  }
}

export const allowedEmails = (c: Config): string[] =>
  c.ALLOWED_EMAILS.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
