-- Align withdraw.amount to decimal for fractional withdrawals
ALTER TABLE "Withdraw"
  ALTER COLUMN "amount" TYPE numeric(19,4) USING "amount"::numeric;
