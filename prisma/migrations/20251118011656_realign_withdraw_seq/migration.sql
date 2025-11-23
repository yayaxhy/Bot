-- Align Withdraw_id_seq with existing data
WITH max_val AS (
  SELECT COALESCE(MAX(CAST(REGEXP_REPLACE(id, '^W', '') AS INTEGER)), 0) AS max_id
  FROM "Withdraw"
)
SELECT setval('Withdraw_id_seq', (SELECT max_id FROM max_val));
