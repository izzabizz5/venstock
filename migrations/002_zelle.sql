-- Run ONCE to allow 'zelle' as a payment method (SQLite can't alter a CHECK, so the table is rebuilt):
--   npx wrangler d1 execute show-pos-db --remote --file=migrations/002_zelle.sql
CREATE TABLE sales_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id TEXT NOT NULL UNIQUE,
  show_id INTEGER,
  payment_method TEXT NOT NULL CHECK (payment_method IN ('cash','venmo','zelle')),
  total_cents INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  voided INTEGER NOT NULL DEFAULT 0,
  register TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  subtotal_cents INTEGER NOT NULL DEFAULT 0,
  discount_cents INTEGER NOT NULL DEFAULT 0,
  discount_label TEXT NOT NULL DEFAULT ''
);
INSERT INTO sales_new (id, client_id, show_id, payment_method, total_cents, created_at, voided,
                       register, notes, subtotal_cents, discount_cents, discount_label)
  SELECT id, client_id, show_id, payment_method, total_cents, created_at, voided,
         register, notes, subtotal_cents, discount_cents, discount_label FROM sales;
DROP TABLE sales;
ALTER TABLE sales_new RENAME TO sales;
CREATE INDEX IF NOT EXISTS idx_sales_show ON sales(show_id);
