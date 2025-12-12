-- Buff tables for commission +1% and double-flow 5000
CREATE TABLE IF NOT EXISTS "commission_buff" (
    "user_id" TEXT PRIMARY KEY,
    "boost" NUMERIC(10,4) NOT NULL DEFAULT 0.01,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "flow_buff" (
    "user_id" TEXT PRIMARY KEY,
    "remaining_extra" NUMERIC(19,4) NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now()
);
