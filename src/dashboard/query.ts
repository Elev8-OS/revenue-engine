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
import { stringsFor, type Lang } from '../i18n.js'

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
  /**
   * The range the amount sits in, from the same finding as `atStake`.
   * Both null where the check could only establish a point — a band drawn from
   * one number would be a picture of a confidence we do not have.
   */
  bandLow: number | null
  bandHigh: number | null
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
           max(case when r.pos = 1 then r.band_low end)  as "bandLow",
           max(case when r.pos = 1 then r.band_high end) as "bandHigh",
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

/**
 * Rooms that cannot be assessed, from two sources that mean different things.
 *
 *   not_assessable   A CHECK RAN and could not reach this room — a missing
 *                    signal, stale data, a gate that refused. Written per day by
 *                    a check run.
 *   no band          A STRUCTURAL fact: without a room count or a capacity there
 *                    is no cohort, so nothing can be compared no matter which
 *                    checks run. True before any check exists.
 *
 * Both belong in the same count, because the reader's question is "how much of
 * my portfolio did this actually look at". Splitting them across two numbers
 * would answer a question nobody asked.
 *
 * The reason this exists at all: the tile read 0 on a portfolio where four rooms
 * had no band, because it only queried not_assessable — a table nothing writes
 * until the check runner is built. The one number whose job is to stop a
 * half-assessed portfolio looking healthy was doing the opposite.
 */
export async function notAssessable(client: PoolClient, lang: Lang) {
  const { rows } = await client.query<{ label: string, reason: string }>(
    `select e.label, ${say('n.reason', '$1')} as reason
       from not_assessable n join entity e on e.id = n.entity_id
      where n.as_of = (select max(as_of) from not_assessable)
     union
     select e.label, $2 as reason
       from entity e
      where e.active and e.band is null
        -- Not twice. A room with no band that a check also could not reach is
        -- one room, and the check's reason is the more specific of the two.
        and e.id not in (select entity_id from not_assessable
                          where as_of = (select max(as_of) from not_assessable))
      order by label`, [lang, stringsFor(lang).reasonNoBand])
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

export interface NoPmsRow {
  entityId: string
  label: string
  market: string
  band: string | null
  sleeps: number | null
  /** Channex room ids: a room id means one bookable unit. */
  roomIds: number
  /** OTA listings linked to it. Published somewhere means it is real. */
  otaLinks: number
  otaSources: string | null
}

/**
 * Objects with no PMS property id — candidates for not being lettings at all.
 *
 * This is a REPORT, not a cleanup. It exists because the cleanup nearly went
 * ahead on a wrong premise: three rows looked like junk by name — a storage
 * cupboard, an office, and "1 - 3 Plunge Pool" — and then PriceLabs turned out
 * to price a listing called "1 - 3 Plunge Pool" with three units. Names are not
 * evidence. So the columns here are the evidence:
 *
 *   roomIds > 0   the channel manager gave it a bookable room → it is a letting
 *   otaLinks > 0  it is published on an OTA → it is a letting
 *   both zero     nothing in any source treats it as bookable
 *
 * A row with neither is safe to remove. A row with either is not, whatever it is
 * called, and deleting it would have taken a real object out of the portfolio.
 */
export async function withoutPmsId(client: PoolClient): Promise<NoPmsRow[]> {
  const { rows } = await client.query<NoPmsRow>(
    `select e.id                        as "entityId",
            e.label,
            e.market::text              as market,
            e.band,
            e.sleeps,
            count(distinct case when a.source = 'channex' and a.kind = 'room'
                                then a.external_id end)::int as "roomIds",
            count(distinct case when a.source in ('mdv_airbnb','mdv_booking')
                                then a.external_id end)::int as "otaLinks",
            nullif(string_agg(distinct case when a.source in ('mdv_airbnb','mdv_booking')
                                            then a.source::text end, ', '), '') as "otaSources"
       from entity e
       left join entity_alias a on a.entity_id = e.id
      where e.active and e.pms_property_id is null
      group by e.id
      order by "otaLinks" desc, "roomIds" desc, e.label`)
  return rows
}

/**
 * What we have MEASURED about a room, as opposed to what we have concluded.
 *
 * This exists because of a specific, fair complaint: two imports ran, 22'047
 * rows landed in the archive, and the dashboard showed nothing. It was not
 * wrong — every column that carries meaning reads from `finding`, and no check
 * exists yet to write one. But a page that looks identical before and after a
 * successful import is a page that cannot be trusted to report either.
 *
 * So the two columns the layout already reserved get filled with measurements,
 * and they are labelled as measurements. `occupancy 63% against a market at
 * 30%` is not a finding: it carries no cause, no money, no recommendation, and
 * it does not know whether the gap is a price problem or a visibility one — that
 * is what the check and its gates are for, and the funnel they need is still
 * behind the MDV grant. What it IS, is true and sourced, which is the whole bar
 * this project holds itself to.
 *
 * Both halves come from PriceLabs' own comparison for that listing's
 * neighbourhood, so the two numbers in a cell are always the same kind of thing
 * measured the same way.
 */
export interface Signals {
  /** Ours and theirs over the next 30 nights, as percentages. */
  occupancy: number | null
  marketOccupancy: number | null
  /** Market pricing index: above 1 means we ask more than the market. */
  mpi: number | null
  adr: number | null
  marketAdr: number | null
  /**
   * Revenue on the books for the same window. Not rendered — it is what tells a
   * booked calendar from a blocked one, and a room reading 100% occupied with
   * nothing earned is closed, not full.
   */
  revenue: number | null
  /** Median over the archived calendar, not an average: one blocked night with
   *  a placeholder price would drag a mean and cannot move a median. */
  priceRecommended: number | null
  priceLive: number | null
  /** Nights actually archived. A cell over three nights is not a cell over 90. */
  nights: number
  currency: string | null
  /** When the provider last recomputed it, where it says. */
  observedAt: Date | null
  /** The day WE looked, which is the honest age of the row. */
  asOf: string | null
}

export async function signals(client: PoolClient): Promise<Map<string, Signals>> {
  const { rows } = await client.query<{
    entity_id: string, occupancy: string | null, market_occupancy: string | null,
    mpi: string | null, adr: string | null, market_adr: string | null, revenue: string | null,
    price_recommended: string | null, price_live: string | null, nights: number,
    currency: string | null, observed_at: Date | null, as_of: string | null
  }>(`
    -- Per entity, the most recent pass. Not a global max: a listing PriceLabs
    -- refused today must show yesterday's number as yesterday's, not vanish.
    with win_asof as (
      select entity_id, max(as_of_date) as as_of
        from snapshot where metric = 'occupancy_next_30d' group by entity_id
    ),
    win as (
      select s.entity_id,
             max(s.value) filter (where s.metric = 'occupancy_next_30d')        as occupancy,
             max(s.value) filter (where s.metric = 'market_occupancy_next_30d') as market_occupancy,
             max(s.value) filter (where s.metric = 'mpi_next_30d')              as mpi,
             max(s.value) filter (where s.metric = 'adr_next_30d')              as adr,
             max(s.value) filter (where s.metric = 'market_adr_next_30d')       as market_adr,
             max(s.value) filter (where s.metric = 'revenue_next_30d')           as revenue,
             max(s.as_of_date)::text as as_of
        from snapshot s
        join win_asof w on w.entity_id = s.entity_id and s.as_of_date = w.as_of
       group by s.entity_id
    ),
    px_asof as (
      select entity_id, max(as_of_date) as as_of
        from snapshot where metric = 'price_recommended' group by entity_id
    ),
    cal as (
      select s.entity_id,
             percentile_cont(0.5) within group (order by s.value)
               filter (where s.metric = 'price_recommended') as price_recommended,
             percentile_cont(0.5) within group (order by s.value)
               filter (where s.metric = 'price_current')     as price_live,
             count(*) filter (where s.metric = 'price_recommended')::int as nights,
             max(s.currency)   as currency,
             max(s.observed_at) as observed_at
        from snapshot s
        join px_asof p on p.entity_id = s.entity_id and s.as_of_date = p.as_of
        -- The month ahead of the observation, so the window is the same length
        -- for a row read today and a row read last week.
       where s.metric in ('price_recommended', 'price_current')
         and s.stay_date >= p.as_of and s.stay_date < p.as_of + 30
       group by s.entity_id
    )
    select e.id::text as entity_id,
           w.occupancy::text, w.market_occupancy::text, w.mpi::text,
           w.adr::text, w.market_adr::text, w.revenue::text,
           c.price_recommended::text, c.price_live::text,
           coalesce(c.nights, 0) as nights, c.currency, c.observed_at,
           w.as_of
      from entity e
      left join win w on w.entity_id = e.id
      left join cal c on c.entity_id = e.id
     where e.active`)

  const num = (v: string | null) => v === null ? null : Number(v)
  return new Map(rows.map(r => [r.entity_id, {
    occupancy: num(r.occupancy), marketOccupancy: num(r.market_occupancy),
    mpi: num(r.mpi), adr: num(r.adr), marketAdr: num(r.market_adr), revenue: num(r.revenue),
    priceRecommended: num(r.price_recommended), priceLive: num(r.price_live),
    nights: r.nights, currency: r.currency, observedAt: r.observed_at, asOf: r.as_of,
  }]))
}
