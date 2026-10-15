-- 0003_part2_quotes.sql: simulated quote checks for part 2 (sessions/quotes).
--
-- A quote check is a simulated compliance/risk screen run before a quote is
-- issued. A final quote must reference a PASS check owned by the same owner,
-- and each check backs at most one quote. quotes.check_id stays nullable so
-- rows created before this migration (and part 3 test seeds) remain valid.

CREATE TABLE quote_checks (
  id                  text PRIMARY KEY,
  owner_id            text NOT NULL,
  recipient_id        text NOT NULL REFERENCES recipients (id),
  source_debit_minor  numeric(38,0) NOT NULL CHECK (source_debit_minor > 0),
  scenario            text NOT NULL CHECK (scenario IN ('PASS', 'REJECT', 'REVIEW')),
  result              text NOT NULL CHECK (result IN ('PASS', 'REJECT', 'REVIEW')),
  fixture_version     text NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  -- target of the composite FK from quotes (same owner, PASS only)
  CONSTRAINT quote_checks_id_owner_result_key UNIQUE (id, owner_id, result)
);
CREATE INDEX quote_checks_owner_idx ON quote_checks (owner_id, created_at DESC);

ALTER TABLE quotes
  ADD COLUMN check_id text,
  ADD COLUMN check_result text,
  ADD CONSTRAINT quotes_check_id_key UNIQUE (check_id),
  ADD CONSTRAINT quotes_check_pair_check
    CHECK ((check_id IS NULL) = (check_result IS NULL)),
  ADD CONSTRAINT quotes_check_result_pass_check
    CHECK (check_result IS NULL OR check_result = 'PASS'),
  -- MATCH SIMPLE: not enforced while check_id is NULL
  ADD CONSTRAINT quotes_check_fkey
    FOREIGN KEY (check_id, owner_id, check_result)
    REFERENCES quote_checks (id, owner_id, result),
  ADD CONSTRAINT quotes_amounts_sum_check
    CHECK (fee_minor + conversion_principal_minor = source_debit_minor);

ALTER TABLE quote_checks ENABLE ROW LEVEL SECURITY;

-- On Supabase, also drop the default grants to the public API roles.
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON TABLE quote_checks FROM %I', r);
    END IF;
  END LOOP;
END;
$$;
