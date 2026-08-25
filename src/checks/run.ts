/**
 * Running the checks, and superseding what they replace.
 *
 * Two decisions here are worth more than the loop:
 *
 *   1. A RE-RUN REPLACES, IT DOES NOT ACCUMULATE. An open finding from this
 *      morning and one from this afternoon about the same room and the same
 *      check are not two problems; they are one problem observed twice. Without
 *      superseding, the dashboard's count grows every time somebody presses the
 *      button, which turns the one number whose job is to be trusted into a
 *      measure of how often the button was pressed. The old row is not deleted:
 *      it becomes `superseded`, because a decision record that vanishes cannot
 *      be audited.
 *
 *   2. IT SHARES THE IMPORT'S LOCK, deliberately. A check run against a database
 *      that an import is halfway through writing would read a portfolio in two
 *      states and produce findings from the seam. `import_run` already enforces
 *      one-at-a-time in the database rather than in a handler, so a check run is
 *      a run of that kind — which also means the page that reports imports
 *      reports these, with no second mechanism to keep in step.
 *
 * `not_assessable` is written for every room the check could not reach, with the
 * missing signal named. That table feeds the "N rooms not assessable" line,
 * which is what stops a portfolio with three findings reading as healthy while
 * forty rooms were never looked at.
 */
import type { PoolClient } from 'pg'
import { signals } from '../dashboard/query.js'
import { assess, CHECK_KEY, CHECK_VERSION, type CheckInput, type Draft } from './occupancy-gap.js'

export interface CheckReport {
  kind: 'checks'
  asOf: string
  /** Rooms considered: every active entity. */
  considered: number
  assessed: number
  findings: number
  healthy: number
  notAssessable: number
  /** Findings by severity, so a run's shape is legible without opening the page. */
  bySeverity: Record<string, number>
  /** Previous open findings retired by this run. */
  superseded: number
  /**
   * Findings where a lever could be named. The rest deliberately name none:
   * without the funnel, "invisible" and "overpriced" measure the same.
   */
  leverNamed: number
  /** Rooms with no band: structural, and not this check's business to fix. */
  unbanded: number
  stageErrors: string[]
}

/** Writes one finding and everything that argues for and against it. */
async function writeFinding(db: PoolClient, d: Draft): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into finding (entity_id, check_key, check_version, severity, headline,
                          window_from, window_to, amount_revenue, amount_margin,
                          band_low, band_high, currency, confidence, first_failing,
                          text_i18n)
     values ($1, $2, $3, $4, $5, $6::date, $7::date, $8, $9, $10, $11, $12, $13,
             $14::gate_stage, $15::jsonb)
     returning id::text`,
    [d.entityId, d.checkKey, d.checkVersion, d.severity, d.headline.en,
     d.windowFrom, d.windowTo, d.amountRevenue, d.amountMargin,
     d.bandLow, d.bandHigh, d.currency, d.confidence, d.firstFailing,
     JSON.stringify(d.headline)])
  const id = rows[0]!.id

  for (const g of d.gates) {
    await db.query(
      `insert into finding_gate (finding_id, stage, verdict, note, text_i18n)
       values ($1, $2::gate_stage, $3::gate_verdict, $4, $5::jsonb)`,
      [id, g.stage, g.verdict, g.note.en, JSON.stringify(g.note)])
  }
  for (const e of d.evidence) {
    await db.query(
      `insert into finding_evidence (finding_id, side, family, metric, claim, text_i18n)
       values ($1, $2, $3, $4, $5, $6::jsonb)`,
      [id, e.side, e.family, e.metric, e.claim.en, JSON.stringify(e.claim)])
  }
  for (const n of d.numbers) {
    // Every figure in the prose, with its origin. The persona that will later
    // write these sentences may use no number that is not here, and each one is
    // checked against its source before the text is shown.
    await db.query(
      `insert into finding_number (finding_id, token, value, unit, source, source_field)
       values ($1, $2, $3, $4, 'pricelabs'::source_system, $5)
       on conflict (finding_id, token) do nothing`,
      [id, n.token, n.value, n.unit, n.sourceField])
  }
  return id
}

export async function runChecks(
  db: PoolClient, opts: { today?: string } = {},
): Promise<CheckReport> {
  const asOf = opts.today ?? new Date().toISOString().slice(0, 10)
  const report: CheckReport = {
    kind: 'checks', asOf, considered: 0, assessed: 0, findings: 0, healthy: 0,
    notAssessable: 0, bySeverity: {}, superseded: 0, leverNamed: 0, unbanded: 0,
    stageErrors: [],
  }

  const { rows: entities } = await db.query<{
    id: string, label: string, band: string | null
  }>(`select id::text, label, band from entity where active order by label`)
  const measured = await signals(db)

  // Retire the previous generation first, in one statement. Doing it per room
  // inside the loop would leave a half-superseded portfolio if the run failed
  // midway — some rooms showing this morning's finding, others this afternoon's,
  // with nothing to say which was which.
  const { rowCount } = await db.query(
    `update finding set state = 'superseded'
      where check_key = $1 and state = 'open'`, [CHECK_KEY])
  report.superseded = rowCount ?? 0

  // One day's verdicts replace the same day's, so pressing the button twice does
  // not leave a stale reason behind.
  await db.query(`delete from not_assessable where as_of = $1::date`, [asOf])

  for (const e of entities) {
    report.considered++
    if (!e.band) report.unbanded++

    const sig = measured.get(e.id)
    const input: CheckInput = {
      entityId: e.id, label: e.label, band: e.band,
      occupancy: sig?.occupancy ?? null,
      marketOccupancy: sig?.marketOccupancy ?? null,
      mpi: sig?.mpi ?? null,
      revenue: sig?.revenue ?? null,
      priceRecommended: sig?.priceRecommended ?? null,
      priceLive: sig?.priceLive ?? null,
      nights: sig?.nights ?? 0,
      currency: sig?.currency ?? null,
      // The observation date the measurement carries, falling back to the run's
      // own date. Using the run date for a row measured last week would date the
      // window wrongly and make the amount look fresher than it is.
      asOf: sig?.asOf ?? asOf,
    }

    try {
      const verdict = assess(input)
      if (verdict.kind === 'not_assessable') {
        report.notAssessable++
        await db.query(
          `insert into not_assessable (entity_id, as_of, reason, text_i18n)
           values ($1, $2::date, $3, $4::jsonb)
           on conflict (entity_id, as_of)
             do update set reason = excluded.reason, text_i18n = excluded.text_i18n`,
          [e.id, asOf, verdict.reason.en, JSON.stringify(verdict.reason)])
        continue
      }
      report.assessed++
      if (verdict.kind === 'healthy') { report.healthy++; continue }

      await writeFinding(db, verdict.draft)
      report.findings++
      report.bySeverity[verdict.draft.severity] =
        (report.bySeverity[verdict.draft.severity] ?? 0) + 1
      if (verdict.draft.firstFailing) report.leverNamed++
    } catch (err) {
      // One room's failure is not the run's. Named once so a systematic problem
      // is visible without repeating the same message sixty times.
      if (!report.stageErrors.length) {
        report.stageErrors.push(`${e.label}: ${(err as Error).message}`)
      }
    }
  }

  return report
}
