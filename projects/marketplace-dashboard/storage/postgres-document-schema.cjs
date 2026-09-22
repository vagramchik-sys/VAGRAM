'use strict';

module.exports = String.raw`BEGIN;
CREATE TABLE IF NOT EXISTS pult.source_files (
 source_path text COLLATE "C" PRIMARY KEY,
 logical_key text COLLATE "C" NOT NULL UNIQUE REFERENCES pult.document_states(logical_key),
 domain text NOT NULL, media_type text NOT NULL,
 source_bytes bigint NOT NULL CHECK(source_bytes>=0),
 source_sha256 bytea NOT NULL CHECK(octet_length(source_sha256)=32),
 baseline_present boolean NOT NULL DEFAULT true,
 imported_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE pult.source_files ADD COLUMN IF NOT EXISTS baseline_present boolean NOT NULL DEFAULT true;
COMMENT ON TABLE pult.source_files IS
 'Verified file checkpoint provenance and atomic runtime path identity. baseline_present=false marks a document created after the checkpoint. Market facts are normalized separately.';
COMMIT;`;
