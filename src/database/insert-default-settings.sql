INSERT INTO app_settings (singleton, "from", amount, "to")
VALUES (TRUE, DEFAULT, DEFAULT, DEFAULT)
ON CONFLICT (singleton) DO NOTHING;
