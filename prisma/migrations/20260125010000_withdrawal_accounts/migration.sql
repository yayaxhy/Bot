-- Withdrawal accounts (up to 3 slots per user)
CREATE TABLE IF NOT EXISTS "WithdrawalAccount" (
  "discordUserId" TEXT NOT NULL,
  "account1" TEXT,
  "account2" TEXT,
  "account3" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "WithdrawalAccount_pkey" PRIMARY KEY ("discordUserId"),
  CONSTRAINT "WithdrawalAccount_discordUserId_fkey" FOREIGN KEY ("discordUserId") REFERENCES "Member"("discordUserId") ON DELETE CASCADE ON UPDATE CASCADE
);
