CREATE TABLE IF NOT EXISTS transactions (
  name TEXT NOT NULL CONSTRAINT transactions_name_valid
    CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  at DATE NOT NULL,
  amount NUMERIC NOT NULL CONSTRAINT transactions_amount_valid
    CHECK (amount <> 'NaN'::numeric AND amount <> 'Infinity'::numeric AND amount <> '-Infinity'::numeric),
  every INTERVAL CONSTRAINT transactions_every_valid CHECK (
    every IS NULL OR (
      every >= INTERVAL '1 day'
      AND mod(extract(epoch FROM every)::numeric, 86400) = 0
    )
  ),
  ends_after DATE CONSTRAINT transactions_ends_after_valid CHECK (
    ends_after IS NULL OR (every IS NOT NULL AND ends_after >= at)
  ),
  tags TEXT NOT NULL DEFAULT '[]' CONSTRAINT transactions_tags_valid CHECK (valid_tags(tags)),
  notes TEXT CONSTRAINT transactions_notes_valid CHECK (notes IS NULL OR length(notes) <= 2000),
  PRIMARY KEY (name, at)
);
