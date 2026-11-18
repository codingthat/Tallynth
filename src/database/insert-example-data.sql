INSERT INTO transactions (name, amount, at, ends_after, every, notes) VALUES
('One-time sales bonus', 1000.00, date_trunc('month', current_date) + '5 weeks'::interval, NULL, NULL, ''),
('Salary', 1100.00, date_trunc('month', current_date), date_trunc('month', current_date) + '1 year'::interval, '2 weeks', 'Biweekly income from one-year contract'),
('Utilities', -200.00, date_trunc('month', current_date), date_trunc('month', current_date), '1 month', 'Utilities for the month, on yearly contract'),
('Food', -300.00, date_trunc('month', current_date), NULL, '1 month', 'Grocery budget'),
('Rent', -1200.00, date_trunc('month', current_date), NULL, '1 month', 'Rent payment'),
('Miscellaneous', -100.00, date_trunc('month', current_date), NULL, '1 month', 'Miscellaneous expense');