-- Audit log for deleted peiwan rows
CREATE TABLE "PeiwanDeletion" (
  "peiwanId" INTEGER NOT NULL,
  "discordUserId" TEXT NOT NULL,
  "deletedBy" TEXT,
  "deletedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "PeiwanDeletion_pkey" PRIMARY KEY ("peiwanId")
);

CREATE INDEX "PeiwanDeletion_discordUserId_idx" ON "PeiwanDeletion"("discordUserId");
