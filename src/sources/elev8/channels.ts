/**
 * The OTA link — the join this project has been missing since day one.
 *
 * Six systems name the same apartment differently, and the pair that mattered
 * most had no bridge at all: MDV knows an Airbnb listing by Airbnb's id and a
 * Booking property by Booking's id, and those two namespaces are not joinable to
 * each other or to anything of ours. Name matching reached 14/58 and 24/50.
 * Coordinates were worse than useless — 71 listings share 36 coordinate pairs,
 * so coordinates identify the BUILDING and would have linked units to their
 * neighbours while looking entirely plausible.
 *
 * Elev8 has the bridge, because Elev8 drives the channel manager:
 * `POST /api/v1/channex/channel/import-listing` takes `channel_listing_ids`,
 * which is the OTA's own id space — the same space MDV reads from.
 *
 * WHAT THIS FILE WILL NOT DO: guess which response field is which. The response
 * shapes are undocumented, and there is one specific way to get this wrong that
 * would be invisible — a payload plausibly carries BOTH an Elev8 `listing_id`
 * and an OTA listing id, and picking the wrong one produces a complete, tidy,
 * entirely false mapping. So the discriminator is the id's FORM, measured from
 * the data: Elev8 ids are 32-hex or dashed UUIDs, OTA ids are numeric. Form is a
 * property of the shape, not a value, so measuring it stores nothing sensitive.
 * When the forms do not separate cleanly, this refuses to link and says why.
 */
import type { PoolClient } from 'pg'
import type { SourceSystem } from '../../entity/resolve.js'
import { link, lookupAlias, recordUnresolved } from '../../entity/resolve.js'
import type { Elev8Client } from './client.js'
import { describe, recordShape, type ShapeEntry } from './shape.js'

/**
 * Channel name to MDV source. Substrings rather than exact titles because
 * Channex channel titles carry suffixes ("Airbnb (Official)"), but deliberately
 * NOT fuzzy: an unrecognised channel is reported, never assigned to the nearest
 * match. Assigning Vrbo's listings to Airbnb would be worse than ignoring them.
 */
const CHANNEL_TO_SOURCE: { match: RegExp, source: SourceSystem }[] = [
  { match: /air\s*bnb|airbnb/i, source: 'mdv_airbnb' },
  { match: /booking\.?com|booking/i, source: 'mdv_booking' },
]

export type IdForm = 'uuid' | 'numeric' | 'other'

export function idForm(v: unknown): IdForm | null {
  if (typeof v === 'number') return Number.isInteger(v) ? 'numeric' : 'other'
  if (typeof v !== 'string' || !v.trim()) return null
  const s = v.trim()
  if (/^[0-9a-f]{32}$/i.test(s.replace(/-/g, ''))) return 'uuid'
  if (/^\d+$/.test(s)) return 'numeric'
  return 'other'
}

/** Every string-ish path, with the distribution of id forms found at it. */
export function formProfile(rows: unknown[]): Map<string, Record<IdForm, number>> {
  const out = new Map<string, Record<IdForm, number>>()
  const bump = (path: string, f: IdForm) => {
    const e = out.get(path) ?? { uuid: 0, numeric: 0, other: 0 }
    e[f]++
    out.set(path, e)
  }
  const walk = (node: unknown, prefix: string, depth: number): void => {
    if (depth > 3) return
    if (Array.isArray(node)) { for (const el of node) walk(el, `${prefix}[]`, depth); return }
    if (node === null || typeof node !== 'object') return
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      const path = prefix ? `${prefix}.${k}` : k
      const f = idForm(v)
      if (f) bump(path, f)
      else if (v && typeof v === 'object') walk(v, path, depth + 1)
    }
  }
  for (const r of rows) walk(r, '', 0)
  return out
}

export interface ChannelSummary {
  channelId: string
  title: string
  source: SourceSystem | null
  /** Why no source: unrecognised, or recognised but ambiguous. */
  note?: string
}

/**
 * Picks the two id paths by form, or refuses.
 *
 * The rule: among paths whose name plausibly names a listing, the one that is
 * overwhelmingly UUID-shaped is ours and the one that is overwhelmingly
 * numeric-shaped is the OTA's. "Overwhelmingly" is 90%, not a majority —
 * a field that is 60% numeric is a field we do not understand yet.
 */
export function pickIdPaths(rows: unknown[]): {
  ok: true, elev8Path: string, otaPath: string, evidence: string
} | { ok: false, reason: string } {
  if (!rows.length) return { ok: false, reason: 'no listings returned for this channel' }
  const profile = formProfile(rows)
  const named = [...profile.entries()].filter(([p]) => /listing|room|unit|property|id$/i.test(p))
  const share = (c: Record<IdForm, number>, f: IdForm) => {
    const total = c.uuid + c.numeric + c.other
    return total ? c[f] / total : 0
  }
  const uuidish = named.filter(([, c]) => share(c, 'uuid') >= 0.9)
  const numish = named.filter(([, c]) => share(c, 'numeric') >= 0.9)

  // Naming the forms actually seen is the difference between a refusal somebody
  // can act on and one they have to reproduce by hand. Counts of forms are not
  // values, so this stays safe to log and safe to show.
  const seen = () => named
    .map(([p, c]) => `${p}(u${c.uuid}/n${c.numeric}/o${c.other})`)
    .join(' ') || 'no id-like paths at all'

  if (!uuidish.length) {
    return {
      ok: false,
      reason: `no id path is ≥90% UUID-shaped, so the Elev8 listing cannot be told `
        + `from the OTA listing — saw ${seen()}`,
    }
  }
  if (!numish.length) {
    return {
      ok: false,
      reason: `no id path is ≥90% numeric, so the OTA listing cannot be identified `
        + `— saw ${seen()}`,
    }
  }
  // More than one candidate on either side is not a tie to break, it is a
  // question to answer. Naming the candidates makes the next step a look rather
  // than an experiment.
  if (uuidish.length > 1 || numish.length > 1) {
    return {
      ok: false,
      reason: `ambiguous: UUID-shaped [${uuidish.map(([p]) => p).join(', ')}], `
        + `numeric [${numish.map(([p]) => p).join(', ')}]`,
    }
  }
  const [elev8Path, ec] = uuidish[0]!
  const [otaPath, oc] = numish[0]!
  return {
    ok: true, elev8Path, otaPath,
    evidence: `${elev8Path} uuid ${ec.uuid}/${ec.uuid + ec.numeric + ec.other}, `
      + `${otaPath} numeric ${oc.numeric}/${oc.uuid + oc.numeric + oc.other}`,
  }
}

export function classify(title: string): SourceSystem | null {
  for (const { match, source } of CHANNEL_TO_SOURCE) if (match.test(title)) return source
  return null
}

/** Reads the channel list and says which channels we can even use. */
export async function readChannels(
  db: PoolClient, api: Elev8Client,
): Promise<ChannelSummary[]> {
  const res = await api.get<Record<string, unknown>[]>(db, '/api/v1/channex/channel')
  const rows = Array.isArray(res.data) ? res.data : []
  await recordShape(db, 'elev8', 'GET /api/v1/channex/channel', rows,
                    `envelope: ${res.envelope}`)
  return rows.map(r => {
    const id = String(r.id ?? r.channel_id ?? '')
    const title = String(r.title ?? r.name ?? r.channel ?? r.provider ?? '')
    const source = classify(title)
    return {
      channelId: id, title,
      source,
      note: source ? undefined
        : title ? 'channel is not Airbnb or Booking — ignored, not guessed'
        : 'channel has no recognisable title field',
    }
  }).filter(c => c.channelId)
}

export interface LinkReport {
  channel: string
  source: SourceSystem
  listings: number
  linked: number
  alreadyLinked: number
  /** OTA ids with no Elev8 entity behind them, recorded not dropped. */
  noEntity: number
  refused?: string
  evidence?: string
}

/**
 * Links one channel's listings: OTA id → the entity that owns the Elev8 listing.
 *
 * The alias is written with `matched_by = 'elev8_channel_map'`, which is the
 * whole improvement over what came before. Every earlier attempt at this join
 * would have been recorded as `unique_label` or worse — a match that is probably
 * right. This one is a key the channel manager itself maintains.
 */
export async function linkChannel(
  db: PoolClient, api: Elev8Client, channel: ChannelSummary & { source: SourceSystem },
): Promise<LinkReport> {
  const res = await api.get<Record<string, unknown>[]>(
    db, `/api/v1/channex/channel/${encodeURIComponent(channel.channelId)}/listings`)
  const rows = Array.isArray(res.data) ? res.data : []
  await recordShape(db, 'elev8', 'GET /api/v1/channex/channel/:id/listings', rows,
                    `channel ${channel.title}, envelope: ${res.envelope}`)

  const base: LinkReport = {
    channel: channel.title, source: channel.source,
    listings: rows.length, linked: 0, alreadyLinked: 0, noEntity: 0,
  }

  const paths = pickIdPaths(rows)
  if (!paths.ok) return { ...base, refused: paths.reason }

  const read = (row: Record<string, unknown>, path: string): string | null => {
    const v = row[path]
    return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : null
  }

  for (const row of rows) {
    const elev8Id = read(row, paths.elev8Path)
    const otaId = read(row, paths.otaPath)
    if (!elev8Id || !otaId) continue

    // The Elev8 listing must already be an entity. Creating one here would mean
    // the channel list, not the listing list, decided what exists.
    const owner = await lookupAlias(db, { source: 'elev8', kind: 'listing', externalId: elev8Id })
    if (!owner) {
      base.noEntity++
      await recordUnresolved(db,
        { source: channel.source, kind: 'listing', externalId: otaId },
        `channel ${channel.title} maps it to Elev8 listing ${elev8Id}, which is not imported yet`)
      continue
    }

    const existing = await lookupAlias(db,
      { source: channel.source, kind: 'listing', externalId: otaId })
    if (existing) { base.alreadyLinked++; continue }

    await link(db, { source: channel.source, kind: 'listing', externalId: otaId },
               owner.entityId, 'elev8_channel_map')
    base.linked++
  }
  return { ...base, evidence: paths.evidence }
}

/** The shape of a channel's listing payload, for when linking refuses. */
export async function describeChannelListings(
  db: PoolClient, api: Elev8Client, channelId: string,
): Promise<{ rows: number, shape: ShapeEntry[], forms: Record<string, Record<IdForm, number>> }> {
  const res = await api.get<Record<string, unknown>[]>(
    db, `/api/v1/channex/channel/${encodeURIComponent(channelId)}/listings`)
  const rows = Array.isArray(res.data) ? res.data : []
  return {
    rows: rows.length,
    shape: describe(rows),
    forms: Object.fromEntries(formProfile(rows)),
  }
}
