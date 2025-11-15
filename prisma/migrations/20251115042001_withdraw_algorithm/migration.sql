-- CreateTable
CREATE TABLE "Withdraw" (
    "id" TEXT NOT NULL,
    "discordId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "amount" INTEGER NOT NULL,
    "method" TEXT NOT NULL,
    "notifiedAt" TIMESTAMP(3),

    CONSTRAINT "Withdraw_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Withdraw_discordId_key" ON "Withdraw"("discordId");
