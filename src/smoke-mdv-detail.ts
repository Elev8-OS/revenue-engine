/**
 * The fields two already-paid-for calls were carrying, against a provider whose
 * payload matches the live shape export.
 *
 * The judgements worth protecting:
 *
 *   · ELIGIBLE IS NOT ACTIVE. `is_eligible: true, is_enabled: false` is a lever
 *     the channel is offering that nobody has taken — a different fact from "off",
 *     which is a decision someone made. A single boolean could never say that, and
 *     it is the cheapest action list on the account.
 *   · The COMPARABLE-SET ADR arrives here. `adr_booked_comps` is the one number a
 *     compset endpoint was mainly wanted for, and it has been on every import.
 *   · A NEGATIVE guest target survives. Everywhere else in this codebase a
 *     negative number is a sentinel; here it means we are subsidising the guest
 *     price, and refusing it would silently drop a real cost.
 *   · The promotion window is read from the NESTED path, because I recorded in a
 *     migration comment that this payload has no start or end date. It has both,
 *     four levels down.
 */
import { createServer } from 'node:http'
import { Pool } from 'pg'
import { MdvClient, seedRefreshToken } from './sources/mdv/client.js'
import { importDetail, CHART_METRICS } from './sources/mdv/detail.js'
import { importReputation } from './sources/mdv/reputation.js'
import { RateBudget } from './scheduler/budget.js'

const pool = new Pool({ connectionString: process.env.DATABASE_URL! })
let fails = 0
const check = (n: string, ok: boolean, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? '  — ' + extra : ''}`); if (!ok) fails++
}

const port = 4599
const srv = createServer((req, res) => {
  const path = (req.url ?? '').split('?')[0]!
  const json = (o: unknown) => {
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o))
  }
  if (path === '/oauth/token') {
    return json({ access_token: 'at', refresh_token: `r${Math.random()}`, expires_in: 3600 })
  }
  if (path === '/api/v1/booking/properties/') {
    return json({ properties: [
      { property_id: 701, name: 'Basel Flat', status: 'active',
        commission_pct: 15, guest_target_pct: -4.5, pms_markup_pct: 3,
        data_as_of: '2026-08-27T01:00:00Z' },
      { property_id: 999, name: 'Unknown', status: 'active', commission_pct: 12 },
    ] })
  }
  if (path === '/api/v1/airbnb/listings/') {
    return json({ count: 1, results: [{
      listing_id: 'L700', listing_title: 'Canggu Villa', active: true,
      needs_setup: false, guest_target_pct: -2, airbnb_pms_markup: 4,
      rating_average: 4.87, review_count: 63, data_as_of: '2026-08-27T01:00:00Z',
      image_url: 'https://example.invalid/photo.jpg',
      chart_metrics: {
        search_views: 1805, property_views: 96, booking_conversions: 4,
        search_to_view_rate: 5.3, view_to_booking_rate: 4.2,
        fp_search_impressions: 210, occupancy_rate: 61, cancellation_rate: 3.5,
        booking_window: 34, adr_booked: 148, adr_booked_comps: 121,
        search_listing_conversion: 1.1, listing_booking_conversion: 0.9,
      },
      promotions: [
        { promotion_id: 'p1', promotion_type: 'WEEKLY_DISCOUNT', is_active: true,
          price_factor: 0.9, price_change: -12, start_date: '2026-09-01',
          end_date: '2026-09-30', lead_days: null, min_length_of_stay: 7 },
      ],
      eligible_promotions: [
        { type: 'EARLY_BIRD', attributes: [
          { uuid: 'e1', priceFactor: 0.85, startDate: '2026-10-01',
            endDate: '2026-12-20', promotionFactorType: 'PERCENT', audienceType: null }] },
      ],
      // Offered by the channel, not taken. The whole point of the pair.
      mobile_only: { is_eligible: true, is_enabled: false, percentage: null },
      loyalty_data: { is_eligible: true, is_enabled: true, percentage: 5 },
      // Not offered at all: must not appear as an unclaimed lever.
      new_listing_promotion: { is_eligible: false, is_enabled: false, percentage: null },
    }] })
  }
  if (path === '/api/v1/booking/promotions/') {
    return json({ results: [{
      property_id: 701, id: 'bp1', promotion_type: 'BASIC_DEAL', is_active: true,
      discount: 10, family: 'DEAL', category_id: 'c1', deactivated_at: null,
      data_as_of: '2026-08-27T01:00:00Z',
      // Nested, four levels down — the shape I had recorded as absent.
      attributes: { bookDates: { dates: { from: '2026-09-05', to: '2026-09-25' } },
                    stayDates: { dates: null } },
    }] })
  }
  if (path === '/api/v1/booking/reviews/') return json({ results: [] })
  if (path === '/api/v1/airbnb/reviews/') return json({ results: [] })
  res.writeHead(404); res.end()
})
await new Promise<void>(r => srv.listen(port, r))

const c = await pool.connect()
await c.query('delete from snapshot'); await c.query('delete from channel_promotion')
await c.query('delete from channel_terms')
await c.query('delete from entity_alias'); await c.query('delete from entity')
await c.query('delete from oauth_token'); await c.query('truncate oauth_event')
await seedRefreshToken(c, { clientId: 'cid', refreshToken: 'seed' })
const mk = async (label: string) => (await c.query<{ id: string }>(
  `insert into entity (label, market, active) values ($1, 'ch', true) returning id::text`,
  [label])).rows[0]!.id
const eB = await mk('Basel Flat')
const eA = await mk('Canggu Villa')
await c.query(`insert into entity_alias (entity_id, source, kind, external_id, matched_by)
  values ($1, 'mdv_booking', 'property', '701', 'test')`, [eB])
await c.query(`insert into entity_alias (entity_id, source, kind, external_id, matched_by)
  values ($1, 'mdv_airbnb', 'listing', 'L700', 'test')`, [eA])

const mdv = new MdvClient({
  clientId: 'cid', clientSecret: 'sec',
  base: `http://127.0.0.1:${port}/api/v1`,
  tokenUrl: `http://127.0.0.1:${port}/oauth/token`,
  budget: new RateBudget(), sleep: async () => {},
})
const report = await importDetail(c, mdv)

/* ------------------------------------------------- 1 · the commission stack */

const terms = await c.query<{
  commission_pct: string | null, guest_target_pct: string | null, pms_markup_pct: string | null
}>(`select commission_pct::text, guest_target_pct::text, pms_markup_pct::text
      from channel_terms where entity_id = $1 and source = 'mdv_booking'`, [eB])
check('the commission stack is stored from a call we were already making',
      terms.rows.length === 1 && Number(terms.rows[0]!.commission_pct) === 15
      && Number(terms.rows[0]!.pms_markup_pct) === 3, JSON.stringify(terms.rows))
// The one place a negative number is a measurement and not a sentinel.
check('a NEGATIVE guest target survives, because it means we subsidise the price',
      Number(terms.rows[0]!.guest_target_pct) === -4.5,
      String(terms.rows[0]!.guest_target_pct))
check('and an id matching nothing is reported rather than invented',
      report.endpoints[0]!.unresolvedIds.includes('999'),
      report.endpoints[0]!.unresolvedIds.join(','))

/* ------------------------------------------------------ 2 · the Airbnb funnel */

const m = await c.query<{ metric: string, value: string }>(
  `select metric, value::text from snapshot where entity_id = $1 order by metric`, [eA])
const by = new Map(m.rows.map(r => [r.metric, Number(r.value)]))
check('the whole Airbnb funnel arrives from the listing call',
      by.get('funnel_airbnb_impressions_trailing') === 1805
      && by.get('funnel_airbnb_views_trailing') === 96
      && by.get('funnel_airbnb_conversions_trailing') === 4,
      [...by.keys()].join(','))
// The number a compset endpoint was mainly wanted for.
check('and so does the comparable-set ADR, which we went looking for elsewhere',
      by.get('adr_booked_comps_airbnb_trailing') === 121
      && by.get('adr_booked_airbnb_trailing') === 148, '')
check('every mapped chart metric that was present is stored',
      Object.values(CHART_METRICS).every(name => by.has(`${name}_trailing`)),
      Object.values(CHART_METRICS).filter(n => !by.has(`${n}_trailing`)).join(','))
check('the review standing comes from the same call, not a second one',
      by.get('reviews_airbnb_score') === 4.87 && by.get('reviews_airbnb_count') === 63, '')

/* --------------------------------------------------- 3 · eligible is not off */

const lv = await c.query<{ kind: string, active: boolean | null, eligible: boolean | null,
                           min_los: number | null, price_factor: string | null }>(
  `select kind, active, eligible, min_los, price_factor::text from channel_promotion
    where entity_id = $1 order by kind`, [eA])
const lvBy = new Map(lv.rows.map(r => [r.kind, r]))
check('a promotion the listing runs is stored active, with its factor and its stay rule',
      lvBy.get('WEEKLY_DISCOUNT')?.active === true
      && Number(lvBy.get('WEEKLY_DISCOUNT')?.price_factor) === 0.9
      && lvBy.get('WEEKLY_DISCOUNT')?.min_los === 7, JSON.stringify(lv.rows))
// The distinction the whole table exists for.
check('a lever the channel OFFERS and nobody has taken is eligible with no switch',
      lvBy.get('EARLY_BIRD')?.eligible === true
      && lvBy.get('EARLY_BIRD')?.active === null,
      JSON.stringify(lvBy.get('EARLY_BIRD')))
check('a programme offered and switched off is eligible AND false — not the same thing',
      lvBy.get('MOBILE_ONLY')?.eligible === true
      && lvBy.get('MOBILE_ONLY')?.active === false,
      JSON.stringify(lvBy.get('MOBILE_ONLY')))
check('a programme offered and switched on is both true',
      lvBy.get('LOYALTY_DATA')?.eligible === true
      && lvBy.get('LOYALTY_DATA')?.active === true, '')
// Not offered is not an unclaimed opportunity, so it must not appear at all.
check('a programme the channel does NOT offer produces no row',
      !lvBy.has('NEW_LISTING_PROMOTION'), [...lvBy.keys()].join(','))
check('the pass counts what it wrote where, so a silent zero is impossible to miss',
      report.endpoints[1]!.eligible > 0 && report.endpoints[1]!.levers > 0
      && report.endpoints[1]!.metrics > 0,
      JSON.stringify(report.endpoints[1]))

/* ------------------------------------------ 4 · the window I said did not exist */

const rep = await importReputation(c, mdv)
const promo = rep.endpoints.find(e => e.path === '/booking/promotions/')!
const win = await c.query<{ starts_on: Date | null, ends_on: Date | null }>(
  `select starts_on, ends_on from channel_promotion
    where entity_id = $1 and kind = 'BASIC_DEAL'`, [eB])
check('the promotion window is found four levels down, where I had recorded none exists',
      win.rows[0]?.starts_on?.toISOString().slice(0, 10) === '2026-09-05'
      && win.rows[0]?.ends_on?.toISOString().slice(0, 10) === '2026-09-25',
      JSON.stringify(win.rows))
check('and the pass says WHICH path answered, so the next account is a one-line change',
      /attributes\.bookDates\.dates\.from/.test(promo.note), promo.note)

check('no entity was created by either pass',
      (await c.query<{ n: number }>(`select count(*)::int n from entity`)).rows[0]!.n === 2)

srv.close(); c.release(); await pool.end()
console.log(`\n${fails === 0 ? 'all green' : fails + ' FAILING'}`)
process.exit(fails ? 1 : 0)
