'use strict';

module.exports = String.raw`BEGIN;
CREATE SCHEMA IF NOT EXISTS pult_market;
CREATE TABLE IF NOT EXISTS pult_market.source_documents (
 source_document_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 logical_name text COLLATE "C" NOT NULL, sha256 bytea NOT NULL CHECK(octet_length(sha256)=32),
 exact_bytes bytea NOT NULL, byte_length bigint NOT NULL CHECK(byte_length>=0),
 imported_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(logical_name,sha256)
);
CREATE TABLE IF NOT EXISTS pult_market.stores (
 store_id text COLLATE "C" PRIMARY KEY, market text NOT NULL CHECK(market IN ('Ozon','WB')),
 display_name text, registry_row jsonb,
 registry_source_document_id bigint REFERENCES pult_market.source_documents(source_document_id),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS pult_market.snapshot_versions (
 snapshot_id uuid PRIMARY KEY, store_id text COLLATE "C" NOT NULL REFERENCES pult_market.stores(store_id),
 source_document_id bigint NOT NULL REFERENCES pult_market.source_documents(source_document_id),
 source_sha256 bytea NOT NULL CHECK(octet_length(source_sha256)=32), source_byte_length bigint NOT NULL,
 source_metadata jsonb NOT NULL, expected_counts jsonb NOT NULL, verified_counts jsonb,
 row_digest bytea CHECK(row_digest IS NULL OR octet_length(row_digest)=32), complete boolean NOT NULL DEFAULT false,
 imported_at timestamptz NOT NULL DEFAULT clock_timestamp(), completed_at timestamptz,
 UNIQUE(store_id,source_sha256)
);
CREATE TABLE IF NOT EXISTS pult_market.current_snapshots (
 store_id text COLLATE "C" PRIMARY KEY REFERENCES pult_market.stores(store_id),
 snapshot_id uuid NOT NULL UNIQUE REFERENCES pult_market.snapshot_versions(snapshot_id),
 switched_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS pult_market.products (
 snapshot_id uuid NOT NULL REFERENCES pult_market.snapshot_versions(snapshot_id) ON DELETE CASCADE,
 store_id text COLLATE "C" NOT NULL, source_index integer NOT NULL CHECK(source_index>=0),
 product_id text COLLATE "C", sku text COLLATE "C", offer_id text COLLATE "C",
 row_sha256 bytea NOT NULL CHECK(octet_length(row_sha256)=32), raw_row jsonb NOT NULL,
 PRIMARY KEY(snapshot_id,source_index)
);
CREATE INDEX IF NOT EXISTS products_store_product_idx ON pult_market.products(store_id,product_id);
CREATE INDEX IF NOT EXISTS products_store_sku_idx ON pult_market.products(store_id,sku);
CREATE INDEX IF NOT EXISTS products_store_offer_idx ON pult_market.products(store_id,offer_id);
CREATE TABLE IF NOT EXISTS pult_market.stocks (
 snapshot_id uuid NOT NULL REFERENCES pult_market.snapshot_versions(snapshot_id) ON DELETE CASCADE,
 store_id text COLLATE "C" NOT NULL, source_index integer NOT NULL CHECK(source_index>=0),
 product_id text COLLATE "C", offer_id text COLLATE "C",
 row_sha256 bytea NOT NULL CHECK(octet_length(row_sha256)=32), raw_row jsonb NOT NULL,
 PRIMARY KEY(snapshot_id,source_index)
);
CREATE INDEX IF NOT EXISTS stocks_store_product_idx ON pult_market.stocks(store_id,product_id);
CREATE INDEX IF NOT EXISTS stocks_store_offer_idx ON pult_market.stocks(store_id,offer_id);
CREATE TABLE IF NOT EXISTS pult_market.stock_items (
 snapshot_id uuid NOT NULL REFERENCES pult_market.snapshot_versions(snapshot_id) ON DELETE CASCADE,
 store_id text COLLATE "C" NOT NULL, stock_source_index integer NOT NULL, item_index integer NOT NULL,
 sku text COLLATE "C", warehouse text COLLATE "C", raw_row jsonb NOT NULL,
 PRIMARY KEY(snapshot_id,stock_source_index,item_index)
);
CREATE INDEX IF NOT EXISTS stock_items_store_sku_idx ON pult_market.stock_items(store_id,sku);
CREATE TABLE IF NOT EXISTS pult_market.finance_operations (
 snapshot_id uuid NOT NULL REFERENCES pult_market.snapshot_versions(snapshot_id) ON DELETE CASCADE,
 store_id text COLLATE "C" NOT NULL, source_index integer NOT NULL CHECK(source_index>=0),
 operation_id text COLLATE "C", operation_day date, operation_type text,
 row_sha256 bytea NOT NULL CHECK(octet_length(row_sha256)=32), raw_row jsonb NOT NULL,
 PRIMARY KEY(snapshot_id,source_index)
);
CREATE INDEX IF NOT EXISTS finance_operations_store_day_idx ON pult_market.finance_operations(store_id,operation_day);
CREATE INDEX IF NOT EXISTS finance_operations_store_operation_idx ON pult_market.finance_operations(store_id,operation_id);
COMMENT ON TABLE pult_market.finance_operations IS
 'Staging normalization with indexed identity/date fields and lossless source JSON; accounting measures remain in raw_row until reviewed runtime projections are added.';
CREATE TABLE IF NOT EXISTS pult_market.finance_operation_skus (
 snapshot_id uuid NOT NULL REFERENCES pult_market.snapshot_versions(snapshot_id) ON DELETE CASCADE,
 store_id text COLLATE "C" NOT NULL, operation_source_index integer NOT NULL, item_index integer NOT NULL,
 sku text COLLATE "C" NOT NULL, operation_day date, raw_item jsonb,
 PRIMARY KEY(snapshot_id,operation_source_index,item_index,sku)
);
CREATE INDEX IF NOT EXISTS finance_operation_skus_lookup_idx ON pult_market.finance_operation_skus(store_id,sku,operation_day);
CREATE TABLE IF NOT EXISTS pult_market.stock_rows (
 snapshot_id uuid NOT NULL REFERENCES pult_market.snapshot_versions(snapshot_id) ON DELETE CASCADE,
 store_id text COLLATE "C" NOT NULL, source_index integer NOT NULL CHECK(source_index>=0),
 product_id text COLLATE "C", sku text COLLATE "C", warehouse_id text COLLATE "C",
 row_sha256 bytea NOT NULL CHECK(octet_length(row_sha256)=32), raw_row jsonb NOT NULL,
 PRIMARY KEY(snapshot_id,source_index)
);
CREATE INDEX IF NOT EXISTS stock_rows_store_sku_idx ON pult_market.stock_rows(store_id,sku);
CREATE TABLE IF NOT EXISTS pult_market.category_tree_rows (
 snapshot_id uuid NOT NULL REFERENCES pult_market.snapshot_versions(snapshot_id) ON DELETE CASCADE,
 store_id text COLLATE "C" NOT NULL, source_index integer NOT NULL CHECK(source_index>=0),
 category_id text COLLATE "C", row_sha256 bytea NOT NULL CHECK(octet_length(row_sha256)=32), raw_row jsonb NOT NULL,
 PRIMARY KEY(snapshot_id,source_index)
);
CREATE INDEX IF NOT EXISTS category_tree_store_category_idx ON pult_market.category_tree_rows(store_id,category_id);
COMMIT;`;
