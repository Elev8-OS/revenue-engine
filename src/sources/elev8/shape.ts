/**
 * What the API actually returns, described as a shape.
 *
 * Why this exists: the Elev8 Postman collection documents 1'062 endpoints and
 * carries ZERO response examples. Every field path in a mapper written against
 * it would be a guess, and this project has already been bitten three times by
 * the specific failure that guessing cannot catch — a field that EXISTS and is
 * EMPTY. Airbnb `bedrooms` was null on all 50 listings; Elev8 `maximum_capacity`
 * is filled on 55 of 72; `size` on 27 of 72. In every case the schema was right
 * and the data was absent.
 *
 * So the fill count is not a nicety here, it is the point. `rooms[].name: 3/55`
 * and `rooms[].name: 55/55` demand completely different code, and no amount of
 * reading documentation distinguishes them.
 *
 * VALUES ARE NEVER RECORDED. Only paths, the set of JSON types seen at each, and
 * how often a non-empty value appeared. A shape is safe to store and safe to put
 * on a page; a sample of live guest data is neither. That is a deliberate limit,
 * not an oversight: knowing that `guest_email` is filled 812/812 is the useful
 * part, and knowing any one of them is not.
 */
import type { PoolClient } from 'pg'

export interface ShapeEntry {
  path: string
  types: string[]
  /** Non-empty occurrences. Null, '', [] and {} all count as absent. */
  filled: number
  total: number
}

const MAX_DEPTH = 4
/** A guard against a pathological payload, not a considered ceiling. */
const MAX_PATHS = 400

const typeOf = (v: unknown): string =>
  v === null ? 'null'
  : Array.isArray(v) ? 'array'
  : typeof v === 'object' ? 'object'
  : typeof v

const isEmpty = (v: unknown): boolean =>
  v === null || v === undefined || v === ''
  || (Array.isArray(v) && v.length === 0)
  || (typeof v === 'object' && !Array.isArray(v) && Object.keys(v as object).length === 0)

/**
 * Derives the shape of a set of sibling objects.
 *
 * `total` is the number of PARENTS a path could have appeared under, not the
 * number of samples, so a path inside an array reports against the elements that
 * actually exist. Reporting `rooms[].name: 4/55` for four rooms across 55
 * listings would read as "51 rooms are missing a name" when there were only four
 * rooms at all — the opposite of the truth.
 */
export function describe(samples: unknown[]): ShapeEntry[] {
  const acc = new Map<string, { types: Set<string>, filled: number, total: number }>()

  const touch = (path: string, value: unknown) => {
    if (acc.size >= MAX_PATHS && !acc.has(path)) return false
    let e = acc.get(path)
    if (!e) { e = { types: new Set(), filled: 0, total: 0 }; acc.set(path, e) }
    e.types.add(typeOf(value))
    e.total++
    if (!isEmpty(value)) e.filled++
    return true
  }

  const walk = (node: unknown, prefix: string, depth: number): void => {
    if (depth > MAX_DEPTH) return
    if (Array.isArray(node)) {
      for (const el of node) walk(el, `${prefix}[]`, depth)
      return
    }
    if (node === null || typeof node !== 'object') return
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      const path = prefix ? `${prefix}.${k}` : k
      if (!touch(path, v)) continue
      if (v && typeof v === 'object') walk(v, path, depth + 1)
    }
  }

  for (const s of samples) walk(s, '', 0)

  return [...acc.entries()]
    .map(([path, e]) => ({ path, types: [...e.types].sort(), filled: e.filled, total: e.total }))
    .sort((a, b) => a.path.localeCompare(b.path))
}

export async function recordShape(
  client: PoolClient, source: string, endpoint: string,
  samples: unknown[], note?: string,
): Promise<ShapeEntry[]> {
  const shape = describe(samples)
  await client.query(
    `insert into api_shape (source, endpoint, sample_count, shape, note)
     values ($1, $2, $3, $4::jsonb, $5)`,
    [source, endpoint, samples.length, JSON.stringify(shape), note ?? null],
  )
  return shape
}

export async function latestShape(
  client: PoolClient, source: string, endpoint: string,
): Promise<{ observedAt: Date, sampleCount: number, shape: ShapeEntry[], note?: string } | null> {
  const { rows } = await client.query<{
    observed_at: Date, sample_count: number, shape: ShapeEntry[], note: string | null
  }>(`select observed_at, sample_count, shape, note from api_shape
       where source = $1 and endpoint = $2
       order by observed_at desc limit 1`, [source, endpoint])
  const r = rows[0]
  return r ? {
    observedAt: r.observed_at, sampleCount: r.sample_count,
    shape: r.shape, note: r.note ?? undefined,
  } : null
}

/**
 * Every endpoint whose shape has been observed, most recent first — one row per
 * endpoint, so a page can list what is known without reading every revision.
 */
export async function knownShapes(
  client: PoolClient, source?: string,
): Promise<{ source: string, endpoint: string, observedAt: Date, sampleCount: number, paths: number }[]> {
  const { rows } = await client.query<{
    source: string, endpoint: string, observed_at: Date, sample_count: number, paths: number
  }>(`select distinct on (source, endpoint)
             source, endpoint, observed_at, sample_count,
             jsonb_array_length(shape) as paths
        from api_shape
       where ($1::text is null or source = $1)
       order by source, endpoint, observed_at desc`, [source ?? null])
  return rows.map(r => ({
    source: r.source, endpoint: r.endpoint, observedAt: r.observed_at,
    sampleCount: r.sample_count, paths: Number(r.paths),
  }))
}

/**
 * Finds which of several candidate names is actually present and filled.
 *
 * This is the same discipline as `entity_alias.matched_by`: when a field could
 * plausibly be called four things, pick one by evidence and RECORD which, so
 * that six months later the choice is inspectable rather than folklore. A
 * mapper that silently tries four names in order cannot be audited, and cannot
 * tell "the field is named differently" from "the field is empty" — which need
 * opposite responses.
 */
export function pickField(
  shape: ShapeEntry[], candidates: string[],
): { path: string, filled: number, total: number } | null {
  const byPath = new Map(shape.map(e => [e.path, e]))
  const present = candidates
    .map(c => byPath.get(c))
    .filter((e): e is ShapeEntry => Boolean(e) && e!.filled > 0)
  if (!present.length) return null
  // Best filled wins, so a legacy field kept for compatibility and left empty
  // never beats the one actually in use.
  present.sort((a, b) => b.filled / b.total - a.filled / a.total)
  const best = present[0]!
  return { path: best.path, filled: best.filled, total: best.total }
}
