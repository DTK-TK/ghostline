-- 0004_dashboard.sql
-- Access control for the dashboard (spec: dashboard-and-simulator, task 2).
--
-- RLS is enabled on every table with NO policies. The anon and authenticated
-- roles can therefore read and write nothing; the server uses the service role
-- key, which bypasses RLS. All dashboard reads go through server code behind
-- the DASHBOARD_PASSCODE proxy.
--
-- Deferred (not in this migration): calls_read / events_read policies,
-- family_members.user_id (Supabase Auth).

ALTER TABLE households     ENABLE ROW LEVEL SECURITY;
ALTER TABLE contacts       ENABLE ROW LEVEL SECURITY;
ALTER TABLE family_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE calls          ENABLE ROW LEVEL SECURITY;
ALTER TABLE call_events    ENABLE ROW LEVEL SECURITY;
ALTER TABLE fraud_reports  ENABLE ROW LEVEL SECURITY;
ALTER TABLE mock_messages  ENABLE ROW LEVEL SECURITY;

-- Shared with task 14 (migration columns).
ALTER TABLE households ADD COLUMN IF NOT EXISTS is_demo boolean NOT NULL DEFAULT false;
ALTER TABLE calls      ADD COLUMN IF NOT EXISTS is_simulated boolean NOT NULL DEFAULT false;
