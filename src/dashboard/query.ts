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
import { clientCredentials } from '../sources/mdv/register.js'
import { stringsFor, type Lang } from '../i18n.js'
export type { FunnelState } from '../checks/occupancy-gap.js'
import type { FunnelState } from '../checks/occupancy-gap.js'

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
  /**
   * The micro layer: the price distribution of this listing's OWN neighbourhood,
   * for its own bedroom category. A price is not high or low on its own — it is
   * high or low against a spread, and this is the spread.
   */
  nbhdP25: number | null
  nbhdP50: number | null
  nbhdP75: number | null
  nbhdP90: number | null
  /** How many listings the band rests on. Two and 155 are different claims. */
  nbhdListings: number | null
  /**
   * Occupancy with owner-blocked nights taken out.
   *
   * The one that separates "full" from "closed". A room reading 100% with no
   * revenue behind it is blocked, not sold, and the unadjusted figure cannot
   * tell the difference.
   */
  adjustedOccupancy: number | null
  /** Revenue per available night — the figure that survives a price/occupancy trade. */
  revpar: number | null
  /** The same window one year earlier. Without it, "26%" has no direction. */
  stlyOccupancy: number | null
  stlyAdr: number | null
  stlyRevenue: number | null
  /** The same measure at a shorter and a longer horizon, so a trend is visible. */
  occupancy7: number | null
  occupancy90: number | null
  /**
   * The funnel, one side per CHANNEL.
   *
   * Split by source and not by metric name, which is the correction. Both
   * channels turned out to answer with the same field names AND the same axis,
   * so both write `funnel_impressions_trailing` — and a query keyed on the
   * metric alone would have collapsed Booking and Airbnb with a `max()`,
   * silently reporting whichever number happened to be larger as though it were
   * the listing's whole visibility.
   *
   * The axis travels with the side because it is derived from the payload, so a
   * label that said "recent history" from a constant could be wrong the day the
   * provider starts sending dates.
   */
  funnelBooking: FunnelSide | null
  funnelAirbnb: FunnelSide | null
}

export interface FunnelSide {
  /** What the rows were about: one figure over a window, or one per night. */
  axis: 'trailing' | 'forward'
  impressions: number | null
  views: number | null
  conversions: number | null
  /** Forward only: nights the sums rest on. Three and ninety are different claims. */
  nights: number
}

export async function signals(client: PoolClient): Promise<Map<string, Signals>> {
  const { rows } = await client.query<{
    entity_id: string, occupancy: string | null, market_occupancy: string | null,
    mpi: string | null, adr: string | null, market_adr: string | null, revenue: string | null,
    adj_occ: string | null, revpar: string | null, stly_occ: string | null,
    stly_adr: string | null, stly_rev: string | null,
    occ7: string | null, occ90: string | null,
    price_recommended: string | null, price_live: string | null, nights: number,
    currency: string | null, observed_at: Date | null, as_of: string | null,
    p25: string | null, p50: string | null, p75: string | null, p90: string | null,
    listings: string | null,
    b_t_impr: string | null, b_t_views: string | null, b_t_conv: string | null,
    b_f_impr: string | null, b_f_views: string | null, b_f_conv: string | null,
    b_nights: number,
    a_t_impr: string | null, a_t_views: string | null, a_t_conv: string | null,
    a_f_impr: string | null, a_f_views: string | null, a_f_conv: string | null,
    a_nights: number
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
             -- Written by the metrics adapter since the first PriceLabs pass and
             -- read by nothing until now. Twelve measures over seven windows are
             -- archived; six were on the page.
             max(s.value) filter (where s.metric = 'adjusted_occupancy_next_30d')  as adj_occ,
             max(s.value) filter (where s.metric = 'revpar_next_30d')              as revpar,
             max(s.value) filter (where s.metric = 'stly_occupancy_next_30d')      as stly_occ,
             max(s.value) filter (where s.metric = 'stly_adr_next_30d')            as stly_adr,
             max(s.value) filter (where s.metric = 'stly_revenue_next_30d')        as stly_rev,
             max(s.value) filter (where s.metric = 'occupancy_next_7d')            as occ7,
             max(s.value) filter (where s.metric = 'occupancy_next_90d')           as occ90,
             max(s.as_of_date)::text as as_of
        from snapshot s
        join win_asof w on w.entity_id = s.entity_id and s.as_of_date = w.as_of
       group by s.entity_id
    ),
    nb_asof as (
      select entity_id, max(as_of_date) as as_of
        from snapshot where metric = 'nbhd_price_p50' group by entity_id
    ),
    nb as (
      select s.entity_id,
             max(s.value) filter (where s.metric = 'nbhd_price_p25')   as p25,
             max(s.value) filter (where s.metric = 'nbhd_price_p50')   as p50,
             max(s.value) filter (where s.metric = 'nbhd_price_p75')   as p75,
             max(s.value) filter (where s.metric = 'nbhd_price_p90')   as p90,
             max(s.value) filter (where s.metric = 'nbhd_listings')    as listings
        from snapshot s
        join nb_asof n on n.entity_id = s.entity_id and s.as_of_date = n.as_of
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
    ),
    -- Booking. Keyed on the metric NAME, which now carries the channel:
    -- both channels write the same concepts about the same object on the same day,
    -- and snapshot's primary key has no source column, so a shared name meant the
    -- second pass overwrote the first. The name is what keeps them apart.
    fnb_asof as (
      select entity_id, max(as_of_date) as as_of
        from snapshot
       where metric in ('funnel_booking_impressions', 'funnel_booking_impressions_trailing')
       group by entity_id
    ),
    fnb as (
      select s.entity_id,
             max(s.value) filter (where s.metric = 'funnel_booking_impressions_trailing') as t_impr,
             max(s.value) filter (where s.metric = 'funnel_booking_views_trailing')       as t_views,
             max(s.value) filter (where s.metric = 'funnel_booking_conversions_trailing') as t_conv,
             -- Forward figures are summed over the same thirty nights the occupancy
             -- figure above covers, so the two are comparable.
             sum(s.value) filter (where s.metric = 'funnel_booking_impressions'
               and s.stay_date >= a.as_of and s.stay_date < a.as_of + 30)             as f_impr,
             sum(s.value) filter (where s.metric = 'funnel_booking_views'
               and s.stay_date >= a.as_of and s.stay_date < a.as_of + 30)             as f_views,
             sum(s.value) filter (where s.metric = 'funnel_booking_conversions'
               and s.stay_date >= a.as_of and s.stay_date < a.as_of + 30)             as f_conv,
             count(*) filter (where s.metric = 'funnel_booking_impressions'
               and s.stay_date >= a.as_of and s.stay_date < a.as_of + 30)::int        as f_nights
        from snapshot s
        join fnb_asof a on a.entity_id = s.entity_id and s.as_of_date = a.as_of
       group by s.entity_id
    ),
    -- Airbnb. Keyed on the metric NAME, which now carries the channel:
    -- both channels write the same concepts about the same object on the same day,
    -- and snapshot's primary key has no source column, so a shared name meant the
    -- second pass overwrote the first. The name is what keeps them apart.
    fna_asof as (
      select entity_id, max(as_of_date) as as_of
        from snapshot
       where metric in ('funnel_airbnb_impressions', 'funnel_airbnb_impressions_trailing')
       group by entity_id
    ),
    fna as (
      select s.entity_id,
             max(s.value) filter (where s.metric = 'funnel_airbnb_impressions_trailing') as t_impr,
             max(s.value) filter (where s.metric = 'funnel_airbnb_views_trailing')       as t_views,
             max(s.value) filter (where s.metric = 'funnel_airbnb_conversions_trailing') as t_conv,
             -- Forward figures are summed over the same thirty nights the occupancy
             -- figure above covers, so the two are comparable.
             sum(s.value) filter (where s.metric = 'funnel_airbnb_impressions'
               and s.stay_date >= a.as_of and s.stay_date < a.as_of + 30)             as f_impr,
             sum(s.value) filter (where s.metric = 'funnel_airbnb_views'
               and s.stay_date >= a.as_of and s.stay_date < a.as_of + 30)             as f_views,
             sum(s.value) filter (where s.metric = 'funnel_airbnb_conversions'
               and s.stay_date >= a.as_of and s.stay_date < a.as_of + 30)             as f_conv,
             count(*) filter (where s.metric = 'funnel_airbnb_impressions'
               and s.stay_date >= a.as_of and s.stay_date < a.as_of + 30)::int        as f_nights
        from snapshot s
        join fna_asof a on a.entity_id = s.entity_id and s.as_of_date = a.as_of
       group by s.entity_id
    )
    select e.id::text as entity_id,
           w.occupancy::text, w.market_occupancy::text, w.mpi::text,
           w.adr::text, w.market_adr::text, w.revenue::text,
           w.adj_occ::text, w.revpar::text, w.stly_occ::text, w.stly_adr::text,
           w.stly_rev::text, w.occ7::text, w.occ90::text,
           c.price_recommended::text, c.price_live::text,
           coalesce(c.nights, 0) as nights, c.currency, c.observed_at,
           w.as_of,
           nb.p25::text, nb.p50::text, nb.p75::text, nb.p90::text, nb.listings::text,
           fb.t_impr::text as b_t_impr, fb.t_views::text as b_t_views,
           fb.t_conv::text as b_t_conv, fb.f_impr::text as b_f_impr,
           fb.f_views::text as b_f_views, fb.f_conv::text as b_f_conv,
           coalesce(fb.f_nights, 0) as b_nights,
           fa.t_impr::text as a_t_impr, fa.t_views::text as a_t_views,
           fa.t_conv::text as a_t_conv, fa.f_impr::text as a_f_impr,
           fa.f_views::text as a_f_views, fa.f_conv::text as a_f_conv,
           coalesce(fa.f_nights, 0) as a_nights
      from entity e
      left join win w on w.entity_id = e.id
      left join cal c on c.entity_id = e.id
      left join nb on nb.entity_id = e.id
      left join fnb fb on fb.entity_id = e.id
      left join fna fa on fa.entity_id = e.id
     where e.active`)

  const num = (v: string | null) => v === null ? null : Number(v)
  /**
   * One channel's side, or null when that channel said nothing.
   *
   * Only one axis can be populated per (entity, source, day) — the adapter
   * derives the axis once per pass, so it writes the suffixed metrics or the
   * unsuffixed ones, never both. Forward is checked first anyway, because it is
   * the more specific answer and a leftover trailing row from an earlier shape
   * must not outrank a dated one.
   */
  const side = (ti: number | null, tv: number | null, tc: number | null,
                fi: number | null, fv: number | null, fc: number | null,
                nights: number): FunnelSide | null => {
    if (fi !== null || fv !== null || fc !== null) {
      return { axis: 'forward', impressions: fi, views: fv, conversions: fc, nights }
    }
    if (ti !== null || tv !== null || tc !== null) {
      return { axis: 'trailing', impressions: ti, views: tv, conversions: tc, nights: 0 }
    }
    return null
  }
  return new Map(rows.map(r => [r.entity_id, {
    occupancy: num(r.occupancy), marketOccupancy: num(r.market_occupancy),
    mpi: num(r.mpi), adr: num(r.adr), marketAdr: num(r.market_adr), revenue: num(r.revenue),
    priceRecommended: num(r.price_recommended), priceLive: num(r.price_live),
    nights: r.nights, currency: r.currency, observedAt: r.observed_at, asOf: r.as_of,
    nbhdP25: num(r.p25), nbhdP50: num(r.p50), nbhdP75: num(r.p75), nbhdP90: num(r.p90),
    nbhdListings: num(r.listings),
    adjustedOccupancy: num(r.adj_occ), revpar: num(r.revpar),
    stlyOccupancy: num(r.stly_occ), stlyAdr: num(r.stly_adr),
    stlyRevenue: num(r.stly_rev),
    occupancy7: num(r.occ7), occupancy90: num(r.occ90),
    funnelBooking: side(num(r.b_t_impr), num(r.b_t_views), num(r.b_t_conv),
                        num(r.b_f_impr), num(r.b_f_views), num(r.b_f_conv), r.b_nights),
    funnelAirbnb: side(num(r.a_t_impr), num(r.a_t_views), num(r.a_t_conv),
                       num(r.a_f_impr), num(r.a_f_views), num(r.a_f_conv), r.a_nights),
  }]))
}

/**
 * Why the three funnel gates cannot be evaluated — established, not asserted.
 *
 * The check used to hardcode "the MyDataValue grant is revoked" into every gate
 * note. That was stale within a day of the grant coming back, and it was never
 * something the check had checked: it stated a cause for missing data without
 * looking. Read once per run, so the sentence on every finding corrects itself.
 *
 * The order is the order a reader would fix things in. A missing credential
 * beats a revoked grant beats a stale token beats "nothing reads it yet" — and
 * that last one is the honest common case today, because the MDV importer
 * attaches objects and records freshness and does not pull a single funnel
 * signal. No adapter writes them, so no room can have them.
 */
export async function funnelState(db: PoolClient): Promise<FunnelState> {
  /**
   * A REGISTERED client counts as configured, and reading the variables alone did
   * not. This is the same defect `runMdv` had: once the service registered its own
   * client the variables became optional, so a fully working grant would have gone
   * on reporting "not configured" — a sentence contradicted by the data beside it.
   */
  if (!await clientCredentials(db)) return { kind: 'not_configured' }
  const { rows } = await db.query<{ revoked_at: Date | null, stale_since: Date | null }>(
    `select revoked_at, stale_since from oauth_token where provider = 'mdv'`)
  const grant = rows[0]
  if (!grant) return { kind: 'not_configured' }
  if (grant.revoked_at) return { kind: 'grant_revoked' }
  if (grant.stale_since) return { kind: 'grant_stale' }
  // Has ANY funnel signal ever been archived? If not, the reason is that nothing
  // reads them — which stops being true on its own the day the adapter lands,
  // with no line here to remember to change.
  const { rows: seen } = await db.query<{ n: number }>(
    `select count(*)::int n from snapshot
      where source in ('mdv_booking', 'mdv_airbnb') limit 1`)
  return (seen[0]?.n ?? 0) > 0 ? { kind: 'read' } : { kind: 'unread' }
}

/* ------------------------------------------------------- realised bookings */

/**
 * What actually got sold, and what the OTAs took for it.
 *
 * This reads `booking_economics`, a table with eighteen columns that the
 * dashboard has never touched — 541 to 555 rows measured on the live account,
 * carrying the channel, the gross amount, the OTA commission, the city tax, the
 * guest's country and the moment it was booked. Every per-channel figure and
 * every margin statement the plan calls for was already sitting there.
 *
 * The window is arrivals in the last 90 days, and it is REPORTED rather than
 * assumed: a channel mix over three bookings and a channel mix over sixty are
 * different claims, and the count travels with the number.
 */
export interface Realised {
  revenue: number
  nights: number
  commission: number
  /**
   * Commission over gross, as a fraction.
   *
   * Deliberately not called "the take rate". The full stack is multiplicative —
   * promotions, then commissions, then fixed deductions — and this is only the
   * commission layer. Naming it as the whole thing would understate what the
   * host actually gives up.
   */
  commissionRate: number | null
  bookings: number
  channels: { name: string, revenue: number, share: number }[]
  currency: string | null
}

const REALISED_DAYS = 90

export async function realised(client: PoolClient): Promise<Map<string, Realised>> {
  const { rows } = await client.query<{
    entity_id: string, revenue: string | null, nights: string | null,
    commission: string | null, bookings: number, currency: string | null
  }>(`
    select b.entity_id::text as entity_id,
           sum(b.gross_amount)::text  as revenue,
           sum(b.nights)::text        as nights,
           sum(b.ota_commission)::text as commission,
           count(*)::int              as bookings,
           max(b.currency)            as currency
      from booking_economics b
      join entity e on e.id = b.entity_id and e.active
     where b.arrival >= current_date - $1::int
       and b.arrival <  current_date
       -- A cancelled booking is not revenue. The column arrived with the
       -- PriceLabs adapter precisely so this line could exist.
       and coalesce(b.status, '') <> 'cancelled'
     group by b.entity_id`, [REALISED_DAYS])

  const { rows: ch } = await client.query<{
    entity_id: string, channel: string, revenue: string | null
  }>(`
    select entity_id::text as entity_id, channel, sum(gross_amount)::text as revenue
      from booking_economics
     where arrival >= current_date - $1::int and arrival < current_date
       and coalesce(status, '') <> 'cancelled'
     group by entity_id, channel`, [REALISED_DAYS])

  const byEntity = new Map<string, { name: string, revenue: number }[]>()
  for (const r of ch) {
    const list = byEntity.get(r.entity_id) ?? []
    list.push({ name: r.channel, revenue: Number(r.revenue ?? 0) })
    byEntity.set(r.entity_id, list)
  }

  const out = new Map<string, Realised>()
  for (const r of rows) {
    const revenue = Number(r.revenue ?? 0)
    const commission = Number(r.commission ?? 0)
    const channels = (byEntity.get(r.entity_id) ?? [])
      .map(c => ({ ...c, share: revenue > 0 ? c.revenue / revenue : 0 }))
      .sort((a, b) => b.revenue - a.revenue)
    out.set(r.entity_id, {
      revenue, nights: Number(r.nights ?? 0), commission,
      // Guarded, because a window with no gross would otherwise divide by zero
      // and render as a confident "0%".
      commissionRate: revenue > 0 ? commission / revenue : null,
      bookings: r.bookings, channels, currency: r.currency,
    })
  }
  return out
}

export const realisedWindowDays = REALISED_DAYS

/* --------------------------------------------------------------- reputation */

export interface ReviewStanding { score: number | null, count: number | null }

/**
 * Review score and count per channel.
 *
 * Two numbers that decide which findings are even allowed to fire. MyDataValue's
 * own ranking match weights the score at 18.4% and the count at 3.1%, so a
 * listing with a perfect score from one review carries a structural handicap that
 * no price change repairs — and a pricing tool pointed at it proposes prices
 * forever.
 */
export async function reviews(
  client: PoolClient,
): Promise<Map<string, { booking: ReviewStanding | null, airbnb: ReviewStanding | null }>> {
  const { rows } = await client.query<{
    entity_id: string, metric: string, value: string
  }>(`
    select distinct on (entity_id, metric)
           entity_id::text as entity_id, metric, value::text
      from snapshot
     where metric in ('reviews_booking_score', 'reviews_booking_count',
                      'reviews_airbnb_score', 'reviews_airbnb_count')
     order by entity_id, metric, as_of_date desc`)
  const out = new Map<string, { booking: ReviewStanding | null, airbnb: ReviewStanding | null }>()
  for (const r of rows) {
    const side = r.metric.includes('booking') ? 'booking' : 'airbnb'
    const field = r.metric.endsWith('score') ? 'score' : 'count'
    const entry = out.get(r.entity_id) ?? { booking: null, airbnb: null }
    const standing = entry[side] ?? { score: null, count: null }
    standing[field] = Number(r.value)
    entry[side] = standing
    out.set(r.entity_id, entry)
  }
  return out
}

/* --------------------------------------------------------------- promotions */

export interface Promotion {
  kind: string
  active: boolean | null
  discountPct: number | null
  endsOn: string | null
  /** The provider's own grouping. Transcribed, never mapped onto ours. */
  family: string | null
  /** When the channel switched it off — the only time signal this payload has. */
  deactivatedAt: string | null
}

/**
 * The commercial levers, per object and account-wide.
 *
 * Two maps, because MyDataValue's promotions report is documented as team-wide:
 * some rows name an object and some are about the account. A row we cannot
 * attribute is kept as account-level rather than pinned onto a listing — the
 * take-rate stack is multiplicative, so attributing a discount to the wrong
 * object misstates a margin rather than rounding it.
 */
/**
 * Every lever the provider offers on this account, and how many rooms run it.
 *
 * The account-wide list asked the wrong question. "Here are the promotions on the
 * account" is a fact nobody acts on; "eleven of forty rooms run the mobile rate"
 * is. The vocabulary also gives the per-room matrix its columns, so an empty cell
 * means "offered and not taken" rather than "unknown" — which is the whole
 * difference between a grid and a pile of chips.
 */
export async function leverCoverage(
  client: PoolClient,
): Promise<Array<{ kind: string, on: number, of: number }>> {
  const { rows } = await client.query<{ kind: string, on: number, of: number }>(`
    with latest as (select max(as_of_date) as d from channel_promotion),
    rooms as (select count(*)::int n from entity where active)
    select p.kind,
           count(*) filter (where p.active is true and p.entity_id is not null)::int as on,
           (select n from rooms) as of
      from channel_promotion p, latest
     where p.as_of_date = latest.d
     group by p.kind
     order by 2 desc, 1`)
  return rows
}

export async function promotions(
  client: PoolClient,
): Promise<{ byEntity: Map<string, Promotion[]>, account: Promotion[] }> {
  const { rows } = await client.query<{
    entity_id: string | null, kind: string, active: boolean | null,
    discount_pct: string | null, ends_on: Date | null,
    family: string | null, deactivated_at: Date | null
  }>(`
    with latest as (select max(as_of_date) as d from channel_promotion)
    select entity_id::text as entity_id, kind, active, discount_pct::text, ends_on,
           family, deactivated_at
      from channel_promotion, latest
     where as_of_date = latest.d
     order by kind`)
  const byEntity = new Map<string, Promotion[]>()
  const account: Promotion[] = []
  for (const r of rows) {
    const p: Promotion = {
      kind: r.kind, active: r.active,
      discountPct: r.discount_pct === null ? null : Number(r.discount_pct),
      endsOn: r.ends_on ? r.ends_on.toISOString().slice(0, 10) : null,
      family: r.family,
      deactivatedAt: r.deactivated_at
        ? r.deactivated_at.toISOString().slice(0, 10) : null,
    }
    if (r.entity_id) {
      const list = byEntity.get(r.entity_id) ?? []
      list.push(p); byEntity.set(r.entity_id, list)
    } else account.push(p)
  }
  return { byEntity, account }
}

/* ----------------------------------------------------- the cohort, our own */

export interface CohortStanding {
  /** How many listings in the cohort beat this one. */
  better: number
  /** How large the cohort is, including this listing. */
  of: number
  /**
   * The cohort's own medians, which are what make a rate DRAWABLE.
   *
   * A search-to-view rate of 0.75% cannot go on a 0-100% track: the bar is a
   * sliver and the reader learns nothing. Against the median of our own set it
   * has a scale that means something — below the middle, or above it — and that
   * is also the only comparison we can defend.
   */
  viewRateMedian: number | null
  bookRateMedian: number | null
}

/**
 * Where a listing's funnel sits inside OUR OWN cohort — market × band × channel.
 *
 * This is the only honest comparison available, and it is worth being precise
 * about why. No provider sells competitor funnel data: nobody can tell us what
 * the apartment next door converts at. Published benchmarks exist, but they are
 * vendor blog figures with unstated methodology and no control for market or
 * size — and the sources themselves note that a luxury villa converts lower than
 * a budget flat because a large booking involves more deliberation. Applying one
 * industry number across Basel, Tauplitz and Canggu would produce a verdict about
 * nothing.
 *
 * So the yardstick is the portfolio itself, and the page says so. "Nine of twelve
 * 2BR listings in this market convert better on Booking" is a claim we can
 * defend from our own measurements.
 *
 * The cohort size travels with the rank BECAUSE a rank without it is unreadable:
 * being third of three and third of forty are opposite findings, and a cohort of
 * two is not a distribution at all.
 */
export async function funnelCohorts(
  client: PoolClient,
): Promise<Map<string, { booking: CohortStanding | null, airbnb: CohortStanding | null }>> {
  const { rows } = await client.query<{
    entity_id: string, channel: string, better: number, of: number,
    median: string | null, book_median: string | null
  }>(`
    with latest as (
      -- One rate per entity per channel, from the most recent pass that wrote it.
      -- Both the trailing and the per-night name are accepted: which one an
      -- account produces is a property of the payload, not of this query.
      select distinct on (s.entity_id, s.metric)
             s.entity_id, s.metric, s.value
        from snapshot s
       where s.metric in ('funnel_booking_view_rate_trailing', 'funnel_booking_view_rate',
                          'funnel_airbnb_view_rate_trailing', 'funnel_airbnb_view_rate')
       order by s.entity_id, s.metric, s.as_of_date desc
    ),
    keyed as (
      select l.entity_id, l.value,
             case when l.metric like 'funnel_booking%' then 'booking' else 'airbnb' end as channel,
             e.market::text as market,
             -- An unbanded room still has a market, and grouping it with the
             -- other unbanded rooms is honest as long as the page says the band
             -- is missing. Dropping it would make it invisible instead.
             coalesce(e.band, '(no band)') as band
        from latest l
        join entity e on e.id = l.entity_id and e.active
    ),
    cohort as (
      select market, band, channel,
             count(*)::int as n,
             -- An ordered-set aggregate, which is why it lives in its own
             -- grouped query: percentile_cont cannot take an OVER clause.
             percentile_cont(0.5) within group (order by value) as median
        from keyed group by market, band, channel
    ),
    -- The book-rate median needs its own pass: it is a different metric over the
    -- same cohort key, and folding it into the keyed set would rank listings on the
    -- wrong number.
    booked as (
      select distinct on (s.entity_id, s.metric) s.entity_id, s.metric, s.value
        from snapshot s
       where s.metric in ('funnel_booking_book_rate_trailing', 'funnel_booking_book_rate',
                          'funnel_airbnb_book_rate_trailing', 'funnel_airbnb_book_rate')
       order by s.entity_id, s.metric, s.as_of_date desc
    ),
    booked_cohort as (
      select e.market::text as market, coalesce(e.band, '(no band)') as band,
             case when b.metric like 'funnel_booking%' then 'booking' else 'airbnb' end as channel,
             percentile_cont(0.5) within group (order by b.value) as median
        from booked b join entity e on e.id = b.entity_id and e.active
       group by 1, 2, 3
    )
    select k.entity_id::text as entity_id, k.channel,
           -- rank() minus one counts strictly better values only, so ties do not
           -- count against either listing.
           (rank() over (partition by k.market, k.band, k.channel
                         order by k.value desc) - 1)::int as better,
           c.n as of,
           c.median::text as median,
           bc.median::text as book_median
      from keyed k
      join cohort c on c.market = k.market and c.band = k.band and c.channel = k.channel
      left join booked_cohort bc on bc.market = k.market and bc.band = k.band
                                and bc.channel = k.channel`)
  const out = new Map<string, { booking: CohortStanding | null, airbnb: CohortStanding | null }>()
  for (const r of rows) {
    const entry = out.get(r.entity_id) ?? { booking: null, airbnb: null }
    entry[r.channel === 'booking' ? 'booking' : 'airbnb'] = {
      better: r.better, of: r.of,
      viewRateMedian: r.median === null ? null : Number(r.median),
      bookRateMedian: r.book_median === null ? null : Number(r.book_median),
    }
    out.set(r.entity_id, entry)
  }
  return out
}

/* ------------------------------------------------- the shape of demand, ours */

export interface DemandShape {
  /** Days between booking and arrival, from our own realised bookings. */
  leadMedian: number | null
  leadP25: number | null
  leadP75: number | null
  /** Nights per booking, realised. This is what a minimum stay is measured against. */
  nightsMedian: number | null
  nightsP75: number | null
  bookings: number
  /** Where the guests who actually booked came from, biggest first. */
  origins: Array<{ country: string, bookings: number, share: number }>
}

const DEMAND_DAYS = 365

/**
 * What our own demand looks like: how far ahead people book, how long they stay,
 * and where they come from.
 *
 * Every figure here comes out of `booking_economics`, which has held
 * `booked_at`, `arrival`, `nights` and `guest_country` since the first PriceLabs
 * pass. Lead time and stay length were never derived, and guest origin — the
 * thing the macro block has been describing as absent for weeks — was sitting in
 * a column nobody selected.
 *
 * This is the REALISED side. MyDataValue's demand report holds the same shapes
 * for the SEARCH side (`book_window_*`, `length_of_stay_*`, `traveller_country_*`),
 * and the two answer different questions: who booked us, against who looked. The
 * gap between them is the interesting part, and it needs the demand adapter
 * first.
 *
 * A year, because a quarter of Balinese bookings and a quarter of Swiss ones fall
 * in different seasons and a 90-day window would report the season, not the
 * pattern.
 */
export async function demandShape(client: PoolClient): Promise<Map<string, DemandShape>> {
  const { rows } = await client.query<{
    entity_id: string, lead_median: string | null, lead_p25: string | null,
    lead_p75: string | null, nights_median: string | null, nights_p75: string | null,
    bookings: number
  }>(`
    select entity_id::text as entity_id,
           percentile_cont(0.5) within group (
             order by (arrival - booked_at::date))::text as lead_median,
           percentile_cont(0.25) within group (
             order by (arrival - booked_at::date))::text as lead_p25,
           percentile_cont(0.75) within group (
             order by (arrival - booked_at::date))::text as lead_p75,
           percentile_cont(0.5) within group (order by nights)::text as nights_median,
           percentile_cont(0.75) within group (order by nights)::text as nights_p75,
           count(*)::int as bookings
      from booking_economics
     where arrival >= current_date - $1::int
       and booked_at is not null
       and coalesce(status, '') <> 'cancelled'
     group by entity_id`, [DEMAND_DAYS])

  const { rows: orig } = await client.query<{
    entity_id: string, country: string, bookings: number
  }>(`
    select entity_id::text as entity_id,
           -- Upper-cased so 'ch' and 'CH' are one country rather than two.
           upper(guest_country) as country, count(*)::int as bookings
      from booking_economics
     where arrival >= current_date - $1::int
       and guest_country is not null and guest_country <> ''
       and coalesce(status, '') <> 'cancelled'
     group by entity_id, upper(guest_country)`, [DEMAND_DAYS])

  const byEntity = new Map<string, Array<{ country: string, bookings: number }>>()
  for (const r of orig) {
    const list = byEntity.get(r.entity_id) ?? []
    list.push({ country: r.country, bookings: r.bookings })
    byEntity.set(r.entity_id, list)
  }

  const num = (v: string | null) => v === null ? null : Number(v)
  const out = new Map<string, DemandShape>()
  for (const r of rows) {
    const list = (byEntity.get(r.entity_id) ?? []).sort((a, b) => b.bookings - a.bookings)
    const total = list.reduce((n, c) => n + c.bookings, 0)
    out.set(r.entity_id, {
      leadMedian: num(r.lead_median), leadP25: num(r.lead_p25), leadP75: num(r.lead_p75),
      nightsMedian: num(r.nights_median), nightsP75: num(r.nights_p75),
      bookings: r.bookings,
      origins: list.map(c => ({ ...c, share: total > 0 ? c.bookings / total : 0 })),
    })
  }
  return out
}

export const demandWindowDays = DEMAND_DAYS

/* ------------------------------------------------------------- the price gap */

export interface PriceGap {
  /** Nights in the next 30 where our price and the recommendation differ. */
  nights: number
  /** Nights we ask MORE than recommended, and fewer. */
  above: number
  below: number
  /** Median of our price and of the recommendation over those nights. */
  ours: number | null
  recommended: number | null
  currency: string | null
  /** Nights whose minimum stay exceeds what guests actually book. */
  minStayOver: number
  minStayMax: number | null
}

/**
 * Where our calendar and the recommendation disagree, night by night.
 *
 * `signals()` already reports the MEDIAN of each, which answers "are we high"
 * but not "on how many nights, and by how much". A recommendation needs the
 * count: moving one night is a rounding error and moving twenty-two is a
 * decision.
 *
 * `min_stay` and `unbookable` have been archived per night since the first
 * PriceLabs pass and read by nothing. A minimum stay is only assessable against
 * what guests actually book, which is why the realised nights come from
 * `demandShape` and the comparison happens where both are in hand.
 */
export async function priceGap(
  client: PoolClient, tolerance = 0.05,
): Promise<Map<string, PriceGap>> {
  const { rows } = await client.query<{
    entity_id: string, nights: number, above: number, below: number,
    ours: string | null, recommended: string | null, currency: string | null,
    min_stay_max: string | null
  }>(`
    with asof as (
      select entity_id, max(as_of_date) as d
        from snapshot where metric = 'price_recommended' group by entity_id
    ),
    nightly as (
      select s.entity_id, s.stay_date,
             max(s.value) filter (where s.metric = 'price_current')     as ours,
             max(s.value) filter (where s.metric = 'price_recommended') as rec,
             max(s.value) filter (where s.metric = 'min_stay')          as min_stay,
             max(s.currency) as currency
        from snapshot s
        join asof a on a.entity_id = s.entity_id and s.as_of_date = a.d
       where s.metric in ('price_current', 'price_recommended', 'min_stay')
         and s.stay_date >= a.d and s.stay_date < a.d + 30
       group by s.entity_id, s.stay_date
    )
    select entity_id::text as entity_id,
           count(*) filter (where ours is not null and rec is not null and rec > 0
             and abs(ours - rec) / rec > $1)::int as nights,
           count(*) filter (where ours is not null and rec is not null and rec > 0
             and (ours - rec) / rec > $1)::int as above,
           count(*) filter (where ours is not null and rec is not null and rec > 0
             and (rec - ours) / rec > $1)::int as below,
           percentile_cont(0.5) within group (order by ours)::text as ours,
           percentile_cont(0.5) within group (order by rec)::text as recommended,
           max(currency) as currency,
           max(min_stay)::text as min_stay_max
      from nightly
     group by entity_id`, [tolerance])
  const num = (v: string | null) => v === null ? null : Number(v)
  return new Map(rows.map(r => [r.entity_id, {
    nights: r.nights, above: r.above, below: r.below,
    ours: num(r.ours), recommended: num(r.recommended), currency: r.currency,
    // Filled in by the caller, which is the only place the realised stay length
    // is also in hand. A minimum stay compared against nothing is not a finding.
    minStayOver: 0, minStayMax: num(r.min_stay_max),
  }]))
}
