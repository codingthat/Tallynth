INSERT INTO transactions (name, at, amount, every, ends_after, tags, notes)
SELECT name, at, amount, every, ends_after, COALESCE(tags, '[]'), notes
FROM jsonb_to_recordset($1::jsonb) AS record(
  name TEXT,
  at DATE,
  amount NUMERIC,
  every INTERVAL,
  ends_after DATE,
  tags TEXT,
  notes TEXT
)
ON CONFLICT (name, at) DO UPDATE SET
  amount = EXCLUDED.amount,
  every = EXCLUDED.every,
  ends_after = EXCLUDED.ends_after,
  tags = EXCLUDED.tags,
  notes = EXCLUDED.notes;
