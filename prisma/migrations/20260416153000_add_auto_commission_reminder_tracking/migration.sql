ALTER TABLE "auto_commission_buff"
ADD COLUMN IF NOT EXISTS "reminder_sent_for_active_until" TIMESTAMPTZ;
