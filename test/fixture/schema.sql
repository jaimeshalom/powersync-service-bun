-- A small multi-tenant to-do schema with a deterministic seed: ids are md5-derived uuids and
-- timestamps are fixed, so every run and every runtime must serve byte-identical buckets.
-- It carries the value shapes that differ between JS runtimes: non-ASCII text, big integers
-- inside jsonb, numerics, booleans, nulls, arrays, bytea and timestamps.
CREATE TABLE account (id uuid PRIMARY KEY, name text NOT NULL, email text NOT NULL, created_at timestamptz NOT NULL);
CREATE TABLE org (id uuid PRIMARY KEY, name text NOT NULL, created_at timestamptz NOT NULL);
CREATE TABLE member (id uuid PRIMARY KEY, org_id uuid NOT NULL REFERENCES org, user_id uuid NOT NULL REFERENCES account, role text NOT NULL);
CREATE TABLE list (id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES account, name text NOT NULL, is_shared boolean NOT NULL, org_id uuid REFERENCES org,
  created_at timestamptz NOT NULL);
CREATE TABLE todo (id uuid PRIMARY KEY, user_id uuid NOT NULL, list_id uuid NOT NULL REFERENCES list, text text NOT NULL, completed boolean NOT NULL,
  note text, position integer NOT NULL, price numeric(12,4), big bigint, meta jsonb, tags text[], blob bytea, is_shared boolean NOT NULL,
  created_at timestamptz NOT NULL, due date);
CREATE INDEX ON todo (user_id); CREATE INDEX ON todo (list_id);

CREATE FUNCTION pg_temp.u(t text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT md5(t)::uuid $$;
INSERT INTO account SELECT pg_temp.u('user'||i), 'User '||i, 'u'||i||'@example.test', '2026-01-01Z' FROM generate_series(1,50) i;
INSERT INTO org SELECT pg_temp.u('org'||o), 'Org '||o, '2026-01-01Z' FROM generate_series(1,5) o;
INSERT INTO member SELECT pg_temp.u('mem'||i), pg_temp.u('org'||(i%5+1)), pg_temp.u('user'||i), 'member' FROM generate_series(1,50) i;
INSERT INTO list SELECT pg_temp.u('list'||i||'-'||l), pg_temp.u('user'||i), 'List '||i||'-'||l, l=3, CASE WHEN l=3 THEN pg_temp.u('org'||(i%5+1)) END, '2026-01-01Z'
  FROM generate_series(1,50) i, generate_series(1,3) l;
INSERT INTO todo SELECT pg_temp.u('todo'||i||'-'||l||'-'||t), pg_temp.u('user'||i), pg_temp.u('list'||i||'-'||l), 'Todo ñ 日本 '||t||' ✓ 🚀', t%3=0,
    CASE WHEN t%4=0 THEN NULL ELSE repeat('note ',t) END, t, (t*1234.5678)::numeric(12,4), 9007199254740993 + t,
    jsonb_build_object('n', t, 'big', 9007199254740993, 'nested', jsonb_build_object('a', ARRAY[1,2,3], 'f', 0.1)),
    ARRAY['a','ñ', t::text], decode(md5(t::text), 'hex'), l=3, '2026-01-01Z', DATE '2026-02-01' + t
  FROM generate_series(1,50) i, generate_series(1,3) l, generate_series(1,20) t;
CREATE PUBLICATION powersync FOR ALL TABLES;
