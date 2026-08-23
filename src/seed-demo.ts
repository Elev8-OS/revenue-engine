/**
 * Demonstration data, clearly labelled.
 *
 * Every figure below was MEASURED on the live accounts during the data survey —
 * the Booking click rates, the Airbnb forward impressions, the take rate, the
 * cost per turnover. That makes the dashboard reviewable before the ingest
 * exists, without inventing anything.
 *
 * The `[Demo]` prefix is load-bearing: the page keys its banner off it, so demo
 * data can never quietly pass for real data. `npm run seed:clear` removes it.
 */
import { Pool } from 'pg'

const pool = new Pool({ connectionString: process.env.DATABASE_URL! })
const c = await pool.connect()

if (process.argv.includes('--clear')) {
  await c.query(`delete from entity where label like '[Demo]%'`)
  await c.query(`delete from dataset_freshness where dataset like 'demo_%'`)
  console.log('demo data removed')
  c.release(); await pool.end(); process.exit(0)
}

await c.query(`delete from entity where label like '[Demo]%'`)

interface Seed {
  label: string; band: string; contract: string; holdout: boolean
  severity: string; headline: string; revenue: number; margin: number
  low: number; high: number; confidence: number; failing: string
  gate: Array<[string, string, string | null]>
  supporting: Array<[string, string, string, string]>
  against: Array<[string, string, string, string]>
}

const SEEDS: Seed[] = [
  {
    label: '[Demo] Villa Masurai · Pererenan', band: '2BR', contract: 'guaranteed_rent', holdout: false,
    severity: 'high', revenue: 1640, margin: 1180, low: 900, high: 2400, confidence: 0.74,
    failing: 'conversion',
    headline: 'Konversion liegt 14 % unter der Kohorte, während die Klickrate 23 % darüber liegt',
    gate: [['impressions', 'healthy', null], ['ctr', 'healthy', '23 % über Kohorte'],
           ['conversion', 'failing', '14 % unter Kohorte'], ['price', 'failing', '12 % unter dem Set']],
    supporting: [
      ['performance', 'Funnel Booking', '99 014 Impressionen, 743 Aufrufe, 5 Buchungen — Klickrate 0,75 %, Konversion 0,67 %.', '7 h'],
      ['market', 'Compset', 'Acht gematchte Vergleichsobjekte liegen bei 207 Median für dieses Fenster, wir bei 182.', '1 T'],
      ['operations', 'Abgabequote', 'Effektive Abgabequote 23,4 % gegen 20,8 % in der Kohorte — Genius, Visibility Booster 4 %, Mobile 10 %.', '7 h'],
    ],
    against: [
      ['market', 'Promotionen', 'Zwei der acht Vergleichsobjekte haben diese Woche Gratis-Storno eingeschaltet; bei höherem Preis könnte die Konversion stärker fallen als die Lücke vermuten lässt.', '1 T'],
      ['calendar', 'Saison', 'Die australischen Schulferien enden am 6. Oktober — die letzten neun Tage des Fensters tragen strukturell weniger Nachfrage.', 'kuratiert'],
    ],
  },
  {
    label: '[Demo] Villa Bakti · Ubud', band: '1BR', contract: 'net_share', holdout: true,
    severity: 'high', revenue: 610, margin: 520, low: 290, high: 940, confidence: 0.58,
    failing: 'ctr',
    headline: 'Oft gezeigt, selten geklickt — Klickrate 78 % unter der Kohorte',
    gate: [['impressions', 'healthy', null], ['ctr', 'failing', '78 % unter Kohorte'],
           ['conversion', 'unknown', 'hinter der Klickrate zurückgehalten'],
           ['price', 'unknown', 'hinter der Klickrate zurückgehalten']],
    supporting: [
      ['performance', 'Funnel Booking', '67 777 Impressionen, 237 Aufrufe — Klickrate 0,35 %, bei dünnem Nenner.', '7 h'],
      ['market', 'Bewertungstiefe', 'MDVs eigenes Matching gewichtet review_score mit 18,4 % und review_count mit 3,1 %; drei Bewertungen sind ein struktureller Nachteil in der Ergebnisliste.', '1 T'],
    ],
    against: [
      ['performance', 'Holdout', 'Dieser Raum ist im Messungs-Holdout, es wurde also nichts automatisch geändert — der Rückgang ist nicht Folge unserer eigenen Preise.', 'live'],
    ],
  },
  {
    label: '[Demo] Canggu Loft · Studio', band: 'Studio', contract: 'gross_share', holdout: false,
    severity: 'medium', revenue: 820, margin: 610, low: 420, high: 1240, confidence: 0.66,
    failing: 'price',
    headline: 'Alle Sichtbarkeitstore halten — echter Preisfall, 7 % unter dem Set',
    gate: [['impressions', 'healthy', null], ['ctr', 'healthy', '20 % über Kohorte'],
           ['conversion', 'healthy', null], ['price', 'failing', '7 % unter dem Set']],
    supporting: [
      ['performance', 'Funnel Booking', '87 809 Impressionen, 612 Aufrufe, 5 Buchungen — Klickrate 0,70 %, Konversion 0,82 %.', '7 h'],
      ['market', 'Marktlage', 'Perzentil 44 im Studio-Band, Marktbelegung 66 % gegen 79 % im Vorjahr, Angebot +14 %.', '4 h'],
    ],
    against: [
      ['market', 'Zielkonflikt', 'Der Vertrag zahlt auf den Bruttoerlös, die Engine rangiert hier also auf Erlös. Auf Deckungsbeitrag optimiert wäre die Empfehlung eine andere.', 'Vertrag'],
    ],
  },
]

for (const s of SEEDS) {
  const { rows } = await c.query<{ id: string }>(
    `insert into entity (label, market, bedroom_band, location_type, location_code, contract, in_holdout)
     values ($1,'bali',$2,'beach','ID-BA-BADUNG',$3,$4) returning id`,
    [s.label, s.band, s.contract, s.holdout])
  const entityId = rows[0]!.id

  const f = await c.query<{ id: string }>(
    `insert into finding (entity_id, check_key, check_version, severity, headline,
       window_from, window_to, amount_revenue, amount_margin, band_low, band_high,
       currency, confidence, first_failing, expires_at)
     values ($1,'demo.seeded',1,$2,$3, current_date, current_date + 38,
             $4,$5,$6,$7,'USD',$8,$9::gate_stage, now() + interval '5 days')
     returning id`,
    [entityId, s.severity, s.headline, s.revenue, s.margin, s.low, s.high, s.confidence, s.failing])
  const findingId = f.rows[0]!.id

  for (const [stage, verdict, note] of s.gate) {
    await c.query(
      `insert into finding_gate (finding_id, stage, verdict, note)
       values ($1,$2::gate_stage,$3::gate_verdict,$4)`, [findingId, stage, verdict, note])
  }
  for (const [family, metric, claim, observed] of s.supporting) {
    await c.query(
      `insert into finding_evidence (finding_id, side, family, metric, claim, observed_at)
       values ($1,'supporting',$2,$3,$4,$5)`, [findingId, family, metric, claim, observed])
  }
  for (const [family, metric, claim, observed] of s.against) {
    await c.query(
      `insert into finding_evidence (finding_id, side, family, metric, claim, observed_at)
       values ($1,'against',$2,$3,$4,$5)`, [findingId, family, metric, claim, observed])
  }
}

// Rooms a check could not reach. The live MDV ranking feed returned 47 rows
// against 62 connected listings, so this is the real shape of the problem.
for (const [label, reason] of [
  ['[Demo] Uluwatu Cliff House · Raum 2', 'keine Ranking-Daten auf beiden Kanälen'],
  ['[Demo] Villa Padma · Raum 1', 'Compset nicht aufgelöst'],
] as const) {
  const { rows } = await c.query<{ id: string }>(
    `insert into entity (label, market, bedroom_band) values ($1,'bali','2BR') returning id`, [label])
  await c.query(
    `insert into not_assessable (entity_id, as_of, reason) values ($1, current_date, $2)`,
    [rows[0]!.id, reason])
}

// Freshness with a deliberate spread, because that is what the real accounts
// look like: pricing minutes old, the core record a day behind.
for (const [source, dataset, minutes] of [
  ['mdv_booking', 'demo_pricing', 20], ['mdv_booking', 'demo_ranking', 25],
  ['mdv_booking', 'demo_property_core', 1500], ['pricelabs', 'demo_market_panel', 240],
] as const) {
  await c.query(
    `insert into dataset_freshness (source, dataset, entity_id, observed_at, status)
     values ($1::source_system, $2, null, now() - ($3 || ' minutes')::interval, 'ok')
     on conflict (source, dataset, entity_id) do update set observed_at = excluded.observed_at`,
    [source, dataset, String(minutes)])
}

const n = await c.query<{ n: number }>(`select count(*)::int n from entity where label like '[Demo]%'`)
console.log(`seeded ${n.rows[0]!.n} demo entities`)
c.release(); await pool.end()
