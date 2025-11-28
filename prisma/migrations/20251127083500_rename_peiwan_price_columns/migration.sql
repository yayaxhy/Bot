-- Rename PEIWAN price columns to game-specific names
ALTER TABLE "PEIWAN" RENAME COLUMN "quotation_Q2" TO "lolPrice";
ALTER TABLE "PEIWAN" RENAME COLUMN "quotation_Q3" TO "valPrice";
ALTER TABLE "PEIWAN" RENAME COLUMN "quotation_Q4" TO "deltaPrice";
ALTER TABLE "PEIWAN" RENAME COLUMN "quotation_Q5" TO "csgoPrice";
ALTER TABLE "PEIWAN" RENAME COLUMN "quotation_Q6" TO "narakaPrice";
ALTER TABLE "PEIWAN" RENAME COLUMN "quotation_Q7" TO "apexPrice";
