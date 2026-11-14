INSERT INTO app_settings (singleton, "from", amount, "to")
VALUES (TRUE, CURRENT_DATE, 123.45, (CURRENT_DATE + INTERVAL '1 year')::date)
ON CONFLICT (singleton) DO NOTHING;
