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
function selfUrl(d: DashboardData, over: { lang?: Lang } = {}): string {
  const p = new URLSearchParams({ basis: d.basis })
  if (d.openId) p.set('open', d.openId)
  p.set('lang', over.lang ?? d.lang)
  return `/?${p.toString()}`
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
function vsMarket(sig: q.Signals | undefined, s: Strings): string {
  if (!sig || (sig.occupancy === null && sig.mpi === null && sig.priceRecommended === null)) {
    return `<span class="mut">${e(s.notMeasured)}</span>`
  }
  const pct = (v: number | null) => v === null ? '—' : `${Math.round(v)}%`
  const lead = sig.occupancy !== null && sig.marketOccupancy !== null
    ? sig.occupancy - sig.marketOccupancy : null
  const cls = lead === null ? 'mut' : lead >= 0 ? 'ok' : 'no'
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
  return `<span class="${cls}">${pct(sig.occupancy)}</span>`
    + `<span class="mut"> / ${pct(sig.marketOccupancy)}</span>`
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
    const href = `/?${p.toString()}`
    const domain = r.firstFailing ? s.domain[r.firstFailing] : null
    const detail = isOpen ? `<tr class="detail"><td colspan="6">
        ${r.headline ? `<p class="head">${e(r.headline)}</p>`
                     : `<p class="mut">${e(s.noOpenFinding)}</p>`}
        ${gateBlock(d, s)}
        ${evidenceBlock(d, s)}
      </td></tr>` : ''
    return `<tr class="${isOpen ? 'open' : ''}">
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
<html lang="${e(s.htmlLang)}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(s.appTitle)}</title>
<style>
  :root { color-scheme: light dark;
    --paper:#F1F3F1; --ink:#171C1B; --mut:#5D6B69; --line:#D2DAD6; --sunk:#E7EBE8;
    --brass:#8A6A1C; --teal:#0D615E; --rust:#97392B; --surface:#FBFCFA; }
  @media (prefers-color-scheme: dark) { :root {
    --paper:#0F1312; --ink:#E7ECE9; --mut:#94A3A0; --line:#28302E; --sunk:#1B2120;
    --brass:#DFB44E; --teal:#58C4BC; --rust:#E28A7C; --surface:#161B1A; } }
  *{box-sizing:border-box} body{margin:0;background:var(--paper);color:var(--ink);
    padding:2.5rem 1.25rem 6rem;font:15px/1.6 ui-sans-serif,system-ui,sans-serif}
  main{max-width:74rem;margin:0 auto}
  h1{font-size:1.5rem;margin:0 0 .2rem;letter-spacing:-.01em}
  h3{font-size:.95rem;margin:0 0 .5rem}
  h4{font-size:.82rem;margin:.8rem 0 .3rem;font-weight:600}
  .sub{color:var(--mut);font-size:.8rem;margin-top:.15rem}
  .mut{color:var(--mut)}
  a{color:inherit}
  .top{display:flex;flex-wrap:wrap;gap:1rem;align-items:flex-end;justify-content:space-between;margin-bottom:1.5rem}
  .controls{display:flex;gap:.5rem;align-items:center}
  .lens a{display:inline-block;padding:.3rem .7rem;border:1px solid var(--line);
    border-radius:3px;text-decoration:none;font-size:.85rem;background:var(--surface)}
  .lens a.on{background:var(--ink);color:var(--paper);border-color:var(--ink)}
  .lang{font-size:.78rem;color:var(--mut)}
  .lang a{text-decoration:none;border-bottom:1px dotted var(--line)}
  .banner{border:1px solid var(--line);border-radius:4px;padding:.8rem 1rem;margin-bottom:.7rem;font-size:.88rem}
  .banner.warn{border-left:3px solid var(--rust);background:color-mix(in srgb,var(--rust) 8%,var(--surface))}
  .banner.demo{border-left:3px solid var(--brass);background:color-mix(in srgb,var(--brass) 8%,var(--surface))}
  .stats{display:grid;gap:.7rem;grid-template-columns:repeat(auto-fit,minmax(11rem,1fr));margin:1.2rem 0}
  .stat{background:var(--surface);border:1px solid var(--line);border-radius:4px;padding:.8rem 1rem}
  .stat .k{font-size:.66rem;text-transform:uppercase;letter-spacing:.09em;color:var(--mut)}
  .stat .v{font-size:1.5rem;font-weight:600;font-variant-numeric:tabular-nums;margin-top:.2rem}
  table{width:100%;border-collapse:collapse;font-size:.9rem;background:var(--surface);
    border:1px solid var(--line);border-radius:4px;overflow:hidden}
  th{text-align:left;font-size:.64rem;text-transform:uppercase;letter-spacing:.1em;color:var(--mut);
    padding:.6rem .8rem;border-bottom:1px solid var(--line);background:var(--sunk)}
  td{padding:.7rem .8rem;border-bottom:1px solid var(--line);vertical-align:top}
  tr:last-child td{border-bottom:none}
  tr.open td{background:var(--sunk)}
  td.num{font-variant-numeric:tabular-nums;white-space:nowrap}
  .rowlink{text-decoration:none;font-weight:600}
  .rowlink:hover{text-decoration:underline}
  .tag{display:inline-block;border:1px solid var(--line);border-radius:2px;padding:.05rem .35rem;
    font-size:.66rem;color:var(--mut);margin-left:.3rem}
  .tag.hold{border-color:var(--brass);color:var(--brass)}
  tr.detail td{background:var(--paper);padding:1rem}
  .head{font-weight:600;margin:0 0 .8rem}
  .panel{border:1px solid var(--line);border-radius:4px;padding:.9rem 1rem;margin-bottom:.7rem;background:var(--surface)}
  ul.gate{list-style:none;margin:0 0 .6rem;padding:0;display:flex;flex-wrap:wrap;gap:1rem;font-size:.86rem}
  .dot{display:inline-block;width:.5rem;height:.5rem;border-radius:50%;margin-right:.35rem}
  .dot.good{background:var(--ink)} .dot.bad{background:var(--rust)}
  .dot.unk{background:var(--line)}
  ul.ev{margin:0;padding-left:1.1rem;font-size:.86rem;display:flex;flex-direction:column;gap:.3rem}
  code{font:500 .82em ui-monospace,monospace;color:var(--teal)}
  footer{margin-top:1.5rem;color:var(--mut);font-size:.82rem;display:flex;flex-wrap:wrap;gap:.9rem}
  .empty{padding:2.5rem 1rem;text-align:center;color:var(--mut)}
</style></head>
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
<html lang="${e(s.htmlLang)}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(s.loginTitle)}</title>
<style>
  :root{color-scheme:light dark;--paper:#F1F3F1;--ink:#171C1B;--mut:#5D6B69;--line:#D2DAD6;--surface:#FBFCFA;--teal:#0D615E;--rust:#97392B}
  @media (prefers-color-scheme: dark){:root{--paper:#0F1312;--ink:#E7ECE9;--mut:#94A3A0;--line:#28302E;--surface:#161B1A;--teal:#58C4BC;--rust:#E28A7C}}
  body{margin:0;background:var(--paper);color:var(--ink);display:grid;place-items:center;
    min-height:100vh;font:15px/1.6 ui-sans-serif,system-ui,sans-serif;padding:1.5rem}
  .card{background:var(--surface);border:1px solid var(--line);border-radius:5px;
    padding:1.8rem;max-width:26rem;width:100%}
  h1{font-size:1.2rem;margin:0 0 .4rem}
  p{color:var(--mut);font-size:.9rem;margin:0 0 1.1rem}
  p.alt{margin:1.3rem 0 .7rem;font-size:.82rem}
  p.err{color:var(--rust)}
  input,button{font:inherit;width:100%;padding:.55rem .7rem;border-radius:3px;border:1px solid var(--line)}
  input{background:var(--paper);color:var(--ink);margin-bottom:.6rem}
  button{background:var(--ink);color:var(--paper);border-color:var(--ink);cursor:pointer;font-weight:600}
  .btn{display:flex;align-items:center;justify-content:center;gap:.6rem;text-decoration:none;
    padding:.62rem .7rem;border:1px solid var(--line);border-radius:3px;
    background:var(--paper);color:var(--ink);font-weight:600;font-size:.92rem}
  code{font:500 .85em ui-monospace,monospace;color:var(--teal)}
  .lang{margin-top:1.2rem;font-size:.78rem;color:var(--mut)}
  .lang a{color:inherit;text-decoration:none;border-bottom:1px dotted var(--line)}
</style></head>
<body><div class="card">
  <h1>Revenue Engine</h1>
  ${v.error ? `<p class="err">${v.error}</p>` : ''}
  ${body}
  <div class="lang"><a href="/?lang=${otherLang(v.lang)}" hreflang="${otherLang(v.lang)}">${e(s.otherLangName)}</a></div>
</div></body></html>`
}
