/**
 * The action derivation. No database, no provider — pure judgements.
 *
 * The property worth protecting above all others: A PRICE ACTION IS HELD WHEN THE
 * ROOM IS NOT BEING SEEN. That rule is the whole difference between this and a
 * pricing tool. A room nobody opens does not have a price problem, and proposing
 * a cut would spend margin on something a cut cannot fix — while the reader,
 * seeing a confident price recommendation, would never look further.
 *
 * The second: a held action stays VISIBLE with its gate named. Hiding it would
 * read as "no price case here", which is a different and wrong claim.
 */
import { actionsFor, type ActionInput, type ActionStrings } from './dashboard/actions.js'
import type { Row, Signals, PriceGap, DemandShape, Promotion, CohortStanding }
  from './dashboard/query.js'

let fails = 0
const check = (n: string, ok: boolean, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? '  — ' + extra : ''}`); if (!ok) fails++
}

const t: ActionStrings = {
  money: (v, cur) => `${cur ?? 'CHF'} ${v}`,
  nights: n => `${n} nights of the next 30`,
  nightsPlain: n => `${n} nights`,
  priceAbove: (a, of) => `above on ${a} of ${of}`,
  priceBelow: (b, of) => `below on ${b} of ${of}`,
  minStayScope: 'on the nights that carry it',
  minStayBecause: (b, m, p) => `${b} bookings, median ${m}, p75 ${p}`,
  leverOn: 'on', leverOff: 'off', leverAbsent: 'not offered',
  leverName: k => k, leverBecause: (on, of) => `${on} of ${of} run it`,
  contentScope: 'no source connected', contentBecause: 'no content source',
}

const row = (over: Partial<Row> = {}): Row => ({
  entityId: 'e1', label: 'Room', market: 'bali', band: '2BR', bandBasis: 'bedrooms', units: null, group: null,
  contract: null, inHoldout: false, atStake: 1089, bandLow: null, bandHigh: null,
  currency: 'CHF', findings: 1, worstSeverity: 'high', firstFailing: null,
  headline: null, worstFindingId: null, ...over,
})
const gap = (over: Partial<PriceGap> = {}): PriceGap => ({
  nights: 22, above: 22, below: 0, ours: 180, recommended: 165, currency: 'CHF',
  minStayOver: 0, minStayMax: null, ...over,
})
const demand = (over: Partial<DemandShape> = {}): DemandShape => ({
  leadMedian: 34, leadP25: 8, leadP75: 96, nightsMedian: 3, nightsP75: 5,
  bookings: 22, origins: [], ...over,
})
const seen = (impressions: number, views: number): Signals['funnelBooking'] =>
  ({ axis: 'trailing', impressions, views, conversions: 2, nights: 0 })
const standing = (viewRateMedian: number | null): CohortStanding =>
  ({ better: 4, of: 12, viewRateMedian, bookRateMedian: 0.02 })

const base = (over: Partial<ActionInput> = {}): ActionInput => ({
  row: row(), sig: undefined, gap: gap(), demand: demand(),
  promos: [], coverage: [], cohort: undefined, ...over,
})

/* ------------------------------------------------ 1 · the rule that matters */

const healthy = actionsFor(base({
  sig: { ...({} as Signals), funnelBooking: seen(10_000, 150), funnelAirbnb: null },
  cohort: { booking: standing(0.012), airbnb: null },
}), t)
const price = healthy.find(a => a.lever === 'price')!
// 150/10000 = 1.5%, median 1.2% — seen and opened, so the price case stands.
check('a room that IS being opened gets its price action, unblocked',
      price.blockedBy === null, String(price.blockedBy))
check('and the action names a from and a to, not "consider adjusting"',
      price.from === 'CHF 180' && price.to === 'CHF 165',
      `${price.from} → ${price.to}`)
check('with the scope, because moving one night and moving 22 are different decisions',
      price.scope.includes('22'))
check('and the money only from the finding, never estimated here', price.worth === 1089)

const dark = actionsFor(base({
  // 40/10000 = 0.4% against a median of 1.2% — a third of the cohort's rate.
  sig: { ...({} as Signals), funnelBooking: seen(10_000, 40), funnelAirbnb: null },
  cohort: { booking: standing(0.012), airbnb: null },
}), t)
const held = dark.find(a => a.lever === 'price')!
check('a room nobody OPENS has its price action held, not proposed',
      held.blockedBy === 'ctr', String(held.blockedBy))
// Held, not hidden. Removing it would read as "no price case here".
check('but the held action is still present, with its gate named',
      dark.some(a => a.lever === 'price'))

const noCohort = actionsFor(base({
  sig: { ...({} as Signals), funnelBooking: seen(10_000, 40), funnelAirbnb: null },
  cohort: { booking: standing(null), airbnb: null },
}), t)
// No median means no yardstick. Blocking on a comparison we cannot make would be
// as wrong as ignoring one we can.
check('with no cohort median there is no gate to fail, so nothing is held',
      noCohort.find(a => a.lever === 'price')!.blockedBy === null)

/* --------------------------------------------------------- 2 · minimum stay */

const minStay = actionsFor(base({ gap: gap({ minStayMax: 7 }) }), t).find(a => a.lever === 'min_stay')
check('a minimum stay above what guests actually book becomes an action',
      minStay?.from === '7 nights' && minStay?.to === '3 nights',
      `${minStay?.from} → ${minStay?.to}`)
const fitting = actionsFor(base({ gap: gap({ minStayMax: 4 }) }), t)
check('a minimum stay inside the realised spread is left alone',
      !fitting.some(a => a.lever === 'min_stay'))
// A distribution needs a population.
const thin = actionsFor(base({
  gap: gap({ minStayMax: 7 }), demand: demand({ bookings: 3 }),
}), t)
check('three bookings are not a distribution, so no minimum-stay claim is made',
      !thin.some(a => a.lever === 'min_stay'))
const noHistory = actionsFor(base({ gap: gap({ minStayMax: 7 }), demand: undefined }), t)
check('and with no realised bookings at all, none either',
      !noHistory.some(a => a.lever === 'min_stay'))

/* -------------------------------------------------------------- 3 · levers */

const coverage = [
  { kind: 'MOBILE_RATE', on: 31, of: 41 },
  { kind: 'SECRET_DEAL', on: 12, of: 41 },
]
const promos: Promotion[] = [
  { kind: 'MOBILE_RATE', active: false, discountPct: 10, endsOn: null,
    family: null, deactivatedAt: null },
]
const levers = actionsFor(base({ coverage, promos }), t)
  .filter(a => a.lever === 'discount')
check('a lever the majority runs and this room does not becomes one action',
      levers.length === 1 && levers[0]!.scope === 'MOBILE_RATE',
      levers.map(l => l.scope).join(','))
check('and it counts the crowd rather than asserting it',
      levers[0]!.because.includes('31 of 41'))
// A minority lever is not a case. Twelve of forty-one running something is not
// evidence that the other twenty-nine are wrong.
check('a lever only a minority runs produces nothing',
      !levers.some(l => l.scope === 'SECRET_DEAL'))
const already = actionsFor(base({
  coverage,
  promos: [{ kind: 'MOBILE_RATE', active: true, discountPct: 10, endsOn: null,
             family: null, deactivatedAt: null }],
}), t).filter(a => a.lever === 'discount')
check('a lever already switched on is not proposed again', already.length === 0)

/* ------------------------------------------------------------- 4 · content */

const all = actionsFor(base(), t)
const content = all.find(a => a.lever === 'content')!
// The named absence. Generic copy advice would be the one thing worse than
// silence: it would look like a finding.
check('text and photos appear as a named absence, not as generic advice',
      content.from === null && content.to === null
      && content.because.includes('no content source'), '')
check('and they sort last, so they never head the list',
      all[all.length - 1]!.lever === 'content')
check('the action list is ranked, price first',
      all[0]!.lever === 'price', all.map(a => a.lever).join(','))

/* ------------------------------------------------------- 5 · nothing to say */

const quiet = actionsFor(base({ gap: undefined, demand: undefined }), t)
check('with no calendar and no history, only the named absence remains',
      quiet.length === 1 && quiet[0]!.lever === 'content',
      quiet.map(a => a.lever).join(','))

console.log(`\n${fails === 0 ? 'all green' : fails + ' FAILING'}`)
process.exit(fails ? 1 : 0)
