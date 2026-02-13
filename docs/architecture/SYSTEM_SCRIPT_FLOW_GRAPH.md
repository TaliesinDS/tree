# System Script Flow Graph (full app complexity map)

This is a personal architecture map showing how scripts connect and how data moves across the whole system.

## 1) Full system graph (scripts + data flow)

```mermaid
flowchart LR
  %% =========================
  %% External actors/systems
  %% =========================
  U[Browser User]
  G[Gramps Desktop Export\n.gpkg /.gramps]

  %% =========================
  %% Frontend shell
  %% =========================
  subgraph FE[Frontend - api static relchart]
    IDX[index.html]
    APP[js/app.js]
    APIJS[js/api.js]
    STATE[js/state.js]

    subgraph FEA[Feature modules]
      AUTHF[js/features/auth.js]
      GRAPHF[js/features/graph.js]
      PEOPLEF[js/features/people.js]
      FAMF[js/features/families.js]
      EVENTSF[js/features/events.js]
      EVSEL[js/features/eventSelection.js]
      EVDP[js/features/eventDetailPanel.js]
      PLACEF[js/features/places.js]
      MAPF[js/features/map.js]
      TABSF[js/features/tabs.js]
      KEYF[js/features/keybinds.js]
      DPF[js/features/detailPanel.js]
      OPTF[js/features/options.js]
      IMPF[js/features/import.js]
      GUESTF[js/features/guests.js]
      NOTESF[js/features/userNotes.js]
      MBROWF[js/features/mediaBrowser.js]
      MOVLF[js/features/mediaOverlay.js]
      PORTALF[js/features/portal.js]
    end

    subgraph CH[Chart pipeline]
      DOT[js/chart/dot.js]
      GV[js/chart/graphviz.js]
      RENDER[js/chart/render.js]
      PZ[js/chart/panzoom.js]
      PAYLOAD[js/chart/payload.js]
      LINEAGE[js/chart/lineage.js]
      CULL[js/chart/culling.js]
    end

    subgraph UTIL[Frontend utils]
      UDATE[js/util/date.js]
      UEV[js/util/event_format.js]
      UDOM[js/util/dom.js]
      UCLIP[js/util/clipboard.js]
    end
  end

  %% FE wiring
  U --> IDX --> APP
  APP --> APIJS
  APP --> STATE
  APP --> AUTHF
  APP --> GRAPHF
  APP --> PEOPLEF
  APP --> FAMF
  APP --> EVENTSF
  APP --> EVDP
  APP --> PLACEF
  APP --> MAPF
  APP --> TABSF
  APP --> KEYF
  APP --> DPF
  APP --> OPTF
  APP --> IMPF
  APP --> GUESTF
  APP --> MBROWF

  GRAPHF --> DOT --> GV --> RENDER --> PZ
  GRAPHF --> PAYLOAD
  GRAPHF --> LINEAGE
  GRAPHF --> CULL

  PEOPLEF --> APIJS
  FAMF --> APIJS
  EVENTSF --> APIJS
  PLACEF --> APIJS
  MAPF --> APIJS
  DPF --> APIJS
  AUTHF --> APIJS
  GUESTF --> APIJS
  NOTESF --> APIJS
  MBROWF --> APIJS
  MOVLF --> APIJS
  IMPF --> APIJS

  DPF --> NOTESF
  DPF --> MOVLF
  MBROWF --> MOVLF
  EVENTSF --> EVSEL --> EVDP

  DPF --> UDATE
  FAMF --> UDATE
  PLACEF --> UCLIP
  PEOPLEF --> UDOM
  FAMF --> UDOM
  PLACEF --> UDOM
  EVENTSF --> UEV

  MAPF --> PORTALF
  OPTF --> PORTALF

  %% =========================
  %% FastAPI app
  %% =========================
  subgraph API[Backend - api]
    MAIN[main.py]
    MID[middleware.py]
    AUTHM[auth.py]
    DB[db.py]

    subgraph CORE[Core query/transform modules]
      QRY[queries.py]
      RSV[resolve.py]
      SER[serialize.py]
      GPH[graph.py]
      PRV[privacy.py]
      NMS[names.py]
      UTL[util.py]
    end

    subgraph ROUTES[api routes]
      RHEALTH[health.py]
      RDEMO[demo.py]
      RAUTH[auth.py]
      RGRAPH[graph.py]
      RPEOPLE[people.py]
      RFAM[families.py]
      REVT[events.py]
      RPL[places.py]
      RREL[relationship.py]
      RIMP[import_tree.py]
      RMEDIA[media.py]
      RNOTES[user_notes.py]
      RMEM[instance_members.py]
    end

    ADMINCLI[admin.py]
    IMS[import_service.py]
  end

  %% API app wiring
  APIJS -->|HTTP JSON + cookies| MAIN
  MAIN --> MID
  MID --> AUTHM

  MAIN --> RHEALTH
  MAIN --> RDEMO
  MAIN --> RAUTH
  MAIN --> RGRAPH
  MAIN --> RPEOPLE
  MAIN --> RFAM
  MAIN --> REVT
  MAIN --> RPL
  MAIN --> RREL
  MAIN --> RIMP
  MAIN --> RMEDIA
  MAIN --> RNOTES
  MAIN --> RMEM

  RAUTH --> AUTHM
  RAUTH --> DB
  RMEM --> AUTHM
  RNOTES --> AUTHM
  RIMP --> AUTHM

  RGRAPH --> DB
  RGRAPH --> QRY
  RGRAPH --> RSV
  RGRAPH --> SER
  RGRAPH --> GPH
  RGRAPH --> PRV

  RPEOPLE --> DB
  RPEOPLE --> QRY
  RPEOPLE --> RSV
  RPEOPLE --> NMS
  RPEOPLE --> PRV
  RPEOPLE --> UTL
  RPEOPLE --> RMEDIA

  RFAM --> DB
  RFAM --> QRY
  RFAM --> SER

  REVT --> DB
  REVT --> NMS
  REVT --> PRV
  REVT --> UTL

  RPL --> DB
  RPL --> UTL

  RREL --> DB
  RREL --> GPH
  RREL --> RSV
  RREL --> NMS
  RREL --> PRV

  RMEDIA --> DB
  RMEDIA --> PRV

  RNOTES --> DB
  RMEM --> DB

  RIMP --> IMS
  IMS --> EXPPKG
  IMS --> LOADPG

  %% =========================
  %% Export/import scripts
  %% =========================
  subgraph EXP[Export and loader scripts]
    EXPPKG[export_gramps_package.py]
    LOADPG[load_export_to_postgres.py]
    EXPSQL[export_gramps_sqlite.py]
    INSPSQL[inspect_gramps_sqlite.py]
    MIGEV[migrate_event_gramps_id.py]
  end

  G --> EXPPKG
  EXPPKG -->|JSONL files| LOADPG

  %% =========================
  %% Storage
  %% =========================
  subgraph DATA[Data + files]
    SQL1[sql/schema.sql]
    SQL2[sql/schema_core.sql]
    PG[(PostgreSQL)]
    COREDB[_core schema]
    INSTDB[inst slug schemas]
    MEDIAFS[api media instance - original and thumb]
  end

  LOADPG --> SQL1
  ADMINCLI --> SQL2
  DB --> PG
  LOADPG --> PG
  RAUTH --> COREDB
  RMEM --> COREDB
  ADMINCLI --> COREDB
  RGRAPH --> INSTDB
  RPEOPLE --> INSTDB
  RFAM --> INSTDB
  REVT --> INSTDB
  RPL --> INSTDB
  RREL --> INSTDB
  RMEDIA --> INSTDB
  RNOTES --> INSTDB

  RMEDIA --> MEDIAFS
  IMS --> MEDIAFS

  %% =========================
  %% Tests / quality feedback loop
  %% =========================
  subgraph TST[tests]
    TA[tests/test_auth.py]
    TG[tests/test_graph.py]
    TGN[tests/test_graph_neighborhood_payload.py]
    TN[tests/test_names.py]
    TP[tests/test_privacy.py]
    TCF[tests/conftest.py]
  end

  TA --> RAUTH
  TG --> RGRAPH
  TGN --> RGRAPH
  TN --> NMS
  TP --> PRV
  TCF --> MAIN
```

## 2) Focused data-movement view (app-to-app flow)

```mermaid
flowchart TD
  A[Gramps Desktop] -->|Export .gpkg/.gramps| B[Browser Import UI\njs/features/import.js]
  B -->|POST /import| C[api/routes/import_tree.py]
  C --> D[api/import_service.py]
  D --> E[export/export_gramps_package.py\nXML -> JSONL]
  D --> F[export/load_export_to_postgres.py\nJSONL -> SQL]
  D --> G[api media instance files and thumbs]
  F --> H[(PostgreSQL inst slug)]

  I[Browser Relchart UI\njs/app.js + features/*] -->|GET /graph,/people,/families,/events,/places,/media| J[FastAPI routes/*]
  J --> K[api/db.py + queries/resolve/serialize/privacy modules]
  K --> H
  J --> G

  L[Admin CLI\napi/admin.py] -->|create-admin/create-instance/create-user| M[_core schema]
  L -->|create-instance applies schema.sql| H

  N[Auth middleware\napi/middleware.py + api/auth.py] --> J
  J -->|JWT + CSRF cookies| I
```

## 3) How to use this map

- Read left to right for runtime call flow.
- Frontend graph rendering is a two-phase pipeline: DOT generation, then SVG post-processing.
- Import path is intentionally separate from normal read APIs.
- Multi-instance isolation happens at `db_conn(instance_slug)` via schema-based `search_path`.
- Media has dual persistence: DB metadata in Postgres + binaries on filesystem.
