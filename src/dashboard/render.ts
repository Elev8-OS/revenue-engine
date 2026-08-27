/**
 * Server-rendered dashboard. No framework and no client JavaScript: the whole
 * interaction is "which row is open", "which basis ranks" and "which language",
 * and all three are fine as query parameters. That keeps the deployable surface
 * one file and removes a build step from the critical path.
 *
 * Every visible string comes from the language table rather than from here, so
 * an untranslated screen is a compile error rather than a surprise in Bali.
 */
import type * as q from './query.js'
// A value import alongside the type one: `realisedWindowDays` is a constant the
// page must state rather than repeat, so the window it names cannot drift apart
// from the window the query actually used.
import { realisedWindowDays, demandWindowDays } from './query.js'
import { actionsFor, type Action, type ActionStrings } from './actions.js'
import type { Basis, Row } from './query.js'
import { type Lang, type Strings, stringsFor, otherLang } from '../i18n.js'
import { head } from '../ui/theme.js'

const e = (s: unknown) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

const money = (v: number | null, cur: string | null, locale: string) =>
  v === null ? '—'
    : new Intl.NumberFormat(locale, {
        style: 'currency', currency: cur ?? 'CHF', maximumFractionDigits: 0,
      }).format(v)

/** A count. Grouped, never abbreviated: 99'014 read as "99k" loses the precision
 *  that makes it checkable against the provider's own report. */
const count = (v: number, locale: string) =>
  new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(v)

/**
 * A share, with the decimal it needs.
 *
 * Booking's measured search-to-view was 743 of 99'014 — 0.75%. Rounded to whole
 * percent that is "1%", and the difference between 0.75 and 1 is a third of the
 * traffic. Two decimals below one percent, one above.
 */
const pct = (v: number, locale: string) => {
  // Zero is exactly zero and gets no decimals: an axis reading "0.00%" spends
  // three characters saying nothing and makes the reader check for a rounding
  // they need not think about.
  const d = v === 0 ? 0 : v < 1 ? 2 : v < 10 ? 1 : 0
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: d, maximumFractionDigits: d,
  }).format(v) + '%'
}

export type RoomView = 'all' | 'act' | 'held' | 'quiet' | 'na'
export type RoomSort = 'money' | 'risk' | 'name'

export interface DashboardData {
  lang: Lang
  basis: Basis
  /**
   * Which rooms to show. A portfolio of forty-one with eighteen findings has no
   * front door without this: the reader's first question is "what needs me", and
   * before this the only answer was to open rooms one at a time.
   */
  view: RoomView
  sort: RoomSort
  /**
   * The tenant's group, or null for the whole account. Narrows EVERYTHING the
   * page derives — hero, worklist, filter counts and table. The cockpit is
   * narrowed in SQL by the same value, because a dropdown that filters the table
   * while the hero keeps the account total teaches the reader something false.
   */
  group: string | null
  openId: string | null
  rows: Row[]
  counts: { entities: number, open: number, critical: number, high: number }
  notAssessable: Array<{ label: string, reason: string }>
  freshness: Array<{ source: string, dataset: string, age_minutes: number }>
  /** Measurements per entity, keyed by entity id. Empty until an import runs. */
  signals: Map<string, q.Signals>
  /**
   * What actually sold in the last 90 days, per entity, out of
   * `booking_economics` — a table with the channel, the gross and the OTA
   * commission on every reservation, which this page had never once read.
   */
  realised: Map<string, q.Realised>
  /** Score and count per channel. Two numbers that decide which findings may fire. */
  reviews: Map<string, { booking: q.ReviewStanding | null, airbnb: q.ReviewStanding | null }>
  /** Commercial levers attributed to an object, and the account-wide ones. */
  promotions: Map<string, q.Promotion[]>
  accountPromotions: q.Promotion[]
  /**
   * How many rooms run each lever. The account-wide question worth asking —
   * which lever is barely used — rather than a list of what exists.
   */
  leverCoverage: Array<{ kind: string, on: number, of: number }>
  /** The eight figures a reader scans first. Everything else is their drilldown. */
  cockpit: q.Cockpit
  /** Night-by-night disagreement with the recommendation, and the minimum stay. */
  priceGap: Map<string, q.PriceGap>
  /** Rank on Booking, position and first-page share on Airbnb, per room. */
  search: Map<string, q.SearchStanding>
  /**
   * The channel's own daily percentile for the WHOLE account, per channel. Not
   * narrowed by the group and not attributable to a room — the panel says both.
   */
  rankTimeline: Map<string, q.RankPoint[]>
  /** Lead time, stay length and guest origin, from our own realised bookings. */
  demand: Map<string, q.DemandShape>
  /** Where each listing's funnel sits inside our OWN market × band × channel set. */
  cohorts: Map<string, { booking: q.CohortStanding | null, airbnb: q.CohortStanding | null }>
  /**
   * Why the funnel is dark, MEASURED once per page rather than written into a
   * string. The macro block used to carry "whose grant is revoked" as a
   * constant, so unlike the stored gate prose it did not even need a stale check
   * run to be wrong — it was wrong on every render the moment the grant returned.
   */
  funnel: q.FunnelState['kind']
  gate: Array<{ stage: string, verdict: string, note: string | null }>
  evidence: Array<{ side: string, family: string, metric: string, claim: string, observed_at: string | null }>
  demo: boolean
  /** True when no sign-in is configured, so the page is reachable by anyone. */
  unprotected: boolean
  email?: string
}

function age(min: number, s: Strings): string {
  if (min < 90) return s.ageMinutes(min)
  const h = Math.round(min / 60)
  return h < 48 ? s.ageHours(h) : s.ageDays(Math.round(h / 24))
}

/** Preserves where the reader was when they switch language. */
/**
 * The current page with one thing changed — and with the open row's anchor, so
 * switching language or basis does not throw the reader back to the top. Same
 * reasoning as the row links: every control here is a full navigation, and a
 * navigation with no fragment resets the scroll.
 */
function selfUrl(
  d: DashboardData,
  over: { lang?: Lang, basis?: Basis } = {},
): string {
  // Every control keeps the whole state: switching language must not silently
  // reset the filter, and switching basis must not close the open room. Before
  // the filter existed this was two parameters; forgetting to carry a third is
  // exactly how a control starts feeling broken.
  const p = new URLSearchParams({
    basis: over.basis ?? d.basis,
    lang: over.lang ?? d.lang,
    view: d.view,
    sort: d.sort,
  })
  if (d.group) p.set('group', d.group)
  if (d.openId) p.set('open', d.openId)
  return `/?${p.toString()}${d.openId ? `#row-${d.openId}` : ''}`
}

function gateBlock(d: DashboardData, s: Strings): string {
  if (!d.gate.length) return ''
  const dots = d.gate.map(g => {
    const cls = g.verdict === 'failing' ? 'bad' : g.verdict === 'healthy' ? 'good' : 'unk'
    const name = s.stage[g.stage] ?? g.stage
    return `<li><span class="dot ${cls}"></span><b>${e(name)}</b>${
      g.note ? ` <span class="mut">${e(g.note)}</span>` : ''}</li>`
  }).join('')
  const failing = d.gate.find(g => g.verdict === 'failing')
  const released = failing
    ? failing.stage === 'price'
      ? s.gateAllHold
      : s.gateBreaksAt(e(s.stage[failing.stage] ?? failing.stage))
    : s.gateNoneBreak
  return `<section class="panel">
    <h3>${e(s.gatekeeper)}</h3>
    <ul class="gate">${dots}</ul>
    <p class="mut">${released} ${s.cohortCaveat}</p>
  </section>`
}

function evidenceBlock(d: DashboardData, s: Strings): string {
  if (!d.evidence.length) return ''
  const side = (name: string, key: string, note: string) => {
    const items = d.evidence.filter(x => x.side === key)
    if (!items.length) return ''
    return `<div><h4>${e(name)} <span class="mut">${e(note)}</span></h4><ul class="ev">${
      items.map(x => `<li>${e(x.claim)} <span class="mut">· ${e(x.metric)}${
        x.observed_at ? ` · ${e(x.observed_at)}` : ''}</span></li>`).join('')
    }</ul></div>`
  }
  return `<section class="panel">
    <h3>${e(s.evidence)}</h3>
    ${side(s.evidenceFor, 'supporting', '')}
    ${side(s.evidenceAgainst, 'against', s.evidenceAgainstNote)}
    ${side(s.evidenceUnknown, 'unknown', '')}
  </section>`
}

/**
 * Ours against the market, over the next thirty nights.
 *
 * Colour says which side of the market we are on and nothing more. It is
 * deliberately NOT a severity: a listing above the market on occupancy is not
 * "good" — it may be underpriced into a full calendar, which is the failure this
 * whole system exists to catch. Green here means "ahead on this one number",
 * and the number is named beside it.
 *
 * Every cell renders from what is present. A missing half prints an em dash
 * rather than a zero, because a market we did not measure is not a market at
 * nought per cent.
 */
/**
 * The picture in an opened row: where we stand, and what the distance is worth.
 *
 * Drawn rather than tabulated because the whole claim is a COMPARISON, and a
 * comparison of two percentages is the one thing a bar does better than a
 * sentence. The gap is shaded, so the quantity being valued below is visibly the
 * same quantity being measured above — which is the step a reader has to take on
 * trust when the two live in different columns.
 *
 * Three rules it keeps:
 *
 *   1. NO BRAND AMBER. Everything else on the page reserves that colour for
 *      actions. A potential bar is data, and a colour that means "brand" in one
 *      place and "opportunity" in another means neither.
 *   2. NOTHING IS DRAWN THAT WAS NOT MEASURED. A missing market half draws no
 *      marker at all rather than a marker at zero, and a room with no finding
 *      gets the occupancy bar and no money bar — because there is no money
 *      figure, not because the figure is nought.
 *   3. THE RANGE IS THE HONEST WIDTH. Where the check produced a band, the bar
 *      is the band and the point estimate is a tick inside it. A single bar
 *      would draw a precision the evidence does not carry.
 *
 * Inline SVG with no script and no external file: it inherits the page's own
 * custom properties, so it is correct in both colour schemes without a second
 * definition of anything.
 */
/**
 * Where a price falls in its neighbourhood's distribution.
 *
 * Named by the boundary it crossed, never by a percentage of the median: "12%
 * below the median" sounds precise and says nothing about whether that is
 * unusual. "Below the bottom quarter of 155 listings" is the sentence a pricing
 * decision is actually made on.
 */
export function pricePosition(
  price: number, p25: number | null, p50: number | null, p75: number | null, p90: number | null,
): keyof Strings['pricePos'] | null {
  if (p25 !== null && price < p25) return 'belowP25'
  if (p90 !== null && price > p90) return 'aboveP90'
  if (p50 !== null && price < p50) return 'p25p50'
  if (p75 !== null && price < p75) return 'p50p75'
  if (p75 !== null) return 'p75p90'
  return null
}

interface Detail {
  sig: q.Signals | undefined
  real: q.Realised | undefined
  rev: { booking: q.ReviewStanding | null, airbnb: q.ReviewStanding | null } | undefined
  promos: q.Promotion[] | undefined
  accountPromos: q.Promotion[]
  /** Every lever the account offers, so an empty cell means "not taken". */
  knownLevers: string[]
  cohort: { booking: q.CohortStanding | null, airbnb: q.CohortStanding | null } | undefined
  gap: q.PriceGap | undefined
  demand: q.DemandShape | undefined
  coverage: Array<{ kind: string, on: number, of: number }>
  /** Where this room stands in each channel's search. See query.searchStanding. */
  search: q.SearchStanding | undefined
}

/** Everything the archive holds about one room, in the order a reader needs it. */
/**
 * The action panel, returned SEPARATELY from the evidence.
 *
 * It has to be, because it has to come first. The version before this one built
 * the actions inside the evidence bundle and the panel landed fourth — under
 * Potential, Price position and Macro — while the comment above it claimed it led
 * the row. Rendering the page and counting the panels was the only way that was
 * ever going to be noticed.
 */
/** One set of action strings, so the worklist and the room can never disagree. */
function actionStrings(s: Strings): ActionStrings {
  return {
    money: (v, cur) => money(v, cur, s.numberLocale),
    nights: s.aNights, nightsPlain: s.aNightsPlain,
    priceAbove: s.aPriceAbove, priceBelow: s.aPriceBelow,
    minStayScope: s.aMinStayScope, minStayBecause: s.aMinStayBecause,
    leverOn: s.leverOn, leverOff: s.leverOff, leverAbsent: s.aLeverAbsent,
    leverName: k => k.replace(/_/g, ' ').toLowerCase(),
    leverBecause: s.aLeverBecause,
    contentScope: s.aContentScope, contentBecause: s.aContentBecause,
  }
}

/** The actions for one row, from the same inputs the room detail uses. */
function actionsOf(r: Row, d: DashboardData, s: Strings): Action[] {
  return actionsFor({
    row: r, sig: d.signals.get(r.entityId), gap: d.priceGap.get(r.entityId),
    demand: d.demand.get(r.entityId), promos: d.promotions.get(r.entityId),
    coverage: d.leverCoverage, cohort: d.cohorts.get(r.entityId),
  }, actionStrings(s))
}

/**
 * How a room reads at a glance: does it need something, is it waiting, or is it
 * quiet. Derived from the actions rather than from the findings, because a
 * finding is an observation and an action is a thing to do.
 */
export type RoomState = 'act' | 'held' | 'quiet'

function roomState(list: Action[]): RoomState {
  const real = list.filter(a => a.lever !== 'content')
  if (real.some(a => !a.blockedBy)) return 'act'
  if (real.some(a => a.blockedBy)) return 'held'
  return 'quiet'
}

function actionsPanel(r: Row, d: Detail, s: Strings): string {
  const actions = actionsFor({
    row: r, sig: d.sig, gap: d.gap, demand: d.demand,
    promos: d.promos, coverage: d.coverage, cohort: d.cohort,
  }, {
    money: (v, cur) => money(v, cur, s.numberLocale),
    nights: s.aNights, nightsPlain: s.aNightsPlain,
    priceAbove: s.aPriceAbove, priceBelow: s.aPriceBelow,
    minStayScope: s.aMinStayScope, minStayBecause: s.aMinStayBecause,
    leverOn: s.leverOn, leverOff: s.leverOff, leverAbsent: s.aLeverAbsent,
    leverName: k => k.replace(/_/g, ' ').toLowerCase(),
    leverBecause: s.aLeverBecause,
    contentScope: s.aContentScope, contentBecause: s.aContentBecause,
  })
  return actionsBlock(actions, s)
}

/** The evidence for the panel above: everything the actions were derived from. */
function detailBlocks(r: Row, d: Detail, s: Strings): string {
  return demandBlock(d.demand, s)
    + trendBlock(d.sig, s)
    + realisedBlock(r, d.real, s)
    + reviewsBlock(d.rev, s)
    + leversBlock(d.promos, d.accountPromos, d.knownLevers, s)
}

function potentialChart(r: Row, sig: q.Signals | undefined, s: Strings): string {
  const ours = sig?.occupancy ?? null
  const theirs = sig?.marketOccupancy ?? null
  // Nothing to draw is not nothing to say — but saying it is now the caller's
  // job. This function used to also emit the action panel, the price position,
  // the macro block and the whole evidence stack, which is why a layout change
  // could silently drop four blocks at once: they were hidden behind an optional
  // parameter. One function, one picture.
  if (ours === null && r.atStake === null) return ''

  const W = 640, PAD = 96, TRACK = W - PAD - 16
  const x = (pct: number) => PAD + (Math.max(0, Math.min(100, pct)) / 100) * TRACK
  const parts: string[] = []
  let y = 0

  if (ours !== null) {
    const behind = theirs !== null && theirs > ours
    // The shaded gap, drawn first so the bars sit on top of it.
    if (behind) {
      parts.push(`<rect x="${x(ours).toFixed(1)}" y="14" width="${(x(theirs) - x(ours)).toFixed(1)}"`
        + ` height="16" fill="var(--rust)" opacity=".16"/>`)
    }
    parts.push(`<text x="0" y="26" class="lbl">${e(s.potentialOurs)}</text>`)
    parts.push(`<rect x="${PAD}" y="14" width="${TRACK}" height="16" rx="4" fill="var(--sunk)"/>`)
    parts.push(`<rect x="${PAD}" y="14" width="${(x(ours) - PAD).toFixed(1)}" height="16" rx="4"`
      + ` fill="var(--ink)"/>`)
    parts.push(`<text x="${(x(ours) + 8).toFixed(1)}" y="26" class="val">${Math.round(ours)}%</text>`)
    y = 44
    if (theirs !== null) {
      parts.push(`<text x="0" y="${y + 12}" class="lbl">${e(s.potentialMarket)}</text>`)
      parts.push(`<rect x="${PAD}" y="${y}" width="${TRACK}" height="16" rx="4" fill="var(--sunk)"/>`)
      parts.push(`<rect x="${PAD}" y="${y}" width="${(x(theirs) - PAD).toFixed(1)}" height="16"`
        + ` rx="4" fill="var(--mut)"/>`)
      parts.push(`<text x="${(x(theirs) + 8).toFixed(1)}" y="${y + 12}" class="val">`
        + `${Math.round(theirs)}%</text>`)
      y += 30
    }
    const gap = theirs === null ? null : theirs - ours
    if (gap !== null) {
      parts.push(`<text x="${PAD}" y="${y + 10}" class="cap">${
        gap > 0 ? e(s.potentialGapPp(Math.round(gap))) : e(s.potentialAhead)}</text>`)
      y += 22
    }
  }

  /**
   * The money as a BRACKET, not as a bar on a zero-based axis.
   *
   * The first version drew it as a magnitude: a track from nought to the top of
   * the band, with the range shaded inside it. On real numbers that range is a
   * sliver at the far right — CHF 1'089 to CHF 1'188 on a track that starts at
   * zero is 92% empty — so the one thing the row exists to show, the WIDTH of
   * the uncertainty, was the one thing invisible. A bracket has no origin to
   * mislead with: it spans the band, the tick sits where the estimate falls
   * inside it, and both ends are labelled with their own figure.
   */
  if (r.atStake !== null) {
    const hasBand = r.bandLow !== null && r.bandHigh !== null && r.bandLow !== r.bandHigh
    const lo = hasBand ? Math.min(r.bandLow!, r.bandHigh!) : r.atStake
    const hi = hasBand ? Math.max(r.bandLow!, r.bandHigh!) : r.atStake
    const span = 300
    const left = PAD, right = PAD + span
    y += 16
    parts.push(`<text x="0" y="${y + 5}" class="lbl">${e(s.colAtStake)}</text>`)
    if (hasBand) {
      parts.push(`<line x1="${left}" y1="${y}" x2="${right}" y2="${y}" stroke="var(--line)"`
        + ` stroke-width="3"/>`)
      for (const cap of [left, right]) {
        parts.push(`<line x1="${cap}" y1="${y - 6}" x2="${cap}" y2="${y + 6}"`
          + ` stroke="var(--mut)" stroke-width="2"/>`)
      }
      const at = left + ((r.atStake - lo) / (hi - lo)) * span
      parts.push(`<circle cx="${at.toFixed(1)}" cy="${y}" r="5" fill="var(--ink)"/>`)
      parts.push(`<text x="${left}" y="${y + 22}" class="cap">${
        e(money(lo, r.currency, s.numberLocale))}</text>`)
      parts.push(`<text x="${right}" y="${y + 22}" class="cap" text-anchor="end">${
        e(money(hi, r.currency, s.numberLocale))}</text>`)
    } else {
      parts.push(`<circle cx="${left + 6}" cy="${y}" r="5" fill="var(--ink)"/>`)
    }
    parts.push(`<text x="${right + 16}" y="${y + 5}" class="val">${
      e(money(r.atStake, r.currency, s.numberLocale))}</text>`)
    y += hasBand ? 30 : 14
  }

  const chart = `<svg class="pot" viewBox="0 0 ${W} ${y + 6}" role="img"
      aria-label="${e(s.potentialHeading)}">${parts.join('')}</svg>`
  return `<section class="panel"><h3>${e(s.potentialHeading)}</h3>${chart}</section>`
}

/**
 * The micro layer, drawn: our price inside the neighbourhood's own spread.
 *
 * This is the block that answers "and what does that do to the price". Two
 * markers on one scale — what is live and what PriceLabs recommends — against
 * the quartiles of the same bedroom category in the same neighbourhood. The
 * distance between the two markers IS the effect of the recommendation, and the
 * band behind them is what makes that distance mean something: moving CHF 45 to
 * CHF 47 is nothing on its own and is still nothing when the neighbourhood's
 * bottom quarter starts at 60.
 *
 * The scale is stretched to hold whichever is further out, our price or the
 * band, so a listing priced far below its neighbourhood is drawn far below it
 * rather than clamped onto the edge and made to look adjacent.
 */
function pricePositionBlock(sig: q.Signals | undefined, r: Row, s: Strings): string {
  if (!sig) return ''
  const { nbhdP25: p25, nbhdP50: p50, nbhdP75: p75, nbhdP90: p90 } = sig
  const live = sig.priceLive
  const rec = sig.priceRecommended
  /**
   * Named absence, not silence. Two different things are missing here and they
   * need different fixes: no neighbourhood panel yet (a PriceLabs stage that has
   * not landed) and no price of our own (a listing PriceLabs is not pricing).
   * The block used to render nothing for either, which read as "this room has no
   * micro layer" rather than "this run did not get one".
   */
  if (p50 === null || (live === null && rec === null)) {
    return `<section class="panel"><h3>${e(s.pricePosHeading)}</h3>
      <p class="mut" style="margin:0;font-size:.86rem">${e(p50 === null
        ? s.pricePosNoPanel : s.pricePosNoPrice)}</p></section>`
  }

  const W = 640, PAD = 96, TRACK = W - PAD - 16
  const values = [p25, p50, p75, p90, live, rec].filter((v): v is number => v !== null)
  const lo = Math.min(...values) * 0.92
  const hi = Math.max(...values) * 1.06
  const span = hi - lo || 1
  const x = (v: number) => PAD + ((v - lo) / span) * TRACK
  const parts: string[] = []
  const H = 18

  parts.push(`<rect x="${PAD}" y="10" width="${TRACK}" height="${H}" rx="4" fill="var(--sunk)"/>`)
  // The interquartile range: where half the neighbourhood actually sits.
  if (p25 !== null && p75 !== null) {
    parts.push(`<rect x="${x(p25).toFixed(1)}" y="10" width="${(x(p75) - x(p25)).toFixed(1)}"`
      + ` height="${H}" rx="4" fill="var(--mut)" opacity=".3"/>`)
  }
  for (const [v, label] of [[p25, 'P25'], [p50, 'P50'], [p75, 'P75'], [p90, 'P90']] as const) {
    if (v === null) continue
    parts.push(`<line x1="${x(v).toFixed(1)}" y1="8" x2="${x(v).toFixed(1)}" y2="${10 + H + 2}"`
      + ` stroke="var(--mut)" stroke-width="${label === 'P50' ? 2 : 1}"/>`)
    parts.push(`<text x="${x(v).toFixed(1)}" y="${10 + H + 14}" class="cap"`
      + ` text-anchor="middle">${label}</text>`)
  }
  // Live is hollow, the recommendation is filled: the reader should be able to
  // tell what is true today from what is being proposed without a legend.
  if (live !== null) {
    parts.push(`<circle cx="${x(live).toFixed(1)}" cy="${10 + H / 2}" r="6" fill="var(--paper)"`
      + ` stroke="var(--ink)" stroke-width="2"/>`)
  }
  if (rec !== null) {
    parts.push(`<circle cx="${x(rec).toFixed(1)}" cy="${10 + H / 2}" r="5" fill="var(--ink)"/>`)
  }
  // The band, not the panel's own title again. The heading is directly above it,
  // and a row label that repeats it wastes the one column that could say which
  // cohort the quartiles belong to.
  parts.push(`<text x="0" y="${10 + H / 2 + 4}" class="lbl">${e(r.band ?? '—')}</text>`)

  const cash = (v: number) => e(money(v, sig.currency ?? r.currency, s.numberLocale))
  const marks = [
    live === null ? null : `${cash(live)} ${e(s.pricePosLive)}`,
    rec === null ? null : `${cash(rec)} ${e(s.pricePosRecommended)}`,
  ].filter(Boolean).join(' · ')
  const where = live !== null ? pricePosition(live, p25, p50, p75, p90) : null
  const basis = sig.nbhdListings !== null && r.band
    ? e(s.pricePosBasis(Math.round(sig.nbhdListings), r.band))
    : e(s.pricePosNoBasis)

  return `<section class="panel"><h3>${e(s.pricePosHeading)}</h3>
    <svg class="pot" viewBox="0 0 ${W} ${10 + H + 20}" role="img"
      aria-label="${e(s.pricePosHeading)}">${parts.join('')}</svg>
    <p class="mut" style="margin:.4rem 0 0;font-size:.86rem">${marks}${
      where ? ` — <b>${e(s.pricePos[where])}</b>` : ''} <span class="mut">· ${basis}</span></p>
  </section>`
}

/**
 * The macro block, and it is unconditional on purpose.
 *
 * It was nested inside the price-position block, which returns nothing when
 * there is no neighbourhood band — so on the live account, where the
 * neighbourhood panel came back in an encoding the reader could not yet parse,
 * BOTH blocks vanished and the macro layer was invisible. Which is precisely the
 * failure it exists to prevent: an absent thing that says nothing about being
 * absent looks like a thing that was never asked for.
 *
 * A layer that is missing has to be visible AS missing, and it must not be able
 * to disappear because a different layer is missing too.
 */
/**
 * One funnel chain: how many saw it, how many opened it, how many booked.
 *
 * The two shares are computed HERE from the two counts either side of them, and
 * never taken from the provider's own rate field. A rate arriving as `3.4` is
 * 3.4% or 340% and the payload does not say which — so the adapter withholds it
 * and this draws what cannot be misread.
 *
 * The chain is drawn as soon as ONE stage is known. A listing with impressions
 * and no view count is still telling us something, and blanking the whole block
 * for the missing stage would hide the stage we have.
 */
function funnelChain(
  channel: string, s: Strings, sideOf: q.FunnelSide | null,
  standing: q.CohortStanding | null = null,
): string {
  if (!sideOf) return ''
  const { impressions: seen, views, conversions: booked } = sideOf
  if (seen === null && views === null && booked === null) return ''
  // The axis is measured, so the label is derived too. A constant reading
  // "recent history" would go on saying it the day the channel starts sending
  // dates — the same failure mode as the revoked-grant sentence.
  const label = `${channel} \u00b7 ${sideOf.axis === 'forward'
    ? s.funnelAxisForward(sideOf.nights) : s.funnelAxisTrailing}`
  return `<div class="fchain"><div class="flabel">${e(label)}${
    cohortChip(standing, s)}</div>
    ${funnelChart([
      { label: s.funnelImpressions, value: seen, of: null, median: null },
      { label: s.funnelViews, value: views, of: seen,
        median: standing?.viewRateMedian ?? null },
      { label: s.funnelBookings, value: booked, of: views,
        median: standing?.bookRateMedian ?? null },
    ], s)}</div>`
}

/**
 * The macro block: either the measured funnel, or the reason there is none.
 *
 * The sentence and the numbers are mutually exclusive on purpose. This block has
 * twice shipped a claim it could not evidence — "MyDataValue is revoked",
 * rendered on every page load from a constant — and the lesson stuck: the state
 * is derived, and once real figures exist the sentence about their absence is not
 * merely wrong, it is contradicted by the numbers next to it.
 */
/* ============================================================ the three bands */
/*
 * Pulse, Today, Rooms — in that order, and each visually lighter than the one
 * above it. The order is the reader's own sequence of questions:
 *
 *   "Is anything wrong?"        one glance, one figure
 *   "What should I do?"         a ranked list, across the whole portfolio
 *   "Why, on this room?"        the drilldown
 *
 * Before this the page answered the third question only, and answered it 41
 * times in a table with no way in. The action list existed but lived INSIDE a
 * room, so seeing the eight things worth doing today meant opening rooms one at
 * a time and remembering.
 */

/**
 * The pulse: one figure large enough to be the whole answer, and the eight
 * measurements beside it as a strip rather than eight competing cards.
 *
 * The old page had TWO rows of tiles — four counters and then eight KPIs — which
 * is a category error as much as a layout one: "Rooms 41" does not belong beside
 * "Nights sold 26%". The counters are facts about the list; the KPIs are
 * judgements about the business. So the counters moved into the filter row above
 * the table, where they are what they actually are: how many rooms are in each
 * state.
 *
 * The teaching line moved into a `<details>` per tile. It has to stay reachable —
 * most readers do not know what RevPAR is — but eight paragraphs at full weight
 * turned the top of the page into an essay.
 *
 * THE DESIGN CONSTRAINT THAT SHAPED THE TILES, kept from the grid this replaced.
 * Most people reading this page are not revenue managers. They have not met
 * RevPAR, they do not know what MPI is, and — the part that decides whether the
 * page is any use — they do not know which of these numbers moves their money and
 * which is just a number. A grid of abbreviations and percentages hands them a
 * spreadsheet and hopes. So an opened tile carries, in this order: the technical
 * term (so the reader recognises the word when a channel or a consultant uses
 * it), what the figure is measured against, how many nights or bookings it rests
 * on, and one line on what it does to the money.
 *
 * The verdict word comes from one shared rule in `query.ts`, never from the
 * renderer, so two figures can never disagree about the same size of gap. And
 * `unknown` is a real verdict: a portfolio with no market data does not have good
 * occupancy, it has occupancy nobody has compared — saying "on track" there would
 * be the most comfortable lie on the page.
 */
function pulseBand(
  d: DashboardData, s: Strings, actions: number, heldCount: number, rooms: number,
): string {
  const c = d.cockpit
  const P = (v: number | null) => v === null ? '—' : pct(v, s.numberLocale)
  const M = (v: number | null) => v === null ? '—' : money(v, c.currency, s.numberLocale)
  const N = (v: number | null) => v === null ? '—' : count(v, s.numberLocale)
  const num2 = (v: number | null) => v === null ? '—'
    : new Intl.NumberFormat(s.numberLocale,
        { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v)
  /**
   * One figure, collapsed. The summary is what a reader scanning the band needs:
   * the number, its plain-language name, and the verdict as a WORD beside the dot.
   * Everything that teaches — the technical term, what the figure is measured
   * against, how many nights or bookings it rests on, and the one line on what it
   * does to the money — is one click away rather than absent.
   *
   * `basis` is not optional and never omitted. A 42% occupancy over 1230 archived
   * nights and a 42% over three are the same figure and different claims, and the
   * band that shows only the first number is the band that misleads. This line
   * was dropped once when the tiles were rebuilt as a strip; the test that caught
   * it is the reason it is a required parameter now.
   */
  const tile = (
    key: 'revpar' | 'occupancy' | 'pace' | 'mpi' | 'take' | 'visibility'
       | 'reviews' | 'blocked',
    k: q.Kpi, shown: string, against: string | null, basis: string, flag = '',
  ) => `<details class="pk v-${k.verdict}">
    <summary>
      <span class="pk-n">${k.value === null
        ? `<i class="pk-none">${e(s.cockpitNoData)}</i>` : e(shown)}</span>
      <span class="pk-name">${e(s.kpi[key].name)}</span>
      <span class="pk-dot" aria-hidden="true"></span>
      <span class="pk-v">${e(s.verdict[k.verdict])}</span>
    </summary>
    <div class="pk-body">
      <p class="pk-term">${e(s.kpi[key].term)}</p>
      ${against ? `<p class="pk-vs">${e(against)}</p>` : ''}
      <p class="pk-basis">${e(basis)}</p>
      <p class="pk-money">${e(s.kpi[key].money)}</p>
      ${flag}
    </div>
  </details>`
  return `<section class="pulse">
    <div class="hero">
      <p class="hero-k">${e(s.heroAtStake)}</p>
      <p class="hero-n">${c.atStake === null
        ? `<i>${e(s.heroNothing)}</i>` : e(M(c.atStake))}</p>
      <p class="hero-lead">${e(s.heroLead(actions, rooms))}${
        heldCount ? ` <span class="hero-held">${e(s.heroHeld(heldCount))}</span>` : ''}</p>
    </div>
    <div class="pstrip">
      ${tile('revpar', c.revpar, M(c.revpar.value),
        c.revpar.against === null ? null
          : `${s.kpi.revpar.against}: ${M(c.revpar.against)}`,
        s.cockpitBasisNights(c.revpar.basis))}
      ${tile('occupancy', c.occupancy, P(c.occupancy.value),
        c.occupancy.against === null ? null
          : `${s.kpi.occupancy.against}: ${P(c.occupancy.against)}`,
        s.cockpitBasisNights(c.occupancy.basis))}
      ${tile('pace', c.pace, N(c.pace.value), s.kpi.pace.against,
        s.cockpitBasisBookings(c.pace.basis))}
      ${tile('mpi', c.mpi, num2(c.mpi.value), s.kpi.mpi.against,
        s.cockpitBasisNights(c.mpi.basis))}
      ${tile('visibility', c.visibility,
        c.visibility.value === null ? '—' : pct(c.visibility.value * 100, s.numberLocale),
        s.kpi.visibility.against, s.cockpitBasisRooms(c.visibility.basis))}
      ${tile('take', c.takeRate,
        c.takeRate.value === null ? '—' : pct(c.takeRate.value * 100, s.numberLocale),
        s.kpi.take.against, s.cockpitBasisBookings(c.takeRate.basis))}
      ${tile('reviews', c.reviewScore,
        c.reviewScore.value === null ? '—'
          : new Intl.NumberFormat(s.numberLocale,
              { maximumFractionDigits: 1 }).format(c.reviewScore.value),
        s.kpi.reviews.against, s.cockpitBasisRooms(c.reviewScore.basis),
        c.thinReviews > 0 ? `<p class="pk-flag">${e(s.reviewsThin(c.thinReviews))}</p>` : '')}
      ${tile('blocked', c.blocked,
        c.blocked.value === null ? '—' : pct(c.blocked.value * 100, s.numberLocale),
        s.kpi.blocked.against, s.cockpitBasisNights(c.blocked.basis))}
    </div>
  </section>`
}

/**
 * Today: every proposal in the portfolio, biggest first.
 *
 * This is the band that did not exist, and its absence was the page's largest
 * usability failure. Actions are comparable across rooms and rankable by money —
 * "the eight things to do today" is the question a revenue manager actually has —
 * and the only way to see them was to open forty-one rooms one at a time.
 *
 * A held line stays in the list with its gate named, because a price case waiting
 * on a visibility problem is still something to know about. It sorts below the
 * ones that are ready, since it is not something to do today.
 */
function todayBand(
  d: DashboardData, s: Strings, list: Array<{ rows: Row[], action: Action }>,
): string {
  if (!list.length) {
    return `<section class="today">
      <div class="band-head"><h2>${e(s.todayHeading)}</h2></div>
      <p class="mut band-empty">${e(s.todayEmpty)}</p></section>`
  }
  /** Two named rooms, then a count. Beyond that the names stop informing. */
  const NAMED = 2
  const roomLink = (row: Row) => {
    const p = new URLSearchParams({ basis: d.basis, lang: d.lang, view: d.view,
                                    sort: d.sort, open: row.entityId })
    if (d.group) p.set('group', d.group)
    return `<a href="/?${p.toString()}#row-${e(row.entityId)}">${e(row.label)}</a>`
  }
  const line = ({ rows, action: a }: { rows: Row[], action: Action }) => {
    const shown = rows.slice(0, NAMED).map(roomLink).join(', ')
    const rest = rows.length - NAMED
    return `<li class="wl ${a.blockedBy ? 'held' : 'ready'}">
      <span class="wl-lever">${e(s.leverLabel[a.lever])}</span>
      <span class="wl-move">${a.from !== null && a.to !== null
        ? `<s>${e(a.from)}</s> <b>${e(a.to)}</b>` : `<b>${e(a.scope)}</b>`}</span>
      <span class="wl-room">${shown}${rest > 0
        ? ` <span class="wl-more">${e(s.andMoreRooms(rest))}</span>` : ''}</span>
      <span class="wl-scope">${a.from !== null ? e(a.scope) : ''}</span>
      <span class="wl-worth">${a.worth !== null && rows[0]
        ? e(money(a.worth, rows[0].currency, s.numberLocale)) : ''}</span>
      ${a.blockedBy ? `<span class="wl-gate">${
        e(s.actionHeld(s.stage[a.blockedBy] ?? a.blockedBy))}</span>` : ''}
    </li>`
  }
  return `<section class="today">
    <div class="band-head">
      <h2>${e(s.todayHeading)}</h2>
      <p class="mut">${e(s.todayLead)}</p>
    </div>
    <ol class="wlist">${list.map(line).join('')}</ol>
  </section>`
}

/** The filter row: what the four old counters actually were. */
function filterBar(
  d: DashboardData, s: Strings, counts: Record<RoomView, number>, shown: number,
  groups: Array<{ name: string, n: number }>,
): string {
  const link = (v: RoomView) => {
    const p = new URLSearchParams({ basis: d.basis, lang: d.lang, view: v, sort: d.sort })
    if (d.group) p.set('group', d.group)
    return `<a class="${d.view === v ? 'on' : ''}" href="/?${p.toString()}#rooms"
      >${e(s.view[v])} <span class="fc">${counts[v]}</span></a>`
  }
  const sortLink = (k: RoomSort) => {
    const p = new URLSearchParams({ basis: d.basis, lang: d.lang, view: d.view, sort: k })
    if (d.group) p.set('group', d.group)
    return `<a class="${d.sort === k ? 'on' : ''}" href="/?${p.toString()}#rooms"
      >${e(s.sorting[k])}</a>`
  }
  /**
   * The group picker, as a plain GET form with a submit button.
   *
   * No JavaScript: this page has none and adding a listener for one dropdown
   * would make the control's behaviour depend on a script loading. A `<select>`
   * inside a form that GETs back to `/` is the same navigation every other
   * control here already is, and it works with the keyboard, with a screen
   * reader, and with the back button for free.
   *
   * Hidden fields carry the rest of the state, for the reason the filter row
   * already carries it: a control that resets another reads as the page losing
   * your place.
   */
  const groupPicker = groups.length === 0 ? '' : `<form class="gpick" method="get" action="/">
    <input type="hidden" name="basis" value="${e(d.basis)}">
    <input type="hidden" name="lang" value="${e(d.lang)}">
    <input type="hidden" name="view" value="${e(d.view)}">
    <input type="hidden" name="sort" value="${e(d.sort)}">
    <label for="gsel">${e(s.groupLabel)}</label>
    <select id="gsel" name="group">
      <option value=""${d.group ? '' : ' selected'}>${e(s.groupAll(counts.all))}</option>
      ${groups.map(g => `<option value="${e(g.name)}"${
        d.group === g.name ? ' selected' : ''}>${e(g.name)} (${g.n})</option>`).join('')}
    </select>
    <button type="submit">${e(s.groupApply)}</button>
  </form>`

  return `<div class="band-head" id="rooms">
    <h2>${e(s.roomsHeading)} <span class="mut count">${
      e(s.shownOf(shown, counts.all))}</span></h2>
    ${groupPicker}
  </div>
  <div class="bar">
    <nav class="seg">${(['all', 'act', 'held', 'quiet', 'na'] as const)
      .map(link).join('')}</nav>
    <nav class="seg quiet"><span class="seg-k">${e(s.sortBy)}</span>${
      (['money', 'risk', 'name'] as const).map(sortLink).join('')}</nav>
  </div>`
}


/**
 * The action list. This block is the reason the rest of the page exists.
 *
 * It sits FIRST inside an opened row, above the measurements, because a reader
 * who has to scroll past six panels to find out what to do will read six panels
 * and do nothing. The measurements are the evidence for this list, not a preamble
 * to it.
 *
 * A HELD action stays visible with its gate named. Hiding it would leave the
 * reader believing the room has no price case, when what it has is a price case
 * waiting on a visibility problem — and that distinction is the single most
 * valuable thing this engine knows.
 */
function actionsBlock(list: Action[], s: Strings): string {
  if (!list.length) {
    return `<section class="panel"><h3>${e(s.actionsHeading)}</h3>
      <p class="mut" style="margin:0;font-size:.86rem">${e(s.actionsNone)}</p></section>`
  }
  const line = (a: Action) => `<li class="act ${a.blockedBy ? 'held' : ''} lv-${a.lever}">
    <div class="act-h">
      <span class="act-lever">${e(s.leverLabel[a.lever])}</span>
      ${a.from !== null && a.to !== null ? `<span class="act-move">
        <span class="act-from">${e(a.from)}</span>
        <span class="act-arr">${e(s.actionArrow)}</span>
        <span class="act-to">${e(a.to)}</span></span>` : ''}
      <span class="act-scope">${e(a.scope)}</span>
      ${a.worth !== null ? `<span class="act-worth">${
        e(money(a.worth, null, s.numberLocale))} <i>${e(s.actionWorth)}</i></span>` : ''}
    </div>
    ${a.blockedBy ? `<div class="act-gate">${
      e(s.actionHeld(s.stage[a.blockedBy] ?? a.blockedBy))}</div>` : ''}
    <div class="act-why">${e(a.because)}</div></li>`
  return `<section class="panel act-panel"><h3>${e(s.actionsHeading)}</h3>
    <p class="mut" style="margin:0 0 .6rem;font-size:.78rem">${e(s.actionsLead)}</p>
    <ol class="acts">${list.map(line).join('')}</ol></section>`
}

/**
 * How our own guests book: lead time, stay length, and where they come from.
 *
 * Every figure is out of `booking_economics`, which has carried `booked_at`,
 * `arrival`, `nights` and `guest_country` since the first PriceLabs pass and was
 * selected by nothing. Guest origin in particular is the thing the macro block
 * has spent weeks describing as absent — for realised bookings it was in a
 * column all along.
 *
 * The note underneath is not decoration. This is who BOOKED; who SEARCHED is a
 * different population and lives in a report that is measured but not yet
 * stored. Presenting one as the other would be the most plausible-looking
 * mistake available here.
 */
function demandBlock(dm: q.DemandShape | undefined, s: Strings): string {
  if (!dm || !dm.bookings) {
    return `<section class="panel"><h3>${e(s.demandHeading)}</h3>
      <p class="mut" style="margin:0;font-size:.86rem">${e(s.demandNone)}</p></section>`
  }
  const days = (v: number | null) => v === null ? '—'
    : new Intl.NumberFormat(s.numberLocale, { maximumFractionDigits: 0 }).format(v)
  // A range, not a single number: a median lead time of 34 days with a quartile
  // spread of 8 to 96 is a different business from one that spreads 30 to 38.
  const spread = (lo: number | null, mid: number | null, hi: number | null) =>
    `<span class="dq">${days(lo)}</span><b>${days(mid)}</b><span class="dq">${days(hi)}</span>`
  const top = dm.origins.slice(0, 6)
  const rest = dm.origins.slice(6).reduce((n, c) => n + c.bookings, 0)
  const total = dm.origins.reduce((n, c) => n + c.bookings, 0)
  const bars = top.map((c, i) => `<div class="orow">
      <div class="oname">${e(c.country)}</div>
      <div class="otrack"><span style="width:${(c.share * 100).toFixed(1)}%;
        background:var(--c${(i % 4) + 1})"></span></div>
      <div class="oval">${e(pct(c.share * 100, s.numberLocale))}</div>
    </div>`).join('') + (rest > 0 && total > 0 ? `<div class="orow">
      <div class="oname mut">+${dm.origins.length - top.length}</div>
      <div class="otrack"><span style="width:${(rest / total * 100).toFixed(1)}%;
        background:var(--mut)"></span></div>
      <div class="oval">${e(pct(rest / total * 100, s.numberLocale))}</div></div>` : '')
  return `<section class="panel"><h3>${e(s.demandHeading)}</h3>
    <p class="mut" style="margin:0 0 .55rem;font-size:.78rem">${
      e(s.demandWindow(demandWindowDays, dm.bookings))}</p>
    <div class="dgrid">
      <div><div class="dlab">${e(s.demandLead)}</div>
        <div class="dval">${spread(dm.leadP25, dm.leadMedian, dm.leadP75)}</div></div>
      <div><div class="dlab">${e(s.demandStay)}</div>
        <div class="dval">${spread(null, dm.nightsMedian, dm.nightsP75)}</div></div>
    </div>
    ${bars ? `<div class="dlab" style="margin-top:.7rem">${e(s.demandOrigin)}</div>
      <div class="orig">${bars}</div>` : ''}
    <p class="mut" style="margin:.55rem 0 0;font-size:.76rem">${
      e(s.demandOriginSearchNote)}</p></section>`
}

/* =========================================================== charts ======= */
/*
 * Every chart here is inline SVG on the page's own tokens, and every one of them
 * follows three rules that came out of getting them wrong first:
 *
 *   ONE AXIS, ALWAYS. Two measures of different scale get two charts, never two
 *   y-scales on one. A funnel that runs 99'014 → 743 → 12 cannot be drawn on a
 *   linear axis at all — the last two stages are invisible slivers — so it is
 *   drawn as nested proportions instead of forced onto one.
 *
 *   IDENTITY IS NEVER COLOUR ALONE. The four chart hues were validated against
 *   colour-vision simulation, and blue and green still sit close under
 *   tritanopia. So every series is directly labelled as well as coloured.
 *
 *   THE DENOMINATOR TRAVELS WITH THE NUMBER. A share over three bookings and a
 *   share over sixty are different claims, and a chart that hides the count is
 *   the most confident kind of wrong.
 */

/** A funnel stage: how many, the share of the stage above, and our own median. */
interface Stage {
  label: string
  value: number | null
  of: number | null
  /** The cohort's median for THIS step, which is what gives the share a scale. */
  median: number | null
}

/**
 * The funnel: three counts, two rates, and each rate against our own median.
 *
 * THE FORM CHANGED AFTER LOOKING AT IT. The first version drew each stage as a
 * share of the stage above, on the reasoning that every bar would then use the
 * full width. It does not: the measured chain is 99'014 seen → 743 opened → 12
 * booked, so the second bar is 0.75% of the track and the third is smaller
 * still. Two invisible slivers, under a comment claiming they could not happen.
 *
 * A rate of 0.75% has no readable position on a 0-100% track, and log scaling
 * only moves the problem into the reader's head. What it does have a readable
 * position against is the MEDIAN OF OUR OWN SET — below the middle or above it —
 * and that is also the only comparison this project can defend, since no
 * provider sells the neighbours' funnel. So the track runs 0 to twice the
 * median, the median is ticked at the centre, and a rate off the end is clamped
 * with the number still printed.
 *
 * Without a cohort there is no scale, so no meter is drawn — the counts and the
 * rate stand on their own rather than sitting on an invented axis.
 */
function funnelChart(stages: Stage[], s: Strings): string {
  const drawn = stages.filter(st => st.value !== null)
  if (!drawn.length) return ''
  const rows = drawn.map((st, i) => {
    const share = st.of !== null && st.of > 0 && st.value !== null
      ? st.value / st.of : null
    const meter = (() => {
      if (share === null) return ''
      if (st.median === null || st.median <= 0) {
        return `<span class="fm-none">${e(s.cohortNoScale)}</span>`
      }
      const full = st.median * 2
      const at = Math.min(1, share / full)
      const over = share > full
      return `<span class="fm" title="${e(s.cohortMedianIs(pct(st.median * 100, s.numberLocale)))}">
        <span class="fm-fill${over ? ' over' : ''}" style="width:${(at * 100).toFixed(1)}%"></span>
        <span class="fm-mid"></span></span>`
    })()
    return `${i > 0 ? `<div class="fstep">
        <span class="fstep-r">${share === null ? ''
          : e(pct(share * 100, s.numberLocale))}</span>${meter}</div>` : ''}
      <div class="fst">
        <span class="fst-n">${e(count(st.value ?? 0, s.numberLocale))}</span>
        <span class="fst-l">${e(st.label)}</span>
      </div>`
  })
  return `<div class="fun">${rows.join('')}</div>`
}

/**
 * Occupancy across three horizons, ours against the market, with last year marked.
 *
 * A slope chart rather than bars: the question is not "how much at 30 days" but
 * "is the gap widening as the horizon lengthens", and only a line answers that.
 * One axis, in percent, for both series — they are the same measure.
 */
function horizonChart(sig: q.Signals, s: Strings): string {
  const ours = [sig.occupancy7, sig.occupancy, sig.occupancy90]
  if (ours.every(v => v === null)) return ''
  const theirs = [null, sig.marketOccupancy, null]
  const W = 560, H = 150, PAD_B = 26, PAD_T = 14, PAD_R = 54
  const all = [...ours, ...theirs, sig.stlyOccupancy].filter((v): v is number => v !== null)
  const top = Math.max(20, Math.ceil(Math.max(...all) / 10) * 10 + 5)
  const x = (i: number) => (i / 2) * (W - PAD_R)
  const y = (v: number) => PAD_T + (1 - v / top) * (H - PAD_T - PAD_B)
  const parts: string[] = []
  // A recessive grid: two lines, no box, no ticks the reader has to decode.
  for (const g of [0, top / 2, top]) {
    parts.push(`<line x1="0" y1="${y(g)}" x2="${W - PAD_R}" y2="${y(g)}"
      class="cx-grid"></line>`)
    parts.push(`<text x="${W - PAD_R + 6}" y="${y(g) + 4}" class="cx-ax">${
      e(pct(g, s.numberLocale))}</text>`)
  }
  const line = (vals: Array<number | null>, cls: string) => {
    const pts = vals.map((v, i) => v === null ? null : `${x(i)},${y(v)}`)
      .filter((p): p is string => p !== null)
    if (pts.length < 2) return ''
    return `<polyline points="${pts.join(' ')}" class="cx-line ${cls}"></polyline>`
  }
  parts.push(line(ours, 'c2'))
  ours.forEach((v, i) => {
    if (v === null) return
    parts.push(`<circle cx="${x(i)}" cy="${y(v)}" r="4.5" class="cx-dot c2"></circle>`)
  })
  if (sig.marketOccupancy !== null) {
    parts.push(`<circle cx="${x(1)}" cy="${y(sig.marketOccupancy)}" r="4.5"
      class="cx-dot c1"></circle>`)
    // Right-anchored, left of the point: the "ours" label sits to the right of
    // the same x, and at a small gap the two collide.
    parts.push(`<text x="${x(1) - 10}" y="${y(sig.marketOccupancy) + 4}" class="cx-dl c1"
      text-anchor="end">${e(s.potentialMarket)} ${
      e(pct(sig.marketOccupancy, s.numberLocale))}</text>`)
  }
  if (sig.stlyOccupancy !== null) {
    // Last year is a REFERENCE, not a series: a dashed rule with its own label,
    // so it cannot be mistaken for a fourth measurement.
    parts.push(`<line x1="0" y1="${y(sig.stlyOccupancy)}" x2="${W - PAD_R}"
      y2="${y(sig.stlyOccupancy)}" class="cx-ref"></line>`)
    // Right-aligned at the end of its own rule: the middle of the plot is where
    // both series labels live, and three labels competing for it collided.
    parts.push(`<text x="${W - PAD_R - 4}" y="${y(sig.stlyOccupancy) - 7}"
      class="cx-dl mut" text-anchor="end">${e(s.trendYoy)} ${
      e(pct(sig.stlyOccupancy, s.numberLocale))}</text>`)
  }
  if (sig.occupancy !== null) {
    parts.push(`<text x="${x(1) + 9}" y="${y(sig.occupancy) - 8}" class="cx-dl c2">${
      e(s.potentialOurs)} ${e(pct(sig.occupancy, s.numberLocale))}</text>`)
  }
  ;['7', '30', '90'].forEach((n, i) => {
    parts.push(`<text x="${x(i)}" y="${H - 6}" class="cx-ax"
      text-anchor="${i === 0 ? 'start' : i === 2 ? 'end' : 'middle'}">${e(n)}</text>`)
  })
  return `<svg class="cx" viewBox="0 0 ${W} ${H}" role="img"
    aria-label="${e(s.horizonAria)}">${parts.join('')}</svg>`
}

/**
 * Channel mix as ONE stacked bar.
 *
 * Two rows of separate bars invited a comparison between channels' absolute
 * revenue; the question is what share each takes of this room's gross, which is
 * a part-to-whole and belongs in one bar. Segments get a 2px gap so adjacent
 * fills never touch, and each is labelled by name — the hues pass validation but
 * blue and green are close under tritanopia, so the name carries identity.
 */
const CHANNEL_ORDER = ['booking', 'airbnb', 'direct', 'other']
const channelHue = (name: string): string => {
  const i = CHANNEL_ORDER.indexOf(name.toLowerCase())
  // A fifth channel is never given an invented hue: it folds into the fourth
  // slot, because a colour that appears once is a colour nobody learns.
  return `var(--c${(i < 0 ? 3 : i) + 1})`
}

function channelChart(real: q.Realised, s: Strings, cur: string | null): string {
  if (!real.channels.length || real.revenue <= 0) return ''
  const W = 560, BAR = 26, GAP = 2
  let cursor = 0
  const segs: string[] = []
  const legend: string[] = []
  for (const c of real.channels) {
    const w = Math.max(0, c.share * W - GAP)
    if (w > 1) {
      segs.push(`<rect x="${cursor.toFixed(1)}" y="0" width="${w.toFixed(1)}"
        height="${BAR}" rx="3" fill="${channelHue(c.name)}"></rect>`)
      if (w > 74) {
        segs.push(`<text x="${(cursor + w / 2).toFixed(1)}" y="${BAR / 2 + 4}"
          class="cx-seg" text-anchor="middle">${e(pct(c.share * 100, s.numberLocale))}</text>`)
      }
    }
    cursor += c.share * W
    legend.push(`<span class="cx-key"><i style="background:${channelHue(c.name)}"></i>${
      e(c.name)} · ${e(pct(c.share * 100, s.numberLocale))} · ${
      e(money(c.revenue, cur, s.numberLocale))}</span>`)
  }
  return `<svg class="cx" viewBox="0 0 ${W} ${BAR}" role="img"
      aria-label="${e(s.channelAria)}">${segs.join('')}</svg>
    <div class="cx-keys">${legend.join('')}</div>`
}

/**
 * The commercial levers as a MATRIX, not a chip pile.
 *
 * This replaces a row of nine equal chips, which is what "shown as a whole
 * instead of per listing" was really describing: nine independent-looking
 * switches, in no order, repeated identically on every room. The provider groups
 * these deal types itself — the payload carries a `family` — and the nine are a
 * fixed vocabulary, so the honest form is a fixed grid where a listing's row can
 * be compared against the one above it at a glance, and an EMPTY cell is as
 * informative as a filled one.
 *
 * Three states, never two: on, off, and not stated. A switch the payload never
 * sent is not a switch that is off.
 */
function leverMatrix(
  known: string[], own: q.Promotion[], s: Strings,
): string {
  if (!known.length) return ''
  const byKind = new Map(own.map(p => [p.kind, p]))
  const cell = (kind: string) => {
    const p = byKind.get(kind)
    const state = !p ? 'none' : p.active === null ? 'unk' : p.active ? 'on' : 'off'
    const label = p?.discountPct !== null && p?.discountPct !== undefined
      ? pct(p.discountPct, s.numberLocale) : ''
    return `<div class="lv ${state}" title="${e(kind)}">
      <div class="lv-k">${e(kind.replace(/_/g, ' ').toLowerCase())}</div>
      <div class="lv-v">${label ? e(label) : state === 'on' ? '●'
        : state === 'unk' ? '?' : ''}</div></div>`
  }
  return `<div class="lvgrid">${known.map(cell).join('')}</div>`
}

/**
 * How many rooms run each lever, across the portfolio.
 *
 * The account-wide view done as a question worth asking — "which lever are we
 * barely using" — rather than as a list of every promotion on the account. Bars
 * because the job is comparing magnitudes across a category; sorted, because an
 * unsorted bar chart makes the reader do the sorting.
 */
function leverCoverage(
  rows: Array<{ kind: string, on: number, of: number }>, s: Strings,
): string {
  if (!rows.length) return ''
  const W = 560, ROW = 22, LAB = 150
  const max = Math.max(...rows.map(r => r.of), 1)
  const parts = rows.map((r, i) => {
    const y = i * ROW
    const track = W - LAB - 46
    const wOn = (r.on / max) * track
    return `<text x="0" y="${y + 14}" class="cx-lab">${
        e(r.kind.replace(/_/g, ' ').toLowerCase())}</text>
      <rect x="${LAB}" y="${y + 5}" width="${track}" height="11" rx="3"
        fill="var(--sunk)"></rect>
      <rect x="${LAB}" y="${y + 5}" width="${Math.max(0, wOn).toFixed(1)}" height="11"
        rx="3" fill="var(--c1)"></rect>
      <text x="${W}" y="${y + 14}" class="cx-val" text-anchor="end">${r.on}</text>`
  })
  return `<svg class="cx" viewBox="0 0 ${W} ${rows.length * ROW}" role="img"
    aria-label="${e(s.coverageAria)}">${parts.join('')}</svg>`
}

/**
 * A review score on its own channel's scale, with the portfolio median marked.
 *
 * A number alone cannot be read: 8.6 is good on Booking's ten and impossible on
 * Airbnb's five. So the scale is drawn, the maximum is stated, and the median of
 * our own set is a tick — which is the only comparison available, since no
 * provider sells the neighbours' review scores either.
 */
function scoreStrip(
  score: number, max: number, median: number | null, s: Strings,
): string {
  const W = 240, H = 20
  const at = (v: number) => Math.max(0, Math.min(1, v / max)) * W
  return `<svg class="cx-strip" viewBox="-2 0 ${W + 4} ${H}" role="img"
      aria-label="${e(s.reviewsScore)}">
    <rect x="0" y="${H / 2 - 4}" width="${W}" height="8" rx="4" fill="var(--sunk)"></rect>
    <rect x="0" y="${H / 2 - 4}" width="${at(score).toFixed(1)}" height="8" rx="4"
      fill="var(--c-brand-2)"></rect>
    ${median === null ? '' : `<line x1="${at(median).toFixed(1)}" y1="1"
      x2="${at(median).toFixed(1)}" y2="${H - 1}" class="cx-ref"></line>`}
    <circle cx="${at(score).toFixed(1)}" cy="${H / 2}" r="5" class="cx-dot c2"></circle>
  </svg>`
}

/* ================================================ rank and visibility ====== */

/**
 * Where this room stands in the channel's search, and which way it is moving.
 *
 * THE ONE FIGURE ON THIS PAGE WHERE DOWN IS GOOD. Every other number here reads
 * better when it is larger; a rank reads better when it is smaller. So the
 * direction is written in WORDS next to every movement rather than left to an
 * arrow or a colour: "7 places better" cannot be misread, and a green -7 can.
 *
 * THE TWO CHANNELS ARE NOT MERGED. Booking.com sends a rank per property.
 * Airbnb's performance endpoint sends no rank at all — what it sends is an
 * average search position and a first-page impression count, a different measure
 * of the same worry. Averaging a rank of 12 with a position of 12 would produce a
 * figure neither channel would recognise, so each is labelled as its own thing
 * and the channel that supplies nothing says so instead of showing a blank.
 */
function rankPanel(st: q.SearchStanding | undefined, s: Strings): string {
  const lines: string[] = []

  if (st?.bookingRank) {
    const { rank, prior, sinceFirst } = st.bookingRank
    // The movement, stated as a direction and a count of places. `sinceFirst` is
    // signed with negative meaning better, so the words come from the sign and
    // the absolute value is what gets printed.
    const moved = sinceFirst === null ? null
      : sinceFirst === 0 ? s.rankUnmoved
      : sinceFirst < 0 ? s.rankBetter(Math.abs(sinceFirst))
      : s.rankWorse(sinceFirst)
    const cls = sinceFirst === null || sinceFirst === 0 ? 'mut'
      : sinceFirst < 0 ? 'good' : 'bad'
    lines.push(`<div class="rk">
      <div class="rk-k">${e(s.rankChannelBooking)}</div>
      <div class="rk-n">#${e(count(rank, s.numberLocale))}</div>
      ${/* Two DIFFERENT comparisons, so they get two lines. Run together they
             read as one sentence — "5 places better since first measured was #17
             in the previous period" — which is the sort of sentence a reader
             untangles once and then stops trusting. */ ''}
      <div class="rk-m">${moved ? `<b class="${cls}">${e(moved)}</b>` : ''}</div>
      ${prior !== null
        ? `<div class="rk-m"><span class="mut">${e(s.rankPrior(prior))}</span></div>`
        : ''}
    </div>`)
  } else {
    lines.push(`<div class="rk none">
      <div class="rk-k">${e(s.rankChannelBooking)}</div>
      <div class="rk-n">&mdash;</div>
      <div class="rk-m"><span class="mut">${e(s.rankNoneBooking)}</span></div>
    </div>`)
  }

  if (st && st.airbnbPosition !== null) {
    lines.push(`<div class="rk">
      <div class="rk-k">${e(s.rankChannelAirbnb)}</div>
      <div class="rk-n">${e(count(st.airbnbPosition, s.numberLocale))}</div>
      <div class="rk-m"><span class="mut">${e(s.rankPositionNote)}</span></div>
    </div>`)
  } else {
    lines.push(`<div class="rk none">
      <div class="rk-k">${e(s.rankChannelAirbnb)}</div>
      <div class="rk-n">&mdash;</div>
      <div class="rk-m"><span class="mut">${e(s.rankNoneAirbnb)}</span></div>
    </div>`)
  }

  /**
   * First-page impressions as a SHARE where the total is known.
   *
   * 4'100 first-page impressions means nothing without the total it came out of,
   * and the share is the number that answers "are we being found". Where the
   * total is missing the raw count is shown and labelled as a raw count, rather
   * than dividing by something we do not have.
   */
  if (st && st.firstPage !== null) {
    const total = st.airbnbImpressions
    const share = total !== null && total > 0 ? (st.firstPage / total) * 100 : null
    lines.push(`<div class="rk">
      <div class="rk-k">${e(s.rankFirstPage)}</div>
      <div class="rk-n">${share === null
        ? e(count(st.firstPage, s.numberLocale))
        : e(pct(share, s.numberLocale))}</div>
      <div class="rk-m"><span class="mut">${share === null
        ? e(s.rankFirstPageBare)
        : e(s.rankFirstPageOf(st.firstPage, total!))}</span></div>
    </div>`)
  }

  return `<section class="panel">
    <h3>${e(s.rankHeading)}</h3>
    <p class="mut sub-lead">${e(s.rankLead)}</p>
    <div class="rkrow">${lines.join('')}</div>
  </section>`
}

/**
 * The account's daily percentile in the channel's own ranking, per channel.
 *
 * TWO THINGS THIS PANEL REFUSES TO CLAIM, both of them things a line chart makes
 * it very easy to imply:
 *
 *   IT IS NOT A ROOM'S RANK. The provider aggregates over the whole account, so
 *   there is no per-room component — and no way to narrow it to a group either,
 *   only to fake one. It sits with the other account-level panels and names whose
 *   figure it is.
 *
 *   THE GOOD DIRECTION IS NOT STATED BY THE PROVIDER. Nothing in the payload says
 *   whether a higher percentile is a better position or a worse one. So the line
 *   carries no good/bad colour and no verdict: the MOVEMENT is the finding, and a
 *   movement is legible without knowing which end is which. Choosing a direction
 *   here would be a coin toss rendered as a fact.
 */
function rankTimelineChart(
  series: Map<string, q.RankPoint[]>, s: Strings, group: string | null,
): string {
  const drawn = ([['mdv_booking', s.rankChannelBooking, 'c1'],
                  ['mdv_airbnb', s.rankChannelAirbnb, 'c2']] as const)
    .map(([key, label, cls]) => ({ label, cls, pts: series.get(key) ?? [] }))
    .filter(x => x.pts.length >= 2)
  if (!drawn.length) return ''

  const W = 620, H = 156, L = 34, R = 14, T = 14, B = 28
  const all = drawn.flatMap(x => x.pts)
  const dates = [...new Set(all.map(p => p.date))].sort()
  const lo = Math.min(...all.map(p => p.percentile))
  const hi = Math.max(...all.map(p => p.percentile))
  /**
   * A flat series must not divide by zero, and must not be stretched to fill the
   * box either. A line that never moved should look like one — stretching it
   * turns rounding noise into a dramatic trend, which is the single easiest way
   * to make a chart lie without any number being wrong.
   */
  const flat = hi - lo < 1
  const span = flat ? 1 : hi - lo
  const yLo = flat ? (hi + lo) / 2 - 0.5 : lo
  const x = (d: string) =>
    L + (dates.indexOf(d) / Math.max(1, dates.length - 1)) * (W - L - R)
  const y = (v: number) => T + (1 - (v - yLo) / span) * (H - T - B)

  const parts: string[] = []
  for (const g of [yLo, yLo + span / 2, yLo + span]) {
    parts.push(`<line x1="${L}" y1="${y(g).toFixed(1)}" x2="${W - R}" y2="${
      y(g).toFixed(1)}" class="cx-grid"></line>`)
    parts.push(`<text x="${L - 6}" y="${(y(g) + 4).toFixed(1)}" class="cx-ax"
      text-anchor="end">${g.toFixed(0)}</text>`)
  }
  /**
   * Labels are placed by RANK at the right edge, not at a fixed offset.
   *
   * The first version put every label nine pixels above its own endpoint. When
   * the two series finished ten points apart, the labels overlapped each other
   * and one of them sat on top of the other's line — legible in the source,
   * unreadable on screen, and invisible to every test. Rendering it and looking
   * is what found it. So: the series with the higher final value gets its label
   * above, the lower one below, and both stop short of the dot.
   */
  const ends = drawn
    .map(d => ({ ...d, pts: [...d.pts].sort((a, b) => a.date.localeCompare(b.date)) }))
    .map(d => ({ ...d, last: d.pts[d.pts.length - 1]! }))
    .sort((a, b) => b.last.percentile - a.last.percentile)

  for (const [i, d] of ends.entries()) {
    parts.push(`<path d="${d.pts.map((p, n) =>
      `${n ? 'L' : 'M'}${x(p.date).toFixed(1)},${y(p.percentile).toFixed(1)}`)
      .join(' ')}" class="cx-line ${d.cls}"></path>`)
    parts.push(`<circle cx="${x(d.last.date).toFixed(1)}" cy="${
      y(d.last.percentile).toFixed(1)}" r="3.5" class="cx-dot ${d.cls}"></circle>`)
    // Every series carries a direct label. Blue and amber separate well, but
    // identity is never colour alone anywhere on this page.
    const above = i === 0 || ends.length === 1
    parts.push(`<text x="${(x(d.last.date) - 8).toFixed(1)}" y="${
      (y(d.last.percentile) + (above ? -10 : 17)).toFixed(1)}" class="cx-dl ${d.cls}"
      text-anchor="end">${e(d.label)}</text>`)
  }
  parts.push(`<text x="${L}" y="${H - 7}" class="cx-ax">${e(dates[0]!)}</text>`)
  parts.push(`<text x="${W - R}" y="${H - 7}" class="cx-ax" text-anchor="end">${
    e(dates[dates.length - 1]!)}</text>`)

  return `<section class="card">
    <h2 class="ph">${e(s.rankTimelineHeading)}</h2>
    <p class="mut sub-lead">${e(s.rankTimelineNote)}${
      group ? ` ${e(s.rankTimelineAccount(group))}` : ''}</p>
    <svg class="cx" viewBox="0 0 ${W} ${H}" role="img"
      aria-label="${e(s.rankTimelineHeading)}">${parts.join('')}</svg>
    <p class="mut caveat">${e(s.rankTimelineDirection)}</p>
  </section>`
}

/* ------------------------------------------------- what the archive already had */

/**
 * The trend line the archive has held all along.
 *
 * Twelve measures over seven windows have been written since the first PriceLabs
 * pass; the page showed six numbers, all from one window. Occupancy at 26% is not
 * a finding — 26% against 41% last year is, and 26% at seven nights against 38%
 * at ninety is a different one again. The numbers were never missing; nothing
 * asked for them.
 */
function trendBlock(sig: q.Signals | undefined, s: Strings): string {
  if (!sig) return ''
  const pp = (v: number | null) => v === null ? null : pct(v, s.numberLocale)
  const line = (label: string, cells: Array<string | null>) =>
    cells.every(c => c === null) ? '' : `<div class="trow">
      <div class="tlab">${e(label)}</div>
      <div class="tval">${cells.map(c =>
        `<span>${c === null ? '<i class="mut">—</i>' : e(c)}</span>`).join('')}</div></div>`
  // Deliberately NOT repeating the three horizons or last year: both are drawn
  // in the chart above, and a table restating a chart teaches the reader that one
  // of the two is not to be trusted.
  const body = line(s.trendBlocked, [pp(sig.adjustedOccupancy)])
    + line(s.trendRevpar, [sig.revpar === null ? null
        : money(sig.revpar, sig.currency, s.numberLocale)])
  const chart = horizonChart(sig, s)
  if (!body && !chart) return ''
  return `<section class="panel"><h3>${e(s.occupancy30)}</h3>
    ${chart}${body ? `<div class="trend">${body}</div>` : ''}</section>`
}

/**
 * What actually sold, and what the channels took for it.
 *
 * `booking_economics` has eighteen columns and 541 measured rows on this account.
 * The dashboard query referenced it exactly zero times, which is why every
 * per-channel figure in the plan read as "not built" when it was "not asked for".
 */
function realisedBlock(r: Row, real: q.Realised | undefined, s: Strings): string {
  if (!real || !real.bookings) {
    return `<section class="panel"><h3>${e(s.realisedHeading)}</h3>
      <p class="mut" style="margin:0;font-size:.86rem">${
        e(s.realisedNone(realisedWindowDays))}</p></section>`
  }
  const cur = real.currency ?? r.currency
  const stat = (label: string, value: string) =>
    `<div class="rstat"><div class="rnum">${e(value)}</div>
      <div class="rlab">${e(label)}</div></div>`
  const bars = channelChart(real, s, cur)
  return `<section class="panel"><h3>${e(s.realisedHeading)}</h3>
    <p class="mut" style="margin:0 0 .6rem;font-size:.78rem">${
      e(s.realisedWindow(realisedWindowDays, real.bookings))}</p>
    <div class="rstats">
      ${stat(s.realisedRevenue, money(real.revenue, cur, s.numberLocale))}
      ${stat(s.realisedNights, count(real.nights, s.numberLocale))}
      ${stat(s.realisedCommission, real.commissionRate === null
        ? money(real.commission, cur, s.numberLocale)
        : `${money(real.commission, cur, s.numberLocale)} · ${
            pct(real.commissionRate * 100, s.numberLocale)}`)}
    </div>
    ${bars ? `<div class="chan">${bars}</div>` : ''}
    <p class="mut" style="margin:.55rem 0 0;font-size:.76rem">${
      e(s.realisedCommissionNote)}</p></section>`
}

/**
 * Reviews, and the handicap a thin one carries.
 *
 * MyDataValue's own ranking match weights the score at 18.4% and the count at
 * 3.1%. A perfect score from one review therefore loses in search, and no price
 * change repairs it — which is exactly the case a pricing tool cannot see and
 * proposes prices against forever. So the count is never shown without the
 * sentence when it is thin.
 */
const THIN_REVIEWS = 5

function reviewsBlock(
  st: { booking: q.ReviewStanding | null, airbnb: q.ReviewStanding | null } | undefined,
  s: Strings,
): string {
  /**
   * The scale, taken from the score itself and not from the channel name.
   *
   * Booking runs 0-10 and Airbnb 0-5, and hardcoding that per channel would be a
   * claim about the provider's conventions rather than a reading of the payload.
   * A value above 5 can only be on a ten-point scale; below it, either is
   * possible, so the smaller one is used — it is the one that cannot overstate.
   */
  const side = (channel: string, v: q.ReviewStanding | null, median: number | null) => {
    const scale = v && v.score !== null && v.score > 5 ? 10 : 5
    if (!v || (v.score === null && v.count === null)) return ''
    const thin = v.count !== null && v.count <= THIN_REVIEWS
    return `<div class="rvside">
      <div class="flabel">${e(channel)}</div>
      <div class="rvnums">
        <span class="rvscore">${v.score === null ? '<i class="mut">—</i>'
          : e(new Intl.NumberFormat(s.numberLocale,
              { maximumFractionDigits: 1 }).format(v.score))}</span>
        <span class="mut">${e(s.reviewsScore)}</span>
        ${v.score === null ? '' : scoreStrip(v.score, scale, median, s)}
        <span class="rvcount${thin ? ' thin' : ''}">${v.count === null ? '—'
          : e(count(v.count, s.numberLocale))}</span>
        <span class="mut">${e(s.reviewsCount)}</span>
      </div>
      ${thin && v.count !== null
        ? `<p class="warnline">${e(s.reviewsThin(v.count))}</p>` : ''}</div>`
  }
  const body = side(s.funnelChannelBooking, st?.booking ?? null, null)
    + side(s.funnelChannelAirbnb, st?.airbnb ?? null, null)
  return `<section class="panel"><h3>${e(s.reviewsHeading)}</h3>
    ${body || `<p class="mut" style="margin:0;font-size:.86rem">${e(s.reviewsNone)}</p>`}
    </section>`
}

/** The commercial levers, as the provider names them. Never renamed by us. */
function leversBlock(
  own: q.Promotion[] | undefined, account: q.Promotion[],
  known: string[], s: Strings,
): string {
  const grid = leverMatrix(known, own ?? [], s)
  if (!grid && !account.length) {
    return `<section class="panel"><h3>${e(s.leversHeading)}</h3>
      <p class="mut" style="margin:0;font-size:.86rem">${e(s.leversNone)}</p></section>`
  }
  const acct = account.map(p => `<span class="lever ${
    p.active === null ? 'unk' : p.active ? 'on' : 'off'}"><b>${e(p.kind)}</b> ${
    e(p.active === null ? s.leverUnknown : p.active ? s.leverOn : s.leverOff)}${
    p.discountPct !== null ? ` · ${e(pct(p.discountPct, s.numberLocale))}` : ''}</span>`).join('')
  return `<section class="panel"><h3>${e(s.leversHeading)}</h3>
    ${grid}
    <div class="lvkey"><span class="lv on"></span>${e(s.leverOn)}
      <span class="lv off"></span>${e(s.leverOff)}
      <span class="lv unk"></span>${e(s.leverUnknown)}
      <span class="lv none"></span>${e(s.leverStateNone)}</div>
    ${acct ? `<p class="mut" style="margin:.7rem 0 .35rem;font-size:.76rem">${
      e(s.leversAccount)}</p><div class="levers">${acct}</div>` : ''}</section>`
}

/**
 * Where this listing stands against OUR OWN set.
 *
 * Published conversion benchmarks are vendor figures with unstated methodology
 * and no control for market or size — the sources themselves note that a luxury
 * villa converts lower than a budget flat because a larger booking involves more
 * deliberation. One industry number across Basel, Tauplitz and Canggu would be a
 * verdict about nothing.
 *
 * The cohort size is never omitted: third of three and third of forty are
 * opposite findings, and below a floor there is no distribution to rank inside at
 * all, so the page says that instead of showing a rank.
 */
const COHORT_FLOOR = 4

function cohortChip(st: q.CohortStanding | null, s: Strings): string {
  if (!st) return ''
  if (st.of < COHORT_FLOOR) return `<span class="cchip thin">${e(s.cohortThin(st.of))}</span>`
  return `<span class="cchip">${e(st.better === 0 ? s.cohortBest(st.of)
    : s.cohortRank(st.better, st.of))}</span>`
}

function macroBlock(
  s: Strings, funnel: q.FunnelState['kind'], sig?: q.Signals,
  cohort?: { booking: q.CohortStanding | null, airbnb: q.CohortStanding | null },
): string {
  const chains = funnelChain(s.funnelChannelBooking, s, sig?.funnelBooking ?? null,
                             cohort?.booking ?? null)
    + funnelChain(s.funnelChannelAirbnb, s, sig?.funnelAirbnb ?? null,
                  cohort?.airbnb ?? null)
  return `<section class="panel"><h3>${e(s.macroHeading)}</h3>
    ${chains
      ? chains + `<p class="mut" style="margin:.5rem 0 0;font-size:.78rem">${
          e(s.funnelChainNote)} ${e(s.cohortNote)}</p>`
      : `<p class="mut" style="margin:0;font-size:.86rem">${e(s.macro[funnel])}</p>`}
    </section>`
}

function vsMarket(sig: q.Signals | undefined, s: Strings): string {
  if (!sig || (sig.occupancy === null && sig.mpi === null && sig.priceRecommended === null)) {
    return `<span class="mut">${e(s.notMeasured)}</span>`
  }
  const pct = (v: number | null) => v === null ? '—' : `${Math.round(v)}%`
  const lead = sig.occupancy !== null && sig.marketOccupancy !== null
    ? sig.occupancy - sig.marketOccupancy : null
  const second = [
    // The index only where the provider gave one, and to two decimals because
    // 1.04 and 1.4 are different claims.
    sig.mpi === null ? null : `${e(s.mpiLabel)} ${sig.mpi.toFixed(2)}`,
    // Recommendation against what is live. Shown only when both exist: an arrow
    // from a number to nothing reads as a price change to zero.
    sig.priceRecommended !== null && sig.priceLive !== null
      ? `${money(sig.priceLive, sig.currency, s.numberLocale)} → `
        + `${money(sig.priceRecommended, sig.currency, s.numberLocale)}`
      : sig.priceRecommended !== null
        ? `${e(s.recommendLabel)} ${money(sig.priceRecommended, sig.currency, s.numberLocale)}`
        : null,
  ].filter(Boolean).join(' · ')
  // Ours, theirs, and the difference as a chip — the Suite's own delta pattern.
  // The pair stays in ink: colouring the number itself made six of six rows red
  // and turned a portfolio with three findings into a wall of alarm.
  const chip = lead === null ? ''
    : `<span class="chip ${lead >= 0 ? 'up' : 'down'}">${lead >= 0 ? '+' : '−'}`
      + `${Math.abs(Math.round(lead))} pp</span>`
  return `<span class="pair">${pct(sig.occupancy)}</span>`
    + `<span class="mut"> / ${pct(sig.marketOccupancy)}</span>${chip}`
    + `<div class="sub">${second || e(s.occupancy30)}</div>`
}

/**
 * How much calendar we actually hold, and how old it is.
 *
 * The night count is here rather than implied because a median over three
 * archived nights and a median over ninety are not the same statement, and the
 * cell beside it shows one of them without saying which.
 */
function archived(sig: q.Signals | undefined, s: Strings): string {
  if (!sig || !sig.nights) return `<span class="mut">—</span>`
  const when = sig.asOf ?? '—'
  return `${e(s.nightsArchived(sig.nights))}<div class="sub">${e(when)}</div>`
}

export function renderDashboard(d: DashboardData): string {
  const s = stringsFor(d.lang)

  /**
   * Actions are computed ONCE, for every room, and then used three times: to fill
   * the worklist, to classify a room for the filter, and to render the open room's
   * own panel. Computing them per band would let the three disagree — the
   * worklist could propose something the room did not show — which is the kind of
   * inconsistency a reader never reports and never trusts again.
   */
  /**
   * THE GROUP IS APPLIED ONCE, HERE, and everything below reads `inGroup`.
   *
   * `d.rows` stays the full account so the dropdown can count each group — and
   * so the option a reader is standing in never vanishes from its own list.
   * Everything else derives from the narrowed set: the actions, the counts, the
   * worklist, the hero's sentence. One filter, one place, no chance of the hero
   * and the table disagreeing about which rooms they are describing.
   */
  const inGroup = d.group ? d.rows.filter(r => r.group === d.group) : d.rows
  const groups = [...d.rows.reduce((m, r) => {
    if (r.group) m.set(r.group, (m.get(r.group) ?? 0) + 1)
    return m
  }, new Map<string, number>())]
    .map(([name, n]) => ({ name, n }))
    .sort((a, b) => a.name.localeCompare(b.name, s.numberLocale))

  const perRoom = new Map(inGroup.map(r => [r.entityId, actionsOf(r, d, s)]))
  const stateOf = (r: Row): RoomView => {
    if (naSet.has(r.label)) return 'na'
    return roomState(perRoom.get(r.entityId) ?? [])
  }
  const naSet = new Set(d.notAssessable.map(n => n.label))

  const counts: Record<RoomView, number> = {
    all: inGroup.length,
    act: inGroup.filter(r => stateOf(r) === 'act').length,
    held: inGroup.filter(r => stateOf(r) === 'held').length,
    quiet: inGroup.filter(r => stateOf(r) === 'quiet').length,
    // Counted from the rooms actually in scope, not from the account-wide list:
    // "Not assessable 1" beside four visible rooms was a number about somewhere
    // else.
    na: inGroup.filter(r => naSet.has(r.label)).length,
  }

  const SEVERITY: Record<string, number> = {
    critical: 5, high: 4, medium: 3, low: 2, info: 1,
  }
  const visible = inGroup
    .filter(r => d.view === 'all' || stateOf(r) === d.view)
    .sort((a, b) => d.sort === 'name' ? a.label.localeCompare(b.label, s.numberLocale)
      : d.sort === 'risk'
        ? (SEVERITY[b.worstSeverity ?? ''] ?? 0) - (SEVERITY[a.worstSeverity ?? ''] ?? 0)
          || (b.atStake ?? 0) - (a.atStake ?? 0)
        : (b.atStake ?? 0) - (a.atStake ?? 0))

  /**
   * The worklist: every real proposal in the portfolio, ready ones first.
   *
   * `content` is excluded. It is a named absence rather than a proposal, and it is
   * identical on every room — forty-one copies of "no source connected" would bury
   * everything else and teach the reader to skip the list.
   */
  const flat = inGroup
    .flatMap(r => (perRoom.get(r.entityId) ?? [])
      .filter(a => a.lever !== 'content')
      .map(action => ({ row: r, action })))

  /**
   * IDENTICAL PROPOSALS COLLAPSE INTO ONE LINE.
   *
   * Rendered and looked at, the list read badly in exactly one way: four separate
   * lines all saying "turn the mobile rate on", one per room, each worth nothing,
   * sitting above a held rate action worth CHF 1'890. Four copies of the same
   * sentence is not four things to decide — it is one decision that happens to
   * touch four rooms, and printing it four times pushed the money off the top.
   *
   * Only WORTHLESS proposals merge. An action that carries an amount is specific
   * to the room whose money it is, and merging two of those would hide where the
   * money actually is — the same mistake as a snapshot key that cannot tell two
   * sources apart.
   */
  const merged = new Map<string, { rows: Row[], action: Action }>()
  const lines: Array<{ rows: Row[], action: Action }> = []
  for (const { row, action } of flat) {
    if (action.worth !== null) { lines.push({ rows: [row], action }); continue }
    const key = [action.lever, action.from, action.to, action.scope,
                 action.because, action.blockedBy].join('\u0000')
    const seen = merged.get(key)
    if (seen) { seen.rows.push(row); continue }
    const line = { rows: [row], action }
    merged.set(key, line)
    lines.push(line)
  }
  const work = lines.sort((a, b) =>
    Number(Boolean(a.action.blockedBy)) - Number(Boolean(b.action.blockedBy))
    || (b.action.worth ?? 0) - (a.action.worth ?? 0)
    || a.action.rank - b.action.rank)
  // Counted from the unmerged list: a line covering four rooms is still four
  // changes, and the hero must not shrink because the display got tidier.
  const heldCount = flat.filter(w => w.action.blockedBy).length
  const roomsWithWork = new Set(flat.filter(w => !w.action.blockedBy)
    .map(w => w.row.entityId)).size

  const cash = (v: number | null, cur: string | null) => money(v, cur, s.numberLocale)
  const rows = visible.map(r => {
    const isOpen = d.openId === r.entityId
    const p = new URLSearchParams({ basis: d.basis, lang: d.lang,
                                    view: d.view, sort: d.sort })
    if (d.group) p.set('group', d.group)
    if (!isOpen) p.set('open', r.entityId)
    const href = `/?${p.toString()}#row-${r.entityId}`
    const domain = r.firstFailing ? s.domain[r.firstFailing] : null
    const bundle = {
      sig: d.signals.get(r.entityId),
      real: d.realised.get(r.entityId),
      rev: d.reviews.get(r.entityId),
      promos: d.promotions.get(r.entityId),
      accountPromos: d.accountPromotions,
      knownLevers: d.leverCoverage.map(l => l.kind),
      cohort: d.cohorts.get(r.entityId),
      gap: d.priceGap.get(r.entityId),
      demand: d.demand.get(r.entityId),
      coverage: d.leverCoverage,
      search: d.search.get(r.entityId),
    }
    /**
     * THREE GROUPS, not ten panels.
     *
     * The open row used to be a two-thousand-pixel stack of equally weighted
     * cards, and the reader lost the table. Now: what to change, why, and
     * everything else — the third collapsed, because it is reference and not
     * reading. The order is the order of the questions, and each group has a
     * heading so a reader can stop after the first one.
     */
    const detail = isOpen ? `<tr class="detail"><td colspan="6">
      <div class="room">
        <div class="rgroup">
          <h4 class="rg-h">${e(s.groupWhat)}</h4>
          ${actionsPanel(r, bundle, s)}
        </div>
        <div class="rgroup">
          <h4 class="rg-h">${e(s.groupWhy)}</h4>
          ${r.headline ? `<p class="head">${e(r.headline)}</p>`
                       : `<p class="mut">${e(s.noOpenFinding)}</p>`}
          ${potentialChart(r, bundle.sig, s)}
          ${pricePositionBlock(bundle.sig, r, s)}
          ${macroBlock(s, d.funnel, bundle.sig, bundle.cohort)}
          ${rankPanel(bundle.search, s)}
          ${gateBlock(d, s)}
        </div>
        <details class="rgroup rmore">
          <summary class="rg-h">${e(s.groupDetails)}</summary>
          ${detailBlocks(r, bundle, s)}
          ${evidenceBlock(d, s)}
        </details>
      </div></td></tr>` : ''
    const state = stateOf(r)
    return `<tr id="row-${e(r.entityId)}" class="${isOpen ? 'open' : ''} st-${state}">
      <td><a class="rowlink" href="${e(href)}"><span class="rail"
        aria-hidden="true"></span>${e(r.label)}<span class="chev">${
        isOpen ? e(s.closeRoom) : e(s.openRoom)}</span></a>
        <div class="sub">${e(r.market)}${r.band ? ` · ${e(r.band)}` : ''}${
          r.units && r.units > 1 ? ` · ${e(s.unitsLet(r.units))}` : ''}
          ${r.contract ? `<span class="tag">${e(s.contract[r.contract] ?? r.contract)}</span>` : ''}
          ${r.inHoldout ? '<span class="tag hold">Holdout</span>' : ''}</div></td>
      <td class="num">${cash(r.atStake, r.currency)}</td>
      <td>${r.findings
        ? e(s.findingCount(r.findings, s.severity[r.worstSeverity ?? ''] ?? ''))
        : `<span class="mut">${e(s.noneOpen)}</span>`}</td>
      <td>${domain
        ? `${e(domain)}<div class="sub">${e(s.gateLabel(s.stage[r.firstFailing!] ?? r.firstFailing!))}</div>`
        : `<span class="mut">${e(s.notRated)}</span>`}</td>
      <td>${vsMarket(d.signals.get(r.entityId), s)}</td>
      <td>${archived(d.signals.get(r.entityId), s)}</td>
    </tr>${detail}`
  }).join('')

  const banners = [
    d.unprotected ? `<div class="banner warn">${s.openToTheInternet}</div>` : '',
    d.demo ? `<div class="banner demo">${s.demoData}</div>` : '',
  ].join('')

  return `<!doctype html>
<html lang="${e(s.htmlLang)}"><head>${head(`${e(s.appTitle)}`)}</head>
<body><main>
  <div class="top">
    <div><h1>${e(s.heading)}</h1>
      <div class="sub">${d.email ? `${e(s.signedInAs(d.email))} · <a href="/auth/logout">${e(s.signOut)}</a> · ` : ''}<a href="/status?lang=${d.lang}">${e(s.readiness)}</a></div></div>
    <div class="controls">
      <span class="lang"><a href="${e(selfUrl(d, { lang: otherLang(d.lang) }))}"
        hreflang="${otherLang(d.lang)}">${e(s.otherLangName)}</a></span>
      <span class="lens">
        <a class="${d.basis === 'revenue' ? 'on' : ''}" href="${
          e(selfUrl(d, { basis: 'revenue' }))}">${e(s.basisRevenue)}</a>
        <a class="${d.basis === 'margin' ? 'on' : ''}" href="${
          e(selfUrl(d, { basis: 'margin' }))}">${e(s.basisMargin)}</a>
      </span>
    </div>
  </div>
  ${banners}
  ${/* Counted from `flat`, not from the collapsed `work`: the hero states how many
       CHANGES there are, and a line covering four rooms is four changes. Passing
       the display list here made the hero say three when the page proposed six. */
    ''}${pulseBand(d, s, flat.filter(w => !w.action.blockedBy).length,
                   heldCount, roomsWithWork)}
  ${todayBand(d, s, work)}
  ${filterBar(d, s, counts, visible.length, groups)}
  ${d.view === 'na' && d.notAssessable.length ? `<div class="banner">${
      d.notAssessable.map(n => `${e(n.label)} <span class="mut">(${e(n.reason)})</span>`).join(' · ')
    }</div>` : ''}
  ${/* Six columns do not fit a phone. Measured at 430px the table was 551px wide
       and the WHOLE PAGE scrolled sideways — the hero, the worklist and the
       filter bar all dragged along by one element. It scrolls inside its own
       box now, so the rest of the page stays where the reader put it. */ ''}
  ${visible.length ? `<div class="tscroll"><table>
    <thead><tr><th>${e(s.colProperty)}</th><th>${e(s.colAtStake)}</th><th>${e(s.colFindings)}</th>
      <th>${e(s.colWorstDomain)}</th><th>${e(s.colVsMarket)}</th><th>${e(s.colArchived)}</th></tr></thead>
    <tbody>${rows}</tbody></table></div>`
    : d.rows.length ? `<p class="mut band-empty">${e(s.todayEmpty)}</p>`
    : `<div class="empty"><p><b>${e(s.noPropertiesYet)}</b></p>
       <p>${e(s.noPropertiesWhy)} <a href="/status?lang=${d.lang}">${e(s.readiness)}</a>.</p></div>`}
  ${/* The one figure on the page that does NOT narrow with the group: lever
       coverage counts every active room on the account. Rendering it under a
       group-filtered table without saying so would let "31 of 41" read as a
       fact about Zermattstays. It says whose number it is instead. */ ''}
  ${rankTimelineChart(d.rankTimeline, s, d.group)}
  ${d.leverCoverage.length ? `<section class="card">
    <h2 class="ph">${e(s.leversPortfolio)}</h2>
    <p class="mut" style="margin:.1rem 0 .8rem;font-size:.84rem">${
      e(s.leversPortfolioNote)}${d.group ? ` ${e(s.leversWholeAccount(d.group))}` : ''}</p>
    ${leverCoverage(d.leverCoverage, s)}
  </section>` : ''}
  <details class="legend">
    <summary>${e(s.legendHeading)}</summary>
    <p class="mut">${e(s.legendLead)}</p>
    <dl>${s.legend.map(x =>
      `<dt>${e(x.term)}</dt><dd>${e(x.text)}</dd>`).join('')}</dl>
  </details>
  <footer>
    <span>${s.largestNotSum}</span>
    ${d.freshness.length ? `<span>${e(s.freshness)}: ${d.freshness.map(f =>
      `${e(f.dataset)} ${e(age(f.age_minutes, s))}`).join(' · ')}</span>` : ''}
  </footer>
</main></body></html>`
}

export interface LoginView {
  lang: Lang
  /** Entra is configured, so the Microsoft button is the way in. */
  sso: boolean
  /** The mail fallback, only when someone deliberately switched it on. */
  magic: boolean
  /** A link was just requested — say so without confirming the address exists. */
  sent?: boolean
  /** A short, already-safe reason the last attempt failed. */
  error?: string
}

/**
 * The door.
 *
 * Single sign-on first and alone whenever it is configured. Offering two ways in
 * would mean the weaker one decides how strong the door is, so the mail fallback
 * only appears when the deployment says it should.
 */
export function renderLogin(v: LoginView): string {
  const s = stringsFor(v.lang)
  const body = v.sent
    ? `<p>${s.loginLinkSent}</p>`
    : [
        v.sso
          ? `<p>${e(s.loginSsoLead)}</p>
             <a class="btn" href="/auth/sso?lang=${v.lang}">
               <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
                 <rect x="0" y="0" width="7" height="7" fill="#F25022"/>
                 <rect x="9" y="0" width="7" height="7" fill="#7FBA00"/>
                 <rect x="0" y="9" width="7" height="7" fill="#00A4EF"/>
                 <rect x="9" y="9" width="7" height="7" fill="#FFB900"/>
               </svg>
               ${e(s.loginWithMicrosoft)}
             </a>`
          : '',
        v.magic
          ? `<p class="alt">${e(v.sso ? s.loginMagicAlso : s.loginMagicLead)}</p>
             <form method="post" action="/auth/request">
               <input type="hidden" name="lang" value="${v.lang}">
               <input type="email" name="email" required autocomplete="email"
                      placeholder="${e(s.loginEmailPlaceholder)}">
               <button type="submit">${e(s.loginSendLink)}</button>
             </form>`
          : '',
        !v.sso && !v.magic ? `<p>${s.loginNoMethod}</p>` : '',
      ].filter(Boolean).join('\n')

  return `<!doctype html>
<html lang="${e(s.htmlLang)}"><head>${head(`${e(s.loginTitle)}`)}</head>
<body><div class="card">
  <h1>Revenue Engine</h1>
  ${v.error ? `<p class="err">${v.error}</p>` : ''}
  ${body}
  <div class="lang"><a href="/?lang=${otherLang(v.lang)}" hreflang="${otherLang(v.lang)}">${e(s.otherLangName)}</a></div>
</div></body></html>`
}
