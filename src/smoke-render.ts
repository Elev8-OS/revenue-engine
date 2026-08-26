/**
 * The dashboard markup, asserted where a human would otherwise have to notice.
 *
 * Three things here have already gone wrong once, and none of them fails loudly:
 *
 *   1. THE SCROLL. Opening a row was a full navigation with no fragment, so the
 *      browser landed at the top of the page and the reader had to find their
 *      property again. Nothing errors; the page is simply unusable at sixty
 *      rooms, and a rendered page looks fine in a diff.
 *   2. A NUMBER DRAWN THAT WAS NOT MEASURED. The potential graphic must not
 *      invent a market marker, a band or a zero.
 *   3. HALF A TRANSLATION. Every legend term has to exist in both languages, or
 *      one office reads a glossary and the other reads English.
 */
import { renderDashboard, pricePosition, type DashboardData } from './dashboard/render.js'
import type { Row, Signals } from './dashboard/query.js'
import { renderShapesText } from './sources/elev8/shape.js'
import { en, id, LANGS, stringsFor } from './i18n.js'

let fails = 0
const check = (n: string, ok: boolean, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? '  — ' + extra : ''}`); if (!ok) fails++
}

const ID = '11111111-2222-3333-4444-555555555555'
const row = (over: Partial<Row> = {}): Row => ({
  entityId: ID, label: 'ID - APT 2', market: 'bali', band: '2BR', bandBasis: 'bedrooms',
  contract: null, inHoldout: false, atStake: 1089, bandLow: 1089, bandHigh: 1188,
  currency: 'CHF', findings: 1, worstSeverity: 'medium', firstFailing: 'price',
  headline: '22 points below the market.', worstFindingId: 'f-1', ...over,
})
const sig = (over: Partial<Signals> = {}): Signals => ({
  occupancy: 26, marketOccupancy: 48, mpi: 1.31, adr: null, marketAdr: null, revenue: 900,
  priceRecommended: 165, priceLive: 180, nights: 30, currency: 'CHF',
  observedAt: null, asOf: '2026-08-25',
  nbhdP25: 60, nbhdP50: 80, nbhdP75: 98, nbhdP90: 136, nbhdListings: 155,
  // The default is a portfolio with NO funnel read yet, because that is the state
  // every listing was in for weeks and the page has to be right in it.
  adjustedOccupancy: null, revpar: null,
  stlyOccupancy: null, stlyAdr: null, stlyRevenue: null,
  occupancy7: null, occupancy90: null,
  funnelBooking: null, funnelAirbnb: null, ...over,
})
const data = (over: Partial<DashboardData> = {}): DashboardData => ({
  lang: 'en', basis: 'revenue', openId: null, rows: [row()],
  counts: { entities: 1, open: 1, critical: 0, high: 0 },
  // Empty by default: the page has to be right for a portfolio where none of
  // this has been read yet, which is where every listing starts.
  realised: new Map(), reviews: new Map(), promotions: new Map(),
  accountPromotions: [], cohorts: new Map(), leverCoverage: [],
  notAssessable: [], freshness: [], gate: [], evidence: [],
  signals: new Map([[ID, sig()]]), funnel: 'unread', demo: false, unprotected: false, ...over,
})

/* ------------------------------------------------------ 1 · the scroll position */

const closed = renderDashboard(data())
check('the row carries its own id', closed.includes(`id="row-${ID}"`))
check('and the link that opens it ends in that fragment',
      closed.includes(`open=${ID}#row-${ID}`),
      closed.slice(closed.indexOf('rowlink') - 200, closed.indexOf('rowlink')))

const open = renderDashboard(data({ openId: ID }))
/** The row's own link, as opposed to the language and basis links beside it. */
const rowHref = (html: string) =>
  /<a class="rowlink" href="([^"]*)"/.exec(html)?.[1] ?? ''
check('the link that CLOSES it keeps the fragment, so collapsing stays put',
      rowHref(open).endsWith(`#row-${ID}`) && !rowHref(open).includes('open='),
      rowHref(open))
// The language switch is a full navigation too, and it deliberately preserves
// the open row — so it has to preserve the anchor with it.
check('the language switch keeps the reader on the open row',
      open.includes(`lang=id#row-${ID}`), '')

/* ------------------------------------------------------ 2 · the potential graphic */

check('an opened row draws the picture', open.includes('<svg class="pot"'))
check('a closed row does not', !closed.includes('<svg class="pot"'))
check('ours and the market are both drawn', open.includes('>26%<') && open.includes('>48%<'))
check('the gap is named in points', open.includes('22 pp behind'))
// The apostrophe is the Swiss group separator that `en-CH` produces; the space
// before it is a non-breaking one, which is why only the digits are asserted.
check('the band is a bracket with both ends labelled',
      open.includes("1'089") && open.includes("1'188"))

const noMarket = renderDashboard(data({
  openId: ID, signals: new Map([[ID, sig({ marketOccupancy: null })]]) }))
check('with no market half, no market bar is invented',
      !noMarket.includes('>48%<') && !noMarket.includes('pp behind'))
check('but ours is still drawn, because it was measured', noMarket.includes('>26%<'))

const noMoney = renderDashboard(data({
  openId: ID, rows: [row({ atStake: null, bandLow: null, bandHigh: null })] }))
check('a room with no amount draws no money row rather than a zero',
      !noMoney.includes("1'089") && noMoney.includes('<svg class="pot"'))

const point = renderDashboard(data({
  openId: ID, rows: [row({ bandLow: 1089, bandHigh: 1089 })] }))
check('a point estimate draws no bracket, because there is no range to show',
      !point.includes('stroke-width="3"'))

const nothing = renderDashboard(data({
  openId: ID, rows: [row({ atStake: null, bandLow: null, bandHigh: null })],
  signals: new Map() }))
check('a room with nothing measured draws nothing at all',
      !nothing.includes('<svg class="pot"'))

/* ------------------------------------------------------ 3 · the legend, in both */

check('the legend is on the page', closed.includes('details class="legend"'))
check('every term is rendered', en.legend.every(t => closed.includes(t.term)))
check('the two languages define the same number of terms',
      en.legend.length === id.legend.length, `${en.legend.length} vs ${id.legend.length}`)
check('no term or definition is empty in either language',
      [...en.legend, ...id.legend].every(t => t.term.trim() && t.text.trim().length > 20))
check('and no Indonesian entry is just the English one',
      en.legend.every((t, i) => id.legend[i]!.text !== t.text))
for (const lang of LANGS) {
  const s = stringsFor(lang)
  const page = renderDashboard(data({ lang }))
  check(`${lang}: the glossary heading is translated`, page.includes(s.legendHeading))
}


/* ------------------------------------------------------ 4 · the micro layer */

// The block that answers "and what does that do to the price": our live price
// and the recommendation on one scale, against the quartiles of the same
// bedroom category in the same neighbourhood.
const micro = renderDashboard(data({ openId: ID }))
check('the price-position block is drawn', micro.includes('>P25<') && micro.includes('>P50<'))
check('both markers are there: what is live and what is proposed',
      micro.includes('live') && micro.includes('recommended'))
// The fixture is a room at CHF 180 live in a neighbourhood whose 1BR band tops
// out at 136 — which is what an MPI of 1.31 looks like from the other side.
check('the verdict names the boundary that was crossed, not a percentage',
      micro.includes('above the top tenth'), '')
check('and it says how many listings the band rests on',
      micro.includes('155 listings'))

check('below the bottom quarter', pricePosition(45, 60, 80, 98, 136) === 'belowP25')
check('lower half', pricePosition(70, 60, 80, 98, 136) === 'p25p50')
check('upper half', pricePosition(90, 60, 80, 98, 136) === 'p50p75')
check('top quarter', pricePosition(120, 60, 80, 98, 136) === 'p75p90')
check('above the top tenth', pricePosition(200, 60, 80, 98, 136) === 'aboveP90')
check('exactly on a boundary counts upward, so P25 is not "below P25"',
      pricePosition(60, 60, 80, 98, 136) === 'p25p50')
check('with no band at all there is no verdict to give',
      pricePosition(60, null, null, null, null) === null)

const noBand = renderDashboard(data({ openId: ID,
  signals: new Map([[ID, sig({ nbhdP25: null, nbhdP50: null, nbhdP75: null, nbhdP90: null,
                               nbhdListings: null })]]) }))
check('a room with no neighbourhood band draws no price-position block at all',
      !noBand.includes('>P50<'), '')

/* ------------------------------------------------------ 5 · the macro layer */

// Absent, and SAID to be absent. A blank space would read as "nothing to see";
// the sentence says why there is nothing and what would change it.
// The macro sentence is chosen by the MEASURED state, not written into a
// constant. The constant version said "whose grant is revoked" and rendered on
// every page load — so unlike the stored gate prose it did not even need a stale
// check run to be wrong; it was wrong the moment the grant came back.
check('the macro block explains the state it is actually in',
      micro.includes('Connected, not read') && micro.includes('guest-origin mix'),
      '')
check('and does NOT claim a revocation when nothing is revoked',
      !micro.includes('revoked'), '')
const revokedPage = renderDashboard(data({ openId: ID, funnel: 'grant_revoked' }))
check('a revoked grant is the one state that says revoked',
      revokedPage.includes('revoked') && revokedPage.includes('new authorisation'))
const stalePage = renderDashboard(data({ openId: ID, funnel: 'grant_stale' }))
check('a stale token says it is behind, and names the variable that fixes it',
      stalePage.includes('behind the chain')
      && stalePage.includes('MDV_SEED_REFRESH_TOKEN')
      && !stalePage.includes('revoked'), '')
for (const k of ['not_configured', 'grant_revoked', 'grant_stale', 'unread', 'read'] as const) {
  check(`${k}: the macro sentence exists in both languages`,
        en.macro[k].length > 40 && id.macro[k].length > 40 && en.macro[k] !== id.macro[k])
}

/* ------------------------------------------------ the shapes text export */

// This is the input to writing a mapper against eleven MDV endpoints, so the
// property under test is exactness: what the provider called a field must come
// out byte-identical. The two field names below differ by one character and are
// the exact class of mistake that reading a rendered page off a screenshot
// cannot catch.
const shaped = renderShapesText([
  { source: 'mdv', endpoint: 'GET /airbnb/ranking/', observedAt: new Date('2026-08-26T04:15:00Z'),
    sampleCount: 3, note: 'rows under results',
    shape: [
      { path: 'results[].search_to_view_rate', types: ['number'], filled: 3, total: 3 },
      { path: 'results[].listing_id', types: ['string'], filled: 3, total: 3 },
      { path: 'results[].impressions', types: ['number', 'null'], filled: 1, total: 3 },
    ] },
  { source: 'mdv', endpoint: 'GET /booking/pricing/', observedAt: new Date('2026-08-26T04:15:00Z'),
    sampleCount: 0, shape: [] },
], { source: 'mdv', now: new Date('2026-08-26T09:00:00Z') })

check('every recorded field name appears verbatim, unescaped and uncut',
      shaped.includes('results[].search_to_view_rate')
      && !shaped.includes('search_to_views_rate')
      && shaped.includes('results[].listing_id'), '')
check('the fill count travels with the name, because a field that exists and is empty is the failure mode',
      /impressions\s+number\|null\s+1\/3/.test(shaped), '')
check('the longest path sets the column, so nothing is truncated to fit',
      shaped.split('\n').every(l => l.length < 200)
      && shaped.includes('results[].impressions      '), '')
check('an endpoint that answered with nothing says so rather than being omitted',
      shaped.includes('GET /booking/pricing/')
      && shaped.includes('the response was empty'), '')
check('no shapes at all is a sentence, not an empty page',
      renderShapesText([], { source: 'mdv' }).includes('run an import first'))
// A shape is safe to keep BECAUSE it holds no values. If that ever stops being
// true this export is the page that leaks it, so the promise is asserted here.
check('the header states the rule that makes this page safe to copy',
      shaped.includes('values are never recorded'))

/* ------------------------------- what the archive already held, now on the page */

const full = renderDashboard(data({
  openId: ID,
  funnel: 'read',
  signals: new Map([[ID, sig({
    occupancy: 26, occupancy7: 12, occupancy90: 38,
    stlyOccupancy: 41, adjustedOccupancy: 22, revpar: 47,
    funnelBooking: { axis: 'trailing', impressions: 99_014, views: 743,
                     conversions: 12, nights: 0 },
  })]]),
  realised: new Map([[ID, {
    revenue: 18_400, nights: 96, commission: 2_760, commissionRate: 0.15,
    bookings: 22, currency: 'CHF',
    channels: [{ name: 'booking', revenue: 12_880, share: 0.7 },
               { name: 'airbnb', revenue: 5_520, share: 0.3 }],
  }]]),
  reviews: new Map([[ID, { booking: { score: 10, count: 1 }, airbnb: null }]]),
  // The nine deal types this account actually runs, taken from the live pass.
  promotions: new Map([[ID, [
    { kind: 'MOBILE_RATE', active: true, discountPct: 10, endsOn: null,
      family: 'RATE', deactivatedAt: null },
    { kind: 'SECRET_DEAL', active: null, discountPct: null, endsOn: null,
      family: 'DEAL', deactivatedAt: null },
    { kind: 'LAST_MINUTE_DEAL', active: false, discountPct: 15, endsOn: null,
      family: 'DEAL', deactivatedAt: '2026-08-01' },
  ]]]),
  accountPromotions: [],
  leverCoverage: [
    { kind: 'MOBILE_RATE', on: 31, of: 40 },
    { kind: 'SECRET_DEAL', on: 12, of: 40 },
    { kind: 'LAST_MINUTE_DEAL', on: 3, of: 40 },
    { kind: 'GETAWAY_CAMPAIGN', on: 0, of: 40 },
  ],
  cohorts: new Map([[ID, { booking: { better: 9, of: 12, viewRateMedian: 0.011, bookRateMedian: 0.02 }, airbnb: null }]]),
}))

// A single occupancy figure is not a finding. 26 against 41 last year is.
check('the year-on-year figure appears, because 26% alone has no direction',
      full.includes('41') && full.includes(en.trendYoy), '')
check('the blocked-night figure appears beside it, so "full" and "closed" are separable',
      full.includes(en.trendBlocked))
// The three horizons live in the CHART now, not in a table beside it — a table
// restating a chart teaches the reader that one of the two is not to be trusted.
check('the shorter and longer horizons are plotted, not tabulated',
      full.includes('cx-line') && !full.includes(en.trendHorizon), '')
// booking_economics: eighteen columns, 541 measured rows, never read until now.
check('the channel split is drawn from realised bookings',
      full.includes('booking') && full.includes('airbnb') && full.includes('70'), '')
check('the commission is shown as money AND as a share',
      full.includes('15') && full.includes(en.realisedCommission))
check('and it says commission rather than claiming to be the whole take rate',
      full.includes('multiplicative'))
// The case a pricing tool cannot see.
check('a perfect score on one review carries its warning',
      full.includes(en.reviewsThin(1)), '')
// The matrix replaced a row of nine equal chips. What it must do that a chip row
// could not: distinguish three states, and make an EMPTY cell mean something.
check('all four lever states are named, so "not stated" can never read as "off"',
      full.includes(en.leverUnknown) && full.includes(en.leverOn)
      && full.includes(en.leverOff) && full.includes(en.leverStateNone), '')
check('a lever the room does not run still gets a cell, so the gap is visible',
      full.includes('getaway campaign'), '')
check('and the ones it does run are there with their rate',
      full.includes('mobile rate') && full.includes('last minute deal'), '')
// The account-wide list became a question worth asking.
check('the portfolio panel says how many rooms run each lever',
      full.includes(en.leversPortfolio) && full.includes('31') && full.includes('>0<'), '')
check('and it explains why that is the useful question',
      full.includes('barely used'))
check('the cohort rank names its own size, so third of three cannot read as third of forty',
      full.includes(en.cohortRank(9, 12)), '')
check('and the yardstick is named as ours, never as "the market"',
      full.includes(en.cohortNote) && !/the market\b/.test(en.cohortNote))

// A cohort too small to rank inside says so instead of producing a rank.
const thin = renderDashboard(data({
  openId: ID, funnel: 'read',
  signals: new Map([[ID, sig({ funnelBooking: { axis: 'trailing', impressions: 100,
    views: 4, conversions: 1, nights: 0 } })]]),
  cohorts: new Map([[ID, { booking: { better: 1, of: 2, viewRateMedian: null, bookRateMedian: null }, airbnb: null }]]),
}))
check('a set of two is refused as a ranking basis',
      thin.includes(en.cohortThin(2)) && !thin.includes(en.cohortRank(1, 2)), '')

// The state every listing starts in: nothing read yet, and the page must say so
// rather than render empty panels.
const bare = renderDashboard(data({ openId: ID }))
for (const [what, sentence] of [
  ['no bookings', en.realisedNone(90)],
  ['no reviews', en.reviewsNone],
  ['no levers', en.leversNone],
] as const) {
  check(`${what}: the absence is named, not left blank`, bare.includes(sentence), '')
}

/* ---------------------------------------------------------------- the charts */

// The funnel cannot go on a shared axis: 99'014 → 743 → 12 makes the last two
// stages invisible. Each stage is drawn against the one above it instead, so the
// bar for 12 bookings out of 743 views is still readable.
check('the funnel is drawn as nested shares, so no stage is an invisible sliver',
      full.includes('0.75%') || full.includes('0,75%'), '')
check('and every stage still prints its absolute count',
      full.includes('99') && full.includes('743') && full.includes('>12<'), '')
check('the horizon chart draws three points and names last year as a reference',
      full.includes('cx-line') && full.includes(en.trendYoy), '')
check('the channel mix is one stacked bar with each channel named in its key',
      full.includes('cx-keys') && full.includes('booking') && full.includes('airbnb'), '')
// Identity is never colour alone: blue and green are close under tritanopia.
check('every series carries a direct label, not just a swatch',
      full.includes('cx-dl') && full.includes('cx-key'), '')
check('the review score is drawn on its own scale rather than as a bare number',
      full.includes('cx-strip'), '')

console.log(fails ? `\n${fails} FAILED` : '\nall green')
process.exit(fails ? 1 : 0)
