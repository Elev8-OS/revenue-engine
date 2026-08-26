/**
 * One pass that asks MyDataValue what it has, and writes down only the shape.
 *
 * WHY THIS EXISTS RATHER THAN A MAPPER. The funnel signals are the last missing
 * piece — impressions, views, conversions per object — and I know what they MEAN
 * from measurements recorded in August: Booking trailing at 99'014 impressions
 * against 743 views, Airbnb forward per stay date with a `search_to_view_rate`
 * between 1.53% and 8.52%. What is NOT recorded anywhere is the endpoint paths
 * and the exact key names.
 *
 * Twice already this project has paid for the alternative. The Elev8 room filter
 * was calibrated against a field name from the MCP view and never fired against
 * the REST one. The PriceLabs neighbourhood panel was read with an assumed array
 * orientation and returned nothing over 43 listings. Both cost a deploy, a live
 * run, and a round trip to find out — and both were avoidable by looking first.
 *
 * So this stage looks first. It calls a list of candidate endpoints, records what
 * came back as a SHAPE, and maps nothing. Then `/shapes` names the real paths and
 * the real keys with their fill counts, and the mapper gets written against
 * measured facts instead of remembered prose.
 *
 * NOTHING IS WRITTEN BUT SHAPES. No snapshot rows, no entities, no aliases. A
 * discovery pass that changed the portfolio would be a migration in disguise.
 *
 * The candidate list is not invented: the resources come from the API's own
 * documented surface, and the URL form `/{channel}/{resource}/` is the one
 * `objects.ts` already uses successfully against `/booking/properties/` and
 * `/airbnb/listings/`. A path that does not exist answers 404, which is itself a
 * recorded fact and cheaper than a wrong mapper.
 */
import type { PoolClient } from 'pg'
import { MdvError, type MdvClient } from './client.js'
import { recordShape } from '../elev8/shape.js'

/**
 * `limit` is passed wherever the endpoint paginates, because a discovery pass
 * needs three rows to describe a shape and gains nothing from three hundred.
 * The two known-good paths are included as CONTROLS: if they fail too, the
 * problem is the grant and not the path list, and that difference is worth one
 * extra call.
 */
export const CANDIDATES: Array<{ path: string, params?: Record<string, string | number>,
                                 why: string, control?: boolean }> = [
  { path: '/booking/properties/', why: 'control: known to work, no parameters', control: true },
  { path: '/airbnb/listings/', params: { limit: 3 }, why: 'control: known to work', control: true },

  // The three funnel gates. Booking's is trailing, Airbnb's is forward per stay
  // date — which is why the two cannot share one mapper.
  { path: '/booking/ranking/', params: { limit: 3 }, why: 'impressions, views, conversions' },
  { path: '/airbnb/ranking/', params: { limit: 3, days_ahead: 14 },
    why: 'forward per stay date: impressions, search_to_view_rate' },

  { path: '/booking/demand/', params: { limit: 3 }, why: 'search volume and composition' },
  { path: '/booking/performance/', why: 'revenue, ADR, reservations, nights' },
  { path: '/airbnb/performance/', why: 'same, other channel' },
  { path: '/booking/promotions/', params: { limit: 3 }, why: 'the commercial levers' },
  { path: '/booking/reviews/', params: { limit: 3 }, why: 'score and count, which rank us' },
  { path: '/airbnb/reviews/', params: { limit: 3 }, why: 'same, other channel' },
  { path: '/booking/pricing/', params: { limit: 3 }, why: 'markup and rate plans' },
  { path: '/change-log/', params: { limit: 3 }, why: 'the drift detector' },
]

export interface Probe {
  path: string
  status: number | 'ok'
  /** Which key the rows arrived under, or the shape of the envelope. */
  envelope: string
  rows: number
  paths: number
  note: string
}

export interface DiscoverReport {
  kind: 'mdv-discover'
  probed: number
  answered: number
  /** Paths that do not exist. A fact, and cheaper than a wrong mapper. */
  missing: string[]
  /** The controls answered, so a failure elsewhere is about the path. */
  controlsOk: boolean
  probes: Probe[]
  stageErrors: string[]
}

/**
 * Finds the rows in a response without assuming the envelope.
 *
 * MDV uses at least three: a bare array, `{properties: []}` and
 * `{count, limit, offset, results: []}`. Reporting WHICH one arrived is the
 * point — the same discipline as `unwrap()` in the Elev8 client. An unknown
 * envelope returns the object itself, so its keys still get recorded.
 */
export function rowsOf(body: unknown): { rows: unknown[], envelope: string } {
  if (Array.isArray(body)) return { rows: body, envelope: 'bare array' }
  if (body && typeof body === 'object') {
    const o = body as Record<string, unknown>
    for (const key of ['results', 'properties', 'listings', 'data', 'items', 'rows']) {
      if (Array.isArray(o[key])) return { rows: o[key] as unknown[], envelope: key }
    }
    return { rows: [o], envelope: `object with keys: ${Object.keys(o).slice(0, 12).join(', ')}` }
  }
  return { rows: [], envelope: typeof body }
}

export async function discoverMdv(
  db: PoolClient, mdv: MdvClient,
): Promise<DiscoverReport> {
  const report: DiscoverReport = {
    kind: 'mdv-discover', probed: 0, answered: 0, missing: [], controlsOk: true,
    probes: [], stageErrors: [],
  }

  for (const c of CANDIDATES) {
    report.probed++
    try {
      const body = await mdv.get<unknown>(db, c.path, c.params)
      const { rows, envelope } = rowsOf(body)
      // Recorded under the endpoint itself, so /shapes lists one row per path and
      // the fill counts say which fields this account actually populates — the
      // failure mode that reading documentation cannot catch.
      const shape = await recordShape(db, 'mdv', `GET ${c.path}`, rows, c.why)
      report.answered++
      report.probes.push({
        path: c.path, status: 'ok', envelope, rows: rows.length,
        paths: shape.length, note: c.why,
      })
    } catch (err) {
      const message = (err as Error).message
      /**
       * The status comes off the ERROR, not out of its sentence. The first
       * version scraped it with a word-boundary regex and matched nothing,
       * because the message reads `http_404` and an underscore is a word
       * character — so every 404 was filed as a stage error instead of as a
       * missing path. Read the typed field; fall back to the text only for
       * something that is not an MdvError at all.
       */
      const status = err instanceof MdvError && err.status
        ? err.status
        : Number(/http_(\d{3})/.exec(message)?.[1] ?? 0)
      // A 404 is a RESULT, not a failure: it removes a candidate from the list
      // for the price of one request.
      if (status === 404) report.missing.push(c.path)
      else if (!report.stageErrors.length) report.stageErrors.push(`${c.path}: ${message}`)
      if (c.control) report.controlsOk = false
      report.probes.push({
        path: c.path, status, envelope: '—', rows: 0, paths: 0,
        note: `${c.why} · ${message.slice(0, 120)}`,
      })
    }
  }
  return report
}
