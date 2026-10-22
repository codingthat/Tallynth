// One financial implementation: PostgreSQL, used by PGlite in browser and tests.
export const forecastSql = `
WITH
bounds AS (SELECT $2::date::timestamptz AS lo, ($3::date+1)::timestamptz AS hi),
snapshots AS (
 SELECT id, at::timestamptz AS at, replace(amount,'.','')::numeric AS units, notes
 FROM jsonb_to_recordset($1::jsonb->'snapshots') AS s(id text,at text,amount text,notes text)
),
anchor AS (SELECT * FROM snapshots,bounds WHERE at<=lo ORDER BY at DESC LIMIT 1),
transactions AS (
 SELECT id, at::timestamptz AS at, name, replace(COALESCE(actual,amount),'.','')::numeric AS units,
 recurrence, NULLIF(until,'')::date AS until
 FROM jsonb_to_recordset($1::jsonb->'transactions') AS t(id text,at text,name text,amount text,recurrence text,until text,actual text)
),
candidates AS (
 SELECT t.id,t.name,t.units,t.at AS at FROM transactions t WHERE recurrence='once'
 UNION ALL
 SELECT t.id,t.name,t.units,
  (bi::date + (least(extract(day FROM t.at)::int,extract(day FROM (bi+interval '2 weeks'))::int)-1))::timestamptz
    + (t.at::time - time '00:00') AS at
 FROM transactions t CROSS JOIN anchor a CROSS JOIN bounds b
 CROSS JOIN LATERAL generate_series(date_trunc('month',greatest(t.at,a.at)),date_trunc('month',least(b.hi,COALESCE(t.until::timestamptz,b.hi))),interval '1 month') bi
 WHERE t.recurrence='biweekly' AND (t.until IS NULL OR t.until>=greatest(t.at,a.at)::date)
 UNION ALL
 SELECT t.id,t.name,t.units,
  (m::date + (least(extract(day FROM t.at)::int,extract(day FROM (m+interval '1 month - 1 day'))::int)-1))::timestamptz
    + (t.at::time - time '00:00') AS at
 FROM transactions t CROSS JOIN anchor a CROSS JOIN bounds b
 CROSS JOIN LATERAL generate_series(date_trunc('month',greatest(t.at,a.at)),date_trunc('month',least(b.hi,COALESCE(t.until::timestamptz,b.hi))),interval '1 month') m
 WHERE t.recurrence='monthly' AND (t.until IS NULL OR t.until>=greatest(t.at,a.at)::date)
 UNION ALL
 SELECT t.id,t.name,t.units,
   (make_date(extract(year FROM y)::int,extract(month FROM t.at)::int,1)
     + (least(extract(day FROM t.at)::int,extract(day FROM(make_date(extract(year FROM y)::int,extract(month FROM t.at)::int,1)+interval '1 month - 1 day'))::int)-1))::timestamptz
     + (t.at::time-time '00:00') AS at
 FROM transactions t CROSS JOIN anchor a CROSS JOIN bounds b
 CROSS JOIN LATERAL generate_series(date_trunc('year',greatest(t.at,a.at)),date_trunc('year',least(b.hi,COALESCE(t.until::timestamptz,b.hi))),interval '1 year') y
 WHERE t.recurrence='yearly' AND (t.until IS NULL OR t.until>=greatest(t.at,a.at)::date)
),
flows AS (
 SELECT c.* FROM candidates c JOIN transactions t USING(id) CROSS JOIN bounds b
 WHERE c.at>=t.at AND c.at<b.hi AND (t.until IS NULL OR c.at::date<=t.until)
),
events AS (
 SELECT f.at,f.units AS delta,NULL::numeric AS reset,f.name AS label,f.id AS key,false AS snapshot
 FROM flows f,anchor a WHERE f.at>=a.at
 UNION ALL
 SELECT s.at,0::numeric,s.units,'Actual balance'||CASE WHEN s.notes='' THEN '' ELSE ': '||s.notes END,s.id,true
 FROM snapshots s,anchor a,bounds b WHERE s.at>=a.at AND s.at<b.hi
 UNION ALL SELECT lo,0::numeric,NULL::numeric,NULL::text,''::text,false FROM bounds
),
ticks AS (
 SELECT at,sum(delta) AS delta,max(reset) AS reset,bool_or(snapshot) AS snapshot,
 CASE WHEN bool_or(snapshot) THEN max(label) FILTER(WHERE snapshot)
 ELSE COALESCE(string_agg(label,' · ' ORDER BY key),'Horizon opening') END AS label
 FROM events GROUP BY at
),
epochs AS (
 SELECT *,count(reset) OVER(ORDER BY at) AS epoch FROM ticks
),
balances AS (
 SELECT *,max(reset) OVER(PARTITION BY epoch)
   +sum(CASE WHEN reset IS NOT NULL THEN 0 ELSE delta END) OVER(PARTITION BY epoch ORDER BY at) AS units
 FROM epochs
)
SELECT to_char(t.at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at,
 t.units::text AS units,t.label,t.snapshot
FROM balances t,bounds b WHERE t.at>=b.lo AND t.at<b.hi
ORDER BY t.at
`;
