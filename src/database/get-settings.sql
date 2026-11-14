SELECT to_char("from", 'YYYY-MM-DD') AS "from",
       amount::text AS amount,
       to_char("to", 'YYYY-MM-DD') AS "to"
FROM app_settings
WHERE singleton = TRUE;
