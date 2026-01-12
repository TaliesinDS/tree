# Feature mapping (what you want → backend capability)

## 1) Relationship / ancestry path between 2 people
DB representation:
- Store parent edges: `person_parent(child_id, parent_id)`.
Implementation:
- Find shortest path with BFS.
- Options:
  - SQL recursive CTE (works well up to moderate graph sizes)
  - Python BFS with batched edge fetch (often simpler to tune)

## 2) Search within notes + sort by event description/content
DB representation:
- Store notes as plain text.
- Use Postgres full-text search (tsvector) + optional trigram for fuzzy.
- Store event description/content in `event.description`.

## 3) Location data + map
DB representation:
- PostGIS point for places.
Frontend:
- Leaflet + OpenStreetMap tiles.

## 4) “Everything Gramps and more”
Reality check:
- Rebuilding the entire Gramps feature surface is a big project.
- A pragmatic approach is:
  1) get core browsing + your killer features working (path/search/map)
  2) add the long tail based on actual usage
