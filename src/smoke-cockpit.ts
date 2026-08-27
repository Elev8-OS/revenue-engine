/**
 * The dashboard's aggregate queries, against a real database.
 *
 * WHY THIS FILE EXISTS. `cockpit()` is eight separate SQL queries and, until
 * now, not one of them had ever been executed by a test. The only coverage was
 * `smoke-render.ts`, which hands the renderer a hand-written object — so a
 * broken query, a wrong parameter index or a numeric/text mismatch would first
 * be discovered by a reader loading the page. This project has already had one
 * outage of exactly that shape: `/import` returning the word "error" because a
 * template read a field that was a string, not an object.
 *
 * WHAT IT PINS DOWN.
 *
 *   1. ALL EIGHT QUERIES RUN. Half the value of this file is that it executes
 *      them at all. Postgres refuses `numeric / text` and refuses a parameter
 *      index that does not exist, and both of those are silent in TypeScript.
 *
 *   2. THE GROUP NARROWS EVERY ONE OF THEM. A group filter that narrows the
 *      table while the hero keeps the account's total money is not a partial
 *      feature, it is a false statement: the reader picks one operator's set and
 *      reads somebody else's number. The checks below compare two groups against
 *      hand-computed figures, so a query that forgot to join the scope shows up
 *      as a number that is too big rather than as nothing at all.
 *
 *   3. AN EMPTY SCOPE PRODUCES NULLS, NOT ZEROS. A group with no archived
 *      nights has no RevPAR. Zero would read as "this group earns nothing per
 *      night", which is a claim; null reads as "not measured", which is true.
 */
import { Pool } from 'pg'
import { cockpit, rankTimeline, searchStanding } from './dashboard/query.js'

const pool = new Pool({ connectionString: process.env.DATABASE_URL! })
let fails = 0
const check = (n: string, ok: boolean, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? '  — ' + extra : ''}`); if (!ok) fails++
}

const c = await pool.connect()
await c.query('begin')

/**
 * A BASELINE, not an assumption of an empty database.
 *
 * The first version of this file asserted `rooms === 4` and failed with 7,
 * because the suite before it had left rows behind. Asserting an absolute total
 * makes a test depend on the order the suites run in — so the unscoped path is
 * checked as a DELTA instead. The group checks below need no baseline: a group
 * name nothing else uses is scope enough.
 */
const base = await cockpit(c, 'revenue')

/* ------------------------------------------------------------- the fixture */

// Two groups, deliberately unequal in every measure, so a missing scope join
// cannot produce the right answer by coincidence.
const { rows: made } = await c.query<{ id: string }>(`
  insert into entity (label, market, band, band_basis, pms_group, pms_group_id)
  values ('Z1', 'ch',   '2BR', 'bedrooms', 'Zermattstays', 126321),
         ('Z2', 'ch',   '1BR', 'bedrooms', 'Zermattstays', 126321),
         ('M1', 'ch',   '3BR', 'bedrooms', 'MiHome',       120104),
         ('U1', 'bali', null,  null,        null,          null)
  returning id`)
const [z1, z2, m1, u1] = made.map(r => r.id) as [string, string, string, string]

const TODAY = '2026-08-27'
/**
 * Occupancy and RevPAR are weighted by archived nights, so the fixture has to
 * archive nights too — `price_recommended` per stay date is what the weight is
 * counted from. Two nights for Z1, one for Z2, four for M1.
 */
const put = async (id: string, metric: string, value: number, stay: string | null = null) =>
  c.query(
    `insert into snapshot (entity_id, source, metric, stay_date, as_of_date, value)
     values ($1, 'pricelabs', $2, coalesce($3::date, $4::date), $4::date, $5)
     on conflict (entity_id, metric, stay_date, as_of_date) do update set value = excluded.value`,
    [id, metric, stay, TODAY, value])

for (const [id, nights, occ, revpar] of
     [[z1, 2, 40, 100], [z2, 1, 20, 60], [m1, 4, 80, 200]] as const) {
  await put(id, 'occupancy_next_30d', occ)
  await put(id, 'revpar_next_30d', revpar)
  await put(id, 'market_occupancy_next_30d', 50)
  for (let i = 0; i < nights; i++) {
    const d = new Date(`${TODAY}T00:00:00Z`)
    d.setUTCDate(d.getUTCDate() + i)
    await put(id, 'price_recommended', 150, d.toISOString().slice(0, 10))
    await put(id, 'unbookable', i === 0 ? 1 : 0, d.toISOString().slice(0, 10))
  }
}
// The ungrouped room carries a wildly different figure. If it leaks into a group
// it will be obvious rather than marginal.
await put(u1, 'occupancy_next_30d', 5)
await put(u1, 'revpar_next_30d', 1000)
for (let i = 0; i < 3; i++) {
  const d = new Date(`${TODAY}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + i)
  await put(u1, 'price_recommended', 150, d.toISOString().slice(0, 10))
}

await c.query(
  `insert into finding (entity_id, check_key, check_version, severity, headline,
                        amount_revenue, amount_margin, currency, confidence, state)
   values ($1, 'price_gap', 1, 'high',   'h', 500, 400, 'CHF', 0.9, 'open'),
          ($2, 'price_gap', 1, 'medium', 'h', 300, 200, 'CHF', 0.9, 'open'),
          ($3, 'price_gap', 1, 'medium', 'h', 900, 700, 'CHF', 0.9, 'open')`,
  [z1, z2, m1])

await c.query(
  `insert into not_assessable (entity_id, as_of, reason)
   values ($1, $2::date, 'no market data')`, [m1, TODAY])

/* ------------------------------------------------- 1 · the whole portfolio */

const all = await cockpit(c, 'revenue')
check('all eight queries execute against a real database', true)
check('the whole portfolio counts every grouped AND ungrouped room',
      all.rooms - base.rooms === 4, `${base.rooms} → ${all.rooms}`)
check('and its money grows by every open finding added',
      (all.atStake ?? 0) - (base.atStake ?? 0) === 1700,
      `${base.atStake} → ${all.atStake}`)

/* ------------------------------------------------------ 2 · one group only */

const z = await cockpit(c, 'revenue', 'Zermattstays')
check('a group counts only its own rooms', z.rooms === 2, String(z.rooms))
// THE CHECK THE HERO DEPENDS ON. 500 + 300, not 1700.
check('and only its own money reaches the hero',
      z.atStake === 800, String(z.atStake))
// Nights-weighted: (40×2 + 20×1) / 3 = 33.33, not the plain mean of 30.
check('occupancy stays weighted by archived nights inside the group',
      z.occupancy.value !== null && Math.abs(z.occupancy.value - 100 / 3) < 0.01,
      String(z.occupancy.value))
check('the night count it rests on is the group\'s, not the account\'s',
      z.occupancy.basis === 3, String(z.occupancy.basis))
// (100×2 + 60×1) / 3 = 86.67
check('RevPAR narrows the same way',
      z.revpar.value !== null && Math.abs(z.revpar.value - 260 / 3) < 0.01,
      String(z.revpar.value))
check('blocked nights are counted inside the group only',
      z.blocked.basis === 3, String(z.blocked.basis))
check('and a not-assessable room in another group is not counted here',
      z.notAssessable === 0, String(z.notAssessable))

const m = await cockpit(c, 'revenue', 'MiHome')
check('the other group is different in every measure',
      m.rooms === 1 && m.atStake === 900 && m.occupancy.value === 80
        && m.occupancy.basis === 4,
      JSON.stringify({ rooms: m.rooms, atStake: m.atStake, occ: m.occupancy.value }))
check('and it sees its own not-assessable room', m.notAssessable === 1)

/* ----------------------------------------- 3 · the basis follows the basis */

const margin = await cockpit(c, 'margin', 'Zermattstays')
check('switching to margin changes the money and keeps the group',
      margin.atStake === 600, String(margin.atStake))

/* --------------------------------------------- 4 · a group with no numbers */

await c.query(
  `insert into entity (label, market, pms_group) values ('E1', 'ch', 'Empty Set')`)
const empty = await cockpit(c, 'revenue', 'Empty Set')
check('a group with nothing archived reports NULL, never a confident zero',
      empty.revpar.value === null && empty.occupancy.value === null
        && empty.atStake === null,
      JSON.stringify({ revpar: empty.revpar.value, occ: empty.occupancy.value,
                       atStake: empty.atStake }))
check('and every tile in it says "not measured" rather than passing a verdict',
      empty.revpar.verdict === 'unknown' && empty.occupancy.verdict === 'unknown', '')
check('its night count is zero, which is a count and not a measurement',
      empty.occupancy.basis === 0, String(empty.occupancy.basis))

/* ------------------------------------- 5 · a name nobody uses is not a leak */

// The server drops an unknown group before it reaches here, but if that guard
// ever moves, this must fail closed — showing the whole account for a typo is
// how a filter starts lying.
const bogus = await cockpit(c, 'revenue', 'No Such Group')
check('an unknown group shows nothing, not everything',
      bogus.rooms === 0 && bogus.atStake === null,
      JSON.stringify({ rooms: bogus.rooms, atStake: bogus.atStake }))

/* ============================================ rank and search visibility == */

/**
 * A rank is stored SIGNED for one reason: `-7` means seven places better, and a
 * reader that refuses negatives as provider sentinels would drop exactly the
 * good news. These checks pin down that the sign survives the round trip through
 * Postgres and back.
 */
await put(z1, 'perf_booking_rank', 5)
await put(z1, 'perf_booking_rank_prior', 9)
await c.query(
  `insert into snapshot (entity_id, source, metric, stay_date, as_of_date, value)
   values ($1, 'mdv_booking', 'perf_booking_rank_change_since_first',
           $2::date, $2::date, -7)
   on conflict (entity_id, metric, stay_date, as_of_date) do update set value = excluded.value`,
  [z1, TODAY])
await put(z1, 'funnel_airbnb_position_trailing', 12)
await put(z1, 'funnel_airbnb_first_page_impressions_trailing', 410)
await put(z1, 'funnel_airbnb_impressions_trailing', 8200)
// Z2 gets a prior and a change but NO current rank: a movement with nothing to
// attach it to is not a position, and must not become one.
await put(z2, 'perf_booking_rank_prior', 14)

const st = await searchStanding(c)
check('a rank comes back with its channel and its previous value',
      st.get(z1)?.bookingRank?.rank === 5 && st.get(z1)?.bookingRank?.prior === 9,
      JSON.stringify(st.get(z1)?.bookingRank))
check('and the improvement survives as a NEGATIVE number, not as an absolute',
      st.get(z1)?.bookingRank?.sinceFirst === -7,
      String(st.get(z1)?.bookingRank?.sinceFirst))
check('a prior with no current rank is not turned into a standing',
      st.get(z2)?.bookingRank === null, JSON.stringify(st.get(z2)))
check('the trailing spelling of the Airbnb position is accepted',
      st.get(z1)?.airbnbPosition === 12, String(st.get(z1)?.airbnbPosition))
check('and the first-page count arrives with the total it came out of',
      st.get(z1)?.firstPage === 410 && st.get(z1)?.airbnbImpressions === 8200,
      JSON.stringify(st.get(z1)))

/**
 * The account-level percentile. Two rows are a series; a row whose unit is not
 * `percentile` is stored and NOT charted, because a number whose scale is
 * unstated cannot be put on an axis.
 */
const ins = async (source: string, label: string, value: number, unit = 'percentile') =>
  c.query(
    `insert into channel_insight (source, section, label, value, unit, as_of_date)
     values ($1, 'rank_timeline', $2, $3, $4, $5::date)
     on conflict do nothing`, [source, label, value, unit, TODAY])
/**
 * Dates far in the future, deliberately.
 *
 * An earlier version of these three checks asserted the WHOLE series and failed,
 * because `smoke-mdv-performance` had already written rows for the same channel
 * on nearby dates. `channel_insight` is keyed on (source, section, label,
 * as_of_date), so the only collision-proof fixture is a label nothing else uses.
 */
const D1 = '2099-01-01', D2 = '2099-01-02', DX = '2099-01-03'
await ins('mdv_booking', D1, 41)
await ins('mdv_booking', D2, 63)
await ins('mdv_booking', DX, 55, 'undecidable')

const tl = await rankTimeline(c)
const mine = (tl.get('mdv_booking') ?? []).filter(p => p.date.startsWith('2099'))
check('the percentile series comes back per channel, in date order',
      mine.map(p => `${p.date}:${p.percentile}`).join(',')
        === `${D1}:41,${D2}:63`, JSON.stringify(mine))
// A number whose scale is unstated cannot be put on an axis. It stays stored.
check('a reading whose unit is undecidable is never charted',
      !mine.some(p => p.date === DX), JSON.stringify(mine))
const stored = await c.query<{ n: number }>(
  `select count(*)::int n from channel_insight
    where section = 'rank_timeline' and label = $1 and unit = 'undecidable'`, [DX])
check('but it is still in the archive, so nothing was thrown away',
      stored.rows[0]?.n === 1, String(stored.rows[0]?.n))
// The group cannot narrow a provider-side aggregate, and the query must not
// pretend otherwise by returning an empty set for a valid group.
check('a group does not silently empty the account-level series',
      ((await rankTimeline(c, 'Zermattstays')).get('mdv_booking') ?? [])
        .filter(p => p.date.startsWith('2099')).length === 2, '')

await c.query('rollback')
c.release()
await pool.end()
console.log(fails ? `\n${fails} FAILED` : '\nall green')
if (fails) process.exit(1)
