-- 0001_init.sql: first schema for the US -> TH P2P remittance demo.
--
-- Table ownership (who writes which table at runtime):
--   part 2 (sessions/quotes): demo_sessions, recipients, quotes
--   part 3 (backend core):    transfers, transfer_events, idempotency_keys,
--                             funding_attempts, payout_attempts
--   part 4 (settlement):      settlement_attempts (part 3 only reads it)
-- The schema itself is owned by part 3; other parts change it via reviewed migrations.
--
-- Conventions: IDs are prefixed text (src/lib/ids.ts); amounts are numeric(38,0)
-- (returned by pg as strings); enums are text + CHECK constraints; timestamps are
-- timestamptz. RLS is enabled on every table with no policies: only the server
-- connection (table owner / service role) can read or write.

-- ---------------------------------------------------------------------------
-- part 2: sessions, recipients, quotes
-- ---------------------------------------------------------------------------

CREATE TABLE demo_sessions (
  id          text PRIMARY KEY,
  token_hash  text NOT NULL UNIQUE,
  owner_id    text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL
);
CREATE INDEX demo_sessions_owner_idx ON demo_sessions (owner_id);

CREATE TABLE recipients (
  id               text PRIMARY KEY,
  owner_id         text NOT NULL,
  name             text NOT NULL,
  country          text NOT NULL DEFAULT 'TH',
  currency         text NOT NULL DEFAULT 'THB',
  bank_label       text NOT NULL,
  account_display  text NOT NULL,
  is_synthetic     boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX recipients_owner_idx ON recipients (owner_id);

CREATE TABLE quotes (
  id                          text PRIMARY KEY,
  owner_id                    text NOT NULL,
  recipient_id                text NOT NULL REFERENCES recipients (id),
  recipient_snapshot          jsonb NOT NULL,
  source_country              text NOT NULL,
  destination_country         text NOT NULL,
  source_currency             text NOT NULL,
  destination_currency        text NOT NULL,
  source_debit_minor          numeric(38,0) NOT NULL CHECK (source_debit_minor >= 0),
  fee_minor                   numeric(38,0) NOT NULL CHECK (fee_minor >= 0),
  conversion_principal_minor  numeric(38,0) NOT NULL CHECK (conversion_principal_minor >= 0),
  fx_rate_numerator           numeric(38,0) NOT NULL CHECK (fx_rate_numerator > 0),
  fx_rate_denominator         numeric(38,0) NOT NULL CHECK (fx_rate_denominator > 0),
  destination_net_minor       numeric(38,0) NOT NULL CHECK (destination_net_minor >= 0),
  settlement_token_units      numeric(38,0) NOT NULL CHECK (settlement_token_units >= 0),
  fixture_version             text NOT NULL,
  chain_id                    integer NOT NULL,
  status                      text NOT NULL DEFAULT 'OPEN'
                              CHECK (status IN ('OPEN', 'ACCEPTED', 'EXPIRED')),
  created_at                  timestamptz NOT NULL DEFAULT now(),
  expires_at                  timestamptz NOT NULL,
  accepted_at                 timestamptz,
  CHECK ((status = 'ACCEPTED') = (accepted_at IS NOT NULL))
);
CREATE INDEX quotes_owner_idx ON quotes (owner_id);

-- ---------------------------------------------------------------------------
-- part 3: transfers and their operations
-- ---------------------------------------------------------------------------

CREATE TABLE transfers (
  id                          text PRIMARY KEY,
  owner_id                    text NOT NULL,
  quote_id                    text NOT NULL REFERENCES quotes (id),
  status                      text NOT NULL CHECK (status IN (
                                'FUNDING_PENDING', 'FUNDED_SIMULATED', 'FUNDING_FAILED',
                                'SETTLEMENT_PENDING', 'SETTLED', 'SETTLEMENT_FAILED',
                                'PAYOUT_PENDING', 'PAYOUT_FAILED', 'REVIEW_REQUIRED',
                                'COMPLETED_SIMULATED')),
  version                     integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  purpose                     text NOT NULL CHECK (purpose IN ('PERSONAL_REMITTANCE')),
  demo_scenario               text NOT NULL CHECK (demo_scenario IN (
                                'HAPPY_PATH', 'FUNDING_DECLINED', 'PAYOUT_FAILED')),

  -- immutable snapshot copied from the accepted quote
  recipient_snapshot          jsonb NOT NULL,
  source_currency             text NOT NULL,
  destination_currency        text NOT NULL,
  source_debit_minor          numeric(38,0) NOT NULL CHECK (source_debit_minor >= 0),
  fee_minor                   numeric(38,0) NOT NULL CHECK (fee_minor >= 0),
  conversion_principal_minor  numeric(38,0) NOT NULL CHECK (conversion_principal_minor >= 0),
  destination_net_minor       numeric(38,0) NOT NULL CHECK (destination_net_minor >= 0),
  settlement_token_units      numeric(38,0) NOT NULL CHECK (settlement_token_units >= 0),
  fx_rate_numerator           numeric(38,0) NOT NULL CHECK (fx_rate_numerator > 0),
  fx_rate_denominator         numeric(38,0) NOT NULL CHECK (fx_rate_denominator > 0),
  fixture_version             text NOT NULL,

  -- substatuses and references
  funding_status              text NOT NULL DEFAULT 'PENDING'
                              CHECK (funding_status IN ('PENDING', 'ACCEPTED', 'DECLINED')),
  funding_reference           text,
  settlement_status           text NOT NULL DEFAULT 'NOT_STARTED'
                              CHECK (settlement_status IN ('NOT_STARTED', 'PREPARING', 'BROADCAST',
                                'PENDING', 'CONFIRMED', 'FAILED', 'REVIEW_REQUIRED')),
  settlement_tx_hash          text,
  settlement_evidence         jsonb,
  settlement_verified_at      timestamptz,
  payout_status               text NOT NULL DEFAULT 'NOT_STARTED'
                              CHECK (payout_status IN ('NOT_STARTED', 'PENDING', 'PAID', 'FAILED', 'UNKNOWN')),
  payout_reference            text,
  last_issue                  jsonb,
  receipt                     jsonb,

  -- claim / fencing for /advance (plan 4.4)
  claim_epoch                 integer NOT NULL DEFAULT 0 CHECK (claim_epoch >= 0),
  claim_expires_at            timestamptz,

  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT transfers_quote_id_key UNIQUE (quote_id)
);
CREATE INDEX transfers_owner_idx ON transfers (owner_id, created_at DESC);

-- scope is CREATE_TRANSFER (transfer_id filled in once the transfer exists) or
-- FUNDING / PAYOUT_RETRY (transfer_id always set). The fingerprint of a
-- FUNDING / PAYOUT_RETRY request must include the transfer ID, so reusing a key
-- for a different transfer is reported as a conflict.
CREATE TABLE idempotency_keys (
  owner_id         text NOT NULL,
  scope            text NOT NULL CHECK (scope IN ('CREATE_TRANSFER', 'FUNDING', 'PAYOUT_RETRY')),
  key              text NOT NULL CHECK (length(key) BETWEEN 1 AND 255),
  fingerprint      text NOT NULL,
  transfer_id      text REFERENCES transfers (id),
  response_status  integer,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, scope, key),
  CHECK (scope = 'CREATE_TRANSFER' OR transfer_id IS NOT NULL)
);
CREATE INDEX idempotency_keys_transfer_idx ON idempotency_keys (transfer_id);

CREATE TABLE transfer_events (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  transfer_id  text NOT NULL REFERENCES transfers (id),
  sequence     integer NOT NULL CHECK (sequence >= 1),
  from_status  text,
  to_status    text NOT NULL,
  reason       text,
  attempt_ref  text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT transfer_events_transfer_sequence_key UNIQUE (transfer_id, sequence)
);

-- transfer_events is append-only.
CREATE FUNCTION transfer_events_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'transfer_events is append-only (% not allowed)', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER transfer_events_no_update_delete
  BEFORE UPDATE OR DELETE ON transfer_events
  FOR EACH ROW EXECUTE FUNCTION transfer_events_append_only();

CREATE TRIGGER transfer_events_no_truncate
  BEFORE TRUNCATE ON transfer_events
  FOR EACH STATEMENT EXECUTE FUNCTION transfer_events_append_only();

CREATE TABLE funding_attempts (
  id           text PRIMARY KEY,
  transfer_id  text NOT NULL REFERENCES transfers (id),
  request_id   text NOT NULL,
  status       text NOT NULL CHECK (status IN ('ACCEPTED', 'DECLINED')),
  reference    text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT funding_attempts_transfer_id_key UNIQUE (transfer_id)
);

CREATE TABLE payout_attempts (
  id           text PRIMARY KEY,
  transfer_id  text NOT NULL REFERENCES transfers (id),
  request_id   text NOT NULL,
  attempt_no   integer NOT NULL CHECK (attempt_no >= 1),
  status       text NOT NULL DEFAULT 'PENDING'
               CHECK (status IN ('PENDING', 'PAID', 'FAILED', 'UNKNOWN')),
  reference    text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payout_attempts_request_id_key UNIQUE (request_id),
  CONSTRAINT payout_attempts_transfer_attempt_key UNIQUE (transfer_id, attempt_no)
);

-- ---------------------------------------------------------------------------
-- part 4: settlement attempts (written only by part 4's module)
-- ---------------------------------------------------------------------------

CREATE TABLE settlement_attempts (
  id                    text PRIMARY KEY,
  transfer_id           text NOT NULL REFERENCES transfers (id),
  chain_id              integer NOT NULL,
  token_address         text NOT NULL,
  signer                text NOT NULL,
  destination           text NOT NULL,
  units                 numeric(38,0) NOT NULL CHECK (units > 0),
  nonce                 bigint NOT NULL CHECK (nonce >= 0),
  signed_tx             text,
  tx_hash               text,
  phase                 text NOT NULL DEFAULT 'PREPARED'
                        CHECK (phase IN ('PREPARED', 'BROADCAST', 'PENDING', 'CONFIRMED', 'FAILED', 'REVIEW')),
  receipt_block_number  bigint,
  receipt_block_hash    text,
  evidence              jsonb,
  created_fence         integer NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT settlement_attempts_signer_nonce_key UNIQUE (chain_id, signer, nonce),
  CONSTRAINT settlement_attempts_tx_hash_key UNIQUE (chain_id, tx_hash)
);
CREATE INDEX settlement_attempts_transfer_idx ON settlement_attempts (transfer_id, created_at DESC);

-- At most one unresolved (in-flight) transaction per signer.
CREATE UNIQUE INDEX settlement_attempts_one_unresolved_per_signer
  ON settlement_attempts (chain_id, signer)
  WHERE phase IN ('PREPARED', 'BROADCAST', 'PENDING');

-- ---------------------------------------------------------------------------
-- Row level security: on everywhere, no policies (server connection only).
-- ---------------------------------------------------------------------------

ALTER TABLE demo_sessions       ENABLE ROW LEVEL SECURITY;
ALTER TABLE recipients          ENABLE ROW LEVEL SECURITY;
ALTER TABLE quotes              ENABLE ROW LEVEL SECURITY;
ALTER TABLE transfers           ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_keys    ENABLE ROW LEVEL SECURITY;
ALTER TABLE transfer_events     ENABLE ROW LEVEL SECURITY;
ALTER TABLE funding_attempts    ENABLE ROW LEVEL SECURITY;
ALTER TABLE payout_attempts     ENABLE ROW LEVEL SECURITY;
ALTER TABLE settlement_attempts ENABLE ROW LEVEL SECURITY;

-- On Supabase, also drop the default grants to the public API roles.
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', r);
    END IF;
  END LOOP;
END;
$$;
