'use strict';

module.exports = String.raw`BEGIN;
CREATE TABLE IF NOT EXISTS pult.source_files (
 source_path text COLLATE "C" PRIMARY KEY,
 logical_key text COLLATE "C" NOT NULL UNIQUE REFERENCES pult.document_states(logical_key),
 domain text NOT NULL, media_type text NOT NULL,
 source_bytes bigint NOT NULL CHECK(source_bytes>=0),
 source_sha256 bytea NOT NULL CHECK(octet_length(source_sha256)=32),
 imported_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
COMMENT ON TABLE pult.source_files IS
 'Verified file checkpoint provenance. Initial bytes live in document_states; runtime revisions must not be overwritten by baseline imports. Market facts are normalized separately.';
COMMIT;`;
