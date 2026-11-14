CREATE OR REPLACE FUNCTION forecast(after_date DATE, start_amount NUMERIC, through_date DATE)
RETURNS TABLE (at DATE, sum NUMERIC, name TEXT, amount NUMERIC)
LANGUAGE SQL STABLE AS $$
WITH events AS (
  SELECT t.at, t.name, t.amount
  FROM transactions t
  WHERE t.every IS NULL
  UNION ALL
  SELECT r.at, t.name, t.amount
  FROM transactions t
  CROSS JOIN LATERAL (
    SELECT (t.at + g.n * t.every)::date AS at
    FROM generate_series(0, through_date - t.at) AS g(n)
  ) r
  WHERE t.every IS NOT NULL
    AND (t.ends_after IS NULL OR r.at <= t.ends_after)
), balances AS (
  SELECT at, amount, name
  FROM events
  WHERE at > after_date AND at <= through_date
  UNION ALL
  SELECT after_date, start_amount, 'Start'
)
SELECT at, sum(amount) OVER (ORDER BY at, amount, name), name, amount
FROM balances
ORDER BY at, amount, name;
$$;
