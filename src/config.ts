/**
 * Configuration. Reads names only — every value comes from the environment,
 * which on Railway means the project variables. Nothing here ever logs a value.
 */
import { z } from 'zod'

const schema = z.object({
  DATABASE_URL: z.string().min(1),

  /**
   * Elev8 has two doors and either opens it.
   *
   *   ELEV8_API_TOKEN   an X-Api-Key. Confirmed for the Partner zone (7
   *                     endpoints) and the Report zone (2). Whether the
   *                     MCP/Claude key also opens the Internal zone (866,
   *                     including rooms and the channel mappings) is an open
   *                     question with Elev8 — if it does, this is all we need.
   *   the login pair    POST /api/v1/auth/login. That is a service account: it
   *                     expires, it can be locked out, and it is a password.
   *                     The fallback, not the preference.
   *
   * The token is preferred where both are set, because a header that cannot
   * expire is strictly better operationally than one that can.
   */
  ELEV8_API_BASE: z.string().url().optional(),
  ELEV8_API_TOKEN: z.string().optional(),
  ELEV8_LOGIN_EMAIL: z.string().optional(),
  ELEV8_LOGIN_PASSWORD: z.string().optional(),

  /**
   * PriceLabs comes with TWO keys, and the specification says so in as many
   * words: "Your Revenue Estimator API key. This is different from the Customer
   * API key."
   *
   *   PRICELABS_API_KEY            the Customer API. Our own listings: the price
   *                                calendar, the performance grid against the
   *                                listing's own market, and realised
   *                                reservations with the OTA commission on them.
   *   PRICELABS_ESTIMATOR_API_KEY  the Revenue Estimator. Addressed by
   *                                coordinate and bedroom count rather than by
   *                                listing, which makes it the only source that
   *                                answers a COHORT question — and therefore the
   *                                only one a "below the market" claim can rest
   *                                on. Optional: without it that stage is
   *                                reported as not run, never as failed.
   *
   * The currency is a variable because the Estimator requires one and the answer
   * is an account decision, not a fact about a listing. Measured on this
   * account: PriceLabs reports CHF even for the Bali villas, which is why the
   * default matches rather than deriving a currency per market.
   */
  PRICELABS_API_KEY: z.string().optional(),
  PRICELABS_API_BASE: z.string().url().optional(),
  PRICELABS_ESTIMATOR_API_KEY: z.string().optional(),
  PRICELABS_ESTIMATOR_CURRENCY: z.string().default('CHF'),
  /**
   * Kept declared, deliberately unused. Elev8 proxies Channex in full — the
   * same occupancy fields, the same channel mappings — so a direct connection
   * would buy a second credential and a second rate limit for data we already
   * have. Declared rather than deleted because the day Elev8's proxy stops
   * being enough, the name should not have to be rediscovered.
   */
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
   *
   * Names match the mydatavalue-mcp service on purpose. That service already
   * holds a grant for this provider and persists its rotated token to a file on
   * a Railway volume (TOKEN_STORE_PATH). Two consequences:
   *
   *   1. NEVER seed this service from that service's refresh token. It has
   *      already been rotated, so presenting it revokes the shared grant and
   *      takes both services down. Each service needs its own authorisation.
   *   2. Client id and secret CAN be shared: one registered client may hold
   *      many independent grants. It is the refresh-token chain that must not
   *      be shared, not the client.
   */
  MDV_BASE_URL: z.string().url().default('https://app.mydatavalue.com/api/v1'),
  MDV_CLIENT_ID: z.string().optional(),
  MDV_CLIENT_SECRET: z.string().optional(),
  MDV_SEED_REFRESH_TOKEN: z.string().optional(),

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
    elev8: Boolean(c.ELEV8_API_BASE
      && (c.ELEV8_API_TOKEN || (c.ELEV8_LOGIN_EMAIL && c.ELEV8_LOGIN_PASSWORD))),
    pricelabs: Boolean(c.PRICELABS_API_KEY),
    // Separate from `pricelabs` on purpose: the Customer API can be fully live
    // while the cohort benchmark is missing, and one green row for both would
    // say the market side was covered when nothing had asked for it.
    pricelabsMarket: Boolean(c.PRICELABS_ESTIMATOR_API_KEY),
    channex: Boolean(c.CHANNEX_API_KEY),
    // Ready means a client is configured. Whether a live grant exists is a
    // database question, not an environment one — see oauth_token.
    mdv: Boolean(c.MDV_CLIENT_ID && c.MDV_CLIENT_SECRET),
  }
}

export const allowedEmails = (c: Config): string[] =>
  c.ALLOWED_EMAILS.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
