-- CreateEnum
CREATE TYPE "PeiwanStatus" AS ENUM ('busy', 'free');

-- AlterTable
ALTER TABLE "PEIWAN" ADD COLUMN     "status" "PeiwanStatus" NOT NULL DEFAULT 'free';
