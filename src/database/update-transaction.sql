UPDATE transactions
SET (name, at, amount, every, ends_after, tags, notes) = (
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
)
WHERE name = $2 AND at = $3;
