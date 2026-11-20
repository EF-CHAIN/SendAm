ALTER TABLE "Transaction"
ADD COLUMN "regulatoryAmount" NUMERIC GENERATED ALWAYS AS (
  CASE WHEN "amount" ~ '^[0-9]+([.][0-9]+)?$' THEN "amount"::numeric END
) STORED;
