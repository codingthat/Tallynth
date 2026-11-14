SELECT name,
       to_char(at, 'YYYY-MM-DD') AS at,
       amount::text AS amount,
       every::text AS every,
       to_char(ends_after, 'YYYY-MM-DD') AS ends_after,
       tags::jsonb AS tags,
       notes
FROM transactions;
