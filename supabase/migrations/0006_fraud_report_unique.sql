-- One fraud report per call. buildAndStoreReport treats a unique violation
-- (23505) as "already built" and returns the existing row.
-- Remove any older duplicates first (keep the earliest) so the index can build.
delete from fraud_reports a
  using fraud_reports b
  where a.call_id = b.call_id
    and (a.created_at, a.id) > (b.created_at, b.id);

create unique index if not exists fraud_reports_call_id_unique
  on fraud_reports (call_id);
