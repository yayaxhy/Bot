-- Ensure sequence exists, then align Withdraw_id_seq with existing data
CREATE SEQUENCE IF NOT EXISTS "Withdraw_id_seq";

WITH max_val AS (
  SELECT COALESCE(MAX(CAST(REGEXP_REPLACE(id, '^W', '') AS INTEGER)), 0) AS max_id
  FROM "Withdraw"
)
SELECT setval('"Withdraw_id_seq"', GREATEST((SELECT max_id FROM max_val), 1));
