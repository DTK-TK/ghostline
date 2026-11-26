-- 0003_call_evidence.sql
-- Evidence the conversation engine stores for the alert SMS and fraud report.
-- Idempotent so it is safe whether it runs before or after 0004_dashboard.sql.
alter table calls add column if not exists requested_amount text;
alter table calls add column if not exists payment_method text;
