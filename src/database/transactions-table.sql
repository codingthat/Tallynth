CREATE TABLE IF NOT EXISTS transactions (
  name TEXT NOT NULL,
  at DATE NOT NULL,
  amount money NOT NULL,
  every INTERVAL CONSTRAINT transactions_every_valid CHECK (
    every IS NULL OR (
      every >= INTERVAL '1 day'
      AND mod(extract(epoch FROM every), 86400) IN (0, 21600)
    )
  ),
  ends_after DATE,
  tags TEXT,
  notes TEXT,
  PRIMARY KEY (name, at)
);
