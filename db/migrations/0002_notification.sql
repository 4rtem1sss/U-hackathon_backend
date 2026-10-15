-- Recipient push notification (ntfy) state on transfers. Owned by part 3.
-- NOT_STARTED until COMPLETED_SIMULATED; then PENDING -> SENT | FAILED, or DISABLED when no topic is configured.
ALTER TABLE transfers
  ADD COLUMN notification_channel text NOT NULL DEFAULT 'NTFY'
    CHECK (notification_channel IN ('NTFY')),
  ADD COLUMN notification_status text NOT NULL DEFAULT 'NOT_STARTED'
    CHECK (notification_status IN ('NOT_STARTED', 'PENDING', 'SENT', 'FAILED', 'DISABLED')),
  ADD COLUMN notification_sent_at timestamptz,
  ADD CONSTRAINT transfers_notification_sent_at_check
    CHECK ((notification_status = 'SENT') = (notification_sent_at IS NOT NULL));
