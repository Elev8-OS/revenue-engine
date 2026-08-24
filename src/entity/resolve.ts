/**
 * Alias resolution across the six systems.
 *
 * The problem this exists for, from the live accounts:
 *   Elev8      listing_id in three formats (32-hex, UUID, empty); reservations
 *              carry only listing_name, and names are reused up to three times
 *              (one villa name covers five separately-cleaned unit rows);
 *              cleanings carry no reservation_id at all.
 *   PriceLabs  a composite of two UUIDs joined by '___', pms_name 'channex'.
 *   MDV        Booking property_id and Airbnb listing_id are separate
 *              namespaces and are NOT joinable to each other.
 *   Channex    three levels: property, room, rate plan.
 *
 * Consequence for the design: name matching is allowed, but never silent. Every
 * resolution records how it was made, and anything unresolved lands in
 * unresolved_alias so it can surface as "not assessable" instead of vanishing.
 */
import type { PoolClient } from 'pg'

export type SourceSystem =
  | 'elev8' | 'pricelabs' | 'mdv_booking' | 'mdv_airbnb' | 'channex' | 'nextpax'

export type AliasKind =
  | 'property' | 'room' | 'listing' | 'rate_plan' | 'reservation' | 'group'

export interface ResolveInput {
  source: SourceSystem
  kind: AliasKind
  externalId: string
  /** Only used as a last resort, and then recorded as such. */
  label?: string
}

export type Resolution =
  | { ok: true, entityId: string, matchedBy: string }
  | { ok: false, reason: string }

/** PriceLabs composite ids look like `<uuid>___<uuid>`. Both halves are useful. */
export function splitPriceLabsId(id: string): { left: string, right: string } | null {
  const parts = id.split('___')
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null
  return { left: parts[0], right: parts[1] }
}

/**
 * Elev8 hands out the same id in three shapes. Normalising to lowercase hex
 * without dashes makes the three comparable; an empty id is not a key and is
 * rejected rather than normalised to something that looks like one.
 */
export function normaliseElev8Id(raw: string | null | undefined): string | null {
  if (!raw) return null
  const hex = raw.trim().toLowerCase().replace(/-/g, '')
  return /^[0-9a-f]{32}$/.test(hex) ? hex : null
}

/**
 * A pure lookup: has this external id been seen before, and if so, as what.
 *
 * Separate from `resolve` because the two callers want opposite things from a
 * miss. Code CONSUMING data must attach to an existing entity, so a miss is a
 * failure worth recording. An IMPORTER creates entities, so a miss is the normal
 * case for every new object — and recording it there would fill
 * unresolved_alias with rows that were imported successfully a moment later,
 * which then surface on the dashboard as "not assessable".
 */
export async function lookupAlias(
  client: PoolClient, input: Pick<ResolveInput, 'source' | 'kind' | 'externalId'>,
): Promise<{ entityId: string, matchedBy: string } | null> {
  const { rows } = await client.query<{ entity_id: string, matched_by: string }>(
    `select entity_id, matched_by from entity_alias
      where source = $1 and kind = $2 and external_id = $3`,
    [input.source, input.kind, input.externalId],
  )
  const hit = rows[0]
  return hit ? { entityId: hit.entity_id, matchedBy: hit.matched_by } : null
}

/**
 * Drops a previously recorded failure once the row has been placed. Without
 * this, an object that could not be resolved last week stays on the
 * "not assessable" list forever, even after it was imported.
 */
export async function clearUnresolved(
  client: PoolClient, input: Pick<ResolveInput, 'source' | 'kind' | 'externalId'>,
): Promise<void> {
  await client.query(
    `delete from unresolved_alias
      where source = $1 and kind = $2 and external_id = $3`,
    [input.source, input.kind, input.externalId],
  )
}

export async function resolve(
  client: PoolClient, input: ResolveInput,
): Promise<Resolution> {
  const direct = await client.query<{ entity_id: string, matched_by: string }>(
    `select entity_id, matched_by from entity_alias
      where source = $1 and kind = $2 and external_id = $3`,
    [input.source, input.kind, input.externalId],
  )
  const hit = direct.rows[0]
  if (hit) return { ok: true, entityId: hit.entity_id, matchedBy: hit.matched_by }

  /**
   * PriceLabs composite ids, and the order is load-bearing.
   *
   * MEASURED against the live account: all 62 PriceLabs listings are
   * `<channex_property_id>___<channex_room_id>` with `pms_name: 'channex'`. So
   * the RIGHT half identifies the unit and the LEFT half identifies the building
   * it sits in.
   *
   * The first version tried [left, right] in that order, which is the wrong way
   * round and would have been invisible. "The R Villa Merapi" is ONE Channex
   * property with TWO rooms:
   *
   *   afa397b2-…___05e77a25-…    ROOM 1-4  (4 units)
   *   afa397b2-…___d92c422a-…    Room 5
   *
   * Matching on the left half maps both PriceLabs listings onto whichever entity
   * holds property `afa397b2` — two different units silently collapsed into one,
   * and then priced as one. The room half distinguishes them.
   */
  if (input.source === 'pricelabs') {
    const split = splitPriceLabsId(input.externalId)
    if (split) {
      const room = await client.query<{ entity_id: string }>(
        `select entity_id from entity_alias where kind = 'room' and external_id = $1`,
        [split.right],
      )
      if (room.rows[0]) {
        await link(client, input, room.rows[0].entity_id, 'pricelabs_room_half')
        return { ok: true, entityId: room.rows[0].entity_id, matchedBy: 'pricelabs_room_half' }
      }
      // The property half is deliberately NOT a fallback. It names the building,
      // and a building can hold several units — "The R Villa Merapi" is one
      // Channex property with two rooms. Resolving on it would map every unit in
      // a building onto one entity and then price them as one, which is a
      // mistake that looks like a match. Where the room half is unknown the
      // honest answer is that we do not know which unit this is.
      const shared = await client.query<{ n: number }>(
        `select count(*)::int n from entity where pms_property_id = $1`, [split.left])
      const units = shared.rows[0]?.n ?? 0
      await recordUnresolved(client, input,
        units > 0
          ? `the room half is unknown; the property half names a building with `
            + `${units} unit(s), and matching the building would price them as one`
          : 'neither half is a known room or building')
      return { ok: false, reason: 'the room half is unknown' }
    }
  }

  await recordUnresolved(client, input, 'no alias and no unambiguous name match')
  return { ok: false, reason: 'unresolved' }
}

/**
 * Name matching, deliberately separate and deliberately strict: it only accepts
 * a match when EXACTLY ONE entity has that label. With names reused three times
 * in Elev8, an ambiguous name must stay unresolved rather than pick a winner.
 */
export async function resolveByLabel(
  client: PoolClient, input: ResolveInput & { label: string },
): Promise<Resolution> {
  const { rows } = await client.query<{ id: string }>(
    `select id from entity where lower(label) = lower($1) and active`,
    [input.label],
  )
  if (rows.length === 1 && rows[0]) {
    await link(client, input, rows[0].id, 'unique_label')
    return { ok: true, entityId: rows[0].id, matchedBy: 'unique_label' }
  }
  const reason = rows.length === 0
    ? `no entity labelled "${input.label}"`
    : `label "${input.label}" is ambiguous across ${rows.length} entities`
  await recordUnresolved(client, input, reason)
  return { ok: false, reason }
}

export type LinkOutcome = 'linked' | 'already_ours' | 'conflict'

/**
 * Records an alias, and REPORTS a conflicting claim instead of swallowing it.
 *
 * Migration 002 says the unique constraint exists so that "a second claim on it
 * is an error we want loudly at write time rather than quietly at report time".
 * The code did not honour that: `on conflict do nothing` made a second claim
 * silent, so an id already pointing at another entity looked like a successful
 * write. That is how the Channex property id ended up recording whichever unit
 * was imported first while the others vanished without a trace.
 *
 * A conflict is not always a bug — it can mean the source reuses an id across
 * things we treat as separate — but it is never nothing, so it lands in
 * unresolved_alias where it surfaces as "not assessable" rather than nowhere.
 */
export async function link(
  client: PoolClient, input: ResolveInput, entityId: string, matchedBy: string,
): Promise<LinkOutcome> {
  const { rowCount } = await client.query(
    `insert into entity_alias (entity_id, source, kind, external_id, matched_by)
     values ($1, $2, $3, $4, $5)
     on conflict (source, kind, external_id) do nothing`,
    [entityId, input.source, input.kind, input.externalId, matchedBy],
  )
  if (rowCount) return 'linked'

  const { rows } = await client.query<{ entity_id: string }>(
    `select entity_id from entity_alias
      where source = $1 and kind = $2 and external_id = $3`,
    [input.source, input.kind, input.externalId],
  )
  if (rows[0]?.entity_id === entityId) return 'already_ours'

  await recordUnresolved(client, input,
    `already claimed by another object — one external id cannot mean two things, `
    + `so this claim was not recorded`)
  return 'conflict'
}

/**
 * Exported because importers need it too: a row we cannot place must be recorded
 * rather than skipped, or it disappears silently instead of surfacing as
 * "not assessable".
 */
export async function recordUnresolved(
  client: PoolClient, input: ResolveInput, reason: string,
): Promise<void> {
  await client.query(
    `insert into unresolved_alias (source, kind, external_id, label, reason)
     values ($1, $2, $3, $4, $5)
     on conflict (source, kind, external_id)
       do update set last_seen = now(), reason = excluded.reason`,
    [input.source, input.kind, input.externalId, input.label ?? null, reason],
  )
}
