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

function potential(r: Row, sig: q.Signals | undefined, s: Strings): string {
  const ours = sig?.occupancy ?? null
  const theirs = sig?.marketOccupancy ?? null
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
    + pricePositionBlock(sig, r, s)
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
  if (p50 === null || (live === null && rec === null)) return ''

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
  </section>
  <section class="panel"><h3>${e(s.macroHeading)}</h3>
    <p class="mut" style="margin:0;font-size:.86rem">${e(s.macroBlocked)}</p></section>`
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
        ${potential(r, d.signals.get(r.entityId), s)}
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
