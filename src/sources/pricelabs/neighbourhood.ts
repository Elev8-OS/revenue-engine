/**
 * The micro layer: where our price sits inside its own neighbourhood.
 *
 * Everything the system held until now compared a listing to ONE market number
 * — its neighbourhood's average occupancy, its own MPI. That answers "are we
 * behind" and not "by how much, against what spread, on which night". A price
 * decision needs the distribution: a room at CHF 47 in a neighbourhood whose
 * 1-bedroom band runs 60 / 80 / 98 / 136 is not slightly low, it is below the
 * bottom quartile of 155 listings, and that is a different sentence.
 *
 * `GET /v1/neighborhood_data` is the source and it is the largest payload in the
 * account — around 207'000 characters per listing. It has its own rate bucket
 * for that reason, and the pass keeps exactly one specimen.
 *
 * WHAT IS DELIBERATELY NOT ASSUMED. The reference documents this response as
 * chart-shaped: `Summary Table Base Price` and `Future Percentile Prices`
 * carrying `X_values`, `Y_values` and `Labels`. The MCP view of the same data
 * returns a digested `summary_table` with `table_data` rows and
 * `25_percentile_price` keys instead. Those are two different shapes for the
 * same numbers, and this file has been shown only one of them.
 *
 * So it accepts BOTH and REPORTS which it found — the same discipline as
 * `unwrap()` in the Elev8 client, and for the same reason: a mapper that copes
 * silently with either hides a real difference, and one written against the
 * wrong guess produces confident numbers from the wrong array. Where neither
 * shape matches, it writes nothing and names the keys it saw.
 *
 * NO PERCENTILE IS INFERRED FROM ITS POSITION. A series is used only when its
 * label says which percentile it is. Reading `Y_values[1]` as "the median
 * because it is second" is exactly the kind of guess that survives review and
 * then prices a portfolio.
 */
import type { PoolClient } from 'pg'
import { writeSnapshots, recordFreshness, type SnapshotRow } from '../../snapshot/write.js'
import { recordShape } from '../elev8/shape.js'
import { PriceLabsClient, plain, keepSpecimen, PriceLabsBlockedError } from './client.js'
import type { ResolvedListing } from './listings.js'

/** The percentiles we can name. Anything else is reported, never positioned. */
export const PERCENTILES = [25, 50, 75, 90] as const

export interface NeighbourhoodReport {
  attempted: number
  ok: number
  failed: number
  blocked: string | null
  /** Which encoding the account actually returns. Reported, never assumed. */
  shapeSeen: PanelShape | null
  /**
   * The panel's own top-level keys with their JSON types and array lengths.
   *
   * A diagnostic, and it is here because the first live run reported
   * `shapeSeen: 'neither'` with four perfectly readable percentile labels — so
   * the labels were fine and the guard around them was not, and there was no way
   * to tell WHICH guard from outside the process. This puts the answer in the
   * report, which lands in the log, which is readable without a browser and
   * without a database.
   */
  panelKeys: Array<{ key: string, type: string, length?: number }>
  rowsWritten: number
  /** Listings for which our own bedroom category was present in the table. */
  ownCategory: number
  /** Categories offered that we could not match to a band. Named, not guessed. */
  unmatchedCategories: string[]
  /** Series labels we could not read as a percentile. */
  unreadableLabels: string[]
  firstError: string | null
}

/**
 * A category label to a bedroom count. PriceLabs writes them as "Studio",
 * "1 BR", "2 BR"; our bands are "1BR", "2BR", "5BR+".
 *
 * Studio maps to 0 and NOT to 1: a studio is its own category in this table —
 * on the measured account it carried 2 listings against 155 one-bedrooms and a
 * median of 149 against 80, so folding the two together would move the yardstick
 * by 86%.
 */
export function bedroomsOfCategory(label: string): number | null {
  const s = label.trim().toLowerCase()
  if (s === 'studio' || s === '0 br' || s === '0br') return 0
  const m = /^(\d+)\s*(?:\+)?\s*br/.exec(s)
  return m ? Number(m[1]) : null
}

/** Our band to the same scale. '5BR+' asks at its floor, as the estimator does. */
export function bedroomsOfBand(band: string | null | undefined): number | null {
  const m = /^(\d+)BR\+?$/.exec((band ?? '').trim())
  return m ? Number(m[1]) : null
}

/**
 * Reads a percentile out of a label. Accepts the key form
 * (`25_percentile_price`) and the human form (`25th percentile`, `P75`,
 * `Median`). Returns null rather than a guess.
 */
export function percentileOf(label: string): number | null {
  const s = label.trim().toLowerCase()
  if (s.includes('median')) return 50
  const m = /(?:^|[^\d])(\d{1,2})(?:st|nd|rd|th)?[\s_]*(?:percentile|pct|%)/.exec(s)
    ?? /^p(\d{1,2})$/.exec(s)
  const n = m ? Number(m[1]) : NaN
  return (PERCENTILES as readonly number[]).includes(n) ? n : null
}

interface CategoryBand {
  bedrooms: number | null
  label: string
  count: number | null
  /** percentile → price */
  prices: Map<number, number>
}

/**
 * The digested form: an array of rows, one per bedroom category, with the
 * percentile in the KEY name.
 */
function readTableRows(node: unknown): CategoryBand[] | null {
  const rows = (node as { table_data?: unknown })?.table_data
    ?? (Array.isArray(node) ? node : null)
  if (!Array.isArray(rows) || !rows.length) return null
  const out: CategoryBand[] = []
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    const label = typeof r.category === 'string' ? r.category : ''
    if (!label) continue
    const prices = new Map<number, number>()
    for (const [k, v] of Object.entries(r)) {
      const p = percentileOf(k)
      const value = plain(v)
      if (p !== null && value !== null) prices.set(p, value)
    }
    if (!prices.size) continue
    out.push({ bedrooms: bedroomsOfCategory(label), label, count: plain(r.count), prices })
  }
  return out.length ? out : null
}

/**
 * Every encoding of the chart form this account could plausibly send, each one
 * identified rather than merged.
 *
 * The first live pass reported `Labels` holding four clean percentile names —
 * "25th Percentile Price( CHF)" and friends — and still produced nothing,
 * because `Y_values` did not line up with `Labels` the way the first version
 * assumed. That assumption was the bug: parallel arrays have an ORIENTATION, and
 * with categories on one axis and percentiles on the other there are two ways to
 * nest them and no way to tell from the length alone.
 *
 * So orientation is DERIVED, not assumed:
 *
 *   keyed       Y_values is an object; its keys are the labels. Unambiguous —
 *               the label travels with its own data.
 *   label_major rows.length == Labels.length and row length == X_values.length
 *   x_major     rows.length == X_values.length and row length == Labels.length
 *   ambiguous   BOTH fit, i.e. the grid is square. Refused: a coin toss between
 *               two readings of a price table is the worst possible outcome
 *               here, and one of them silently transposes the percentiles.
 */
type PanelShape = 'table_rows' | 'chart_keyed' | 'chart_label_major' | 'chart_x_major'
  | 'ambiguous' | 'neither'

interface ChartRead {
  shape: PanelShape
  bands: CategoryBand[]
  unreadable: string[]
}

const emptyBand = (label: string): CategoryBand =>
  ({ bedrooms: bedroomsOfCategory(label), label, count: null, prices: new Map() })

function readChartSeries(node: unknown): ChartRead {
  const o = node as Record<string, unknown> | null
  if (!o || typeof o !== 'object') return { shape: 'neither', bands: [], unreadable: [] }
  const labels = o.Labels
  if (!Array.isArray(labels)) return { shape: 'neither', bands: [], unreadable: [] }

  const unreadable = labels.map(String).filter(l => percentileOf(l) === null)
  const bands = new Map<string, CategoryBand>()
  const put = (category: string, p: number, raw: unknown) => {
    const value = plain(raw)
    if (!category || value === null) return
    let band = bands.get(category)
    if (!band) { band = emptyBand(category); bands.set(category, band) }
    band.prices.set(p, value)
  }

  const xs = Array.isArray(o.X_values) ? o.X_values : null
  const ysRaw = o.Y_values

  // Keyed by label: no orientation to get wrong.
  if (ysRaw && typeof ysRaw === 'object' && !Array.isArray(ysRaw)) {
    for (const [rawLabel, series] of Object.entries(ysRaw as Record<string, unknown>)) {
      const p = percentileOf(rawLabel)
      if (p === null) { unreadable.push(rawLabel); continue }
      if (Array.isArray(series) && xs) {
        series.forEach((v, i) => put(String(xs[i] ?? ''), p, v))
      } else if (plain(series) !== null) {
        // A single number per label: the panel describes one category only.
        put(String(xs?.[0] ?? 'all'), p, series)
      }
    }
    return { shape: 'chart_keyed', bands: [...bands.values()], unreadable }
  }

  if (!xs || !Array.isArray(ysRaw)) return { shape: 'neither', bands: [], unreadable }
  const rows = (Array.isArray(ysRaw[0]) ? ysRaw : [ysRaw]) as unknown[][]
  const width = rows[0]?.length ?? 0
  const labelMajor = rows.length === labels.length && width === xs.length
  const xMajor = rows.length === xs.length && width === labels.length

  if (labelMajor && xMajor) return { shape: 'ambiguous', bands: [], unreadable }

  if (labelMajor) {
    labels.forEach((rawLabel, li) => {
      const p = percentileOf(String(rawLabel))
      if (p === null) return
      rows[li]!.forEach((v, xi) => put(String(xs[xi] ?? ''), p, v))
    })
    return { shape: 'chart_label_major', bands: [...bands.values()], unreadable }
  }
  if (xMajor) {
    xs.forEach((rawX, xi) => {
      labels.forEach((rawLabel, li) => {
        const p = percentileOf(String(rawLabel))
        if (p === null) return
        put(String(rawX ?? ''), p, rows[xi]![li])
      })
    })
    return { shape: 'chart_x_major', bands: [...bands.values()], unreadable }
  }
  return { shape: 'neither', bands: [], unreadable }
}

export interface PanelRead {
  shape: PanelShape
  bands: CategoryBand[]
  unreadableLabels: string[]
}

export function readPanel(node: unknown): PanelRead {
  const rows = readTableRows(node)
  if (rows) return { shape: 'table_rows', bands: rows, unreadableLabels: [] }
  const chart = readChartSeries(node)
  if (chart.bands.length) {
    return { shape: chart.shape, bands: chart.bands, unreadableLabels: chart.unreadable }
  }
  const labels = (node as { Labels?: unknown })?.Labels
  return {
    shape: chart.shape, bands: [],
    unreadableLabels: chart.unreadable.length ? chart.unreadable
      : Array.isArray(labels) ? labels.map(String) : [],
  }
}

/**
 * The panel's own keys, types and lengths — never its values.
 *
 * The same rule as `api_shape`: a shape is safe to keep and safe to put in a
 * log, a sample of live data is neither.
 */
export function describePanel(node: unknown): NeighbourhoodReport['panelKeys'] {
  if (!node || typeof node !== 'object') return [{ key: '(root)', type: typeof node }]
  return Object.entries(node as Record<string, unknown>).map(([key, v]) => ({
    key,
    type: Array.isArray(v) ? (v.length && Array.isArray(v[0]) ? 'array[array]'
      : v.length && v[0] !== null && typeof v[0] === 'object' ? 'array[object]' : 'array')
      : v === null ? 'null' : typeof v,
    ...(Array.isArray(v) ? { length: v.length } : {}),
  }))
}

/** The panel key the reference names, with the digested alias beside it. */
const PANEL_KEYS = ['Summary Table Base Price', 'summary_table', 'Summary Table']

export async function importPriceLabsNeighbourhood(
  db: PoolClient, api: PriceLabsClient, listings: ResolvedListing[], asOf: string,
): Promise<NeighbourhoodReport> {
  const report: NeighbourhoodReport = {
    attempted: 0, ok: 0, failed: 0, blocked: null, shapeSeen: null, panelKeys: [],
    rowsWritten: 0, ownCategory: 0, unmatchedCategories: [], unreadableLabels: [],
    firstError: null,
  }
  const unmatched = new Set<string>()
  const unreadable = new Set<string>()
  const samples: unknown[] = []
  let specimenKept = false

  for (const listing of listings) {
    report.attempted++
    try {
      const body = await api.get<{ data?: Record<string, unknown> }>(
        '/v1/neighborhood_data',
        { listing_id: listing.listingId, pms: listing.pms },
        // Its own bucket: this is the 207'000-character response, and sharing a
        // budget with the small calls would let one pass starve the others.
        'pricelabs_market')
      const data = body?.data
      if (!data) { report.failed++; continue }

      if (!specimenKept) {
        await keepSpecimen(db, 'GET /v1/neighborhood_data', listing.listingId, body)
        specimenKept = true
      }
      // Only the panel, not the whole payload: a shape derived from 12 MB of
      // competitor rows would be a thousand paths nobody reads.
      const panelNode = PANEL_KEYS.map(k => data[k]).find(v => v !== undefined)
      samples.push(panelNode ?? {})

      const read = readPanel(panelNode)
      if (report.shapeSeen === null) {
        report.shapeSeen = read.shape
        // Only from the first listing: the encoding is a property of the API, not
        // of the room, and 43 copies of the same key list is not a diagnostic.
        report.panelKeys = describePanel(panelNode)
      }
      for (const l of read.unreadableLabels) unreadable.add(l)
      if (!read.bands.length) { report.failed++; continue }
      report.ok++

      const wanted = bedroomsOfBand(listing.band)
      const own = wanted === null ? null : read.bands.find(b => b.bedrooms === wanted)
      for (const b of read.bands) {
        if (b.bedrooms === null) unmatched.add(b.label)
      }
      if (!own) continue
      report.ownCategory++

      // The neighbourhood total, and how many listings the band rests on. A
      // percentile over two listings and one over 155 are different claims, so
      // the count travels with the prices rather than being left behind.
      const rows: SnapshotRow[] = []
      const put = (metric: string, value: number | null, money = true) => {
        if (value === null) return
        rows.push({
          entityId: listing.entityId, metric, stayDate: asOf, value, source: 'pricelabs',
          ...(money && listing.currency ? { currency: listing.currency } : {}),
        })
      }
      for (const p of PERCENTILES) put(`nbhd_price_p${p}`, own.prices.get(p) ?? null)
      put('nbhd_listings', own.count, false)
      put('nbhd_listings_total', plain((data as Record<string, unknown>)['Listings Used']
        ?? (panelNode as { n_listings?: unknown } | undefined)?.n_listings), false)

      report.rowsWritten += await writeSnapshots(db, asOf, rows)
      await recordFreshness(db, 'pricelabs', 'neighbourhood', listing.entityId, null, 'ok', null)
    } catch (err) {
      if (err instanceof PriceLabsBlockedError) {
        report.blocked = `${err.blocked}: ${err.message}`
        break
      }
      report.failed++
      if (!report.firstError) report.firstError = (err as Error).message
    }
  }

  if (samples.length) {
    await recordShape(db, 'pricelabs', 'GET /v1/neighborhood_data', samples,
      `panel only, ${samples.length} listing(s); shape: ${report.shapeSeen}`)
  }
  report.unmatchedCategories = [...unmatched].sort()
  report.unreadableLabels = [...unreadable].sort()
  return report
}
