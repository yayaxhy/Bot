-- Spend buff table for 双倍消费5000券
CREATE TABLE IF NOT EXISTS "spend_buff" (
    "user_id" TEXT PRIMARY KEY,
    "remaining_extra" NUMERIC(19,4) NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now()
);
