'use strict';

// Native live records. No complete source document, snapshot identifier or generation
// belongs here. A transaction replaces explicit partitions and appends row events.
const LIVE_SCHEMA_SQL = String.raw`
CREATE SCHEMA IF NOT EXISTS pult_live;
CREATE TABLE IF NOT EXISTS pult_live.heads (
 store_id text COLLATE "C" NOT NULL,
 domain text COLLATE "C" NOT NULL CHECK(domain IN ('market','insights','costs','prices','funnel','wb-orders','buyers','catalogs','ledger','intraday','category-intraday')),
 revision bigint NOT NULL CHECK(revision>=0),
 metadata jsonb NOT NULL CHECK(jsonb_typeof(metadata)='object' AND octet_length(metadata::text)<=262144),
 source_metadata jsonb NOT NULL CHECK(jsonb_typeof(source_metadata)='object' AND octet_length(source_metadata::text)<=16384),
 entity_counts jsonb NOT NULL CHECK(jsonb_typeof(entity_counts)='object'),
 head_sha256 text NOT NULL CHECK(head_sha256 ~ '^[a-f0-9]{64}$'),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(store_id,domain)
);
CREATE TABLE IF NOT EXISTS pult_live.facts (
 store_id text COLLATE "C" NOT NULL, domain text COLLATE "C" NOT NULL,
 entity_type text COLLATE "C" NOT NULL, entity_key text COLLATE "C" NOT NULL,
 occurrence integer NOT NULL CHECK(occurrence>=0), business_day date,
 source_order bigint NOT NULL CHECK(source_order>=0), value jsonb NOT NULL CHECK(jsonb_typeof(value)='object'),
 row_sha256 text NOT NULL CHECK(row_sha256 ~ '^[a-f0-9]{64}$'),
 revision bigint NOT NULL CHECK(revision>0), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(store_id,domain,entity_type,entity_key,occurrence),
 FOREIGN KEY(store_id,domain) REFERENCES pult_live.heads(store_id,domain)
);
CREATE INDEX IF NOT EXISTS live_facts_day_idx ON pult_live.facts(store_id,domain,entity_type,business_day,source_order);
CREATE INDEX IF NOT EXISTS live_facts_order_idx ON pult_live.facts(store_id,domain,source_order,entity_type,entity_key,occurrence);
-- Per-collection readers filter entity_type and page by source order. Keep the
-- equality columns first so pagination does not sort complete JSONB records.
CREATE INDEX IF NOT EXISTS live_facts_entity_order_idx ON pult_live.facts(store_id,domain,entity_type,source_order,entity_key,occurrence);
-- Transaction-local working rows in an ordinary table: the runtime needs no
-- CREATE TEMP privilege. Publishers delete them before commit; rollback removes
-- every inserted working row automatically. No source document is stored here.
CREATE TABLE IF NOT EXISTS pult_live.incoming_rows (
 store_id text COLLATE "C" NOT NULL, domain text COLLATE "C" NOT NULL,
 command_id text COLLATE "C" NOT NULL, entity_type text COLLATE "C" NOT NULL,
 entity_key text COLLATE "C" NOT NULL, occurrence integer NOT NULL CHECK(occurrence>=0),
 business_day date, source_order bigint NOT NULL CHECK(source_order>=0),
 value jsonb NOT NULL CHECK(jsonb_typeof(value)='object'),
 row_sha256 text NOT NULL CHECK(row_sha256 ~ '^[a-f0-9]{64}$'),
 PRIMARY KEY(store_id,domain,command_id,entity_type,entity_key,occurrence),
 FOREIGN KEY(store_id,domain) REFERENCES pult_live.heads(store_id,domain)
);
CREATE TABLE IF NOT EXISTS pult_live.commands (
 store_id text COLLATE "C" NOT NULL, domain text COLLATE "C" NOT NULL, command_id text COLLATE "C" NOT NULL,
 intent_sha256 text NOT NULL CHECK(intent_sha256 ~ '^[a-f0-9]{64}$'),
 revision bigint NOT NULL CHECK(revision>0), receipt jsonb NOT NULL CHECK(jsonb_typeof(receipt)='object'),
 receipt_sha256 text NOT NULL CHECK(receipt_sha256 ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(store_id,domain,command_id), UNIQUE(store_id,domain,revision),
 FOREIGN KEY(store_id,domain) REFERENCES pult_live.heads(store_id,domain)
);
CREATE TABLE IF NOT EXISTS pult_live.record_journal (
 event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 store_id text COLLATE "C" NOT NULL, domain text COLLATE "C" NOT NULL,
 command_id text COLLATE "C" NOT NULL, revision bigint NOT NULL CHECK(revision>0),
 action text NOT NULL CHECK(action IN ('insert','update','delete')),
 entity_type text COLLATE "C" NOT NULL, entity_key text COLLATE "C" NOT NULL,
 occurrence integer NOT NULL CHECK(occurrence>=0), business_day date,
 source_order bigint NOT NULL CHECK(source_order>=0), value jsonb NOT NULL CHECK(jsonb_typeof(value)='object'),
 row_sha256 text NOT NULL CHECK(row_sha256 ~ '^[a-f0-9]{64}$'),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(store_id,domain,command_id) REFERENCES pult_live.commands(store_id,domain,command_id) DEFERRABLE INITIALLY DEFERRED,
 UNIQUE(store_id,domain,revision,entity_type,entity_key,occurrence)
);
CREATE INDEX IF NOT EXISTS live_record_journal_lookup_idx ON pult_live.record_journal(store_id,domain,entity_type,entity_key,revision,event_id);
CREATE INDEX IF NOT EXISTS live_record_journal_revision_idx ON pult_live.record_journal(store_id,domain,revision,event_id);
CREATE OR REPLACE FUNCTION pult_live.reject_event_mutation() RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='live events are immutable'; END;
$body$;
DO $body$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='pult_live.commands'::regclass AND tgname='live_commands_immutable') THEN
  CREATE TRIGGER live_commands_immutable BEFORE UPDATE OR DELETE ON pult_live.commands FOR EACH ROW EXECUTE FUNCTION pult_live.reject_event_mutation();
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='pult_live.record_journal'::regclass AND tgname='live_journal_immutable') THEN
  CREATE TRIGGER live_journal_immutable BEFORE UPDATE OR DELETE ON pult_live.record_journal FOR EACH ROW EXECUTE FUNCTION pult_live.reject_event_mutation();
 END IF;
END; $body$;
REVOKE ALL ON SCHEMA pult_live FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA pult_live FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA pult_live FROM PUBLIC;
REVOKE ALL ON FUNCTION pult_live.reject_event_mutation() FROM PUBLIC;
`;

async function ensurePostgresLiveSchema(queryable) {
  if (!queryable || typeof queryable.query !== 'function') throw new TypeError('queryable is required');
  await queryable.query(LIVE_SCHEMA_SQL);
}

module.exports = { LIVE_SCHEMA_SQL, ensurePostgresLiveSchema };
