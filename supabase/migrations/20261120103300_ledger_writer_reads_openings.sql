-- 0034 Found by tests/db/inventory.test.mjs: post_opening_stock (owned by ledger_writer) reads
-- stock_openings to answer an idempotent retry, but ledger_writer had INSERT only.
grant select on stock_openings, stock_opening_lines to ledger_writer;
