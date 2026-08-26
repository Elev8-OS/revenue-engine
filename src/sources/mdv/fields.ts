/**
 * Reading a payload whose field names we do not know, and saying which we found.
 *
 * Extracted from the funnel adapter because it stopped being about the funnel.
 * This is now the house pattern for every MyDataValue endpoint: hold, per
 * CONCEPT, a list of candidate names; take whichever one the payload actually
 * fills; and report the choice three ways — `used`, `missing`, and `unclaimed`.
 *
 * `unclaimed` is the one that earns its keep. It lists the keys that were present
 * and that no concept asked for, which turns a name we failed to anticipate from
 * a silent zero into a written-down fact and a one-line edit. On the first live
 * funnel pass it named `search_views` and `booking_conversions` — the two field
 * names that carried two thirds of the chain — and the fix needed no round trip
 * through a deploy to find.
 *
 * The alternative is reading names off a rendered page, which this project has
 * paid for twice: `search_to_view_rate` and `search_to_views_rate` are
 * indistinguishable at a glance.
 */
/* ---------------------------------------------------------------- resolution */

/** A concept, and every key name that might be carrying it. */
export type FieldSpec = Record<string, string[]>

export interface Resolution {
  /** concept → the key that actually carried it. */
  used: Record<string, string>
  /** Concepts no candidate matched. Named, so the gap is visible as a gap. */
  missing: string[]
  /**
   * Keys the rows carried that no concept claimed.
   *
   * The most valuable field in this file. Everything else reports what worked;
   * this reports what we failed to anticipate, which is the only thing that can
   * turn a wrong candidate list into a right one without another round trip.
   */
  unclaimed: string[]
}

/** Null, '', [] and {} are absent. Zero is a measurement and must survive. */
const present = (v: unknown): boolean =>
  v !== null && v !== undefined && v !== ''
  && !(Array.isArray(v) && v.length === 0)
  && !(typeof v === 'object' && !Array.isArray(v) && Object.keys(v as object).length === 0)

/**
 * Picks, per concept, the candidate the payload actually fills.
 *
 * Fill share decides, and candidate order breaks ties. That ordering matters:
 * a provider that keeps a legacy field alive but empty would otherwise win on
 * being listed first, and the concept would resolve to a column of nulls while
 * the real one sat unclaimed two lines below.
 */
export function resolveFields(rows: unknown[], spec: FieldSpec): Resolution {
  const objects = rows.filter((r): r is Record<string, unknown> =>
    Boolean(r) && typeof r === 'object' && !Array.isArray(r))
  const seen = new Set<string>()
  for (const o of objects) for (const k of Object.keys(o)) seen.add(k)

  const used: Record<string, string> = {}
  const missing: string[] = []
  const claimed = new Set<string>()

  for (const [concept, candidates] of Object.entries(spec)) {
    let bestKey = ''
    let bestFilled = 0
    for (const key of candidates) {
      if (!seen.has(key)) continue
      const filled = objects.filter(o => present(o[key])).length
      // Strictly greater, so the earlier candidate wins a tie. Candidate order is
      // the only signal we have about which name the provider prefers.
      if (filled > bestFilled) { bestKey = key; bestFilled = filled }
    }
    if (bestKey) { used[concept] = bestKey; claimed.add(bestKey) }
    else missing.push(concept)
  }
  // Every candidate of every concept is excluded from `unclaimed`, not just the
  // winners: a documented alternative that happened to be empty this pass is
  // already known about, and listing it as unanticipated would bury the one key
  // that genuinely is.
  const known = new Set(Object.values(spec).flat())
  const unclaimed = [...seen].filter(k => !claimed.has(k) && !known.has(k)).sort()
  return { used, missing, unclaimed }
}

/* -------------------------------------------------------------------- values */

/**
 * A count, or null. Negatives are refused because PriceLabs taught this project
 * that a provider will happily put a sentinel where a number belongs, and a
 * sentinel that reaches a chart becomes a conclusion.
 */
export function countOf(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  if (!Number.isFinite(n) || n < 0) return null
  return n
}

export type RateUnit = 'fraction' | 'percent' | 'undecidable'

/**
 * Establishes whether a column of rates is 0–1 or 0–100, from the values.
 *
 * A single value of `3.4` is 3.4% or 340% and nothing in the payload says which.
 * A COLUMN, though, usually decides itself: any value above 1 rules out
 * fractions, and a spread that stays under 1 while reaching above 0.01 would be
 * an absurd set of percentages. Everything else — a column of small numbers that
 * could honestly be either — is undecidable, and undecidable is an answer this
 * file is willing to give.
 */
export function rateUnit(values: number[]): RateUnit {
  const v = values.filter(n => Number.isFinite(n) && n >= 0)
  if (!v.length) return 'undecidable'
  const max = Math.max(...v)
  if (max > 1) return 'percent'
  // Below 1 and above 1%: as percentages these would all be under one percent of
  // one percent, which no funnel reports.
  if (max > 0.01) return 'fraction'
  return 'undecidable'
}

/** Normalises to a fraction once the unit is known, and refuses over 1. */
export const asFraction = (n: number, unit: RateUnit): number | null => {
  if (unit === 'undecidable') return null
  const f = unit === 'percent' ? n / 100 : n
  return f >= 0 && f <= 1 ? f : null
}

/** A ratio we computed ourselves, which has no unit to get wrong. */
export const ratio = (num: number | null, den: number | null): number | null =>
  num === null || den === null || den <= 0 ? null : Math.min(1, num / den)

