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
import type * as q from './dashboard/query.js'
import type { Row, Signals } from './dashboard/query.js'
import { renderShapesText } from './sources/elev8/shape.js'
import { en, id, LANGS, stringsFor } from './i18n.js'

let fails = 0
const check = (n: string, ok: boolean, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? '  — ' + extra : ''}`); if (!ok) fails++
}

const ID = '11111111-2222-3333-4444-555555555555'
const uid = (n: number) =>
  `${String(n).repeat(8)}-2222-3333-4444-555555555555`.slice(0, 36)
const blankKpi = () => ({ value: null, against: null, basis: 0, verdict: 'unknown' as const })
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
  lang: 'en', basis: 'revenue', view: 'all', sort: 'money', openId: null, rows: [row()],
  counts: { entities: 1, open: 1, critical: 0, high: 0 },
  // Empty by default: the page has to be right for a portfolio where none of
  // this has been read yet, which is where every listing starts.
  realised: new Map(), reviews: new Map(), promotions: new Map(),
  accountPromotions: [], cohorts: new Map(), leverCoverage: [],
  priceGap: new Map(), demand: new Map(),
  // A portfolio where nothing has been measured yet. Every tile must read
  // "not measured" rather than a confident zero — this is where every account
  // starts, and it is the state the page is most often wrong in.
  cockpit: {
    rooms: 0,
    revpar: blankKpi(), occupancy: blankKpi(), adjusted: blankKpi(), pace: blankKpi(),
    mpi: blankKpi(), takeRate: blankKpi(), visibility: blankKpi(),
    reviewScore: blankKpi(), blocked: blankKpi(),
    thinReviews: 0, atStake: null, currency: null, notAssessable: 0,
  },
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
const langHref = (html: string) =>
  /<span class="lang"><a href="([^"]*)"/.exec(html)?.[1] ?? ''
check('the language switch keeps the reader on the open row',
      langHref(open).includes('lang=id')
        && langHref(open).endsWith(`#row-${ID}`), langHref(open))
// Every control is a full navigation, so every control has to carry the whole
// state. Switching language used to reset the room filter to "all" silently,
// which reads as the page losing your place rather than as a bug.
check('and it carries the filter and the sort with it, so no control resets another',
      langHref(open).includes('view=all') && langHref(open).includes('sort=money')
        && langHref(open).includes(`open=${ID}`)
        && langHref(open).includes('basis='), langHref(open))

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

/* ------------------------------------------- a language table in a third language */

// A German sentence sat in the Indonesian table for a full session. The
// existence checks above all passed — the string was there, it was long, and it
// differed from the English — so nothing failed. Only a reader of Indonesian
// would have noticed. This is a coarse guard and it earns its keep: it is the
// check that would have caught it.
const GERMAN = /(^|\s)(im|der|die|das|und|nicht|über|für|mit|beim|noch)(\s|$)/i
const flatten = (v: unknown, out: string[] = []): string[] => {
  if (typeof v === 'string') out.push(v)
  else if (typeof v === 'function') { /* takes arguments; sampled below instead */ }
  else if (v && typeof v === 'object') Object.values(v).forEach(x => flatten(x, out))
  return out
}
const idLeaks = flatten(id).filter(t => GERMAN.test(t))
check('no German phrasing survives in the Indonesian table',
      idLeaks.length === 0, idLeaks.slice(0, 3).join(' | '))

/* ------------------------------------------------------- the three bands */

// The bands exist because the page had no front door: forty-one rooms, the
// actions one click inside each, and two competing rows of counters at the top.
// Each check below is one of the four things that redesign has to keep true.

const bands = renderDashboard(data({
  cockpit: { ...data().cockpit, atStake: 4870, currency: 'CHF',
             revpar: { value: 84, against: 96, basis: 1230, verdict: 'act' },
             occupancy: { value: 26, against: 48, basis: 1230, verdict: 'act' },
             pace: { value: 3, against: null, basis: 22, verdict: 'unknown' } },
}))
check('the hero leads with the money, not with a metric name',
      bands.indexOf('hero-n') < bands.indexOf('pstrip')
        && bands.includes('4') && bands.includes(en.heroAtStake), '')
check('and it says in a plain sentence how much there is to do',
      bands.includes('to change across') || bands.includes(en.heroLead(0, 0)), '')
check('the KPI strip comes after the hero and is collapsed by default',
      /<details class="pk [^"]*">\s*<summary>/.test(bands)
        && !/<details class="pk [^"]*" open/.test(bands), '')
check('the reading order is pulse, then today, then the rooms table',
      bands.indexOf('class="pulse"') < bands.indexOf('class="today"')
        && bands.indexOf('class="today"') < bands.indexOf('id="rooms"'), '')
check('the filter row replaced the second counter row, so there is only one',
      (bands.match(/class="bar"/g) ?? []).length === 1
        && !bands.includes('class="stats"'), '')
check('every view segment carries its own count',
      (['all', 'act', 'held', 'quiet', 'na'] as const)
        .every(v => bands.includes(en.view[v])) && bands.includes('class="fc"'), '')
check('and the three orderings are offered by name',
      (['money', 'risk', 'name'] as const).every(k => bands.includes(en.sorting[k])), '')

// The worklist: a held line stays in it, and sorts below the ones that are ready.
// This is the whole reason the band exists — an action waiting on a visibility
// gate is something to know, not something to do today.
const ID2 = 'aaaa1111-2222-3333-4444-555555555555'
const gap = (over: Partial<q.PriceGap> = {}): q.PriceGap => ({
  nights: 22, above: 18, below: 4, ours: 180, recommended: 165, currency: 'CHF',
  minStayOver: 0, minStayMax: null, ...over,
})
// Room two is the held case: its own view rate is a fifth of the cohort median,
// so the price action is real and waiting on a visibility problem.
const twoRooms = renderDashboard(data({
  rows: [row({ entityId: ID, label: 'ID - APT 2' }),
         row({ entityId: ID2, label: 'ID - APT 9', atStake: 200,
               firstFailing: 'visibility' })],
  signals: new Map([
    [ID, sig()],
    [ID2, sig({ funnelBooking: { axis: 'trailing', impressions: 1000, views: 10,
                                 conversions: 1, nights: 0 } })],
  ]),
  priceGap: new Map([[ID, gap()], [ID2, gap({ ours: 200, recommended: 150 })]]),
  cohorts: new Map([[ID2, { booking: { better: 9, of: 12, viewRateMedian: 0.1,
                                       bookRateMedian: 0.03 }, airbnb: null }]]),
}))
const wlist = twoRooms.slice(twoRooms.indexOf('class="wlist"'),
                             twoRooms.indexOf('</ol>', twoRooms.indexOf('class="wlist"')))
const firstHeld = wlist.indexOf('class="wl held"')
const lastReady = wlist.lastIndexOf('class="wl ready"')
check('the worklist is the portfolio, not one room — several rooms appear in it',
      wlist.includes('ID - APT 2') && wlist.includes('ID - APT 9'), '')
check('a ready line never sorts below a held one',
      firstHeld === -1 || lastReady === -1 || lastReady < firstHeld,
      `held@${firstHeld} ready@${lastReady}`)
// Asserted positively, not "or nothing held": a vacuous pass here would have let
// the ordering check above mean nothing.
check('the fixture really does produce one held line and one ready line',
      firstHeld !== -1 && lastReady !== -1, `held@${firstHeld} ready@${lastReady}`)
check('a held line names the gate it is waiting on rather than disappearing',
      wlist.includes('class="wl-gate"'), '')
check('and each line links back into its own room, anchored',
      /class="wl-room"><a href="\/\?[^"]*#row-/.test(wlist), '')

// Collapsing. Rendered and looked at, the list read as four separate lines all
// saying "turn the mobile rate on" — one per room, each worth nothing — stacked
// above a held rate action worth CHF 1'890. One decision touching four rooms is
// one line. But the HERO still counts changes, not lines: the first attempt at
// this made the page say "3 things to change" while proposing six.
const many = renderDashboard(data({
  rows: [1, 2, 3, 4].map(n => row({ entityId: uid(n), label: `R${n}`, atStake: null,
                                    findings: 0, worstSeverity: null, firstFailing: null })),
  signals: new Map([1, 2, 3, 4].map(n => [uid(n), sig()])),
  leverCoverage: [{ kind: 'MOBILE_RATE', on: 31, of: 41 }],
}))
const mlist = many.slice(many.indexOf('class="wlist"'),
                         many.indexOf('</ol>', many.indexOf('class="wlist"')))
check('four rooms proposing the same worthless change are one line, not four',
      (mlist.match(/class="wl /g) ?? []).length === 1, '')
check('and that line names two rooms and counts the rest',
      mlist.includes('R1') && mlist.includes('R2')
        && mlist.includes(en.andMoreRooms(2)), '')
check('while the hero still counts the changes, not the lines',
      many.includes(en.heroLead(4, 4)), en.heroLead(4, 4))

// An action carrying money is never merged: two rooms owed CHF 900 each is not
// one line about CHF 900, and losing which room the money is in is the same
// mistake as a key that cannot tell two sources apart.
const worth = renderDashboard(data({
  rows: [row({ entityId: uid(1), label: 'R1' }), row({ entityId: uid(2), label: 'R2' })],
  signals: new Map([[uid(1), sig()], [uid(2), sig()]]),
  priceGap: new Map([[uid(1), gap()], [uid(2), gap()]]),
}))
const wl2 = worth.slice(worth.indexOf('class="wlist"'),
                        worth.indexOf('</ol>', worth.indexOf('class="wlist"')))
check('two rooms with the same amount stay two lines, each naming its own room',
      wl2.includes('R1') && wl2.includes('R2')
        && (wl2.match(/class="wl-worth">CHF/g) ?? []).length === 2, '')

// The opened room: three groups in the order of the reader's questions, and the
// reference material collapsed. The old row was ten equal panels in a stack.
const room = renderDashboard(data({ openId: ID }))
const roomDetail = room.slice(room.indexOf('<tr class="detail"'))
check('an opened room asks what to change before it explains why',
      roomDetail.indexOf(en.groupWhat) < roomDetail.indexOf(en.groupWhy), '')
check('and puts the reference material last, collapsed',
      roomDetail.indexOf(en.groupWhy) < roomDetail.indexOf(en.groupDetails)
        && /<details class="rgroup rmore">/.test(roomDetail), '')
check('the evidence is inside the collapsed group, not stacked in the open',
      roomDetail.indexOf(en.groupDetails) < roomDetail.indexOf('class="ev"')
        || !roomDetail.includes('class="ev"'), '')
check('the row itself carries its state, so the table is scannable without reading it',
      /<tr id="row-[^"]*" class="open st-(act|held|quiet)"/.test(room), '')

// The filter is not allowed to disagree with the worklist: both are derived from
// one computation of the actions, and a room counted as "needs a change" that
// contributes no line to the list would be the page contradicting itself.
for (const v of ['act', 'held', 'quiet', 'na'] as const) {
  const filtered = renderDashboard(data({ view: v }))
  check(`view=${v} renders without the other views' rows leaking in`,
        (filtered.match(/<tr id="row-/g) ?? []).length <= 1, '')
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

/* ------------------------------------- the action panel leads the opened row */

// Asserted by POSITION, not by presence. The first version of this panel was
// built inside the evidence bundle and rendered fourth, under three panels of
// measurement, while its own comment claimed it led the row. A reader who has to
// scroll past the evidence to reach the proposal reads the evidence and does
// nothing — so where it sits is part of the contract.
const acted = renderDashboard(data({
  openId: ID, funnel: 'read',
  signals: new Map([[ID, sig({ occupancy: 26, marketOccupancy: 48 })]]),
  priceGap: new Map([[ID, { nights: 22, above: 22, below: 0, ours: 180,
    recommended: 165, currency: 'CHF', minStayOver: 1, minStayMax: 7 }]]),
  demand: new Map([[ID, { leadMedian: 34, leadP25: 8, leadP75: 96, nightsMedian: 3,
    nightsP75: 5, bookings: 22,
    origins: [{ country: 'AU', bookings: 7, share: 0.32 }] }]]),
  leverCoverage: [{ kind: 'MOBILE_RATE', on: 31, of: 41 }],
  promotions: new Map([[ID, []]]),
}))
// Scoped to the opened row, because the cockpit tiles above the table are also
// h3 — a global scrape found "Earnings per night you could sell" first and
// reported a failure about the wrong part of the page.
const detail = acted.slice(acted.indexOf('class="detail"'))
const panelOrder = [...detail.matchAll(/<h3>([^<]*)<\/h3>/g)].map(m => m[1])
check('the action panel is the FIRST panel in an opened row',
      panelOrder[0] === en.actionsHeading, panelOrder.slice(0, 4).join(' | '))
// Matched on the digits, not on "CHF 180": Intl puts a NON-BREAKING space after
// the currency, so a literal with an ordinary space never matches — and the
// assertion would have failed for a reason that has nothing to do with the page.
check('and it names a lever with a from and a to, not advice',
      /180/.test(acted) && /165/.test(acted)
      && acted.includes(en.leverLabel.price), '')
check('the minimum stay is measured against what guests actually book',
      acted.includes(en.leverLabel.min_stay) && acted.includes('7') && acted.includes('3'), '')
check('a lever the majority runs is proposed with the count behind it',
      acted.includes('31 of 41'), '')
// The named absence: generic copy advice would look like a finding.
check('text and photos say no source is connected rather than offering advice',
      acted.includes(en.aContentScope) && acted.includes('content surface is not connected'), '')
// Guest origin was in booking_economics all along.
check('guest origin appears from our own realised bookings',
      acted.includes(en.demandOrigin) && acted.includes('AU'), '')
check('and the page says this is who booked, not who searched',
      acted.includes('who BOOKED') || acted.includes(en.demandOriginSearchNote), '')
check('lead time is a spread, not a lone median',
      acted.includes('34') && acted.includes('8') && acted.includes('96'), '')

/* --------------------------------------------------------------- the cockpit */

// The design constraint behind this whole block: most readers are not revenue
// managers. They have not met RevPAR, they do not know what MPI is, and they do
// not know which of these numbers moves their money. So every tile is tested for
// four things, and the plain-language name is one of them.
const ck = renderDashboard(data({
  cockpit: {
    rooms: 41,
    revpar: { value: 47, against: 61, basis: 1230, verdict: 'act' },
    occupancy: { value: 26, against: 48, basis: 1230, verdict: 'act' },
    adjusted: { value: 22, against: 26, basis: 1230, verdict: 'unknown' },
    pace: { value: 9, against: null, basis: 4, verdict: 'unknown' },
    mpi: { value: 1.31, against: 1, basis: 1230, verdict: 'act' },
    takeRate: { value: 0.152, against: null, basis: 22, verdict: 'unknown' },
    visibility: { value: 0.0075, against: null, basis: 39, verdict: 'unknown' },
    reviewScore: { value: 8.6, against: null, basis: 39, verdict: 'unknown' },
    blocked: { value: 0.18, against: null, basis: 1230, verdict: 'unknown' },
    thinReviews: 4, atStake: 24_800, currency: 'CHF', notAssessable: 37,
  },
}))
check('the plain-language name leads each tile, not the abbreviation',
      ck.includes(en.kpi.revpar.name) && ck.indexOf(en.kpi.revpar.name)
        < ck.indexOf(en.kpi.revpar.term), '')
check('but the technical term is still there, so the word is recognisable elsewhere',
      ck.includes('RevPAR') && ck.includes('MPI'), '')
// The line that makes a tile teach instead of report.
check('every tile says what the figure does to the money',
      (['revpar', 'occupancy', 'pace', 'mpi', 'take', 'visibility', 'reviews', 'blocked'] as const)
        .every(k => ck.includes(en.kpi[k].money.slice(0, 40))), '')
check('a figure is shown with what it is compared against',
      ck.includes(en.kpi.occupancy.against) && ck.includes(en.kpi.revpar.against), '')
check('and with the count it rests on, because 3 nights and 1230 are different claims',
      ck.includes(en.cockpitBasisNights(1230)) && ck.includes(en.cockpitBasisBookings(22)), '')
// A verdict is a word, never a colour alone.
check('the verdict is spelled out, not left to a hue',
      ck.includes(en.verdict.act) && ck.includes(en.verdict.unknown), '')
check('pace admits it has nothing to compare against rather than passing a verdict',
      en.kpi.pace.against.includes('nothing yet'), '')
// An average score hides the room with one review.
check('the thin-review count rides on the score tile, which alone would hide it',
      ck.includes(en.reviewsThin(4)), '')

// The state every account starts in, and the one the page is most often wrong in.
const empty = renderDashboard(data())
check('an unmeasured portfolio says "not measured" on every tile, never a confident zero',
      (empty.match(new RegExp(en.cockpitNoData, 'g')) ?? []).length >= 8,
      String((empty.match(new RegExp(en.cockpitNoData, 'g')) ?? []).length))
check('and no tile claims to be on track without a comparison',
      !empty.includes(en.verdict.good), '')

console.log(fails ? `\n${fails} FAILED` : '\nall green')
process.exit(fails ? 1 : 0)
