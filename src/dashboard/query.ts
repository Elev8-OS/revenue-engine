/**
 * Dashboard reads.
 *
 * Two rules from the design carried into SQL:
 *
 *  1. A room's "at stake" is its LARGEST single finding, never a sum. Two
 *     findings can cover the same nights, so a total would double-count — and a
 *     number nobody can reconstruct destroys the ranking it was meant to
 *     support. Hence max(), not sum().
 *  2. The worst domain is DERIVED from the first failing gate, not stored. A
 *     listing that is shown and not clicked has no price problem, so the column
 *     has to state the gate rather than a label somebody typed.
 */
import type { PoolClient } from 'pg'
import type { Lang } from '../i18n.js'

export type Basis = 'revenue' | 'margin'

/**
 * Reads a stored sentence in the reader's language.
 *
 * Falls back to English, then to the pre-migration text column. English is the
 * anchor because a check constraint guarantees it is there whenever anything is,
 * so this never returns null for a row that has a translation at all.
 */
const say = (col: string, param: string) =>
  `coalesce(text_i18n ->> ${param}, text_i18n ->> 'en', ${col})`

export interface Row {
  entityId: string
  label: string
  market: string
  band: string | null
  /** What the band measures: 'bedrooms' or 'occupancy'. Never assume. */
  bandBasis: string | null
  contract: string | null
  inHoldout: boolean
  atStake: number | null
  currency: string | null
  findings: number
  worstSeverity: string | null
  firstFailing: string | null
  headline: string | null
  worstFindingId: string | null
}

const AMOUNT: Record<Basis, string> = {
  revenue: 'amount_revenue',
  margin: 'amount_margin',
}

const SEVERITY_RANK = `case f.severity
    when 'critical' then 5 when 'high' then 4 when 'medium' then 3
    when 'low' then 2 else 1 end`

export async function portfolio(
  client: PoolClient, basis: Basis, lang: Lang,
): Promise<Row[]> {
  const amount = AMOUNT[basis]
  const { rows } = await client.query<Row>(`
    with ranked as (
      select f.*, ${SEVERITY_RANK} as rank,
             row_number() over (
               partition by f.entity_id
               order by ${SEVERITY_RANK} desc, f.${amount} desc nulls last
             ) as pos
        from finding f
       where f.state = 'open'
    )
    select e.id                       as "entityId",
           e.label,
           e.market::text             as market,
           e.band                     as band,
           e.band_basis               as "bandBasis",
           e.contract::text           as contract,
           e.in_holdout               as "inHoldout",
           -- largest single opportunity, never a sum
           max(r.${amount})           as "atStake",
           max(r.currency)            as currency,
           count(r.id)::int           as findings,
           max(case when r.pos = 1 then r.severity end)      as "worstSeverity",
           max(case when r.pos = 1 then r.first_failing::text end) as "firstFailing",
           max(case when r.pos = 1 then ${say('r.headline', '$1')} end) as headline,
           max(case when r.pos = 1 then r.id::text end)      as "worstFindingId"
      from entity e
      left join ranked r on r.entity_id = e.id
     where e.active
     group by e.id
     order by max(r.${amount}) desc nulls last, e.label`, [lang])
  return rows
}

/** The gate that produced the finding, in funnel order. */
export async function gate(client: PoolClient, findingId: string, lang: Lang) {
  const { rows } = await client.query<{ stage: string, verdict: string, note: string | null }>(
    `select stage::text, verdict::text, ${say('note', '$2')} as note from finding_gate
      where finding_id = $1
      order by case stage when 'impressions' then 1 when 'ctr' then 2
                          when 'conversion' then 3 else 4 end`, [findingId, lang])
  return rows
}

export async function evidence(client: PoolClient, findingId: string, lang: Lang) {
  const { rows } = await client.query<
    { side: string, family: string, metric: string, claim: string, observed_at: string | null }>(
    `select side, family, metric, ${say('claim', '$2')} as claim, observed_at
       from finding_evidence
      where finding_id = $1 order by side, id`, [findingId, lang])
  return rows
}

/** Rooms a check could not reach, with the missing signal named. */
export async function notAssessable(client: PoolClient, lang: Lang) {
  const { rows } = await client.query<{ label: string, reason: string }>(
    `select e.label, ${say('n.reason', '$1')} as reason
       from not_assessable n join entity e on e.id = n.entity_id
      where n.as_of = (select max(as_of) from not_assessable)
      order by e.label`, [lang])
  return rows
}

export async function counts(client: PoolClient) {
  const { rows } = await client.query<{ entities: number, open: number, critical: number, high: number }>(
    `select (select count(*)::int from entity where active) as entities,
            (select count(*)::int from finding where state = 'open') as open,
            (select count(*)::int from finding where state = 'open' and severity = 'critical') as critical,
            (select count(*)::int from finding where state = 'open' and severity = 'high') as high`)
  return rows[0]!
}

/** Per-element freshness, because one "last check" hides a real spread. */
export async function freshness(client: PoolClient) {
  const { rows } = await client.query<{ source: string, dataset: string, age_minutes: number }>(
    `select source::text, dataset,
            round(extract(epoch from (now() - coalesce(observed_at, fetched_at))) / 60)::int as age_minutes
       from dataset_freshness order by source, dataset`)
  return rows
}

/** True when the data is demonstration data, so the page can say so. */
export async function isDemo(client: PoolClient): Promise<boolean> {
  const { rows } = await client.query<{ n: number }>(
    `select count(*)::int n from entity where label like '[Demo]%'`)
  return (rows[0]?.n ?? 0) > 0
}
