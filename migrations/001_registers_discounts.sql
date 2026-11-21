-- Run ONCE on a database created with the original schema.sql:
--   npx wrangler d1 execute show-pos-db --remote --file=migrations/001_registers_discounts.sql
ALTER TABLE items ADD COLUMN category TEXT NOT NULL DEFAULT '';
ALTER TABLE items ADD COLUMN sku TEXT NOT NULL DEFAULT '';
ALTER TABLE sales ADD COLUMN register TEXT NOT NULL DEFAULT '';
ALTER TABLE sales ADD COLUMN notes TEXT NOT NULL DEFAULT '';
ALTER TABLE sales ADD COLUMN subtotal_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sales ADD COLUMN discount_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sales ADD COLUMN discount_label TEXT NOT NULL DEFAULT '';
UPDATE sales SET subtotal_cents = total_cents WHERE subtotal_cents = 0;
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
