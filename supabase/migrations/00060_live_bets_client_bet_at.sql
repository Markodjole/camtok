-- Add client_bet_at to live_bets.
--
-- Stores the epoch timestamp captured on the client the instant the user
-- tapped "bet".  The server validates and uses this as the effective bet time
-- so that bets placed before locks_at are not rejected due to network latency.
-- Nullable: NULL means the client didn't send one or it failed sanity checks.
ALTER TABLE live_bets
  ADD COLUMN IF NOT EXISTS client_bet_at TIMESTAMPTZ;

COMMENT ON COLUMN live_bets.client_bet_at IS
  'Client-side tap time (validated by server).  Used as effective bet time for lock/status checks to handle network-latency race conditions near locks_at.';
