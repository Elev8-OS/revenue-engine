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
 * WHAT THIS FILE USED TO BE, and why it is a tenth of the size now.
 *
 * The first version walked `/api/v1/channex/channel` (61 channels in the live
 * account) and then `/channel/:id/listings` for each, and — because the response
 * shapes were undocumented — decided which field was ours and which was the
 * OTA's by measuring the FORM of the ids: overwhelmingly UUID-shaped is ours,
 * overwhelmingly numeric is theirs, refuse below 90%. That was careful, tested,
 * and solving a problem that does not exist. Recording the actual response shape
 * showed the ids sitting on the listing itself:
 *
 *     ota_channels[].channel_name      112/112  100%
 *     ota_channels[].ota_listing_id     84/112   75%
 *
 * A field named `ota_listing_id` next to a field named `channel_name` needs no
 * form heuristic to interpret. Sixty lines of inference and 61 HTTP calls per
 * import, replaced by two field names — because we looked instead of guessing.
 *
 * What survives is the part that was never about shapes: an unrecognised channel
 * is REPORTED, never assigned to the nearest match. Putting Vrbo's listings
 * under Airbnb would be worse than ignoring them.
 */
import type { PoolClient } from 'pg'
import type { SourceSystem } from '../../entity/resolve.js'
import { link, lookupAlias } from '../../entity/resolve.js'

export interface OtaChannel {
  channel_name?: string
  ota_listing_id?: string
  channel_url?: string
  [k: string]: unknown
}

export interface OtaLinkCounts {
  linked: number
  alreadyLinked: number
  /** Channel names we do not map to a source. Reported, never guessed. */
  unknownChannel: string[]
  /** Channels present but carrying no OTA id — 28 of 112 in the live account. */
  noOtaId: number
}

/**
 * Channel name to MDV source. Substrings rather than exact titles because the
 * names carry suffixes ("Airbnb (Official)"), but deliberately NOT fuzzy.
 */
const CHANNEL_TO_SOURCE: { match: RegExp, source: SourceSystem }[] = [
  { match: /air\s*bnb|airbnb/i, source: 'mdv_airbnb' },
  { match: /booking\.?com|booking/i, source: 'mdv_booking' },
]

export function classify(channelName: string): SourceSystem | null {
  for (const { match, source } of CHANNEL_TO_SOURCE) if (match.test(channelName)) return source
  return null
}

/**
 * Links one listing's OTA ids to its entity.
 *
 * `matched_by = 'elev8_ota_channels'` is the whole improvement over what came
 * before. Every earlier route to this join would have been recorded as
 * `unique_label` or a coordinate match — a link that is probably right. This one
 * is the channel manager's own mapping, read from the record it maintains.
 */
export async function linkOtaChannels(
  db: PoolClient,
  entityId: string,
  channels: OtaChannel[] | null | undefined,
  counts: OtaLinkCounts,
): Promise<void> {
  if (!Array.isArray(channels)) return
  for (const ch of channels) {
    const name = (ch.channel_name ?? '').trim()
    const otaId = (ch.ota_listing_id ?? '').trim()

    // A channel with no OTA id is a connection that exists without a published
    // listing behind it. Counted rather than reported per row: 28 of 112 in the
    // live account, so a message per occurrence would be noise, and the total is
    // the number that tells us whether it is normal or a problem.
    if (!otaId) { counts.noOtaId++; continue }

    const source = classify(name)
    if (!source) {
      if (!counts.unknownChannel.includes(name || '(unnamed)')) {
        counts.unknownChannel.push(name || '(unnamed)')
      }
      continue
    }

    const existing = await lookupAlias(db, { source, kind: 'listing', externalId: otaId })
    if (existing) { counts.alreadyLinked++; continue }

    await link(db, { source, kind: 'listing', externalId: otaId },
               entityId, 'elev8_ota_channels')
    counts.linked++
  }
}
