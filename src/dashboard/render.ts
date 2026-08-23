/**
 * Server-rendered dashboard. No framework and no client JavaScript: the whole
 * interaction is "which row is open" and "which basis ranks", and both are
 * fine as query parameters. That keeps the deployable surface one file and
 * removes a build step from the critical path.
 */
import type { Basis, Row } from './query.js'

const e = (s: unknown) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

const money = (v: number | null, cur: string | null) =>
  v === null ? '—'
    : new Intl.NumberFormat('de-CH', {
        style: 'currency', currency: cur ?? 'CHF', maximumFractionDigits: 0,
      }).format(v)

const contractLabel: Record<string, string> = {
  guaranteed_rent: 'Garantiemiete',
  net_share: '% vom Netto',
  fixed_fee: 'Pauschale',
  gross_share: '% vom Brutto',
}

/**
 * The gate stage a failure belongs to decides the domain. This mapping is the
 * whole "visibility before price" rule in one object: impressions is a
 * restriction problem, clicks and conversion are visibility, and only when all
 * three hold is price the question.
 */
const domainForGate: Record<string, string> = {
  impressions: 'Restriktionen & Aufenthaltsmix',
  ctr: 'Sichtbarkeit & Konversion',
  conversion: 'Sichtbarkeit & Konversion',
  price: 'Preis & Erlös',
}

const severityLabel: Record<string, string> = {
  critical: 'kritisch', high: 'hoch', medium: 'mittel', low: 'niedrig', info: 'Info',
}

export interface DashboardData {
  basis: Basis
  openId: string | null
  rows: Row[]
  counts: { entities: number, open: number, critical: number, high: number }
  notAssessable: Array<{ label: string, reason: string }>
  freshness: Array<{ source: string, dataset: string, age_minutes: number }>
  gate: Array<{ stage: string, verdict: string, note: string | null }>
  evidence: Array<{ side: string, family: string, metric: string, claim: string, observed_at: string | null }>
  demo: boolean
  /** True when no allowlist is configured, so the page is reachable by anyone. */
  unprotected: boolean
  email?: string
}

function age(min: number): string {
  if (min < 90) return `${min} Min`
  const h = Math.round(min / 60)
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} T`
}

function gateBlock(d: DashboardData): string {
  if (!d.gate.length) return ''
  const dots = d.gate.map(g => {
    const cls = g.verdict === 'failing' ? 'bad' : g.verdict === 'healthy' ? 'good' : 'unk'
    const name = { impressions: 'Impressionen', ctr: 'Klickrate', conversion: 'Konversion', price: 'Preislage' }[g.stage] ?? g.stage
    return `<li><span class="dot ${cls}"></span><b>${e(name)}</b>${g.note ? ` <span class="mut">${e(g.note)}</span>` : ''}</li>`
  }).join('')
  const failing = d.gate.find(g => g.verdict === 'failing')
  const released = failing
    ? failing.stage === 'price'
      ? 'Alle drei Sichtbarkeitstore halten — das ist ein echter Preisfall.'
      : `Das Tor reisst bei <b>${e(failing.stage)}</b>. Preisbefunde werden zurückgehalten, bis das behoben ist.`
    : 'Kein Tor reisst.'
  return `<section class="panel">
    <h3>Torwächter</h3>
    <ul class="gate">${dots}</ul>
    <p class="mut">${released} Gemessen gegen unsere eigene Kohorte, nicht gegen den Markt — Wettbewerber-Funneldaten verkauft kein Anbieter.</p>
  </section>`
}

function evidenceBlock(d: DashboardData): string {
  if (!d.evidence.length) return ''
  const side = (name: string, key: string, note: string) => {
    const items = d.evidence.filter(x => x.side === key)
    if (!items.length) return ''
    return `<div><h4>${e(name)} <span class="mut">${e(note)}</span></h4><ul class="ev">${
      items.map(x => `<li>${e(x.claim)} <span class="mut">· ${e(x.metric)}${x.observed_at ? ` · ${e(x.observed_at)}` : ''}</span></li>`).join('')
    }</ul></div>`
  }
  return `<section class="panel">
    <h3>Belege</h3>
    ${side('Dafür', 'supporting', '')}
    ${side('Dagegen', 'against', 'Pflichtfeld — ein Check, der seinen eigenen Gegenfall nicht führen kann, ist nicht fertig')}
    ${side('Unbekannt', 'unknown', '')}
  </section>`
}

export function renderDashboard(d: DashboardData): string {
  const largest = d.rows.find(r => r.atStake !== null)
  const rows = d.rows.map(r => {
    const isOpen = d.openId === r.entityId
    const href = `/?basis=${d.basis}${isOpen ? '' : `&open=${encodeURIComponent(r.entityId)}`}`
    const domain = r.firstFailing ? domainForGate[r.firstFailing] : null
    const detail = isOpen ? `<tr class="detail"><td colspan="6">
        ${r.headline ? `<p class="head">${e(r.headline)}</p>` : '<p class="mut">Kein offener Befund für diesen Raum.</p>'}
        ${gateBlock(d)}
        ${evidenceBlock(d)}
      </td></tr>` : ''
    return `<tr class="${isOpen ? 'open' : ''}">
      <td><a class="rowlink" href="${e(href)}">${isOpen ? '▾' : '▸'} ${e(r.label)}</a>
        <div class="sub">${e(r.market)}${r.band ? ` · ${e(r.band)}` : ''}
          ${r.contract ? `<span class="tag">${e(contractLabel[r.contract] ?? r.contract)}</span>` : ''}
          ${r.inHoldout ? '<span class="tag hold">Holdout</span>' : ''}</div></td>
      <td class="num">${money(r.atStake, r.currency)}</td>
      <td>${r.findings ? `${r.findings}× ${e(severityLabel[r.worstSeverity ?? ''] ?? '')}` : '<span class="mut">keine offen</span>'}</td>
      <td>${domain ? `${e(domain)}<div class="sub">Tor: ${e(r.firstFailing)}</div>` : '<span class="mut">nicht bewertet</span>'}</td>
      <td class="num mut">—</td>
      <td class="num mut">—</td>
    </tr>${detail}`
  }).join('')

  const banners = [
    d.unprotected
      ? `<div class="banner warn"><b>Diese Seite ist offen im Netz.</b> Es ist keine Zugangsliste gesetzt
         (<code>ALLOWED_EMAILS</code>), also kann jeder mit der URL sie sehen. Sobald die Variable
         gesetzt ist, greift die Anmeldung per Magic Link automatisch.</div>` : '',
    d.demo
      ? `<div class="banner demo"><b>Demonstrationsdaten.</b> Es läuft noch kein Zufluss, also stehen hier
         die am Live-Konto <em>gemessenen</em> Zahlen der drei Bali-Räume als Beispiel — erkennbar am
         Präfix <code>[Demo]</code>. Sie werden gelöscht, sobald echte Daten kommen.</div>` : '',
  ].join('')

  return `<!doctype html>
<html lang="de"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Revenue Engine — Listing Health</title>
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
  .lens a{display:inline-block;padding:.3rem .7rem;border:1px solid var(--line);
    border-radius:3px;text-decoration:none;font-size:.85rem;background:var(--surface)}
  .lens a.on{background:var(--ink);color:var(--paper);border-color:var(--ink)}
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
    <div><h1>Listing Health</h1>
      <div class="sub">${d.email ? `angemeldet als ${e(d.email)} · <a href="/auth/logout">abmelden</a> · ` : ''}<a href="/status">Bereitschaft</a></div></div>
    <div class="lens">
      <a class="${d.basis === 'revenue' ? 'on' : ''}" href="/?basis=revenue">Erlös</a>
      <a class="${d.basis === 'margin' ? 'on' : ''}" href="/?basis=margin">Deckungsbeitrag</a>
    </div>
  </div>
  ${banners}
  <div class="stats">
    <div class="stat"><div class="k">Grösste Einzelchance</div>
      <div class="v">${largest ? money(largest.atStake, largest.currency) : '—'}</div>
      <div class="sub">${largest ? e(largest.label) : 'nichts offen'}</div></div>
    <div class="stat"><div class="k">Offene Befunde</div><div class="v">${d.counts.open}</div>
      <div class="sub">${d.counts.critical} kritisch · ${d.counts.high} hoch</div></div>
    <div class="stat"><div class="k">Räume</div><div class="v">${d.counts.entities}</div>
      <div class="sub">aktiv im Portfolio</div></div>
    <div class="stat"><div class="k">Nicht bewertbar</div><div class="v">${d.notAssessable.length}</div>
      <div class="sub">Signal fehlt</div></div>
  </div>
  ${d.notAssessable.length ? `<div class="banner"><b>${d.notAssessable.length} Räume nicht bewertbar</b> — ${
      d.notAssessable.map(n => `${e(n.label)} <span class="mut">(${e(n.reason)})</span>`).join(' · ')
    }</div>` : ''}
  ${d.rows.length ? `<table>
    <thead><tr><th>Objekt</th><th>Im Spiel</th><th>Befunde</th><th>Schlimmste Domäne</th>
      <th>ADR vs Set</th><th>Sync</th></tr></thead>
    <tbody>${rows}</tbody></table>`
    : `<div class="empty"><p><b>Noch keine Objekte.</b></p>
       <p>Der Zufluss läuft nicht — es fehlen Zugangsdaten. Was fehlt, steht auf der
       <a href="/status">Bereitschaftsseite</a>.</p></div>`}
  <footer>
    <span>Jede Zeile zeigt ihre <b>grösste Einzelchance</b> — nie eine Summe, weil Befunde
      dieselben Nächte überlappen können.</span>
    ${d.freshness.length ? `<span>Frische: ${d.freshness.map(f =>
      `${e(f.dataset)} ${age(f.age_minutes)}`).join(' · ')}</span>` : ''}
  </footer>
</main></body></html>`
}

export function renderLogin(sent: boolean, base: string): string {
  return `<!doctype html>
<html lang="de"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Revenue Engine — Anmeldung</title>
<style>
  :root{color-scheme:light dark;--paper:#F1F3F1;--ink:#171C1B;--mut:#5D6B69;--line:#D2DAD6;--surface:#FBFCFA;--teal:#0D615E}
  @media (prefers-color-scheme: dark){:root{--paper:#0F1312;--ink:#E7ECE9;--mut:#94A3A0;--line:#28302E;--surface:#161B1A;--teal:#58C4BC}}
  body{margin:0;background:var(--paper);color:var(--ink);display:grid;place-items:center;
    min-height:100vh;font:15px/1.6 ui-sans-serif,system-ui,sans-serif;padding:1.5rem}
  .card{background:var(--surface);border:1px solid var(--line);border-radius:5px;
    padding:1.8rem;max-width:26rem;width:100%}
  h1{font-size:1.2rem;margin:0 0 .4rem}
  p{color:var(--mut);font-size:.9rem;margin:0 0 1.1rem}
  input,button{font:inherit;width:100%;padding:.55rem .7rem;border-radius:3px;border:1px solid var(--line)}
  input{background:var(--paper);color:var(--ink);margin-bottom:.6rem}
  button{background:var(--ink);color:var(--paper);border-color:var(--ink);cursor:pointer;font-weight:600}
</style></head>
<body><div class="card">
  <h1>Revenue Engine</h1>
  ${sent
    ? `<p>Wenn diese Adresse Zugang hat, ist ein Anmeldelink unterwegs. Er gilt
       <b>15 Minuten</b> und funktioniert <b>einmal</b>.</p>`
    : `<p>Anmeldung per Link, kein Passwort.</p>
       <form method="post" action="/auth/request">
         <input type="email" name="email" required autocomplete="email" placeholder="dein@elev8-suite.com">
         <button type="submit">Link senden</button>
       </form>`}
</div></body></html>`
}
