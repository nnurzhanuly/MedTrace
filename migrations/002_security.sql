ALTER TABLE idempotency_keys ADD COLUMN IF NOT EXISTS request_hash text;

CREATE TABLE IF NOT EXISTS login_attempts (
  bucket text PRIMARY KEY,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  window_start timestamptz NOT NULL DEFAULT now(),
  blocked_until timestamptz
);
CREATE INDEX IF NOT EXISTS idx_login_attempts_window ON login_attempts(window_start);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
