MERGE INTO transactions AS t
USING (
  SELECT name, at, amount, every, ends_after, tags, notes
  FROM jsonb_to_recordset($1::jsonb) AS record(
    name TEXT,
    at DATE,
    amount money,
    every INTERVAL,
    ends_after DATE,
    tags TEXT,
    notes TEXT
  )
) AS s
ON t.name = s.name AND t.at = s.at
WHEN MATCHED THEN
  UPDATE SET
    amount = s.amount,
    every = s.every,
    ends_after = s.ends_after,
    tags = s.tags,
    notes = s.notes
WHEN NOT MATCHED BY TARGET THEN
  INSERT (name, at, amount, every, ends_after, tags, notes)
  VALUES (s.name, s.at, s.amount, s.every, s.ends_after, s.tags, s.notes)
WHEN NOT MATCHED BY SOURCE THEN
  DELETE;