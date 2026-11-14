CREATE TABLE IF NOT EXISTS app_settings (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  "from" DATE NOT NULL,
  amount NUMERIC NOT NULL CONSTRAINT settings_amount_valid
    CHECK (amount <> 'NaN'::numeric AND amount <> 'Infinity'::numeric AND amount <> '-Infinity'::numeric),
  "to" DATE NOT NULL,
  CONSTRAINT settings_dates_valid CHECK ("to" >= "from")
);
