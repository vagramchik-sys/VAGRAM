'use strict';

module.exports = String.raw`BEGIN;
CREATE SCHEMA IF NOT EXISTS pult;
CREATE TABLE IF NOT EXISTS pult.schema_versions (
 version_number integer PRIMARY KEY, description text NOT NULL,
 applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS pult.document_states (
 logical_key text COLLATE "C" PRIMARY KEY, media_type text NOT NULL, content bytea, sha256 bytea,
 revision bigint NOT NULL CHECK (revision > 0), deleted boolean NOT NULL,
 modified_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT document_states_sha256_length CHECK (sha256 IS NULL OR octet_length(sha256)=32),
 CONSTRAINT document_states_content_shape CHECK (
  (NOT deleted AND content IS NOT NULL AND sha256 IS NOT NULL) OR
  (deleted AND content IS NULL AND sha256 IS NULL)
 )
);
CREATE TABLE IF NOT EXISTS pult.commands (
 sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, command_id uuid NOT NULL UNIQUE,
 operation text NOT NULL CHECK (operation IN ('write','delete')), logical_key text COLLATE "C" NOT NULL,
 request_hash bytea NOT NULL CHECK (octet_length(request_hash)=32),
 before_revision bigint NOT NULL CHECK (before_revision >= 0), after_revision bigint NOT NULL,
 media_type text NOT NULL, before_media_type text, before_content bytea,
 before_sha256 bytea CHECK (before_sha256 IS NULL OR octet_length(before_sha256)=32),
 before_deleted boolean, after_content bytea,
 after_sha256 bytea CHECK (after_sha256 IS NULL OR octet_length(after_sha256)=32),
 after_deleted boolean NOT NULL, committed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT commands_revision_step CHECK (after_revision=before_revision+1),
 CONSTRAINT commands_after_shape CHECK (
  (NOT after_deleted AND after_content IS NOT NULL AND after_sha256 IS NOT NULL) OR
  (after_deleted AND after_content IS NULL AND after_sha256 IS NULL)
 )
);
ALTER TABLE pult.commands ADD COLUMN IF NOT EXISTS before_media_type text;
CREATE INDEX IF NOT EXISTS commands_logical_key_revision_idx ON pult.commands(logical_key,after_revision);
INSERT INTO pult.schema_versions(version_number,description)
VALUES(1,'Authoritative document state and durable command journal')
ON CONFLICT(version_number) DO NOTHING;
INSERT INTO pult.schema_versions(version_number,description)
VALUES(2,'Durable before media type for exact command replay')
ON CONFLICT(version_number) DO NOTHING;
COMMIT;`;
