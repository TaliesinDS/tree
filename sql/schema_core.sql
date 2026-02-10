-- Core schema for multi-user, multi-instance support.
-- Contains users, instances, and memberships.
-- Run once against the genealogy database.

CREATE SCHEMA IF NOT EXISTS _core;

-- ─── Users ───
CREATE TABLE IF NOT EXISTS _core.users (
  id            SERIAL PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  display_name  TEXT,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'guest',  -- 'admin' | 'user' | 'guest'
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── Instances (family trees) ───
CREATE TABLE IF NOT EXISTS _core.instances (
  id            SERIAL PRIMARY KEY,
  slug          TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  created_by    INT REFERENCES _core.users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── Memberships (user ↔ instance, with role override) ───
CREATE TABLE IF NOT EXISTS _core.memberships (
  user_id       INT NOT NULL REFERENCES _core.users(id) ON DELETE CASCADE,
  instance_id   INT NOT NULL REFERENCES _core.instances(id) ON DELETE CASCADE,
  role          TEXT NOT NULL DEFAULT 'guest',  -- 'user' | 'guest' (admin is global)
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, instance_id)
);

-- Non-admin users are locked to exactly one instance.
CREATE UNIQUE INDEX IF NOT EXISTS idx_memberships_one_instance_per_user
  ON _core.memberships (user_id);
