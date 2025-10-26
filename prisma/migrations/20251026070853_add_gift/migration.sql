-- CreateTable
CREATE TABLE "Gift" (
    "Giftid" TEXT NOT NULL,
    "price" DECIMAL(19,4) NOT NULL DEFAULT 0,

    CONSTRAINT "Gift_pkey" PRIMARY KEY ("Giftid")
);
