
-- Add incremental display number for orders
ALTER TABLE "Order" ADD COLUMN "displayNo" INTEGER;

CREATE SEQUENCE "Order_displayNo_seq";
ALTER SEQUENCE "Order_displayNo_seq" OWNED BY "Order"."displayNo";
ALTER TABLE "Order" ALTER COLUMN "displayNo" SET DEFAULT nextval('"Order_displayNo_seq"');

UPDATE "Order" SET "displayNo" = nextval('"Order_displayNo_seq"') WHERE "displayNo" IS NULL;

ALTER TABLE "Order" ALTER COLUMN "displayNo" SET NOT NULL;

CREATE UNIQUE INDEX "Order_displayNo_key" ON "Order"("displayNo");
