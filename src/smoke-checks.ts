/**
 * The first check, and the invariants that make it trustworthy.
 *
 * The interesting tests here are not "does it fire". They are the four ways a
 * check like this produces something confident and wrong:
 *
 *   1. NAMING A LEVER IT CANNOT SEE. Three of four gates are unknown while the
 *      MyDataValue grant is revoked. A check that answers "price" on a listing
 *      nobody can find has diagnosed nothing and will get a price cut approved.
 *   2. A NUMBER WITH NO SOURCE. Every figure in the stored sentence must exist in
 *      finding_number with where it came from, and a derived value must not
 *      borrow the name of a metric it is not.
 *   3. HALF A TRANSLATION. Migration 012 stores the finished sentence per
 *      language because a template re-rendered later would make the audit trail
 *      claim something the approver never saw. A missing Indonesian string is
 *      worse than none, because it looks finished.
 *   4. ACCUMULATING INSTEAD OF REPLACING. Press the button twice and the count
 *      that is supposed to be trusted becomes a measure of how often it was
 *      pressed.
 */
import { Pool } from 'pg'
import { assess, CHECK_KEY, MIN_NIGHTS, WINDOW, GAP_LOW, GAP_MEDIUM, GAP_HIGH,
         MPI_HIGH, BASE_CONFIDENCE, FUNNEL_UNKNOWN_FACTOR, BLOCKED_OCCUPANCY_FLOOR,
         type CheckInput, type Text } from './checks/occupancy-gap.js'
import { runChecks } from './checks/run.js'
import { portfolio, gate, evidence, notAssessable, counts } from './dashboard/query.js'
import { isCheckReport, reportCounts } from './import/run.js'

const pool = new Pool({ connectionString: process.env.DATABASE_URL! })
let fails = 0
const check = (n: string, ok: boolean, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? '  — ' + extra : ''}`); if (!ok) fails++
}

const ASOF = '2026-08-25'

const base: CheckInput = {
  entityId: '00000000-0000-0000-0000-000000000000', label: 'Test Flat', band: '2BR',
  occupancy: 21, marketOccupancy: 51, mpi: 2.08, revenue: 1_200,
  priceRecommended: 47, priceLive: 45, nights: 30, currency: 'CHF', asOf: ASOF,
  funnel: { kind: 'unread' },
}
const withInput = (over: Partial<CheckInput>): CheckInput => ({ ...base, ...over })

/** The baseline finding, for assertions about what it does NOT contain. */
const d0 = () => {
  const v = assess(base)
  if (v.kind !== 'finding') throw new Error('the baseline input must produce a finding')
  return v.draft
}

/** Every stored sentence, so the language invariant can be checked over all of them. */
function allTexts(d: ReturnType<typeof assess>): Text[] {
  if (d.kind === 'not_assessable') return [d.reason]
  if (d.kind === 'healthy') return [d.note]
  return [d.draft.headline, ...d.draft.gates.map(g => g.note),
          ...d.draft.evidence.map(e => e.claim)]
}

async function main() {
  /* ---------------------------------------------- 1 · absence, named separately */

  const nothing = assess(withInput({ occupancy: null, marketOccupancy: null, nights: 0 }))
  check('a room PriceLabs holds nothing for is not assessable',
        nothing.kind === 'not_assessable')
  check('and the reason says all three halves are missing',
        nothing.kind === 'not_assessable' && nothing.reason.en.includes('no calendar'),
        nothing.kind === 'not_assessable' ? nothing.reason.en : '')

  const noOurs = assess(withInput({ occupancy: null }))
  check('no occupancy of our own is its own reason',
        noOurs.kind === 'not_assessable' && noOurs.reason.en.includes('no occupancy figure'))

  const noMarket = assess(withInput({ marketOccupancy: null }))
  check('a missing MARKET is a different reason, because it needs a different fix',
        noMarket.kind === 'not_assessable'
        && noMarket.reason.en.includes('nothing to compare against'),
        noMarket.kind === 'not_assessable' ? noMarket.reason.en : '')

  const thin = assess(withInput({ nights: MIN_NIGHTS - 1 }))
  check('a calendar below the floor is refused rather than extrapolated',
        thin.kind === 'not_assessable' && thin.reason.en.includes(`${MIN_NIGHTS - 1} of ${WINDOW}`),
        thin.kind === 'not_assessable' ? thin.reason.en : '')
  check('and exactly at the floor it is assessed',
        assess(withInput({ nights: MIN_NIGHTS })).kind === 'finding')

  /* ---------------------------------------------- 1b · a blocked calendar is not performance */

  // The worst failure this check could produce, and it comes from a real
  // measurement: a room reading 100% occupied whose revenue is zero and whose
  // ADR is the -1 sentinel. Read naively it is far above the market and the
  // check says nothing at all about a room that earns nothing.
  const blocked = assess(withInput({ occupancy: 100, revenue: 0 }))
  check('a full calendar with no revenue is NOT reported as healthy',
        blocked.kind !== 'healthy', blocked.kind)
  check('it is not assessable, and the reason says the nights are blocked',
        blocked.kind === 'not_assessable' && blocked.reason.en.includes('blocked rather than booked'),
        blocked.kind === 'not_assessable' ? blocked.reason.en : '')
  const blockedLow = assess(withInput({ occupancy: BLOCKED_OCCUPANCY_FLOOR, revenue: 0 }))
  check('the guard fires at the floor too, not only on a full calendar',
        blockedLow.kind === 'not_assessable')
  const emptyNew = assess(withInput({ occupancy: 0, revenue: 0 }))
  check('but an EMPTY calendar is a finding, not a block: nothing is closed there',
        emptyNew.kind === 'finding', emptyNew.kind)
  const earning = assess(withInput({ occupancy: 100, revenue: 5_000 }))
  check('a full calendar that earns is healthy, as it should be',
        earning.kind === 'healthy')
  const unknownRevenue = assess(withInput({ revenue: null }))
  check('with no revenue figure the guard cannot run, and the finding says so',
        unknownRevenue.kind === 'finding' && unknownRevenue.draft.evidence.some(
          e => e.metric === 'revenue_next_30d' && e.side === 'unknown'),
        JSON.stringify(unknownRevenue.kind === 'finding'
          ? unknownRevenue.draft.evidence.map(e => e.metric) : ''))
  check('and a known revenue does not invent that caveat',
        !d0().evidence.some(e => e.metric === 'revenue_next_30d'))

  /* ---------------------------------------------- 2 · the threshold and severity */

  check('a room level with the market is healthy, not a finding',
        assess(withInput({ occupancy: 51 })).kind === 'healthy')
  check('a room AHEAD of the market is healthy',
        assess(withInput({ occupancy: 70 })).kind === 'healthy')
  check('just below the threshold is still healthy',
        assess(withInput({ occupancy: 51 - (GAP_LOW - 1) })).kind === 'healthy')

  const low = assess(withInput({ occupancy: 51 - GAP_LOW }))
  const med = assess(withInput({ occupancy: 51 - GAP_MEDIUM }))
  const high = assess(withInput({ occupancy: 51 - GAP_HIGH }))
  check('at the threshold the severity is low',
        low.kind === 'finding' && low.draft.severity === 'low')
  check('twenty points is medium', med.kind === 'finding' && med.draft.severity === 'medium')
  check('thirty points is high', high.kind === 'finding' && high.draft.severity === 'high')
  // 'critical' is reserved and the type says so: this check cannot reach it,
  // because the worst it can establish is a gap with no confirmed cost behind it.
  check('nothing is ever critical from this check alone',
        [low, med, high].every(v => v.kind === 'finding'
          && ['low', 'medium', 'high'].includes(v.draft.severity)))

  /* ---------------------------------------------- 3 · the money, and its band */

  const f = assess(base)
  if (f.kind !== 'finding') throw new Error('expected a finding')
  const d = f.draft
  // 30 points of 30 nights is 9 nights; 9 × 47 = 423.
  check('the amount is the missing nights at the recommended price',
        d.amountRevenue === 423, String(d.amountRevenue))
  check('the band runs from the live price to the recommended one',
        d.bandLow === 405 && d.bandHigh === 423, `${d.bandLow}..${d.bandHigh}`)
  check('the margin stays null, because there is no confirmed cost basis',
        d.amountMargin === null)
  const noPrice = assess(withInput({ priceRecommended: null, priceLive: null }))
  check('with no price at all the finding still stands',
        noPrice.kind === 'finding')
  check('but carries no amount rather than a made-up one',
        noPrice.kind === 'finding' && noPrice.draft.amountRevenue === null
        && noPrice.draft.bandLow === null)
  const onlyLive = assess(withInput({ priceRecommended: null }))
  check('a live price alone is used and the band stays absent',
        onlyLive.kind === 'finding' && onlyLive.draft.amountRevenue === 405
        && onlyLive.draft.bandLow === null, String(
          onlyLive.kind === 'finding' ? onlyLive.draft.amountRevenue : ''))

  /* ---------------------------------------------- 4 · the gates, and the lever */

  check('all four gates are present', d.gates.length === 4)
  const funnel = d.gates.filter(g => g.stage !== 'price')
  check('the three funnel gates are UNKNOWN, not omitted and not healthy',
        funnel.length === 3 && funnel.every(g => g.verdict === 'unknown'))
  check('and each says why', funnel.every(g => g.note.en.includes('MyDataValue')))
  check('the price gate fails on a high index',
        d.gates.find(g => g.stage === 'price')?.verdict === 'failing')

  check('a lever is named when the index is high AND the room is reachable',
        d.firstFailing === 'price')
  const invisible = assess(withInput({ occupancy: 0 }))
  check('but NOT when occupancy is zero: invisible and overpriced measure the same',
        invisible.kind === 'finding' && invisible.draft.firstFailing === null,
        invisible.kind === 'finding' ? String(invisible.draft.firstFailing) : '')
  const fairPrice = assess(withInput({ mpi: 1.0 }))
  check('and not when the price is inside the normal spread',
        fairPrice.kind === 'finding' && fairPrice.draft.firstFailing === null)
  check('a normal index makes the price gate unknown, not healthy',
        fairPrice.kind === 'finding'
        && fairPrice.draft.gates.find(g => g.stage === 'price')?.verdict === 'unknown')
  const cheap = assess(withInput({ mpi: 0.8 }))
  check('below the market the price gate is healthy and argues AGAINST the finding',
        cheap.kind === 'finding'
        && cheap.draft.gates.find(g => g.stage === 'price')?.verdict === 'healthy'
        && cheap.draft.evidence.some(e => e.metric === 'mpi_next_30d' && e.side === 'against'))
  check('the index threshold is above parity, so a rounding difference never fires',
        MPI_HIGH > 1)

  /* ---------------------------------------------- 5 · the counter-case is required */

  check('every finding carries an against row about the unmeasured funnel',
        [f, invisible, fairPrice, cheap, noPrice].every(v => v.kind === 'finding'
          && v.draft.evidence.some(e => e.side === 'against' && e.family === 'funnel')))
  check('and it says a visibility problem would look identical',
        d.evidence.some(e => e.family === 'funnel' && e.claim.en.includes('look')))
  check('the uncomputable margin is recorded as unknown, not as zero',
        d.evidence.some(e => e.side === 'unknown' && e.metric === 'amount_margin'))
  const partial = assess(withInput({ nights: 20 }))
  check('a partial window argues against its own amount',
        partial.kind === 'finding' && partial.draft.evidence.some(
          e => e.side === 'against' && e.metric === 'nights_archived'))
  check('a full window does not invent that caveat',
        !d.evidence.some(e => e.metric === 'nights_archived'))

  /* ---------------------------------------------- 6 · every number has a source */

  const tokens = new Set(d.numbers.map(n => n.token))
  for (const t of ['occupancy', 'market_occupancy', 'gap_pp', 'nights_gap',
                   'nights_archived', 'mpi', 'price_recommended', 'price_live', 'at_stake']) {
    check(`the prose number "${t}" is recorded with its source`, tokens.has(t))
  }
  check('a derived figure says it is derived rather than borrowing a metric name',
        d.numbers.find(n => n.token === 'gap_pp')?.sourceField.startsWith('derived:') === true
        && d.numbers.find(n => n.token === 'at_stake')?.sourceField.startsWith('derived:') === true)
  check('a fetched figure names the metric it came from',
        d.numbers.find(n => n.token === 'occupancy')?.sourceField === 'occupancy_next_30d')
  check('the amount in the sentence is the amount on the row',
        d.headline.en.includes("423") && d.amountRevenue === 423, d.headline.en)
  check('with no price, no amount token is invented',
        noPrice.kind === 'finding'
        && !noPrice.draft.numbers.some(n => n.token === 'at_stake'))

  /* ---------------------------------------------- 7 · confidence, and why it is low */

  const expected = Math.round(BASE_CONFIDENCE * FUNNEL_UNKNOWN_FACTOR * 1000) / 1000
  check('a full window is discounted only by the missing funnel',
        d.confidence === expected, `${d.confidence} vs ${expected}`)
  check('and it is well below face value, because three gates are unseen',
        d.confidence < 0.6)
  check('a shorter window lowers it further',
        partial.kind === 'finding' && partial.draft.confidence < d.confidence)

  /* ---------------------------------------------- 8 · both languages, always */

  for (const v of [f, low, med, high, noPrice, cheap, invisible, nothing, noOurs,
                   noMarket, thin, assess(withInput({ occupancy: 51 }))]) {
    const texts = allTexts(v)
    check(`${v.kind}: every stored sentence carries both languages`,
          texts.length > 0 && texts.every(t => t.en.trim().length > 10 && t.id.trim().length > 10),
          JSON.stringify(texts.find(t => !t.id || t.id.trim().length <= 10) ?? ''))
    check(`${v.kind}: the two languages are not the same string`,
          texts.every(t => t.en !== t.id))
  }

  /* ---------------------------------------------- 9 · the window is dated */

  check('the window starts on the day we observed it', d.windowFrom === ASOF)
  check('and runs the length of the metric', d.windowTo === '2026-09-24')

  /* -------------------------------- 9b · the funnel reason is derived, not asserted */

  // The gate notes hardcoded "the MyDataValue grant is revoked". It went stale
  // the day the grant came back — every finding on the page kept announcing a
  // revocation that no longer existed — and it was never something this check had
  // established. It stated a CAUSE for missing data without looking.
  const noteFor = (state: CheckInput['funnel']) => {
    const v = assess(withInput({ funnel: state }))
    if (v.kind !== 'finding') throw new Error('expected a finding')
    return v.draft.gates.find(g => g.stage === 'impressions')!.note
  }
  check('when nothing reads the funnel, that is what it says',
        noteFor({ kind: 'unread' }).en === 'no impression data: nothing reads MyDataValue\u2019s funnel yet',
        noteFor({ kind: 'unread' }).en)
  check('a revoked grant says a new authorisation is needed',
        noteFor({ kind: 'grant_revoked' }).en.includes('new authorisation'))
  check('a stale token says it is behind, not revoked',
        noteFor({ kind: 'grant_stale' }).en.includes('behind the chain')
        && !noteFor({ kind: 'grant_stale' }).en.includes('revoked'),
        noteFor({ kind: 'grant_stale' }).en)
  check('an unconfigured source says so rather than blaming a grant',
        noteFor({ kind: 'not_configured' }).en.includes('not configured'))
  check('and when the funnel IS read, the gap is about the room and the window',
        noteFor({ kind: 'read' }).en.includes('this room in this window'),
        noteFor({ kind: 'read' }).en)
  check('no state claims a revocation unless the grant is actually revoked',
        (['unread', 'grant_stale', 'not_configured', 'read'] as const)
          .every(k => !noteFor({ kind: k }).en.includes('revoked')))
  for (const k of ['unread', 'grant_revoked', 'grant_stale', 'not_configured', 'read'] as const) {
    const n = noteFor({ kind: k })
    check(`${k}: both languages are written`, n.en.length > 20 && n.id.length > 20
          && n.en !== n.id, JSON.stringify(n))
  }
  const against = (() => {
    const v = assess(withInput({ funnel: { kind: 'unread' } }))
    if (v.kind !== 'finding') throw new Error('expected a finding')
    return v.draft.evidence.find(e => e.family === 'funnel')!.claim
  })()
  check('the counter-case carries the same measured reason',
        against.en.includes('nothing reads') && against.en.includes('look identical'),
        against.en)

  /* ---------------------------------------------- 10 · the run, against a database */

  const c = await pool.connect()
  await c.query(`truncate entity, entity_alias, unresolved_alias, snapshot, snapshot_market,
                 booking_economics, api_shape, raw_payload, dataset_freshness,
                 finding, not_assessable cascade`)

  const { rows: made } = await c.query<{ id: string }>(
    `insert into entity (label, market, band, band_basis) values
       ('Gap Villa',    'bali', '2BR', 'bedrooms'),
       ('Healthy Flat', 'ch',   '1BR', 'bedrooms'),
       ('Thin Flat',    'ch',   '1BR', 'bedrooms'),
       ('Unbanded',     'ch',   null,  null)
     returning id`)
  const [gapVilla, healthy, thinFlat] = made.map(r => r.id) as [string, string, string]

  const win = async (id: string, occ: number, market: number, mpi: number) => {
    for (const [metric, value] of [['occupancy_next_30d', occ],
                                   ['market_occupancy_next_30d', market],
                                   ['mpi_next_30d', mpi],
                                   // Revenue on the books, so the blocked-calendar
                                   // guard has the figure it needs.
                                   ['revenue_next_30d', occ * 20]] as const) {
      await c.query(
        `insert into snapshot (entity_id, metric, stay_date, as_of_date, value, source)
         values ($1, $2, $3::date, $3::date, $4, 'pricelabs')`, [id, metric, ASOF, value])
    }
  }
  const cal = async (id: string, nights: number, rec: number, live: number) => {
    for (let i = 0; i < nights; i++) {
      const day = new Date(`${ASOF}T00:00:00Z`)
      day.setUTCDate(day.getUTCDate() + i)
      const stay = day.toISOString().slice(0, 10)
      await c.query(
        `insert into snapshot (entity_id, metric, stay_date, as_of_date, value, currency, source)
         values ($1, 'price_recommended', $2::date, $3::date, $4, 'CHF', 'pricelabs'),
                ($1, 'price_current',     $2::date, $3::date, $5, 'CHF', 'pricelabs')`,
        [id, stay, ASOF, rec, live])
    }
  }
  await win(gapVilla, 21, 51, 2.08)
  await cal(gapVilla, 30, 47, 45)
  await win(healthy, 55, 51, 1.02)
  await cal(healthy, 30, 60, 60)
  await win(thinFlat, 10, 51, 1.5)
  await cal(thinFlat, 5, 40, 40)

  const r1 = await runChecks(c, { today: ASOF })
  check('the run considers every active room', r1.considered === 4, JSON.stringify(r1))
  check('one finding, one healthy, two unreachable',
        r1.findings === 1 && r1.healthy === 1 && r1.notAssessable === 2,
        JSON.stringify(r1))
  check('the unbanded room is counted as such', r1.unbanded === 1)
  check('the lever was named exactly once', r1.leverNamed === 1)
  check('nothing was superseded on a first run', r1.superseded === 0)
  check('the report tags itself as a check run', isCheckReport(r1))
  // MDV_CLIENT_ID is not set in the test environment, so the honest answer is
  // "not configured" — and the run records which of the five it was, so a
  // finding's prose can be traced to the state that produced it.
  check('and it records WHY the funnel gates were dark',
        r1.funnel === 'not_configured', r1.funnel)
  check('and the import page reads it as findings, healthy, unreachable',
        reportCounts(r1).created === 1 && reportCounts(r1).known === 1
        && reportCounts(r1).unresolved === 2, JSON.stringify(reportCounts(r1)))

  const rows = await portfolio(c, 'revenue', 'en')
  const villa = rows.find(x => x.label === 'Gap Villa')
  check('the dashboard now shows a finding where it showed none',
        villa?.findings === 1 && villa?.worstSeverity === 'high', JSON.stringify(villa))
  check('with money at stake and a currency', Number(villa?.atStake) === 423
        && villa?.currency === 'CHF', JSON.stringify(villa?.atStake))
  check('and the sentence a human reads',
        Boolean(villa?.headline?.includes('30 points below the market')), villa?.headline ?? '')
  check('the worst domain is the price gate, because the room is reachable',
        villa?.firstFailing === 'price')

  const inId = await portfolio(c, 'revenue', 'id')
  const villaId = inId.find(x => x.label === 'Gap Villa')
  check('the stored Indonesian sentence is served, not a re-render',
        Boolean(villaId?.headline?.includes('poin di bawah pasar')), villaId?.headline ?? '')

  const gates = await gate(c, villa!.worstFindingId!, 'en')
  check('the gates come back in funnel order', gates.map(g => g.stage).join(',')
        === 'impressions,ctr,conversion,price', gates.map(g => g.stage).join(','))
  check('three of them read unknown on the page',
        gates.filter(g => g.verdict === 'unknown').length === 3)
  const ev = await evidence(c, villa!.worstFindingId!, 'en')
  check('the counter-case reaches the page',
        ev.some(x => x.side === 'against' && x.family === 'funnel'), JSON.stringify(ev.map(x => x.side)))
  const evId = await evidence(c, villa!.worstFindingId!, 'id')
  check('and it is readable in Indonesian too',
        evId.some(x => x.claim.includes('funnel belum terukur')))

  const na = await notAssessable(c, 'en')
  check('the unreachable rooms are named with their missing signal',
        na.some(x => x.label === 'Thin Flat' && x.reason.includes('5 of 30')),
        JSON.stringify(na))
  check('the unbanded room appears once, with the structural reason',
        na.filter(x => x.label === 'Unbanded').length === 1, JSON.stringify(na))

  const numbers = await c.query<{ token: string, source_field: string }>(
    `select token, source_field from finding_number where finding_id = $1 order by token`,
    [villa!.worstFindingId!])
  check('every number in the sentence is stored with its origin',
        numbers.rows.length === 9, JSON.stringify(numbers.rows.map(n => n.token)))

  /* ---------------------------------------------- 11 · a re-run replaces */

  const r2 = await runChecks(c, { today: ASOF })
  check('the second run retires the first run\'s findings', r2.superseded === 1)
  const after = await counts(c)
  check('and the open count does NOT grow by pressing the button twice',
        after.open === 1, JSON.stringify(after))
  const supers = await c.query<{ n: number }>(
    `select count(*)::int n from finding where state = 'superseded'`)
  check('the retired finding is kept, not deleted: a decision record must be auditable',
        supers.rows[0]?.n === 1)
  const naAfter = await notAssessable(c, 'en')
  check('the same day\'s reasons are replaced, not doubled',
        naAfter.filter(x => x.label === 'Thin Flat').length === 1)

  c.release()
  await pool.end()
  console.log(fails ? `\n${fails} FAILED` : '\nall green')
  process.exit(fails ? 1 : 0)
}

main().catch(e => { console.error(e); process.exit(1) })
