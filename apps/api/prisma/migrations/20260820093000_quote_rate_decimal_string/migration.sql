-- Store exchange rates as decimal strings so quote arithmetic and API responses
-- never round through JavaScript floats. PostgreSQL's text cast can emit
-- scientific notation for existing DOUBLE PRECISION values; to_char reconciles
-- existing rows into a plain decimal representation before the column becomes
-- TEXT.
ALTER TABLE "Quote"
  ALTER COLUMN "rate" TYPE TEXT
  USING CASE
    WHEN "rate" IS NULL THEN NULL
    ELSE trim(trailing '.' FROM trim(trailing '0' FROM to_char("rate", 'FM999999999999999999999999999999990.999999999999999999999999999999')))
  END;
