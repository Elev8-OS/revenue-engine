/**
 * The first check: occupancy against the market, over the next thirty nights.
 *
 * This is the whole point of the system, and it is deliberately the FIRST check
 * rather than the cleverest one, because it is the only claim the archive can
 * currently support on both sides. `/v1/listing_metrics` returns
 * `occupancy_next_30d` for the listing AND `market_occupancy_next_30d` for its
 * own neighbourhood, computed by the provider from the same comparable set. Two
 * numbers, one call, same method. Every other comparison we could attempt right
 * now would be our arithmetic against their number, and that is a different and
 * weaker kind of sentence.
 *
 * WHAT THIS CHECK MAY NOT SAY, AND WHY IT MATTERS MOST
 *
 * A gap is not a cause. The design rule for this product is that a listing which
 * is shown and not clicked has no price problem — so the funnel decides which
 * lever is at fault, and the funnel is MyDataValue's: impressions,
 * click-through, conversion. That grant is revoked. Three of the four gates are
 * therefore `unknown` on every finding this check writes, and they are written
 * as `unknown` rather than omitted, because a gate nobody can see is not the
 * same as a gate that passed.
 *
 * The consequences are carried through honestly instead of being argued away:
 *
 *   1. `first_failing` stays NULL unless the price gate fails AND the listing
 *      has non-zero occupancy. Occupancy above zero is the one piece of evidence
 *      we hold that the listing is reachable at all — somebody found it and
 *      booked it. Without that, "invisible" and "overpriced" produce the same
 *      measurement, and naming a lever would be a guess wearing a label.
 *   2. Confidence is multiplied down by the missing funnel, not left at face
 *      value. The factor is named in code so that the day MDV returns, the
 *      number moves for a stated reason.
 *   3. Every finding carries an `against` evidence row saying the funnel is
 *      unmeasured. Migration 006 requires a counter-case; this is not a formality
 *      here, it is the single most important row on the screen.
 *
 * PROSE IS STORED, NOT TEMPLATED AT READ TIME
 *
 * Migration 012 decided that: a finding is a decision record, somebody approves
 * a price change because they read a sentence, and a template re-rendered after
 * a later deploy would make the audit trail claim something the approver never
 * saw. So both languages are produced here, at write time, from numbers this
 * function is holding — and the formatting is deliberately fixed rather than
 * locale-aware, because a stored sentence that renders differently next year is
 * exactly the drift migration 012 exists to prevent.
 */

export type Text = { en: string, id: string }

export const CHECK_KEY = 'occupancy_gap_30d'
export const CHECK_VERSION = 1

/** The window, in nights. Matches the metric this check reads. */
export const WINDOW = 30

/**
 * The floor below which the calendar is too thin to argue from.
 *
 * Fourteen of thirty, not one: a median recommended price over three archived
 * nights is a number, and using it to value twelve missing nights would be
 * arithmetic dressed as evidence. Measured reason to expect thin calendars —
 * five listings answered LISTING_TOGGLE_OFF on the first live pass.
 */
export const MIN_NIGHTS = 14

/** Percentage points below the market. Below the first, nothing is reported. */
export const GAP_LOW = 10
export const GAP_MEDIUM = 20
export const GAP_HIGH = 30

/**
 * Market pricing index thresholds.
 *
 * 1.15 rather than 1.0 because MPI is a ratio of our asking price to the
 * market's and the two are never identical; a listing 3% above the market is
 * not a price problem, it is a rounding difference. Measured on the live
 * account: MPI at 30 days ran from 0.9 to 2.08 across the portfolio, so 1.15 is
 * inside the real spread rather than a number that never fires.
 */
export const MPI_HIGH = 1.15
export const MPI_LOW = 0.9

/**
 * The blocked-calendar guard, and it exists because of a measurement that would
 * otherwise have produced this check's worst possible failure.
 *
 * On the live account one room reads `occupancy: 100` at seven days — and its
 * revenue over the same window is 0, its ADR is the sentinel -1, and PriceLabs'
 * own formatted view prints "Fully Blocked" in those cells. So those nights are
 * NOT booked. They are closed: an owner block, a renovation, a unit taken off
 * sale. `adjusted_occupancy` does not help — it was identical to `occupancy` at
 * every horizon on that room, so it is not excluding the blocks either.
 *
 * Read naively, such a room is far ABOVE the market and this check calls it
 * healthy and says nothing. A room earning nothing, reported as fine, is a worse
 * outcome than any false alarm this check could raise — it is the exact failure
 * the whole system exists to prevent, produced by the system itself.
 *
 * So: occupancy at or above this floor with zero revenue on the window is not a
 * performance reading at all, and the honest answer is that the room cannot be
 * assessed while its calendar is closed.
 */
export const BLOCKED_OCCUPANCY_FLOOR = 10

/**
 * How much the missing funnel costs us in confidence.
 *
 * Not a fudge factor: three of the four gates cannot be evaluated, so at most
 * one quarter of the causal chain is observed. 0.6 is more generous than 0.25
 * because the MEASUREMENT itself is direct and provider-computed — what is
 * missing is the cause, not the gap. Named so that restoring MDV changes the
 * number for a reason somebody can read.
 */
export const FUNNEL_UNKNOWN_FACTOR = 0.6
export const BASE_CONFIDENCE = 0.9

export interface CheckInput {
  entityId: string
  label: string
  band: string | null
  /** Percentages over the next 30 nights, from the provider. */
  occupancy: number | null
  marketOccupancy: number | null
  mpi: number | null
  /**
   * Revenue on the books for the same window. Not shown to anybody — it is here
   * to tell a booked calendar from a blocked one, which occupancy alone cannot.
   */
  revenue: number | null
  /** Medians over the archived calendar. */
  priceRecommended: number | null
  priceLive: number | null
  nights: number
  currency: string | null
  /** The day we observed it, which dates the window. */
  asOf: string
}

export type GateStage = 'impressions' | 'ctr' | 'conversion' | 'price'
export type GateVerdict = 'healthy' | 'failing' | 'unknown'
export type Severity = 'low' | 'medium' | 'high'

export interface Draft {
  entityId: string
  checkKey: string
  checkVersion: number
  severity: Severity
  headline: Text
  windowFrom: string
  windowTo: string
  amountRevenue: number | null
  /** Null until a confirmed cost basis exists. A margin without costs is a guess. */
  amountMargin: null
  bandLow: number | null
  bandHigh: number | null
  currency: string | null
  confidence: number
  firstFailing: 'price' | null
  gates: Array<{ stage: GateStage, verdict: GateVerdict, note: Text }>
  evidence: Array<{ side: 'supporting' | 'against' | 'unknown', family: string,
                    metric: string, claim: Text }>
  numbers: Array<{ token: string, value: number, unit: string | null,
                   sourceField: string }>
}

export type Verdict =
  | { kind: 'not_assessable', reason: Text }
  | { kind: 'healthy', note: Text }
  | { kind: 'finding', draft: Draft }

/* ------------------------------------------------------------------ numbers */

/**
 * Fixed formatting, on purpose. See the header: a stored sentence must read the
 * same in five years, and `Intl` output depends on the ICU version the runtime
 * happened to ship with.
 */
const pct = (v: number) => `${Math.round(v)}%`
const one = (v: number) => (Math.round(v * 10) / 10).toFixed(1)
const two = (v: number) => (Math.round(v * 100) / 100).toFixed(2)
const cash = (v: number, cur: string | null) =>
  `${cur ?? '?'} ${Math.round(v).toLocaleString('en-US').replace(/,/g, "'")}`

const dayPlus = (from: string, days: number): string => {
  const d = new Date(`${from}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/* ---------------------------------------------------------------- the check */

export function assess(input: CheckInput): Verdict {
  const { occupancy: ours, marketOccupancy: theirs, nights, currency } = input

  // Absence first, and each absence named separately. "Not assessable" is only
  // useful if it says which half was missing: a room with no market comparison
  // needs a different action from one with no calendar.
  if (ours === null && theirs === null && !nights) {
    return { kind: 'not_assessable', reason: {
      en: 'PriceLabs holds nothing for this room: no occupancy, no market and no calendar',
      id: 'PriceLabs tidak punya data untuk kamar ini: tanpa okupansi, tanpa pasar, tanpa kalender',
    } }
  }
  if (ours === null) {
    return { kind: 'not_assessable', reason: {
      en: 'no occupancy figure for the next 30 nights',
      id: 'tidak ada angka okupansi untuk 30 malam ke depan',
    } }
  }
  if (theirs === null) {
    return { kind: 'not_assessable', reason: {
      en: 'no market comparison for the next 30 nights, so there is nothing to compare against',
      id: 'tidak ada pembanding pasar untuk 30 malam ke depan, jadi tidak ada yang bisa dibandingkan',
    } }
  }
  if (nights < MIN_NIGHTS) {
    return { kind: 'not_assessable', reason: {
      en: `the archived calendar covers ${nights} of ${WINDOW} nights, below the floor of ${MIN_NIGHTS}`,
      id: `kalender terarsip mencakup ${nights} dari ${WINDOW} malam, di bawah batas ${MIN_NIGHTS}`,
    } }
  }

  // Before any comparison: is this occupancy even a reading about demand?
  if (ours >= BLOCKED_OCCUPANCY_FLOOR && input.revenue === 0) {
    return { kind: 'not_assessable', reason: {
      en: `the calendar reads ${pct(ours)} occupied with no revenue on it, so those nights are`
        + ` blocked rather than booked — occupancy cannot be compared to a market until the`
        + ` room is on sale`,
      id: `kalender menunjukkan ${pct(ours)} terisi tanpa pendapatan, jadi malam-malam itu`
        + ` diblokir bukan dipesan — okupansi tidak bisa dibandingkan dengan pasar sampai`
        + ` kamar dijual kembali`,
    } }
  }

  const gap = theirs - ours
  if (gap < GAP_LOW) {
    return { kind: 'healthy', note: {
      en: `occupancy ${pct(ours)} against a market at ${pct(theirs)}`,
      id: `okupansi ${pct(ours)} berbanding pasar ${pct(theirs)}`,
    } }
  }

  const severity: Severity =
    gap >= GAP_HIGH ? 'high' : gap >= GAP_MEDIUM ? 'medium' : 'low'

  // Nights we would expect to be sold if we ran at the market's pace. Kept to
  // one decimal because rounding 2.7 nights to 3 inflates every small gap in
  // the portfolio in the same direction.
  const nightsGap = Math.round((gap / 100) * WINDOW * 10) / 10

  // Valued at the RECOMMENDED price where there is one, because that is the
  // price at which the provider believes those nights would sell. Where there
  // is only a live price, that is used and the sentence says so. Where there is
  // neither, the finding still stands with no amount: a finding without a
  // number is honest, a number without a source is not.
  const priced = input.priceRecommended ?? input.priceLive
  const amountRevenue = priced === null ? null : Math.round(nightsGap * priced * 100) / 100
  const bothPrices = input.priceRecommended !== null && input.priceLive !== null
  const lowPrice = bothPrices
    ? Math.min(input.priceRecommended!, input.priceLive!) : null
  const highPrice = bothPrices
    ? Math.max(input.priceRecommended!, input.priceLive!) : null

  const priceFailing = input.mpi !== null && input.mpi > MPI_HIGH
  const priceHealthy = input.mpi !== null && input.mpi < MPI_LOW

  const gates: Draft['gates'] = [
    // All three funnel gates, written as unknown rather than omitted. An absent
    // row would read as "not applicable"; these are applicable and unseen.
    { stage: 'impressions', verdict: 'unknown', note: {
      en: 'no impression data: the MyDataValue grant is revoked',
      id: 'tidak ada data tayangan: izin MyDataValue dicabut' } },
    { stage: 'ctr', verdict: 'unknown', note: {
      en: 'no click-through data: the MyDataValue grant is revoked',
      id: 'tidak ada data klik: izin MyDataValue dicabut' } },
    { stage: 'conversion', verdict: 'unknown', note: {
      en: 'no conversion data: the MyDataValue grant is revoked',
      id: 'tidak ada data konversi: izin MyDataValue dicabut' } },
    { stage: 'price', verdict: priceFailing ? 'failing' : priceHealthy ? 'healthy' : 'unknown',
      note: input.mpi === null
        ? { en: 'no market pricing index for this room',
            id: 'tidak ada indeks harga pasar untuk kamar ini' }
        : priceFailing
        ? { en: `asking ${two(input.mpi)}× the market price`,
            id: `meminta ${two(input.mpi)}× harga pasar` }
        : priceHealthy
        ? { en: `asking ${two(input.mpi)}× the market price, so price is unlikely to be the cause`,
            id: `meminta ${two(input.mpi)}× harga pasar, jadi harga kemungkinan bukan penyebabnya` }
        : { en: `asking ${two(input.mpi)}× the market price, which is within the normal spread`,
            id: `meminta ${two(input.mpi)}× harga pasar, masih dalam rentang normal` } },
  ]

  // The rule from the design, applied rather than quoted: a lever may only be
  // named when we know the listing is reachable. Occupancy above zero is that
  // evidence and it is the only one we hold.
  const firstFailing: 'price' | null = priceFailing && ours > 0 ? 'price' : null

  const evidence: Draft['evidence'] = [
    { side: 'supporting', family: 'occupancy', metric: 'occupancy_next_30d', claim: {
      en: `occupancy ${pct(ours)} over the next ${WINDOW} nights against a market at ${pct(theirs)}`
        + ` — a gap of ${Math.round(gap)} points`,
      id: `okupansi ${pct(ours)} untuk ${WINDOW} malam ke depan berbanding pasar ${pct(theirs)}`
        + ` — selisih ${Math.round(gap)} poin` } },
    // REQUIRED, and the most important row here. Without it the screen implies
    // a price diagnosis that the evidence cannot carry.
    { side: 'against', family: 'funnel', metric: 'impressions', claim: {
      en: 'the funnel is unmeasured: impressions, click-through and conversion are all unknown'
        + ' while the MyDataValue grant is revoked, so a visibility problem would look'
        + ' identical to this one',
      id: 'funnel belum terukur: tayangan, klik dan konversi semuanya tidak diketahui'
        + ' selama izin MyDataValue dicabut, sehingga masalah visibilitas akan terlihat'
        + ' sama seperti ini' } },
    { side: 'unknown', family: 'cost', metric: 'amount_margin', claim: {
      en: 'margin is not computable: no confirmed cost basis for this room',
      id: 'marjin belum bisa dihitung: belum ada dasar biaya terkonfirmasi untuk kamar ini' } },
  ]

  if (input.mpi !== null) {
    evidence.push({
      side: priceFailing ? 'supporting' : 'against', family: 'price', metric: 'mpi_next_30d',
      claim: priceFailing
        ? { en: `priced at ${two(input.mpi)}× the market over the same window`,
            id: `harga ${two(input.mpi)}× pasar pada jendela yang sama` }
        : { en: `priced at ${two(input.mpi)}× the market, which does not explain the gap`,
            id: `harga ${two(input.mpi)}× pasar, yang tidak menjelaskan selisih ini` },
    })
  }
  if (bothPrices) {
    evidence.push({ side: 'supporting', family: 'price', metric: 'price_recommended', claim: {
      en: `PriceLabs recommends ${cash(input.priceRecommended!, currency)} where`
        + ` ${cash(input.priceLive!, currency)} is live (median over ${nights} archived nights)`,
      id: `PriceLabs menyarankan ${cash(input.priceRecommended!, currency)} sementara`
        + ` ${cash(input.priceLive!, currency)} yang aktif (median atas ${nights} malam terarsip)` } })
  } else if (input.priceRecommended !== null) {
    evidence.push({ side: 'unknown', family: 'price', metric: 'price_current', claim: {
      en: `no live price is set on this calendar, so the recommendation of`
        + ` ${cash(input.priceRecommended, currency)} cannot be compared to one`,
      id: `tidak ada harga aktif di kalender ini, jadi saran`
        + ` ${cash(input.priceRecommended, currency)} tidak bisa dibandingkan` } })
  }
  if (input.revenue === null) {
    // The guard above cannot run without this figure, so its absence is stated
    // rather than quietly assumed away.
    evidence.push({ side: 'unknown', family: 'coverage', metric: 'revenue_next_30d', claim: {
      en: 'no revenue figure for this window, so owner-blocked nights cannot be told apart'
        + ' from booked ones',
      id: 'tidak ada angka pendapatan untuk jendela ini, jadi malam yang diblokir pemilik'
        + ' tidak bisa dibedakan dari yang dipesan' } })
  }
  if (nights < WINDOW) {
    evidence.push({ side: 'against', family: 'coverage', metric: 'nights_archived', claim: {
      en: `the archived calendar covers ${nights} of ${WINDOW} nights, so the amount is`
        + ` extrapolated from a partial window`,
      id: `kalender terarsip mencakup ${nights} dari ${WINDOW} malam, jadi jumlahnya`
        + ` diekstrapolasi dari jendela sebagian` } })
  }

  const confidence = Math.round(
    BASE_CONFIDENCE * FUNNEL_UNKNOWN_FACTOR * Math.min(1, nights / WINDOW) * 1000) / 1000

  /**
   * Every number that appears in the prose, with where it came from.
   *
   * Derived values say so in `source_field` rather than borrowing the name of a
   * metric they are not. `gap_pp` is not a field PriceLabs returns, and
   * labelling it as one would make an audit of this row quietly wrong.
   */
  const numbers: Draft['numbers'] = [
    { token: 'occupancy', value: ours, unit: 'percent', sourceField: 'occupancy_next_30d' },
    { token: 'market_occupancy', value: theirs, unit: 'percent',
      sourceField: 'market_occupancy_next_30d' },
    { token: 'gap_pp', value: Math.round(gap * 10) / 10, unit: 'percentage_points',
      sourceField: 'derived: market_occupancy_next_30d - occupancy_next_30d' },
    { token: 'nights_gap', value: nightsGap, unit: 'nights',
      sourceField: `derived: gap_pp / 100 * ${WINDOW}` },
    { token: 'nights_archived', value: nights, unit: 'nights',
      sourceField: 'count of archived price_recommended rows' },
  ]
  if (input.mpi !== null) {
    numbers.push({ token: 'mpi', value: input.mpi, unit: 'ratio', sourceField: 'mpi_next_30d' })
  }
  if (input.priceRecommended !== null) {
    numbers.push({ token: 'price_recommended', value: input.priceRecommended,
                   unit: currency ?? 'currency',
                   sourceField: 'median of price_recommended over the window' })
  }
  if (input.priceLive !== null) {
    numbers.push({ token: 'price_live', value: input.priceLive, unit: currency ?? 'currency',
                   sourceField: 'median of price_current over the window' })
  }
  if (amountRevenue !== null) {
    numbers.push({ token: 'at_stake', value: amountRevenue, unit: currency ?? 'currency',
                   sourceField: `derived: nights_gap * `
                     + `${input.priceRecommended !== null ? 'price_recommended' : 'price_live'}` })
  }

  const money = amountRevenue === null ? null : cash(amountRevenue, currency)
  const headline: Text = {
    en: `${Math.round(gap)} points below the market over the next ${WINDOW} nights`
      + ` (${pct(ours)} against ${pct(theirs)}) — about ${one(nightsGap)} nights unsold`
      + (money ? `, worth around ${money}` : '')
      + (priceFailing ? `, at ${two(input.mpi!)}× the market price` : '')
      + '.',
    id: `${Math.round(gap)} poin di bawah pasar untuk ${WINDOW} malam ke depan`
      + ` (${pct(ours)} berbanding ${pct(theirs)}) — sekitar ${one(nightsGap)} malam tidak terjual`
      + (money ? `, bernilai sekitar ${money}` : '')
      + (priceFailing ? `, dengan harga ${two(input.mpi!)}× harga pasar` : '')
      + '.',
  }

  return { kind: 'finding', draft: {
    entityId: input.entityId,
    checkKey: CHECK_KEY, checkVersion: CHECK_VERSION,
    severity, headline,
    windowFrom: input.asOf, windowTo: dayPlus(input.asOf, WINDOW),
    amountRevenue, amountMargin: null,
    bandLow: lowPrice === null ? null : Math.round(nightsGap * lowPrice * 100) / 100,
    bandHigh: highPrice === null ? null : Math.round(nightsGap * highPrice * 100) / 100,
    currency, confidence, firstFailing, gates, evidence, numbers,
  } }
}
