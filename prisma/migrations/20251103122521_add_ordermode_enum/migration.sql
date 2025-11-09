-- AlterTable
CREATE SEQUENCE commission_orderid_seq;
ALTER TABLE "Commission" ALTER COLUMN "orderID" SET DEFAULT nextval('commission_orderid_seq');
ALTER SEQUENCE commission_orderid_seq OWNED BY "Commission"."orderID";
