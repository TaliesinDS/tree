# Documentation Index

This folder contains all project documentation for **Tree** (Gramps → web viewer).

Quick links:
- **Resume work?** → Read [HANDOFF.md](../HANDOFF.md) at the repo root
- **New to the project?** → Start with [README.md](../README.md) at the repo root

---

## Folder Structure

```
docs/
├── README.md              ← You are here (documentation map)
│
├── architecture/          # How the system works
│   ├── RELCHART.md        # Relationship chart frontend architecture (v3)
│   └── PRIVACY.md         # Privacy model and server-side redaction rules
│
├── specs/                 # What we're building (features & requirements)
│   ├── FEATURES.md        # Feature roadmap and planned capabilities
│   ├── GRAPH_VIEWER.md    # Graph viewer tech spec (feature → requirement matrix)
│   └── MAP.md             # Map view proposal and implementation plan
│
├── guides/                # How to do things
│   ├── DEV.md             # Local development setup (Docker, Postgres, API)
│   └── DEPLOYMENT.md      # Cloud deployment sketch (Cloud Run + Cloud SQL)
│
├── design/                # UI/UX design assets and planning
│   └── ART_ASSETS.md      # Art assets checklist (icons, markers, badges)
│
└── debug/                 # Historical investigations and bug logs
    ├── DATA_QUALITY.md    # Data quality reports (for fixing in Gramps)
    ├── F1592_COUPLE_SPACING_BUGLOG.md   # Single-parent constraint bug (resolved)
    └── FID_MISALIGNMENT_BUGLOG.md       # Hub alignment issues (v1-v2 era)
```

---

## Document Purposes

### `/architecture/` — How the system works

| Document | Purpose | Update when... |
|----------|---------|----------------|
| [RELCHART.md](architecture/RELCHART.md) | Frontend architecture for the relationship chart (v3) | Changing viewer structure, adding modules |
| [PRIVACY.md](architecture/PRIVACY.md) | Privacy model, redaction rules, constants | Changing privacy policy or cutoff dates |

### `/specs/` — What we're building

| Document | Purpose | Update when... |
|----------|---------|----------------|
| [FEATURES.md](specs/FEATURES.md) | Feature roadmap, planned capabilities, UI ideas | Planning new features, completing features |
| [GRAPH_VIEWER.md](specs/GRAPH_VIEWER.md) | Tech spec: feature → tech requirements | Deciding on tech approach for a feature |
| [MAP.md](specs/MAP.md) | Map view proposal (basemaps, pins, routes, offline) | Working on map features |

### `/guides/` — How to do things

| Document | Purpose | Update when... |
|----------|---------|----------------|
| [DEV.md](guides/DEV.md) | Local dev setup: Docker, Postgres, API commands | Changing dev setup, adding dependencies |
| [DEPLOYMENT.md](guides/DEPLOYMENT.md) | Cloud deployment sketch | Deploying or changing infra |

### `/design/` — UI/UX design planning

| Document | Purpose | Update when... |
|----------|---------|----------------|
| [ART_ASSETS.md](design/ART_ASSETS.md) | Art assets checklist (icons, markers, badges) | Planning UI visuals, commissioning art |

### `/debug/` — Historical investigations

| Document | Purpose | Update when... |
|----------|---------|----------------|
| [DATA_QUALITY.md](debug/DATA_QUALITY.md) | Debug reports spec (export fix-lists for Gramps) | Implementing quality reports |
| [F1592_COUPLE_SPACING_BUGLOG.md](debug/F1592_COUPLE_SPACING_BUGLOG.md) | Bug investigation: single-parent constraint interference | Reference only (resolved) |
| [FID_MISALIGNMENT_BUGLOG.md](debug/FID_MISALIGNMENT_BUGLOG.md) | Bug investigation: hub alignment (v1-v2) | Reference only (legacy) |

---

## Conventions

### Naming
- `ALLCAPS.md` for primary documents
- Descriptive names over short names (readability > brevity)

### Content style
- Start with a one-line purpose statement
- Include "when to update" guidance where helpful
- Capture **why**, not just **what**
- Mark sections as `(current)`, `(planned)`, `(legacy)` when status matters

### Single source of truth
If you need to update a fact, it should only need to change in **one file**:
- Privacy constants → `PRIVACY.md`
- File paths → `RELCHART.md` (frontend) or `DEV.md` (setup)
- Feature status → `FEATURES.md`

---

## Files at Repo Root

These stay at the root for visibility:

| File | Purpose |
|------|---------|
| `README.md` | Project overview, goals, quick start |
| `HANDOFF.md` | "Resume here" pointer for continuing work |
| `.github/copilot-instructions.md` | AI assistant context (self-contained) |
