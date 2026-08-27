-- Account-level breakdowns: the market environment, as the channel sees it.
--
-- The performance endpoints carry four things that are about the ACCOUNT and not
-- about one object: how long people stay, how many of them travel together, where
-- they come from, and how often they cancel. Plus the portfolio's rank percentile
-- per day.
--
-- None of that fits `snapshot`, which is keyed per entity, and none of it fits
-- `snapshot_market`, which is keyed by market and size band. Forcing either would
-- mean inventing an entity or a band for a figure that has neither.
--
-- So: long form, one row per figure, with the label the provider used. `section`
-- separates the four kinds so a reader never compares a stay length against a
-- country count.
--
-- WHY `unit` IS A COLUMN AND NOT AN ASSUMPTION. `duration_breakdown."2-6 nights":
-- 41` is either forty-one reservations or forty-one percent, and the payload does
-- not say. It can be DERIVED — a set of shares sums to about 100, a set of counts
-- sums to the reservation total — so the adapter checks and records which it
-- concluded. Where neither holds, the unit is 'undecidable' and the figure is kept
-- but not charted: a bar chart of numbers whose unit is unknown is a picture of
-- nothing.

create table channel_insight (
  source      source_system not null,
  /** duration | group_size | country | rate | rank_timeline */
  section     text not null,
  /** The provider's own label. Transcribed, never mapped onto our vocabulary. */
  label       text not null,
  value       numeric(18,6),
  /** The same figure for the comparison period, where the payload carries one. */
  comparison  numeric(18,6),
  /** count | share | rate | percentile | undecidable — derived, never assumed. */
  unit        text not null,
  /**
   * TRUE when the provider states the comparison is the same period one year
   * earlier, FALSE when it is the immediately preceding period.
   *
   * `period_info.compare_yoy` decides it. Calling a prior-period comparison
   * "last year" would be the kind of quiet mislabelling that survives for months
   * because both numbers look plausible.
   */
  compare_yoy boolean,
  period_start date,
  period_end   date,
  observed_at timestamptz,
  as_of_date  date not null,
  primary key (source, section, label, as_of_date)
);

create index channel_insight_recent_idx on channel_insight (section, as_of_date desc);
