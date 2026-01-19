# Misaligned family hub (FID) bug log

This document is a postmortem-style log of everything we tried to fix the **misaligned family hub (the ⚭ “family node” / “FID hub”)** in the Tree viewer, including what each change aimed to do, what it fixed, what it broke, and what we learned.

It is intentionally thorough so we can revert to a stable revision and restart with a clean mental model (and avoid repeating dead ends).

## Summary

- **Primary symptom (rare)**: A family hub is not centered between spouses; it may be “stuck” to the left side of the couple (example: **F1592 with I3128 + I2760**).
- **Secondary symptom (rare)**: For certain couples, the hub only becomes correct **after expanding children**, suggesting the initial DOT constraints are insufficient until more edges are added.
- **Common regressions during attempts**:
  - Graphviz layout hangs on big graphs.
  - Graphviz WASM throws `Error: index out of bounds` (internal panic).
  - Unrelated couples become “touching” (no gap).
  - Edges/lines disappear on larger graphs (likely due to Graphviz output failure, post-processing assumptions, or style overrides).

## Environment

- OS: Windows
- Viewer: Graphviz rendered via `@hpcc-js/wasm-graphviz` (WASM, runs in the browser main thread)
- Graph layout mode: DOT
- Viewer file: api/static/viewer_ported.html

## Reproduction cases

### Case A: F0844 (initially mis-centered, later correct after expand)

- Starting point used during debugging: load neighborhood for `I0063` at depth 5.
- Observed behavior: hub starts wrong (pushed toward one spouse), becomes correct after expanding children.
- Important clue: expanding children adds more edges/constraints to the DOT graph; the layout changes and the hub “snaps” to correct position.

### Case B: F1592 (rare, hub stuck left)

- Family: `F1592` with spouses `I2760` and `I3128`.
- Observed behavior: hub is placed far left (near wife’s left edge) instead of between spouses.
- Noted rarity: user did not quickly find many other examples.

## How the viewer positions hubs (what matters)

There are three interacting layers:

1) **DOT constraints** (buildDotForFamily)
- Couple cohesion is primarily influenced by:
  - Per-family “couple cluster” (cluster_couple_*) with `rank=same`.
  - Invisible edges with high weights intended to force ordering spouse → hub → spouse.
  - Optional non-cluster rank hints (`{ rank=same; ... }`) for edge cases.

2) **Graphviz output (SVG)**
- Graphviz emits `g.node` groups, with hubs typically represented by an `<ellipse>`.
- Some metadata may not survive into SVG reliably (notably CSS `class` on `g.node`).
- Node `title` content can vary: sometimes it is exactly the node id, sometimes it is formatted as `node <id>`.

3) **SVG post-processing** (postProcessGraphvizSvg)
- The viewer shifts hubs down (`familyHubDyById`).
- It also performs a “de-overlap hubs” horizontal pass to prevent multiple hubs from overlapping.
- That de-overlap pass must never move *couple hubs*, or it can break “hub centered between spouses”.

## Timeline of attempted fixes (chronological)

### 1) “Don’t move couple hubs” in SVG de-overlap (initial idea)

Goal:
- The de-overlap algorithm was shifting hubs horizontally. If it mistakenly treats a real couple hub as “movable”, it can push the hub away from the couple center.

Change idea:
- Identify 2-parent couple hubs and exclude them from the de-overlap shift.

What went wrong:
- In practice, identifying “2-parent hubs” purely from SVG `class` was unreliable because Graphviz doesn’t consistently preserve DOT class attributes in SVG.

Outcome:
- Some hubs still got shifted, causing persistent mis-centering.

### 2) Normalize Graphviz SVG titles (node id mapping)

Goal:
- Ensure we can reliably map an SVG hub node to a payload family id.

Observed:
- SVG `<title>` sometimes looked like `node <id>`.

Fix:
- Normalize: `"node <id>" → "<id>"`.

Outcome:
- This improved correctness for metadata lookups keyed by node id.

### 3) Add non-cluster rank hint only for childless couples (F0844)

Goal:
- Fix the “hub becomes correct only after expanding children” case.

Observation:
- When a couple has no in-view children edges, DOT has fewer constraints, and the hub can drift.

Fix:
- Add `{ rank=same; spouse; hub; spouse; }` when the family has **no in-view children edges**.

Outcome:
- This successfully fixed F0844.

Regression risk:
- Adding rank hints too broadly can collapse rows and/or increase constraint complexity.

### 4) Multi-spouse row ordering experiment (F1592)

Goal:
- Fix rare case where a hub appears stuck left (F1592).

Hypothesis:
- Multi-spouse layout introduces additional ordering constraints; in some cases DOT may mirror rows or place hub outside spouse span.

Experiment:
- Changed multi-spouse row ordering edges from “undirected” (`dir=none`) to directional (`arrowhead=none`) to prevent mirroring.

Result:
- Triggered Graphviz WASM instability in at least one configuration: user hit `Error: index out of bounds`.

Conclusion:
- Some DOT constraint patterns can cause internal panics in WASM Graphviz; we should avoid edge patterns that increase solver brittleness.

### 5) Performance cliffs / hangs

What happened:
- When we increased constraints (especially `constraint=true` + very high weight invisible ordering edges on many couples), the page sometimes hung on large graphs.

Interpretation:
- Graphviz (particularly in WASM, main thread) can become extremely slow with dense constraint sets.

### 6) SVG post-processing “force center hubs between spouses” (attempt)

Goal:
- Avoid DOT complexity by correcting the hub position after layout, in SVG.

What we tried:
- Compute spouse card centers in SVG and shift the hub group to the midpoint.

Why it was rejected:
- It added a lot of additional code and introduced new regressions:
  - hubs offset by large amounts
  - couples touching leaving no room
  - more visual instability

Lesson:
- Post-processing can work, but only if it is extremely constrained and verified; otherwise it becomes another layer that hides the real failure mode.

### 7) “Rollback-first” reset

User feedback:
- The better approach is to remove breaking code and apply a minimal fix.

Action:
- We reverted back to baseline and reapplied only a small patch:
  - normalize SVG title
  - detect couple hubs via payload parents_total (not SVG class)
  - only add rank hint for childless couples

Outcome:
- Layout returned to “almost normal”, with remaining issues:
  - insufficient spacing between unrelated couples
  - rare F1592 hub-left persists

### 8) Couple spacing tweak

Goal:
- Restore visible separation between unrelated couples.

Mechanism:
- The couple cluster includes an invisible spacer node `${fid}__couple_sep` with a fixed width.

Experiment:
- Increased spacer width (0.60 → 0.90).

Outcome:
- Intended to restore separation between adjacent couple blocks.

### 9) Graphviz error resilience (index out of bounds)

Goal:
- Keep UI functional if WASM Graphviz panics.

Change:
- Wrap graphviz layout call in try/catch and retry once with `Couple priority` disabled.

Result:
- Stabilizes UX in the presence of WASM panics, but it does not solve the underlying layout bug.

### 10) New regression reported: “lines are gone” on large graphs

Observed:
- On a bigger test graph, edges/lines disappeared.

Likely causes:
- Graphviz produced incomplete/empty SVG (e.g. failure path), and the viewer still proceeded.
- Post-processing assumes edge DOM structure exists; if not, subsequent styling/rounding may hide edges.
- The try/catch retry path may leave `svgText` in a state that lacks expected elements.

Recommended next step if we ever revisit:
- If graphviz layout throws, show an error panel and stop (don’t try to continue with partial output).

## What we learned (do / don’t)

### Do

- Prefer minimal changes and isolate them:
  - One fix for F0844-like childless hub drift: add `{ rank=same; spouse; hub; spouse; }` only when no in-view children.
  - Ensure the SVG post-process de-overlap pass cannot move couple hubs.
- Use payload metadata (parents_total) rather than SVG `class` for correctness.
- Normalize SVG `<title>` because Graphviz title formatting varies.

### Don’t

- Don’t apply heavy `constraint=true` invisible edges across the whole graph with very large weights; this can hang DOT.
- Don’t change “multi-spouse row ordering semantics” casually; certain patterns appear to trigger WASM Graphviz internal panics.
- Don’t add large post-processing layers without a targeted test harness.

## Concrete code pointers (where to look next)

All in api/static/viewer_ported.html:

- DOT generation:
  - `function buildDotForFamily(payload)`
  - “Couple priority: keep spouses adjacent.” loop
  - `coupleSepId` spacer node (controls unrelated couple spacing)
  - Multi-spouse row block (`cluster_multi_...`)

- SVG post-processing:
  - `function postProcessGraphvizSvg(...)`
  - Hub horizontal de-overlap: `MIN_HUB_SPACING_PX`
  - Hub exclusion for 2-parent couples

- Graphviz layout invocation:
  - `gv.layout(dot, 'svg', 'dot')`

## Suggested restart plan (after revert)

1) Revert to a stable baseline (known-good) and reproduce both cases.
2) Add a debugging “export DOT for one family” mode:
   - ability to export the DOT subgraph containing (father, mother, family) and immediate constraints
   - run external Graphviz (native) to compare with WASM behavior
3) Keep only two minimal changes:
   - Normalize SVG title `node <id>` → `<id>`.
   - In hub de-overlap post-process: do not move 2-parent hubs, detected via parents_total.
4) If F1592 still exists:
   - Build the smallest DOT reproduction for the multi-spouse row ordering and examine whether `dir=none` is causing mirroring.
   - If directional edges fix it but triggers WASM panics, then the real fix is likely “reduce constraint weight / change edge pattern” rather than “directional vs not”.

---

## Appendix: Notable observed states during the session

- At least one change fixed F0844, but caused widespread misplacements.
- At least one change prevented hangs but made most hubs drift.
- At least one change triggered Graphviz WASM `index out of bounds`.
- User preference strongly favored rollback/minimal patch over layered fixes.
