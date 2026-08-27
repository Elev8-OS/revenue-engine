/**
 * From measurements to a named action.
 *
 * This is the layer the whole thing exists for, and it has been missing. The page
 * could say a room is 22 points behind the market and 31% above the recommended
 * price, and then stop — leaving the reader to work out what to actually change.
 * A dashboard that reports without proposing is a report, not an engine.
 *
 * FOUR RULES, all of which cost something to keep.
 *
 *   1. AN ACTION NAMES A LEVER, A FROM AND A TO. "Consider adjusting pricing" is
 *      not an action; "lower the rate on 22 nights from CHF 180 to CHF 165" is.
 *      Anything that cannot be stated in that form does not belong here — it
 *      belongs in the findings, as an observation.
 *
 *   2. A PRICE ACTION IS GATED ON VISIBILITY. If a room is barely seen, or seen
 *      and not opened, the price is not what is wrong with it, and proposing a
 *      cut would spend margin on a problem it cannot fix. So the gate is checked
 *      first and the action is HELD, with the gate named — not hidden, because a
 *      held action is information.
 *
 *   3. NOTHING IS DERIVED FROM A NUMBER WE DO NOT HAVE. Text and image quality
 *      have no source on this account: MyDataValue carries neither, and the
 *      channel manager's content surface is not connected. So they appear as a
 *      named absence rather than as generic advice, which is the one thing a tool
 *      like this must never manufacture.
 *
 *   4. DERIVED AT READ TIME, NEVER STORED. The stored gate prose taught this
 *      project the hard way: a sentence written into a row keeps being displayed
 *      long after it stopped being true. These actions recompute from the archive
 *      on every render, so a deploy cannot leave a stale proposal on the screen.
 */
import type * as q from './query.js'
import type { Row } from './query.js'

export type Lever = 'price' | 'min_stay' | 'discount' | 'content'

export interface Action {
  lever: Lever
  /** Ranked by what it is worth, then by how certain the evidence is. */
  rank: number
  /** The current value, in the reader's terms. Null where there is nothing set. */
  from: string | null
  /** What it would become. Null for an action that has no single target. */
  to: string | null
  /** How much it touches: nights, channels, listings. */
  scope: string
  /** The measurement behind it. Never an opinion. */
  because: string
  /**
   * The gate that holds this action back, named. Null when nothing blocks it.
   *
   * A blocked action is still shown. Hiding it would leave the reader thinking
   * the room has no price case at all, when what it has is a price case waiting
   * on a visibility problem.
   */
  blockedBy: string | null
  /** Money, only where a finding established it. Never estimated here. */
  worth: number | null
}

export interface ActionInput {
  row: Row
  sig: q.Signals | undefined
  gap: q.PriceGap | undefined
  demand: q.DemandShape | undefined
  promos: q.Promotion[] | undefined
  coverage: Array<{ kind: string, on: number, of: number }>
  cohort: { booking: q.CohortStanding | null, airbnb: q.CohortStanding | null } | undefined
}

/** Below this share of the cohort's own median, visibility is the problem. */
const VISIBILITY_FLOOR = 0.6
/** A lever most of the cohort runs and this room does not. */
const CROWD = 0.5
/** Fewer than this many realised bookings and stay length is not a distribution. */
const MIN_BOOKINGS = 5

/**
 * Which gate, if any, holds a price action back.
 *
 * Measured against our own cohort and nothing else, because no provider sells
 * competitor funnel data. Two stages, in order: were we seen at all, and did
 * anyone open it. A room failing the first has no click problem to fix — it has
 * nothing to click on.
 */
function priceGate(i: ActionInput): string | null {
  const sides = [i.cohort?.booking, i.cohort?.airbnb].filter(Boolean) as q.CohortStanding[]
  if (!sides.length) return null
  const funnels = [i.sig?.funnelBooking, i.sig?.funnelAirbnb]
  for (const [n, side] of sides.entries()) {
    const f = funnels[n]
    if (!f || f.impressions === null || f.views === null || f.impressions <= 0) continue
    const rate = f.views / f.impressions
    if (side.viewRateMedian !== null && side.viewRateMedian > 0
        && rate < side.viewRateMedian * VISIBILITY_FLOOR) {
      return 'ctr'
    }
  }
  return null
}

export function actionsFor(i: ActionInput, t: ActionStrings): Action[] {
  const out: Action[] = []
  const money = (v: number | null, cur: string | null) =>
    v === null ? null : t.money(v, cur ?? i.row.currency)

  /* ------------------------------------------------------------------ price */
  if (i.gap && i.gap.nights > 0 && i.gap.ours !== null && i.gap.recommended !== null) {
    const blocked = priceGate(i)
    const dir = i.gap.above >= i.gap.below ? 'above' : 'below'
    out.push({
      lever: 'price',
      rank: 0,
      from: money(i.gap.ours, i.gap.currency),
      to: money(i.gap.recommended, i.gap.currency),
      scope: t.nights(i.gap.nights),
      because: dir === 'above'
        ? t.priceAbove(i.gap.above, i.gap.nights)
        : t.priceBelow(i.gap.below, i.gap.nights),
      blockedBy: blocked,
      // The finding's own figure or nothing. Estimating a price move's value from
      // a calendar would be arithmetic dressed as a forecast.
      worth: i.row.atStake,
    })
  }

  /* --------------------------------------------------------------- min stay */
  //
  // A minimum stay is only assessable against what guests actually book. The
  // realised distribution is ours, from our own reservations, so this needs no
  // provider and no assumption — but it does need enough bookings to be a
  // distribution at all, which is why a thin history produces no action.
  if (i.gap?.minStayMax !== null && i.gap?.minStayMax !== undefined
      && i.demand && i.demand.bookings >= MIN_BOOKINGS
      && i.demand.nightsP75 !== null && i.gap.minStayMax > i.demand.nightsP75) {
    out.push({
      lever: 'min_stay',
      rank: 1,
      from: t.nightsPlain(i.gap.minStayMax),
      to: t.nightsPlain(Math.max(1, Math.round(i.demand.nightsMedian ?? 1))),
      scope: t.minStayScope,
      because: t.minStayBecause(i.demand.bookings, i.demand.nightsMedian ?? 0,
                                i.demand.nightsP75),
      blockedBy: null,
      worth: null,
    })
  }

  /* --------------------------------------------------------------- discount */
  //
  // A lever most of the cohort runs and this room does not. Not "discount more" —
  // a specific programme, with the count that makes it a case rather than a hunch.
  const mine = new Map((i.promos ?? []).map(p => [p.kind, p]))
  for (const lever of i.coverage) {
    if (lever.of <= 0) continue
    const share = lever.on / lever.of
    if (share < CROWD) continue
    const held = mine.get(lever.kind)
    if (held?.active === true) continue
    out.push({
      lever: 'discount',
      rank: 2,
      from: held?.active === false ? t.leverOff : t.leverAbsent,
      to: t.leverOn,
      scope: t.leverName(lever.kind),
      because: t.leverBecause(lever.on, lever.of),
      blockedBy: null,
      worth: null,
    })
  }

  /* ---------------------------------------------------------------- content */
  //
  // The named absence. Text and photo quality are levers this tool cannot assess
  // on this account — MyDataValue carries neither, and the channel manager's
  // content surface is not connected. Generic copywriting advice would be the one
  // thing worse than saying nothing: it would look like a finding.
  out.push({
    lever: 'content',
    rank: 9,
    from: null, to: null,
    scope: t.contentScope,
    because: t.contentBecause,
    blockedBy: null,
    worth: null,
  })

  return out.sort((a, b) =>
    a.rank - b.rank || (b.worth ?? 0) - (a.worth ?? 0))
}

/** The strings an action needs, injected so this file holds no prose of its own. */
export interface ActionStrings {
  money: (v: number, cur: string | null) => string
  nights: (n: number) => string
  nightsPlain: (n: number) => string
  priceAbove: (above: number, of: number) => string
  priceBelow: (below: number, of: number) => string
  minStayScope: string
  minStayBecause: (bookings: number, median: number, p75: number) => string
  leverOn: string
  leverOff: string
  leverAbsent: string
  leverName: (kind: string) => string
  leverBecause: (on: number, of: number) => string
  contentScope: string
  contentBecause: string
}
