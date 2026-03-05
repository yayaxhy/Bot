CREATE TABLE IF NOT EXISTS "auto_commission_buff" (
    "user_id" TEXT PRIMARY KEY,
    "target_share" NUMERIC(10,4) NOT NULL DEFAULT 0.91,
    "threshold_amount" NUMERIC(19,4) NOT NULL DEFAULT 12000,
    "window_days" INTEGER NOT NULL DEFAULT 30,
    "window_start" TIMESTAMPTZ NOT NULL,
    "window_end" TIMESTAMPTZ NOT NULL,
    "current_amount" NUMERIC(19,4) NOT NULL DEFAULT 0,
    "active_until" TIMESTAMPTZ,
    "last_qualified_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now()
);
