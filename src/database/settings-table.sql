CREATE TABLE IF NOT EXISTS app_settings (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  "from" DATE NOT NULL DEFAULT CURRENT_DATE,
  amount money NOT NULL DEFAULT 123.45,
  "to" DATE NOT NULL DEFAULT (CURRENT_DATE + INTERVAL '1 year')::date,
  CONSTRAINT settings_dates_valid CHECK ("to" >= "from")
);
