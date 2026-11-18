UPDATE app_settings 
SET "from" = DEFAULT,
    amount = DEFAULT,
    "to" = DEFAULT
RETURNING *;