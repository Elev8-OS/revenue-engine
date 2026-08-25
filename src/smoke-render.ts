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
import { renderDashboard, type DashboardData } from './dashboard/render.js'
import type { Row, Signals } from './dashboard/query.js'
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
  observedAt: null, asOf: '2026-08-25', ...over,
})
const data = (over: Partial<DashboardData> = {}): DashboardData => ({
  lang: 'en', basis: 'revenue', openId: null, rows: [row()],
  counts: { entities: 1, open: 1, critical: 0, high: 0 },
  notAssessable: [], freshness: [], gate: [], evidence: [],
  signals: new Map([[ID, sig()]]), demo: false, unprotected: false, ...over,
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

console.log(fails ? `\n${fails} FAILED` : '\nall green')
process.exit(fails ? 1 : 0)
