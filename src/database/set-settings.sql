INSERT INTO app_settings (singleton, "from", amount, "to")
VALUES (TRUE, $1::date, $2::numeric, $3::date)
ON CONFLICT (singleton) DO UPDATE
SET "from" = EXCLUDED."from",
    amount = EXCLUDED.amount,
    "to" = EXCLUDED."to"
RETURNING *;
