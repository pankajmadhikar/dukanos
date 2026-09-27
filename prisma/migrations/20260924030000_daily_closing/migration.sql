-- Marks a daily summary as a finalized closing snapshot.
-- Null means posting may still add to the running cache.
ALTER TABLE "daily_summaries" ADD COLUMN "closed_at" TIMESTAMPTZ(6);

COMMENT ON COLUMN daily_summaries.closed_at IS
  'When the shop finalized this business date. Null means the row is still the running cache.';
