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

  // PriceLabs composite: try each half before giving up.
  if (input.source === 'pricelabs') {
    const split = splitPriceLabsId(input.externalId)
    if (split) {
      for (const half of [split.left, split.right]) {
        const { rows } = await client.query<{ entity_id: string }>(
          `select entity_id from entity_alias
            where kind = $1 and external_id = $2 limit 1`,
          [input.kind, half],
        )
        const row = rows[0]
        if (row) {
          await link(client, input, row.entity_id, 'pricelabs_composite_half')
          return { ok: true, entityId: row.entity_id, matchedBy: 'pricelabs_composite_half' }
        }
      }
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

export async function link(
  client: PoolClient, input: ResolveInput, entityId: string, matchedBy: string,
): Promise<void> {
  await client.query(
    `insert into entity_alias (entity_id, source, kind, external_id, matched_by)
     values ($1, $2, $3, $4, $5)
     on conflict (source, kind, external_id) do nothing`,
    [entityId, input.source, input.kind, input.externalId, matchedBy],
  )
}

async function recordUnresolved(
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
