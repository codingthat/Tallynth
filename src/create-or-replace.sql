CREATE TABLE IF NOT EXISTS app_settings (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  value JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS transactions (
    name text NOT NULL,
    at date NOT NULL,
    amount money NOT NULL,
    every interval CHECK (
        every >= '1 day'::interval
        AND NOT extract(epoch from every) / extract(epoch from '1 day'::interval) % 1 > 0
    ), -- no fractional days
    ends_after date,
    tags text,
    notes text,
    PRIMARY KEY (name, at)
);
COMMENT ON TABLE transactions IS 'Income is positive, expenses are negative.';

DROP FUNCTION forecast(date, money, date);
CREATE FUNCTION forecast(after date = current_date, amount money = 0, through date = current_date + '1 year'::interval) RETURNS TABLE (at date, sum money, name text, amount money)
LANGUAGE sql STABLE
AS $$
WITH
events AS (
    SELECT t.at, t.name, t.amount
    FROM transactions t
    WHERE t.every IS NULL
  UNION ALL
    SELECT r.at, t.name, t.amount
    FROM transactions t
    CROSS JOIN LATERAL (
        SELECT (t.at + g.n * t.every)::date AS at
        FROM generate_series(0, through - t.at) AS g(n)
    ) AS r
    WHERE t.every IS NOT NULL
      AND (t.ends_after IS NULL OR r.at <= t.ends_after)
),
balances AS (
    SELECT at, amount, name
    FROM events
    WHERE at > after AND at <= through
  UNION ALL
    SELECT after, amount, 'Start'
)
SELECT
    at,
    sum(amount) OVER (ORDER BY at, amount, name),
    name,
    amount
FROM balances
ORDER BY at, amount, name;
$$;