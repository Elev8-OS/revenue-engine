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
import { actionsFor, type Action } from './actions.js'
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

export interface DashboardData {
  lang: Lang
  basis: Basis
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
  /** Night-by-night disagreement with the recommendation, and the minimum stay. */
  priceGap: Map<string, q.PriceGap>
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
function selfUrl(d: DashboardData, over: { lang?: Lang } = {}): string {
  const p = new URLSearchParams({ basis: d.basis })
  if (d.openId) p.set('open', d.openId)
  p.set('lang', over.lang ?? d.lang)
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

function potential(
  r: Row, sig: q.Signals | undefined, s: Strings, funnel: q.FunnelState['kind'],
  d?: Detail,
): string {
  const ours = sig?.occupancy ?? null
  const theirs = sig?.marketOccupancy ?? null
  // Nothing to draw is not nothing to say: the micro and macro blocks report
  // their own state, and an early return here used to swallow both.
  if (ours === null && r.atStake === null) {
    return (d ? actionsPanel(r, d, s) : '')
      + pricePositionBlock(sig, r, s) + macroBlock(s, funnel, sig, d?.cohort)
      + (d ? detailBlocks(r, d, s) : '')
  }

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
  return (d ? actionsPanel(r, d, s) : '')
    + `<section class="panel"><h3>${e(s.potentialHeading)}</h3>${chart}</section>`
    + pricePositionBlock(sig, r, s)
    + macroBlock(s, funnel, sig, d?.cohort)
    + (d ? detailBlocks(r, d, s) : '')
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
/* ------------------------------------------------------ what to change ===== */

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
  const cash = (v: number | null, cur: string | null) => money(v, cur, s.numberLocale)
  const largest = d.rows.find(r => r.atStake !== null)
  const rows = d.rows.map(r => {
    const isOpen = d.openId === r.entityId
    const p = new URLSearchParams({ basis: d.basis, lang: d.lang })
    if (!isOpen) p.set('open', r.entityId)
    const href = `/?${p.toString()}#row-${r.entityId}`
    const domain = r.firstFailing ? s.domain[r.firstFailing] : null
    const detail = isOpen ? `<tr class="detail"><td colspan="6">
        ${r.headline ? `<p class="head">${e(r.headline)}</p>`
                     : `<p class="mut">${e(s.noOpenFinding)}</p>`}
        ${potential(r, d.signals.get(r.entityId), s, d.funnel, {
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
        })}
        ${gateBlock(d, s)}
        ${evidenceBlock(d, s)}
      </td></tr>` : ''
    // The row carries an id and the link ends in that fragment, so opening a row
    // lands ON the row instead of at the top of the page. Without it every click
    // was a full navigation that reset the scroll, and the reader had to find
    // their property again — which is a real cost on a portfolio this long, and
    // the fix needs no JavaScript at all.
    return `<tr id="row-${e(r.entityId)}" class="${isOpen ? 'open' : ''}">
      <td><a class="rowlink" href="${e(href)}">${isOpen ? '▾' : '▸'} ${e(r.label)}</a>
        <div class="sub">${e(r.market)}${r.band ? ` · ${e(r.band)}` : ''}
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
        <a class="${d.basis === 'revenue' ? 'on' : ''}" href="/?basis=revenue&lang=${d.lang}">${e(s.basisRevenue)}</a>
        <a class="${d.basis === 'margin' ? 'on' : ''}" href="/?basis=margin&lang=${d.lang}">${e(s.basisMargin)}</a>
      </span>
    </div>
  </div>
  ${banners}
  <div class="stats">
    <div class="stat"><div class="k">${e(s.largestSingle)}</div>
      <div class="v">${largest ? cash(largest.atStake, largest.currency) : '—'}</div>
      <div class="sub">${largest ? e(largest.label) : e(s.nothingOpen)}</div></div>
    <div class="stat"><div class="k">${e(s.openFindings)}</div><div class="v">${d.counts.open}</div>
      <div class="sub">${e(s.severityBreakdown(d.counts.critical, d.counts.high))}</div></div>
    <div class="stat"><div class="k">${e(s.rooms)}</div><div class="v">${d.counts.entities}</div>
      <div class="sub">${e(s.activeInPortfolio)}</div></div>
    <div class="stat"><div class="k">${e(s.notAssessable)}</div><div class="v">${d.notAssessable.length}</div>
      <div class="sub">${e(s.signalMissing)}</div></div>
  </div>
  ${d.notAssessable.length ? `<div class="banner"><b>${e(s.roomsNotAssessable(d.notAssessable.length))}</b> — ${
      d.notAssessable.map(n => `${e(n.label)} <span class="mut">(${e(n.reason)})</span>`).join(' · ')
    }</div>` : ''}
  ${d.rows.length ? `<table>
    <thead><tr><th>${e(s.colProperty)}</th><th>${e(s.colAtStake)}</th><th>${e(s.colFindings)}</th>
      <th>${e(s.colWorstDomain)}</th><th>${e(s.colVsMarket)}</th><th>${e(s.colArchived)}</th></tr></thead>
    <tbody>${rows}</tbody></table>`
    : `<div class="empty"><p><b>${e(s.noPropertiesYet)}</b></p>
       <p>${e(s.noPropertiesWhy)} <a href="/status?lang=${d.lang}">${e(s.readiness)}</a>.</p></div>`}
  ${d.leverCoverage.length ? `<section class="card">
    <h2 class="ph">${e(s.leversPortfolio)}</h2>
    <p class="mut" style="margin:.1rem 0 .8rem;font-size:.84rem">${
      e(s.leversPortfolioNote)}</p>
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
