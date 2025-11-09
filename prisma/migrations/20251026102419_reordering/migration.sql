/*
  Warnings:

  - You are about to drop the column `url` on the `Gift` table. All the data in the column will be lost.
  - Added the required column `url_link` to the `Gift` table without a default value. This is not possible if the table is not empty.
  - Made the column `price` on table `Gift` required. This step will fail if there are existing NULL values in that column.

*/
-- AlterTable
ALTER TABLE "Gift" DROP COLUMN "url",
ADD COLUMN     "url_link" TEXT NOT NULL,
ALTER COLUMN "price" SET NOT NULL,
ALTER COLUMN "price" SET DEFAULT 0;
