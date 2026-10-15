-- Lock every app table against Supabase's public Data API (anon/publishable key).
-- RLS on with no policies = anon and authenticated roles see nothing.
-- The backend connects as the table owner (postgres), which bypasses RLS, so
-- server code is unaffected. Plain Postgres (local/tests) behaves the same.
ALTER TABLE demo_sessions        ENABLE ROW LEVEL SECURITY;
ALTER TABLE recipients           ENABLE ROW LEVEL SECURITY;
ALTER TABLE quotes               ENABLE ROW LEVEL SECURITY;
ALTER TABLE quote_checks         ENABLE ROW LEVEL SECURITY;
ALTER TABLE transfers            ENABLE ROW LEVEL SECURITY;
ALTER TABLE transfer_events      ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_keys     ENABLE ROW LEVEL SECURITY;
ALTER TABLE funding_attempts     ENABLE ROW LEVEL SECURITY;
ALTER TABLE settlement_attempts  ENABLE ROW LEVEL SECURITY;
ALTER TABLE payout_attempts      ENABLE ROW LEVEL SECURITY;
ALTER TABLE schema_migrations    ENABLE ROW LEVEL SECURITY;
