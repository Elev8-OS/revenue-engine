-- 012 · the sentences a human actually read, in every language we show.
--
-- Findings are prose with numbers in them, and this tool exists to be argued
-- with by a Swiss office and a Bali team on the same afternoon. Two ways to make
-- that bilingual:
--
--   a) store a template key plus parameters, and render at read time
--   b) store the finished sentence once per language
--
-- (b), and not for convenience. This is a decision record: a price change gets
-- approved because somebody read a sentence. A template rendered later can be
-- edited by a deploy, and then the audit trail says something the approver never
-- saw. A stored sentence cannot drift. The cost is that the writer must produce
-- both renderings at write time — which it can, since it holds the numbers.
--
-- The legacy text columns stay as the fallback, so nothing that was written
-- before this migration becomes unreadable.
alter table finding          add column if not exists text_i18n jsonb;
alter table finding_gate     add column if not exists text_i18n jsonb;
alter table finding_evidence add column if not exists text_i18n jsonb;
alter table not_assessable   add column if not exists text_i18n jsonb;

-- A row that claims to be translated must at least carry English, which is the
-- fallback every read falls back to. Half a translation is worse than none,
-- because it looks finished.
alter table finding
  add constraint finding_text_i18n_has_en
  check (text_i18n is null or text_i18n ? 'en');
alter table finding_gate
  add constraint finding_gate_text_i18n_has_en
  check (text_i18n is null or text_i18n ? 'en');
alter table finding_evidence
  add constraint finding_evidence_text_i18n_has_en
  check (text_i18n is null or text_i18n ? 'en');
alter table not_assessable
  add constraint not_assessable_text_i18n_has_en
  check (text_i18n is null or text_i18n ? 'en');
