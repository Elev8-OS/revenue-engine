/**
 * One stylesheet, and it is the Elev8 Suite one.
 *
 * WHERE THESE VALUES COME FROM. Not from a screenshot and not from taste: they
 * were read out of the running app at alpha.elev8-suite.com through the browser,
 * as the computed values of its own CSS custom properties. That app is Nuxt +
 * shadcn-vue + Tailwind 4 with the `color-yellow theme-default` preset active,
 * so its palette is a neutral grey scale with one amber accent — and the numbers
 * below are that palette verbatim, in the same oklch notation, rather than hex
 * approximations of it. When Elev8 changes its theme, these can be re-read the
 * same way and will still be comparable.
 *
 *   background      oklch(1 0 0)              card      oklch(1 0 0)
 *   foreground      oklch(0.145 0 0)          border    oklch(0.922 0 0)
 *   muted           oklch(0.97 0 0)           muted-fg  oklch(0.51 0 0)
 *   primary         oklch(0.852 0.199 91.936) on it     oklch(0.421 0.095 57.708)
 *   destructive     oklch(0.577 0.245 27.325) radius    0.625rem base, 14px cards
 *   font            Inter, 16px body, h1 24px/700 at -0.025em tracking
 *
 * WHY ONE FILE AND ONE ROUTE. There were seven `<style>` blocks across five
 * pages, each with its own copy of the palette, and three of them had already
 * drifted — different radii, a different card colour, two of them missing the
 * tokens the others used. A restyle that edited seven copies would have produced
 * an eighth variant within a month. So the palette exists once, is served once at
 * `/theme.css`, and every page links it.
 *
 * TWO TOKEN NAMES ARE DELIBERATELY KEPT. `--brass`, `--teal` and `--rust`
 * survive from the old palette because they are referenced by name in markup
 * across five pages and renaming them would be a large, risky diff for no
 * visible gain. They are re-pointed, not reused as colours: `--rust` is now
 * Elev8's destructive red, `--teal` its blue chart accent, and `--brass` an amber
 * dark enough to READ as text — which the brand amber is not. The brand amber
 * itself is `--brand`, for fills, with `--on-brand` for text on top of it. That
 * split is the one real addition: a 85%-lightness amber is a beautiful button
 * and an illegible label, and the old single token could not express both.
 *
 * DARK MODE STAYS `prefers-color-scheme`. Elev8 has a toggle; this app has no
 * client JavaScript at all, and adding some to match a switch would be the
 * wrong trade for an internal tool. The dark values are Elev8's own dark
 * palette, so a viewer with a dark system reads the same colours they would see
 * in the Suite.
 */

export const THEME_CSS = `
:root{
  color-scheme: light dark;

  /* Elev8 Suite, light. Read from the running app, not approximated. */
  --paper: oklch(1 0 0);
  --surface: oklch(1 0 0);
  --sunk: oklch(0.97 0 0);
  --ink: oklch(0.145 0 0);
  --mut: oklch(0.51 0 0);
  --line: oklch(0.922 0 0);

  /* The brand amber: a fill colour, with its own readable text pair. */
  --brand: oklch(0.852 0.199 91.936);
  --on-brand: oklch(0.421 0.095 57.708);
  /* Amber dark enough to read as text on paper. The brand amber is not. */
  --brass: oklch(0.55 0.13 85);

  --rust: oklch(0.577 0.245 27.325);
  --teal: oklch(0.546 0.245 262.881);

  /**
   * Chart hues. Four, in a FIXED order, never cycled — a fifth series folds into
   * "other" rather than inventing a colour, because a hue that appears once is a
   * hue nobody learns.
   *
   * Both sets were run through a contrast and colour-vision validator against
   * their own surface rather than eyeballed: lightness band, chroma floor,
   * adjacent-pair separation under deuteranopia/protanopia/tritanopia, and
   * contrast against the card. All five checks pass in both modes.
   *
   * One caveat that shapes the markup: blue and green sit close under
   * tritanopia (ΔE 5.3). So every series carries a DIRECT LABEL, not just a
   * legend swatch — identity is never left to colour alone.
   *
   * The --c-brand-N steps are the sequential ramp: one hue, light to dark, for a measure
   * that narrows. Never used for identity.
   */
  --c1: #B8860B;
  --c2: #2563EB;
  --c3: #0E8A63;
  --c4: #7C3AED;
  --c-brand-1: oklch(0.9 0.11 92);
  --c-brand-2: oklch(0.82 0.16 90);
  --c-brand-3: oklch(0.66 0.15 87);

  --r-card: 14px;
  --r-ctl: 8px;
  --shadow: 0 1px 2px rgba(0,0,0,.05);
  --font: Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  --mono: "Inter", ui-monospace, Menlo, Monaco, Consolas, monospace;
}

@media (prefers-color-scheme: dark){
  :root{
    --paper: oklch(0.145 0 0);
    --surface: oklch(0.205 0 0);
    --sunk: oklch(0.269 0 0);
    --ink: oklch(0.985 0 0);
    --mut: oklch(0.67 0 0);
    --line: oklch(1 0 0 / .1);
    --brand: oklch(0.795 0.184 86.047);
    --on-brand: oklch(0.279 0.077 58.955);
    --brass: oklch(0.852 0.199 91.936);
    --rust: oklch(0.704 0.191 22.216);
    --teal: oklch(0.707 0.165 254.624);
    /* Re-stepped for the dark surface, not flipped. Same four hues, same order,
       validated again against the dark card. */
    --c1: #B98A12;
    --c2: #4C86E6;
    --c3: #0F9D74;
    --c4: #9A6AE8;
    --c-brand-1: oklch(0.5 0.1 90);
    --c-brand-2: oklch(0.62 0.14 88);
    --c-brand-3: oklch(0.78 0.17 87);
    --shadow: 0 1px 2px rgba(0,0,0,.3);
  }
}

*{box-sizing:border-box}

body{
  margin:0;background:var(--paper);color:var(--ink);
  padding:2rem 1.25rem 6rem;
  font:16px/1.6 var(--font);
  -webkit-font-smoothing:antialiased;
}
main{max-width:74rem;margin:0 auto}

/* The single-card pages — sign-in and the authorisation notices — centre
   themselves. Selected by shape rather than by a class, so no page markup had
   to change: only those two put a card directly inside the body. */
body:has(> .card){display:grid;place-items:center;min-height:100vh;padding:1.5rem}
body:has(> .card) > .card{max-width:30rem;width:100%}
body:has(> .card) p{color:var(--mut);font-size:.9rem;margin:0 0 1.1rem}
body:has(> .card) input,
body:has(> .card) button,
body:has(> .card) .btn{width:100%}

h1{font-size:1.5rem;font-weight:700;letter-spacing:-.025em;margin:0 0 .2rem}
h2{font-size:1rem;font-weight:600;letter-spacing:-.01em;margin:1.8rem 0 .6rem}
h3{font-size:.95rem;font-weight:600;margin:0 0 .5rem}
h4{font-size:.82rem;font-weight:600;margin:.8rem 0 .3rem}
p{margin:0 0 1rem}
a{color:inherit}
.sub{color:var(--mut);font-size:.8rem;margin-top:.15rem}
p.s{color:var(--mut);margin:0 0 1.5rem;font-size:.9rem}
.mut{color:var(--mut)}
.ok{color:var(--ink);font-weight:600}
.no{color:var(--rust);font-weight:600}
.part{color:var(--brass);font-weight:600}
.err{color:var(--rust)}

code{
  font:500 .84em var(--mono);
  background:var(--sunk);color:var(--teal);
  padding:.1em .35em;border-radius:4px;
}

/* Cards. One border, one hairline shadow, 14px — the Suite's card exactly. */
.card,.panel,.stat{
  background:var(--surface);border:1px solid var(--line);
  border-radius:var(--r-card);box-shadow:var(--shadow);
}
.card{padding:1.1rem 1.25rem;margin-bottom:.8rem;overflow-x:auto}
.panel{padding:.9rem 1.1rem;margin-bottom:.7rem}

/* The funnel chain. Three stages, each a count with the share that reached it.
   Wrapped rather than scrolled: on a phone the stages stack, and a chain that
   ran off the side would hide the booking stage — the one that matters most. */
.fchain{margin:.35rem 0 .1rem}
.fchain+.fchain{margin-top:.8rem;padding-top:.7rem;border-top:1px solid var(--bor)}
.flabel{font-size:.74rem;letter-spacing:.02em;text-transform:uppercase;color:var(--mut);
  margin-bottom:.35rem}
.frow{display:flex;align-items:flex-start;gap:.4rem;flex-wrap:wrap}
.fstage{min-width:5.5rem}
.fnum{font-size:1.15rem;font-weight:650;line-height:1.15;font-variant-numeric:tabular-nums}
.flab{font-size:.74rem;color:var(--mut);line-height:1.25}
.fsh{font-size:.78rem;font-variant-numeric:tabular-nums}
.farrow{color:var(--bor);font-size:1.3rem;line-height:1.1;padding:0 .1rem}

/* Cohort standing, on the chain's own label. The size is part of the claim, so
   it is never styled away — a thin set gets a quieter chip, not a hidden one. */
.cchip{display:inline-block;margin-left:.5rem;padding:.12rem .4rem;border-radius:5px;
  border:1px solid var(--bor);font-size:.68rem;letter-spacing:.02em;
  text-transform:none;color:var(--fg);background:var(--bg)}
.cchip.thin{color:var(--mut);font-style:italic}

/* The trend rows: one label, up to three horizons. Grid so the columns line up
   across rows even when a row has a single value. */
.trend{display:flex;flex-direction:column;gap:.3rem}
.trow{display:grid;grid-template-columns:minmax(8rem,auto) 1fr;gap:.6rem;align-items:baseline}
.tlab{font-size:.78rem;color:var(--mut)}
.tval{display:flex;gap:1.1rem;font-variant-numeric:tabular-nums;font-size:.95rem}
.tval span{min-width:3.2rem}

/* What sold. Three figures, then the channel split. */
.rstats{display:flex;flex-wrap:wrap;gap:1.4rem}
.rstat{min-width:6rem}
.rnum{font-size:1.05rem;font-weight:650;font-variant-numeric:tabular-nums;line-height:1.2}
.rlab{font-size:.74rem;color:var(--mut)}
.chan{display:flex;flex-direction:column;gap:.28rem;margin-top:.7rem}
.crow{display:grid;grid-template-columns:5.5rem 1fr 3rem auto;gap:.5rem;align-items:center;
  font-size:.8rem}
.cname{color:var(--mut);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ctrack{height:.45rem;background:var(--bor);border-radius:999px;overflow:hidden}
.ctrack span{display:block;height:100%;background:var(--brand)}
.cval,.cmon{font-variant-numeric:tabular-nums;text-align:right}

/* Reviews. A thin count is marked, because the count is the finding. */
.rvside+.rvside{margin-top:.6rem;padding-top:.55rem;border-top:1px solid var(--bor)}
.rvnums{display:flex;align-items:baseline;gap:.35rem;flex-wrap:wrap;font-size:.82rem}
.rvscore,.rvcount{font-size:1.05rem;font-weight:650;font-variant-numeric:tabular-nums}
.rvcount.thin{color:var(--rust)}
.warnline{margin:.35rem 0 0;font-size:.78rem;color:var(--rust);max-width:44em}

/* Levers, as the provider names them. */
.levers{display:flex;flex-wrap:wrap;gap:.35rem}
.lever{font-size:.75rem;padding:.2rem .45rem;border-radius:6px;border:1px solid var(--bor);
  background:var(--bg);color:var(--mut)}
.lever b{font-weight:600;color:var(--fg)}
.lever.on{border-color:var(--brand)}
.lever.off{opacity:.72}
.lever.unk{border-style:dashed}

/* ---------------------------------------------------------------- charts */
/* SVG text carries TEXT tokens, never a series colour: the mark beside a label
   carries identity, the label stays ink. */
/* =========================================================== the three bands */
/*
 * ONE ACCENT, ON ONE PATH. Amber marks the action path and nothing else — the
 * hero figure, the ready lines in the worklist, the active filter. Everywhere the
 * old page used a card, this one uses whitespace and a single hairline: forty
 * bordered boxes make everything equally important, which is the same as making
 * nothing important.
 *
 * A RHYTHM, NOT A GRID OF EQUALS. The three bands step down in weight — a hero at
 * 3.4rem, band headings at 1.15rem, table text at .9rem — so scrolling feels like
 * moving from the summary into the detail rather than through a stack of cards.
 */
.pulse{display:grid;gap:1.1rem;grid-template-columns:minmax(15rem,22rem) 1fr;
  align-items:start;margin:1.6rem 0 2.2rem}
@media (max-width:56rem){ .pulse{grid-template-columns:1fr} }

/* The hero. One figure large enough to be the whole answer. */
.hero{border-left:3px solid var(--brand);padding:.1rem 0 .1rem 1.1rem}
.hero-k{margin:0;font-size:.72rem;letter-spacing:.09em;text-transform:uppercase;
  color:var(--mut)}
.hero-n{margin:.15rem 0 0;font-size:clamp(2.1rem,5.5vw,3.4rem);font-weight:700;
  letter-spacing:-.035em;line-height:1;font-variant-numeric:tabular-nums}
.hero-n i{font-size:1rem;font-weight:400;font-style:italic;color:var(--mut);
  letter-spacing:0}
.hero-lead{margin:.5rem 0 0;font-size:.9rem;color:var(--ink);max-width:26em}
.hero-held{color:var(--rust);white-space:nowrap}

/* The eight measurements as a strip. Each opens for the line that explains it —
   reachable, because most readers have not met RevPAR, but not eight paragraphs
   of body text at the top of the page. */
.pstrip{display:grid;gap:.4rem;grid-template-columns:repeat(auto-fill,minmax(11rem,1fr))}
.pk{border:1px solid var(--line);border-radius:10px;background:var(--surface);
  padding:.5rem .6rem}
.pk>summary{list-style:none;cursor:pointer;display:grid;
  grid-template-columns:1fr auto;grid-template-areas:"n d" "l v";gap:.05rem .4rem;
  align-items:baseline}
.pk>summary::-webkit-details-marker{display:none}
.pk-n{grid-area:n;font-size:1.15rem;font-weight:700;letter-spacing:-.02em;
  font-variant-numeric:tabular-nums;line-height:1.15}
.pk-none{font-size:.78rem;font-weight:400;font-style:italic;color:var(--mut)}
.pk-name{grid-area:l;font-size:.7rem;color:var(--mut);line-height:1.3}
.pk-dot{grid-area:d;width:.5rem;height:.5rem;border-radius:50%;background:var(--line);
  align-self:center}
/* NOT uppercased. "act" and "watch" survive it; "no comparison" became a shout
   twice the width of the figure it qualified. The word is small, spaced and
   coloured — that is enough to read as a label. */
.pk-v{grid-area:v;font-size:.64rem;letter-spacing:.04em;
  color:var(--mut);text-align:right}
.pk[open]{border-color:var(--mut)}
.pk-body{margin-top:.45rem;padding-top:.45rem;border-top:1px solid var(--line)}
.pk-body p{margin:0 0 .25rem;font-size:.74rem;line-height:1.45;color:var(--mut)}
/* The technical term, in the reader's colour: this is the word a channel or a
   consultant will use at them, so it has to be legible, not a footnote. */
.pk-term{color:var(--ink) !important;font-weight:600}
.pk-basis{font-variant:small-caps;letter-spacing:.06em}
.pk-money{color:var(--ink) !important}
.pk-flag{color:var(--rust) !important}
.pk.v-good .pk-dot{background:#0E8A63}
.pk.v-watch .pk-dot{background:var(--brand)}
.pk.v-act .pk-dot{background:var(--rust)}
.pk.v-act .pk-v{color:var(--rust)}
.pk.v-unknown .pk-dot{background:transparent;border:1px dashed var(--mut)}

/* Band headings. The step down in weight is the navigation. */
.band-head{margin:2.2rem 0 .6rem}
.band-head h2{font-size:1.15rem;font-weight:700;letter-spacing:-.02em;margin:0}
.band-head p{margin:.2rem 0 0;font-size:.84rem;max-width:46em}
.band-head .count{font-weight:400;font-size:.9rem}
.band-empty{font-size:.88rem;padding:.9rem 0 1.4rem;max-width:44em}

/* Today: the band that did not exist. A list, not cards — this is a to-do list
   and it should read like one. */
.wlist{list-style:none;margin:0;padding:0;border-top:1px solid var(--line)}
.wl{display:grid;gap:.2rem .8rem;align-items:baseline;padding:.6rem .2rem .6rem .8rem;
  border-bottom:1px solid var(--line);border-left:3px solid var(--brand);
  grid-template-columns:7rem minmax(8rem,auto) 1fr auto auto;
  grid-template-areas:"lever move room scope worth" ". gate gate gate gate"}
.wl.held{border-left-color:var(--line);background:var(--sunk)}
.wl:hover{background:color-mix(in oklab,var(--brand) 7%,transparent)}
.wl-lever{grid-area:lever;font-size:.66rem;letter-spacing:.06em;text-transform:uppercase;
  color:var(--mut)}
.wl-move{grid-area:move;font-variant-numeric:tabular-nums;font-size:.95rem}
.wl-move s{color:var(--mut);text-decoration-thickness:1px}
.wl-move b{font-weight:700}
.wl-room{grid-area:room;font-size:.88rem}
.wl-room a{color:var(--ink);text-decoration:none;border-bottom:1px solid var(--line)}
.wl-room a:hover{border-bottom-color:var(--brass)}
.wl-scope{grid-area:scope;font-size:.76rem;color:var(--mut);text-align:right}
.wl-worth{grid-area:worth;font-size:.9rem;font-weight:650;
  font-variant-numeric:tabular-nums;text-align:right;min-width:5rem}
.wl-gate{grid-area:gate;font-size:.76rem;color:var(--rust);font-weight:600}
@media (max-width:52rem){
  .wl{grid-template-columns:1fr auto;
    grid-template-areas:"lever worth" "move move" "room room" "scope scope" "gate gate"}
  .wl-scope,.wl-worth{text-align:left}
}

/* The filter row: what the four old counters actually were — how many rooms are
   in each state, and a way to see only those. */
.bar{display:flex;flex-wrap:wrap;gap:.5rem 1.4rem;align-items:center;
  margin:0 0 .8rem;padding-bottom:.7rem;border-bottom:1px solid var(--line)}
.seg{display:flex;flex-wrap:wrap;gap:.15rem}
.seg a{font-size:.8rem;padding:.3rem .55rem;border-radius:7px;text-decoration:none;
  color:var(--mut);border:1px solid transparent}
.seg a:hover{background:var(--sunk)}
.seg a.on{background:var(--brand);color:var(--on-brand);font-weight:650}
.seg .fc{font-variant-numeric:tabular-nums;opacity:.75;margin-left:.15rem}
.seg.quiet a.on{background:transparent;color:var(--ink);border-color:var(--line)}
.seg-k{font-size:.7rem;letter-spacing:.06em;text-transform:uppercase;color:var(--mut);
  align-self:center;margin-right:.2rem}

/* The room rail: state as a mark on the row, so the table scans without reading. */
.rail{display:inline-block;width:3px;height:1.05em;border-radius:2px;
  background:var(--line);margin-right:.55rem;vertical-align:-.15em}
tr.st-act .rail{background:var(--brand)}
tr.st-held .rail{background:var(--rust)}
tr.st-quiet .rail{background:transparent;box-shadow:inset 0 0 0 1px var(--line)}
.chev{font-size:.68rem;letter-spacing:.05em;text-transform:uppercase;color:var(--mut);
  margin-left:.5rem;opacity:0}
tr:hover .chev,tr.open .chev{opacity:1}

/* The open room: three groups, the last collapsed. Ten equal panels made the
   reader lose the table; a heading per group lets them stop after the first. */
.room{display:flex;flex-direction:column;gap:1.3rem;padding:.3rem 0 .6rem}
.rg-h{margin:0 0 .5rem;font-size:.72rem;letter-spacing:.09em;text-transform:uppercase;
  color:var(--mut);font-weight:650}
.rgroup>.panel:first-of-type{margin-top:0}
.rmore{border-top:1px solid var(--line);padding-top:.9rem}
.rmore>summary{list-style:none;cursor:pointer;display:flex;align-items:center;gap:.4rem}
.rmore>summary::-webkit-details-marker{display:none}
.rmore>summary::after{content:'+';font-size:.9rem;color:var(--mut)}
.rmore[open]>summary::after{content:'\\2212'}

/* ------------------------------------------------------------- the cockpit */
/* Eight tiles, each explaining itself. The verdict is a chip AND a word, never a
   colour alone: a reader who cannot distinguish the hues must still be able to
   tell "act" from "on track". */
.cockpit{margin:1.4rem 0 1rem}
.ck-head{margin-bottom:.7rem}
.ck-grid{display:grid;gap:.6rem;grid-template-columns:repeat(auto-fit,minmax(15.5rem,1fr))}
.kpi{background:var(--surface);border:1px solid var(--line);border-radius:var(--r-card);
  padding:.85rem .95rem;box-shadow:var(--shadow);display:flex;flex-direction:column;
  gap:.35rem;border-top:3px solid var(--line)}
.kpi header{display:flex;align-items:baseline;justify-content:space-between;gap:.5rem}
.kpi h3{font-size:.86rem;font-weight:600;margin:0;line-height:1.3;letter-spacing:-.005em}
/* The technical term is present but secondary — there so the reader recognises
   the word when a channel or a consultant uses it, not as the label. */
.kpi-term{font-size:.66rem;letter-spacing:.05em;text-transform:uppercase;
  color:var(--mut);flex:none;white-space:nowrap}
.kpi-fig{display:flex;align-items:baseline;gap:.55rem;flex-wrap:wrap}
.kpi-n{font-size:1.75rem;font-weight:700;line-height:1.1;letter-spacing:-.02em;
  font-variant-numeric:tabular-nums}
.kpi-none{font-size:.95rem;font-weight:400;font-style:italic;color:var(--mut)}
.kpi-vs{font-size:.76rem;color:var(--mut)}
.kpi-meta{display:flex;align-items:center;gap:.5rem;flex-wrap:wrap}
.kpi-basis{font-size:.72rem;color:var(--mut)}
.chip-v{font-size:.68rem;font-weight:650;letter-spacing:.05em;text-transform:uppercase;
  padding:.16rem .4rem;border-radius:5px;border:1px solid var(--line);color:var(--mut)}
/* Status colours, reserved: they are never used as a series hue anywhere else. */
.v-good{border-top-color:#0E8A63}
.v-good .chip-v{border-color:#0E8A63;color:#0E8A63}
.v-watch{border-top-color:var(--brand)}
.v-watch .chip-v{border-color:var(--brand);color:var(--brass)}
.v-act{border-top-color:var(--rust)}
.v-act .chip-v{border-color:var(--rust);color:var(--rust)}
.v-unknown{border-top-style:dashed}
/* The line that makes the tile teach rather than report. */
.kpi-money{margin:.15rem 0 0;font-size:.76rem;line-height:1.45;color:var(--mut)}
.kpi-flag{margin:.1rem 0 0;font-size:.74rem;color:var(--rust)}
@media (prefers-color-scheme: dark){
  .v-good{border-top-color:#0F9D74}
  .v-good .chip-v{border-color:#0F9D74;color:#0F9D74}
}

/* The action list. It leads the opened row, so it carries the only accent border
   on the page — a reader scanning for "what do I do" should land here first. */
.act-panel{border-left:3px solid var(--brand)}
.acts{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:.55rem}
.act{border:1px solid var(--line);border-radius:10px;padding:.6rem .75rem;
  background:var(--paper)}
/* Held, not hidden: a price case waiting on a visibility problem is information,
   and removing it would read as "no price case here". */
.act.held{border-style:dashed;opacity:.9}
.act-h{display:flex;flex-wrap:wrap;align-items:baseline;gap:.4rem .75rem}
.act-lever{font-size:.7rem;letter-spacing:.06em;text-transform:uppercase;
  color:var(--mut);flex:none}
.act-move{font-variant-numeric:tabular-nums;font-size:1rem}
.act-from{color:var(--mut);text-decoration:line-through;text-decoration-thickness:1px}
.act-arr{color:var(--mut);margin:0 .15rem}
.act-to{font-weight:700}
.act-scope{font-size:.8rem;color:var(--mut)}
.act-worth{margin-left:auto;font-size:.85rem;font-weight:650;
  font-variant-numeric:tabular-nums;white-space:nowrap}
.act-worth i{font-style:normal;font-weight:400;font-size:.72rem;color:var(--mut)}
.act-gate{margin-top:.3rem;font-size:.78rem;color:var(--rust);font-weight:600}
.act-why{margin-top:.28rem;font-size:.82rem;color:var(--mut);max-width:56em}
.act.lv-content{border-style:dotted}
.act.lv-content .act-lever{color:var(--mut)}

/* How our guests book. A quartile spread, not a lone median: 34 days with a
   spread of 8 to 96 is a different business from 30 to 38. */
.dgrid{display:flex;flex-wrap:wrap;gap:1.6rem}
.dlab{font-size:.72rem;letter-spacing:.04em;text-transform:uppercase;color:var(--mut)}
.dval{display:flex;align-items:baseline;gap:.4rem;font-variant-numeric:tabular-nums}
.dval b{font-size:1.25rem;font-weight:650}
.dq{font-size:.8rem;color:var(--mut)}
.orig{display:flex;flex-direction:column;gap:.22rem;margin-top:.3rem}
.orow{display:grid;grid-template-columns:2.6rem 1fr 3rem;gap:.5rem;align-items:center;
  font-size:.8rem}
.oname{font-weight:600}
.otrack{height:.45rem;background:var(--sunk);border-radius:999px;overflow:hidden}
.otrack span{display:block;height:100%}
.oval{text-align:right;font-variant-numeric:tabular-nums;color:var(--mut)}

/* The funnel. Counts are the figure; the step between them carries the rate and
   a meter whose scale is our own median — a 0.75% rate has no readable place on
   a 0-100% track, and this project measured exactly that. */
.fun{display:flex;flex-direction:column;gap:0;margin:.15rem 0 .1rem}
.fst{display:flex;align-items:baseline;gap:.5rem}
.fst-n{font-size:1.3rem;font-weight:650;line-height:1.25;
  font-variant-numeric:tabular-nums;min-width:4.6rem}
.fst-l{font-size:.8rem;color:var(--mut)}
.fstep{display:flex;align-items:center;gap:.55rem;padding:.22rem 0 .22rem 1.1rem;
  margin-left:.55rem;border-left:2px solid var(--line)}
.fstep-r{font-size:.82rem;font-weight:600;font-variant-numeric:tabular-nums;
  min-width:3.4rem;color:var(--brass)}
.fm{position:relative;display:block;flex:1;max-width:15rem;height:.5rem;
  background:var(--sunk);border-radius:999px;overflow:hidden}
.fm-fill{position:absolute;inset:0 auto 0 0;background:var(--c2);border-radius:999px}
/* Over twice the median: the track has run out, so the end is squared off rather
   than pretending the value fits. */
.fm-fill.over{background:var(--c3);border-radius:999px 0 0 999px}
.fm-mid{position:absolute;left:50%;top:0;bottom:0;width:1px;background:var(--mut);
  opacity:.55}
.fm-none{font-size:.72rem;color:var(--mut);font-style:italic}

/* A viewBox with 11px type scales its type too. At full container width the
   coverage bars rendered their counts larger than the hero, which inverted the
   whole page's hierarchy — caught by rendering it and looking. Capping the width
   at the size the type was drawn for keeps 11px meaning 11px. */
.cx{width:100%;max-width:620px;height:auto;display:block;overflow:visible;
  margin:.2rem 0 .1rem}
.cx-strip{width:auto;height:20px;vertical-align:middle;margin-left:.3rem}
.cx text{font-family:var(--font)}
.cx-lab{font-size:11px;fill:var(--mut)}
.cx-val{font-size:12px;fill:var(--ink);font-weight:600;
  font-variant-numeric:tabular-nums}
.cx-in{font-size:11px;font-variant-numeric:tabular-nums}
.cx-in.on{fill:var(--on-brand)}
.cx-in.off{fill:var(--mut)}
.cx-seg{font-size:11px;fill:#fff;font-weight:600;font-variant-numeric:tabular-nums}
.cx-ax{font-size:10px;fill:var(--mut);font-variant-numeric:tabular-nums}
.cx-dl{font-size:11px;font-weight:600;font-variant-numeric:tabular-nums}
.cx-dl.c1{fill:var(--c1)}
.cx-dl.c2{fill:var(--c2)}
.cx-dl.mut{fill:var(--mut);font-weight:500}
.cx-grid{stroke:var(--line);stroke-width:1}
/* Last year is a reference, not a series — dashed, so it cannot be misread as
   a fourth measurement. */
.cx-ref{stroke:var(--mut);stroke-width:1.5;stroke-dasharray:3 3}
.cx-line{fill:none;stroke-width:2;stroke-linejoin:round;stroke-linecap:round}
.cx-line.c2{stroke:var(--c2)}
/* A 2px surface ring, so an overlapping dot stays separable from its line. */
.cx-dot{stroke:var(--surface);stroke-width:2}
.cx-dot.c1{fill:var(--c1)}
.cx-dot.c2{fill:var(--c2)}
.cx-keys{display:flex;flex-wrap:wrap;gap:.3rem 1rem;margin-top:.45rem;
  font-size:.76rem;color:var(--mut)}
.cx-key i{display:inline-block;width:.55rem;height:.55rem;border-radius:2px;
  margin-right:.35rem;vertical-align:baseline}

/* The lever matrix. A fixed grid, so an EMPTY cell is as informative as a full
   one — which a row of chips could never be. */
.lvgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(6.6rem,1fr));gap:.3rem}
.lv{border:1px solid var(--line);border-radius:8px;padding:.35rem .45rem;
  min-height:2.9rem;display:flex;flex-direction:column;justify-content:space-between}
.lv-k{font-size:.66rem;line-height:1.25;color:var(--mut);text-transform:capitalize}
.lv-v{font-size:.86rem;font-weight:650;font-variant-numeric:tabular-nums}
.lv.on{border-color:var(--brand);background:color-mix(in oklab,var(--brand) 14%,transparent)}
.lv.on .lv-v{color:var(--brass)}
.lv.off{opacity:.6}
.lv.unk{border-style:dashed}
.lv.none{background:var(--sunk);opacity:.5}
.lvkey{display:flex;flex-wrap:wrap;align-items:center;gap:.3rem .9rem;
  margin-top:.6rem;font-size:.72rem;color:var(--mut)}
.lvkey .lv{min-height:0;width:.85rem;height:.85rem;padding:0;border-radius:3px;
  display:inline-block;margin-right:-.15rem}
.ph{font-size:1.05rem;margin:0}
.stat{padding:.9rem 1.1rem}
.card > h1:first-child{margin-bottom:.5rem}

.top{display:flex;flex-wrap:wrap;gap:1rem;align-items:flex-end;
  justify-content:space-between;margin-bottom:1.5rem}
.controls{display:flex;gap:.5rem;align-items:center}

/* Segmented control, as on the Suite's dashboard: pills, the active one solid. */
.lens a{display:inline-block;padding:.35rem .75rem;border:1px solid var(--line);
  border-radius:var(--r-ctl);text-decoration:none;font-size:.85rem;font-weight:500;
  background:var(--surface)}
/* The one place the brand amber appears on the dashboard. The Suite spends it on
   the primary action and nowhere else; here the basis switch IS the primary
   action, and a page with no amber at all did not read as Elev8. It stays off
   the data: no number and no severity is ever amber, or the colour would start
   meaning two things. */
.lens a.on{background:var(--brand);color:var(--on-brand);border-color:var(--brand);font-weight:600}
.lang{font-size:.78rem;color:var(--mut)}
.lang a{text-decoration:none;border-bottom:1px dotted var(--line)}

/* Buttons. The primary action is the brand amber — the Suite uses it for
   exactly this and nothing else, which is why it stays scarce here too. */
button{
  font:inherit;font-size:.875rem;font-weight:500;
  padding:.5rem 1rem;border-radius:var(--r-ctl);border:0;
  background:var(--brand);color:var(--on-brand);cursor:pointer;
}
button:hover{filter:brightness(.96)}
/* A disabled action must not look like a live brand button with the lights
   dimmed. It goes neutral, which is what the Suite does and what actually reads
   as "not available" rather than "amber, but sad". */
button[disabled]{background:var(--sunk);color:var(--mut);cursor:not-allowed;filter:none}

/* A row of actions with its own label. Replaces three ad-hoc inline styles and
   a form that had been accidentally split across two of them. */
.actions{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem;margin:.9rem 0 0}
.actions .label{color:var(--mut);font-size:.875rem;margin-right:.15rem}
.btn{display:flex;align-items:center;justify-content:center;gap:.6rem;
  text-decoration:none;padding:.55rem .9rem;border:1px solid var(--line);
  border-radius:var(--r-ctl);background:var(--surface);color:var(--ink);
  font-weight:500;font-size:.9rem}
input{font:inherit;font-size:.9rem;padding:.55rem .7rem;border-radius:var(--r-ctl);
  border:1px solid var(--line);background:var(--paper);color:var(--ink);margin-bottom:.6rem}

.banner{border:1px solid var(--line);border-radius:var(--r-card);
  padding:.8rem 1rem;margin-bottom:.7rem;font-size:.9rem;background:var(--surface)}
.banner.warn{border-left:3px solid var(--rust)}
.banner.demo{border-left:3px solid var(--brand)}
.card.warn{border-left:3px solid var(--brand)}

/* Stat tiles, in the Suite's order: small muted label, then the number large. */
.stats{display:grid;gap:.8rem;grid-template-columns:repeat(auto-fit,minmax(12rem,1fr));
  margin:1.2rem 0}
.stat .k{font-size:.78rem;color:var(--mut);font-weight:500}
.stat .v{font-size:1.75rem;font-weight:700;letter-spacing:-.025em;
  font-variant-numeric:tabular-nums;margin-top:.15rem;line-height:1.2}

/* The table's own scroll box. The webkit momentum property keeps the flick on
   iOS; without it a narrow reader has to drag. (No backticks in here — this
   whole stylesheet lives inside a template literal, and a backtick in a comment
   ends the string. Fourth time.) */
/* The group picker. A real form, so it sits in the band head as one control
   rather than as three floating pieces. */
.gpick{display:flex;align-items:center;gap:.45rem;flex-wrap:wrap;font-size:.82rem}
.gpick label{color:var(--mut);font-size:.72rem;letter-spacing:.08em;
  text-transform:uppercase;font-weight:650}
.gpick select{font:inherit;font-size:.85rem;color:var(--ink);background:var(--surface);
  border:1px solid var(--line);border-radius:var(--r-ctl);padding:.3rem .5rem;
  max-width:16rem}
.gpick button{font:inherit;font-size:.82rem;font-weight:600;cursor:pointer;
  color:var(--ink);background:var(--surface);border:1px solid var(--line);
  border-radius:var(--r-ctl);padding:.32rem .7rem}
.gpick button:hover{border-color:var(--mut)}
/* Only the rooms band head, by its id. A bare .band-head rule here would have
   made every band head a flex row, which puts Today's lead paragraph beside its
   heading instead of under it — the kind of change that looks like a one-line
   win and quietly reflows two other bands.
   (No backticks anywhere in this file: the whole stylesheet is inside a template
   literal and a backtick in a comment ends the string. Fifth time.) */
#rooms{display:flex;align-items:baseline;justify-content:space-between;
  gap:1rem 1.4rem;flex-wrap:wrap}

.tscroll{overflow-x:auto;-webkit-overflow-scrolling:touch}
.tscroll>table{min-width:34rem}
table{width:100%;border-collapse:collapse;font-size:.875rem;
  background:var(--surface);border:1px solid var(--line);
  border-radius:var(--r-card);overflow:hidden}
/* A table already inside a card must not draw a second frame around itself. */
.card table{border:0;background:transparent;border-radius:0}
th{text-align:left;font-size:.75rem;font-weight:500;color:var(--mut);
  padding:.6rem .8rem;border-bottom:1px solid var(--line);background:transparent}
td{padding:.7rem .8rem;border-bottom:1px solid var(--line);vertical-align:top}
tr:last-child td{border-bottom:none}
tr.open td{background:var(--sunk)}
tr.detail td{background:var(--sunk);padding:1rem}
td.num,.num{font-variant-numeric:tabular-nums;white-space:nowrap}
.rowlink{text-decoration:none;font-weight:600}
.rowlink:hover{text-decoration:underline}

/* Badges: the Suite's are small, fully rounded and quiet unless they matter. */
.tag{display:inline-block;border:1px solid var(--line);border-radius:999px;
  padding:.05rem .5rem;font-size:.7rem;color:var(--mut);margin-left:.3rem}
.tag.hold{border-color:var(--brass);color:var(--brass)}

.head{font-weight:600;margin:0 0 .8rem}
ul.gate{list-style:none;margin:0 0 .6rem;padding:0;display:flex;flex-wrap:wrap;
  gap:1rem;font-size:.86rem}
.dot{display:inline-block;width:.5rem;height:.5rem;border-radius:50%;margin-right:.35rem}
.dot.good{background:var(--ink)}
.dot.bad{background:var(--rust)}
.dot.unk{background:var(--line)}
ul.ev{margin:0;padding-left:1.1rem;font-size:.86rem;display:flex;
  flex-direction:column;gap:.3rem}

/* Fill shares on the shapes page. Full is neutral rather than green: a field
   that is 100% populated is normal, not an achievement. */
.full{color:var(--ink);font-weight:600}
.some{color:var(--brass);font-weight:600}
.none{color:var(--rust);font-weight:600}

/* The market comparison, as the Suite renders a delta: a small quiet chip, not a
   wall of red text. Six rows of red percentages made a portfolio with three
   findings look like an emergency, which is the opposite of the job. */
.pair{font-weight:600;font-variant-numeric:tabular-nums}
.chip{display:inline-block;border-radius:999px;padding:.05rem .45rem;margin-left:.35rem;
  font-size:.72rem;font-weight:600;font-variant-numeric:tabular-nums;
  background:var(--sunk);color:var(--mut)}
.chip.down{color:var(--rust)}
.chip.up{color:var(--ink)}

/* Opening a row must land on the row. The anchor does the work; this keeps the
   row off the very top edge so the header above it stays readable. */
tr[id]{scroll-margin-top:1rem}

svg.pot{width:100%;max-width:640px;height:auto;display:block;margin:.2rem 0}
svg.pot .lbl{font:500 12px var(--font);fill:var(--mut)}
svg.pot .val{font:600 12px var(--font);fill:var(--ink);font-variant-numeric:tabular-nums}
svg.pot .cap{font:400 11px var(--font);fill:var(--mut)}

/* The glossary. A details/summary element, so it costs no JavaScript, no extra
   page and no round trip — it is open or closed in the browser and nowhere else. */
.legend{margin-top:1.5rem;border:1px solid var(--line);border-radius:var(--r-card);
  background:var(--surface);padding:.6rem 1.1rem}
.legend summary{cursor:pointer;font-weight:600;font-size:.9rem;padding:.35rem 0}
.legend summary::marker{color:var(--mut)}
.legend p{margin:.4rem 0 .8rem;font-size:.85rem}
.legend dl{margin:0 0 .6rem;display:grid;grid-template-columns:minmax(8rem,11rem) 1fr;
  gap:.45rem 1.2rem;font-size:.86rem}
.legend dt{font-weight:600}
.legend dd{margin:0;color:var(--mut)}
@media (max-width:44rem){
  .legend dl{grid-template-columns:1fr;gap:.1rem .8rem}
  .legend dd{margin:0 0 .5rem}
}

footer{margin-top:1.5rem;color:var(--mut);font-size:.82rem;
  display:flex;flex-wrap:wrap;gap:.9rem}
.empty{padding:2.5rem 1rem;text-align:center;color:var(--mut)}
`.trim()

/**
 * The common head.
 *
 * Inter comes from Google Fonts because it is the Suite's typeface and a system
 * fallback stack does not look like it. The stack behind it is real rather than
 * decorative: if the font request fails — an offline laptop, a blocked CDN — the
 * page renders in the platform sans instead of a serif surprise.
 *
 * `refresh` exists for exactly one caller: the import page polls itself while a
 * run is in flight. It is a parameter rather than a template so a page cannot
 * accidentally keep reloading once its work has finished.
 */
export function head(title: string, opts: { refresh?: number, lang?: string } = {}): string {
  return `<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#ffffff">
${opts.refresh ? `<meta http-equiv="refresh" content="${opts.refresh}">` : ''}
<title>${title}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap">
<link rel="stylesheet" href="/theme.css">`
}
