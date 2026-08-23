/**
 * The read port every source implements.
 *
 * Two ports, kept separate on purpose: reading market and performance signals is
 * not the same trust boundary as writing commercial levers to an OTA. A source
 * may implement one and not the other — MDV has 24 write levers but zero
 * rate-write endpoints, PriceLabs owns prices, Channex owns restrictions.
 */
import type { SourceSystem } from '../entity/resolve.js'

export interface FetchResult<T> {
  ok: boolean
  data?: T
  /** Named expected states, not generic failure. */
  blocked?: 'writes_disabled' | 'not_connected' | 'app_not_enabled' | 'unauthorised'
  status?: number
  /** What the provider says about its own freshness, where it says anything. */
  observedAt?: string
  raw?: unknown
}

export interface MarketSignalPort {
  readonly source: SourceSystem
  /** Cheap liveness probe that does not burn budget. */
  health(): Promise<FetchResult<{ note: string }>>
}

export interface OtaCommercialPort {
  readonly source: SourceSystem
  /** Levers this source can actually write, so the UI never offers a phantom. */
  levers(): readonly string[]
}
