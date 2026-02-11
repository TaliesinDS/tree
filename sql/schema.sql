-- Starter schema sketch for a Gramps-derived genealogy DB.
-- Intentionally minimal; expect iteration.

CREATE EXTENSION IF NOT EXISTS postgis;

-- People
CREATE TABLE IF NOT EXISTS person (
  id TEXT PRIMARY KEY,
  gramps_id TEXT NULL,
  display_name TEXT NULL,
  given_name TEXT NULL,
  surname TEXT NULL,
  gender TEXT NULL,
  birth_text TEXT NULL,
  death_text TEXT NULL,
  birth_date DATE NULL,
  death_date DATE NULL,
  is_living BOOLEAN NULL,
  is_private BOOLEAN NOT NULL DEFAULT FALSE,
  is_living_override BOOLEAN NULL
);

-- Migrations for existing DBs
ALTER TABLE person ADD COLUMN IF NOT EXISTS gramps_id TEXT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_person_gramps_id ON person(gramps_id);
CREATE INDEX IF NOT EXISTS idx_person_display_name ON person(display_name);
CREATE INDEX IF NOT EXISTS idx_person_surname ON person(surname);

-- Parent edges (child -> parent). This is the key for relationship path queries.
CREATE TABLE IF NOT EXISTS person_parent (
  child_id TEXT NOT NULL REFERENCES person(id) ON DELETE CASCADE,
  parent_id TEXT NOT NULL REFERENCES person(id) ON DELETE CASCADE,
  relationship_type TEXT NULL,
  PRIMARY KEY (child_id, parent_id)
);

-- Places
CREATE TABLE IF NOT EXISTS place (
  id TEXT PRIMARY KEY,
  gramps_id TEXT NULL,
  name TEXT NULL,
  place_type TEXT NULL,
  enclosed_by_id TEXT NULL REFERENCES place(id),
  lat DOUBLE PRECISION NULL,
  lon DOUBLE PRECISION NULL,
  geom GEOGRAPHY(Point, 4326) NULL,
  is_private BOOLEAN NOT NULL DEFAULT FALSE
);

-- Migrations for existing DBs
ALTER TABLE place ADD COLUMN IF NOT EXISTS gramps_id TEXT NULL;
ALTER TABLE place ADD COLUMN IF NOT EXISTS place_type TEXT NULL;
ALTER TABLE place ADD COLUMN IF NOT EXISTS enclosed_by_id TEXT NULL;

CREATE INDEX IF NOT EXISTS idx_place_geom ON place USING GIST (geom);
CREATE UNIQUE INDEX IF NOT EXISTS idx_place_gramps_id ON place(gramps_id);
CREATE INDEX IF NOT EXISTS idx_place_enclosed_by ON place(enclosed_by_id);

-- Events (birth, death, marriage, occupation, etc.)
CREATE TABLE IF NOT EXISTS event (
  id TEXT PRIMARY KEY,
  gramps_id TEXT NULL,
  event_type TEXT NULL,
  description TEXT NULL,
  event_date_text TEXT NULL,
  event_date DATE NULL,
  place_id TEXT NULL REFERENCES place(id),
  is_private BOOLEAN NOT NULL DEFAULT FALSE
);

-- Migrations for existing DBs
ALTER TABLE event ADD COLUMN IF NOT EXISTS gramps_id TEXT NULL;

CREATE INDEX IF NOT EXISTS idx_event_place ON event(place_id);
CREATE INDEX IF NOT EXISTS idx_event_type ON event(event_type);
CREATE UNIQUE INDEX IF NOT EXISTS idx_event_gramps_id ON event(gramps_id);

-- Link events to people
CREATE TABLE IF NOT EXISTS person_event (
  person_id TEXT NOT NULL REFERENCES person(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL REFERENCES event(id) ON DELETE CASCADE,
  role TEXT NULL,
  PRIMARY KEY (person_id, event_id)
);

-- Notes (full-text search target)
CREATE TABLE IF NOT EXISTS note (
  id TEXT PRIMARY KEY,
  body TEXT NULL,
  is_private BOOLEAN NOT NULL DEFAULT FALSE
);

-- Attach notes to entities
CREATE TABLE IF NOT EXISTS person_note (
  person_id TEXT NOT NULL REFERENCES person(id) ON DELETE CASCADE,
  note_id TEXT NOT NULL REFERENCES note(id) ON DELETE CASCADE,
  PRIMARY KEY (person_id, note_id)
);

CREATE TABLE IF NOT EXISTS event_note (
  event_id TEXT NOT NULL REFERENCES event(id) ON DELETE CASCADE,
  note_id TEXT NOT NULL REFERENCES note(id) ON DELETE CASCADE,
  PRIMARY KEY (event_id, note_id)
);

-- Full text search index for notes
ALTER TABLE note ADD COLUMN IF NOT EXISTS body_tsv tsvector;
CREATE INDEX IF NOT EXISTS idx_note_body_tsv ON note USING GIN (body_tsv);

CREATE OR REPLACE FUNCTION note_tsv_trigger() RETURNS trigger AS $$
BEGIN
  NEW.body_tsv := to_tsvector('simple', coalesce(NEW.body, ''));
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_note_tsv ON note;
CREATE TRIGGER trg_note_tsv
BEFORE INSERT OR UPDATE OF body ON note
FOR EACH ROW EXECUTE FUNCTION note_tsv_trigger();

-- Helpful index for path queries (reverse lookup)
CREATE INDEX IF NOT EXISTS idx_person_parent_parent ON person_parent(parent_id);

-- Families (Gramps "family" objects, often F0000 etc.)
CREATE TABLE IF NOT EXISTS family (
  id TEXT PRIMARY KEY,
  gramps_id TEXT NULL,
  father_id TEXT NULL REFERENCES person(id) ON DELETE SET NULL,
  mother_id TEXT NULL REFERENCES person(id) ON DELETE SET NULL,
  is_private BOOLEAN NOT NULL DEFAULT FALSE
);

-- Migrations for existing DBs
ALTER TABLE family ADD COLUMN IF NOT EXISTS gramps_id TEXT NULL;
ALTER TABLE family ADD COLUMN IF NOT EXISTS father_id TEXT NULL;
ALTER TABLE family ADD COLUMN IF NOT EXISTS mother_id TEXT NULL;
ALTER TABLE family ADD COLUMN IF NOT EXISTS is_private BOOLEAN NOT NULL DEFAULT FALSE;

CREATE UNIQUE INDEX IF NOT EXISTS idx_family_gramps_id ON family(gramps_id);
CREATE INDEX IF NOT EXISTS idx_family_father ON family(father_id);
CREATE INDEX IF NOT EXISTS idx_family_mother ON family(mother_id);

CREATE TABLE IF NOT EXISTS family_child (
  family_id TEXT NOT NULL REFERENCES family(id) ON DELETE CASCADE,
  child_id TEXT NOT NULL REFERENCES person(id) ON DELETE CASCADE,
  PRIMARY KEY (family_id, child_id)
);

CREATE INDEX IF NOT EXISTS idx_family_child_child ON family_child(child_id);

-- Link events to families (e.g., marriage).
CREATE TABLE IF NOT EXISTS family_event (
  family_id TEXT NOT NULL REFERENCES family(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL REFERENCES event(id) ON DELETE CASCADE,
  role TEXT NULL,
  PRIMARY KEY (family_id, event_id)
);

CREATE INDEX IF NOT EXISTS idx_family_event_event ON family_event(event_id);

-- Media objects (from Gramps <object> elements)
CREATE TABLE IF NOT EXISTS media (
  id TEXT PRIMARY KEY,                          -- Gramps handle
  gramps_id TEXT NULL,                          -- e.g. O0001
  mime TEXT NULL,                               -- image/jpeg, image/png, etc.
  description TEXT NULL,                        -- Gramps description field
  checksum TEXT NULL,                           -- MD5 from Gramps export
  original_path TEXT NULL,                      -- original src path from Gramps
  file_size INTEGER NULL,                       -- bytes (populated during import)
  width INTEGER NULL,                           -- pixels (populated during import)
  height INTEGER NULL,                          -- pixels (populated during import)
  is_private BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_media_gramps_id ON media(gramps_id);

-- Person ↔ Media link
CREATE TABLE IF NOT EXISTS person_media (
  person_id TEXT NOT NULL REFERENCES person(id) ON DELETE CASCADE,
  media_id TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0,        -- preserves Gramps ordering
  region_x1 SMALLINT NULL,                      -- crop rectangle corner1_x (0-100%)
  region_y1 SMALLINT NULL,                      -- crop rectangle corner1_y (0-100%)
  region_x2 SMALLINT NULL,                      -- crop rectangle corner2_x (0-100%)
  region_y2 SMALLINT NULL,                      -- crop rectangle corner2_y (0-100%)
  is_portrait BOOLEAN NOT NULL DEFAULT FALSE,   -- user-chosen portrait override
  PRIMARY KEY (person_id, media_id)
);

CREATE INDEX IF NOT EXISTS idx_person_media_media ON person_media(media_id);

-- Event ↔ Media link
CREATE TABLE IF NOT EXISTS event_media (
  event_id TEXT NOT NULL REFERENCES event(id) ON DELETE CASCADE,
  media_id TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (event_id, media_id)
);

-- Place ↔ Media link
CREATE TABLE IF NOT EXISTS place_media (
  place_id TEXT NOT NULL REFERENCES place(id) ON DELETE CASCADE,
  media_id TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (place_id, media_id)
);

-- Family ↔ Media link (future, none in current data)
CREATE TABLE IF NOT EXISTS family_media (
  family_id TEXT NOT NULL REFERENCES family(id) ON DELETE CASCADE,
  media_id TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (family_id, media_id)
);
