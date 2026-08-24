/**
 * Demonstration data, clearly labelled, in both languages.
 *
 * Every figure below was MEASURED on the live accounts during the data survey —
 * the Booking click rates, the Airbnb forward impressions, the take rate. That
 * makes the dashboard reviewable before the ingest exists, without inventing
 * anything.
 *
 * The `[Demo]` prefix is load-bearing: the page keys its banner off it, so demo
 * data can never quietly pass for real data.
 *
 * Every sentence is stored once per language (migration 012), because a finding
 * is a decision record and the sentence somebody approved must not be able to
 * change under them. Numbers are written in each language's own convention —
 * 99,014 in English, 99.014 in Indonesian — since that is what a reader will
 * check against their own screen.
 *
 * `metric` and `observed_at` stay English: they name the data family and its
 * provenance, in the same register as ADR, compset or ota_commission.
 *
 * Exposed as functions rather than only a script because the service applies the
 * desired state at boot from SEED_DEMO — otherwise seeing the dashboard would
 * require a shell, and the person who needs to see it does not have one.
 */
import type { PoolClient } from 'pg'

/** One sentence, both renderings. English is the fallback the reads anchor on. */
interface Text { en: string, id: string }

interface Seed {
  label: string; band: string; contract: string; holdout: boolean
  severity: string; headline: Text; revenue: number; margin: number
  low: number; high: number; confidence: number; failing: string
  gate: Array<[string, string, Text | null]>
  supporting: Array<[string, string, Text, string]>
  against: Array<[string, string, Text, string]>
}

const SEEDS: Seed[] = [
  {
    label: '[Demo] Villa Masurai · Pererenan', band: '2BR', contract: 'guaranteed_rent', holdout: false,
    severity: 'high', revenue: 1640, margin: 1180, low: 900, high: 2400, confidence: 0.74,
    failing: 'conversion',
    headline: {
      en: 'Conversion is 14% below the cohort while the click rate is 23% above it',
      id: 'Konversi 14% di bawah kohort, sementara rasio klik 23% di atasnya',
    },
    gate: [
      ['impressions', 'healthy', null],
      ['ctr', 'healthy', { en: '23% above cohort', id: '23% di atas kohort' }],
      ['conversion', 'failing', { en: '14% below cohort', id: '14% di bawah kohort' }],
      ['price', 'failing', { en: '12% below the set', id: '12% di bawah set' }],
    ],
    supporting: [
      ['performance', 'Booking funnel', {
        en: '99,014 impressions, 743 views, 5 bookings — click rate 0.75%, conversion 0.67%.',
        id: '99.014 impresi, 743 tampilan, 5 pemesanan — rasio klik 0,75%, konversi 0,67%.',
      }, '7 h'],
      ['market', 'Compset', {
        en: 'Eight matched comparables sit at a median of 207 for this window; we are at 182.',
        id: 'Delapan properti pembanding yang cocok berada pada median 207 untuk jendela ini; kita di 182.',
      }, '1 d'],
      ['operations', 'Take rate', {
        en: 'Effective take rate 23.4% against 20.8% in the cohort — Genius, Visibility Booster 4%, Mobile 10%.',
        id: 'Take rate efektif 23,4% dibanding 20,8% di kohort — Genius, Visibility Booster 4%, Mobile 10%.',
      }, '7 h'],
    ],
    against: [
      ['market', 'Promotions', {
        en: 'Two of the eight comparables switched on free cancellation this week; at a higher price, conversion could fall further than the gap suggests.',
        id: 'Dua dari delapan pembanding mengaktifkan pembatalan gratis minggu ini; pada harga yang lebih tinggi, konversi bisa turun lebih dalam daripada yang tersirat dari selisih itu.',
      }, '1 d'],
      ['calendar', 'Season', {
        en: 'Australian school holidays end on 6 October — the last nine days of the window structurally carry less demand.',
        id: 'Libur sekolah Australia berakhir 6 Oktober — sembilan hari terakhir dari jendela ini secara struktural membawa permintaan lebih sedikit.',
      }, 'curated'],
    ],
  },
  {
    label: '[Demo] Villa Bakti · Ubud', band: '1BR', contract: 'net_share', holdout: true,
    severity: 'high', revenue: 610, margin: 520, low: 290, high: 940, confidence: 0.58,
    failing: 'ctr',
    headline: {
      en: 'Shown often, clicked rarely — click rate 78% below the cohort',
      id: 'Sering ditampilkan, jarang diklik — rasio klik 78% di bawah kohort',
    },
    gate: [
      ['impressions', 'healthy', null],
      ['ctr', 'failing', { en: '78% below cohort', id: '78% di bawah kohort' }],
      ['conversion', 'unknown', {
        en: 'held back behind the click rate', id: 'ditahan di belakang rasio klik' }],
      ['price', 'unknown', {
        en: 'held back behind the click rate', id: 'ditahan di belakang rasio klik' }],
    ],
    supporting: [
      ['performance', 'Booking funnel', {
        en: '67,777 impressions, 237 views — click rate 0.35%, on a thin denominator.',
        id: '67.777 impresi, 237 tampilan — rasio klik 0,35%, dengan penyebut yang tipis.',
      }, '7 h'],
      ['market', 'Review depth', {
        en: "MDV's own matching weights review_score at 18.4% and review_count at 3.1%; three reviews are a structural disadvantage in the result list.",
        id: 'Pencocokan milik MDV sendiri memberi bobot 18,4% pada review_score dan 3,1% pada review_count; tiga ulasan adalah kerugian struktural di daftar hasil.',
      }, '1 d'],
    ],
    against: [
      ['performance', 'Holdout', {
        en: 'This room is in the measurement holdout, so nothing was changed automatically — the decline is not a consequence of our own prices.',
        id: 'Unit ini berada dalam holdout pengukuran, jadi tidak ada yang diubah otomatis — penurunan ini bukan akibat harga kita sendiri.',
      }, 'live'],
    ],
  },
  {
    label: '[Demo] Canggu Loft · Studio', band: 'Studio', contract: 'gross_share', holdout: false,
    severity: 'medium', revenue: 820, margin: 610, low: 420, high: 1240, confidence: 0.66,
    failing: 'price',
    headline: {
      en: 'All visibility gates hold — a genuine price case, 7% below the set',
      id: 'Semua gerbang visibilitas lolos — ini benar-benar soal harga, 7% di bawah set',
    },
    gate: [
      ['impressions', 'healthy', null],
      ['ctr', 'healthy', { en: '20% above cohort', id: '20% di atas kohort' }],
      ['conversion', 'healthy', null],
      ['price', 'failing', { en: '7% below the set', id: '7% di bawah set' }],
    ],
    supporting: [
      ['performance', 'Booking funnel', {
        en: '87,809 impressions, 612 views, 5 bookings — click rate 0.70%, conversion 0.82%.',
        id: '87.809 impresi, 612 tampilan, 5 pemesanan — rasio klik 0,70%, konversi 0,82%.',
      }, '7 h'],
      ['market', 'Market position', {
        en: 'Percentile 44 in the studio band, market occupancy 66% against 79% last year, supply +14%.',
        id: 'Persentil 44 di band studio, okupansi pasar 66% dibanding 79% tahun lalu, pasokan +14%.',
      }, '4 h'],
    ],
    against: [
      ['market', 'Objective conflict', {
        en: 'The contract pays on gross revenue, so the engine ranks this room on revenue. Optimised for contribution the recommendation would be different.',
        id: 'Kontrak dibayar atas pendapatan bruto, jadi mesin memeringkat unit ini berdasarkan pendapatan. Jika dioptimalkan untuk kontribusi, rekomendasinya akan berbeda.',
      }, 'contract'],
    ],
  },
]

export async function seedDemo(client: PoolClient): Promise<number> {
  await client.query(`delete from entity where label like '[Demo]%'`)
  for (const s of SEEDS) {
    const { rows } = await client.query<{ id: string }>(
      `insert into entity (label, market, band, band_basis, location_type, location_code, contract, in_holdout)
       values ($1,'bali',$2,'bedrooms','beach','ID-BA-BADUNG',$3,$4) returning id`,
      [s.label, s.band, s.contract, s.holdout])
    const entityId = rows[0]!.id

    const f = await client.query<{ id: string }>(
      `insert into finding (entity_id, check_key, check_version, severity, headline, text_i18n,
         window_from, window_to, amount_revenue, amount_margin, band_low, band_high,
         currency, confidence, first_failing, expires_at)
       values ($1,'demo.seeded',1,$2,$3,$4::jsonb, current_date, current_date + 38,
               $5,$6,$7,$8,'USD',$9,$10::gate_stage, now() + interval '5 days')
       returning id`,
      [entityId, s.severity, s.headline.en, JSON.stringify(s.headline),
       s.revenue, s.margin, s.low, s.high, s.confidence, s.failing])
    const findingId = f.rows[0]!.id

    for (const [stage, verdict, note] of s.gate) {
      await client.query(
        `insert into finding_gate (finding_id, stage, verdict, note, text_i18n)
         values ($1,$2::gate_stage,$3::gate_verdict,$4,$5::jsonb)`,
        [findingId, stage, verdict, note?.en ?? null, note ? JSON.stringify(note) : null])
    }
    for (const side of ['supporting', 'against'] as const) {
      for (const [family, metric, claim, observed] of s[side]) {
        await client.query(
          `insert into finding_evidence (finding_id, side, family, metric, claim, text_i18n, observed_at)
           values ($1,$2,$3,$4,$5,$6::jsonb,$7)`,
          [findingId, side, family, metric, claim.en, JSON.stringify(claim), observed])
      }
    }
  }

  // Rooms a check could not reach. The live MDV ranking feed returned 47 rows
  // against 62 connected listings, so this is the real shape of the problem.
  const unreachable: Array<[string, Text]> = [
    ['[Demo] Uluwatu Cliff House · Room 2', {
      en: 'no ranking data on either channel', id: 'tidak ada data peringkat di kedua kanal' }],
    ['[Demo] Villa Padma · Room 1', {
      en: 'compset not resolved', id: 'compset belum terselesaikan' }],
  ]
  for (const [label, reason] of unreachable) {
    const { rows } = await client.query<{ id: string }>(
      `insert into entity (label, market, band, band_basis) values ($1,'bali','2BR','bedrooms') returning id`, [label])
    await client.query(
      `insert into not_assessable (entity_id, as_of, reason, text_i18n)
       values ($1, current_date, $2, $3::jsonb)`,
      [rows[0]!.id, reason.en, JSON.stringify(reason)])
  }

  // Freshness with a deliberate spread, because that is what the real accounts
  // look like: pricing minutes old, the core record a day behind.
  for (const [source, dataset, minutes] of [
    ['mdv_booking', 'demo_pricing', 20], ['mdv_booking', 'demo_ranking', 25],
    ['mdv_booking', 'demo_property_core', 1500], ['pricelabs', 'demo_market_panel', 240],
  ] as const) {
    await client.query(
      `insert into dataset_freshness (source, dataset, entity_id, observed_at, status)
       values ($1::source_system, $2, null, now() - ($3 || ' minutes')::interval, 'ok')
       on conflict (source, dataset, entity_id) do update set observed_at = excluded.observed_at`,
      [source, dataset, String(minutes)])
  }
  const { rows } = await client.query<{ n: number }>(
    `select count(*)::int n from entity where label like '[Demo]%'`)
  return rows[0]!.n
}

export async function clearDemo(client: PoolClient): Promise<number> {
  const { rowCount } = await client.query(`delete from entity where label like '[Demo]%'`)
  await client.query(`delete from dataset_freshness where dataset like 'demo_%'`)
  return rowCount ?? 0
}

export async function hasDemo(client: PoolClient): Promise<boolean> {
  const { rows } = await client.query<{ n: number }>(
    `select count(*)::int n from entity where label like '[Demo]%'`)
  return (rows[0]?.n ?? 0) > 0
}
