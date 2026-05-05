-- Betting Engine V2: server-captured click snapshot (JSON). Never trust client for resolution baselines.
ALTER TABLE live_bets
ADD COLUMN IF NOT EXISTS click_snapshot JSONB;

COMMENT ON COLUMN live_bets.click_snapshot IS
  'Engine V2: UserBetSnapshotV2 captured at bet placement time (server only).';
