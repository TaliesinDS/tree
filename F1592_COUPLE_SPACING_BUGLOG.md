# F1592 Couple Spacing Bug Log (Tree relchart)

Date: 2026-01-17

## Summary
A specific couple/family hub (Family **F1592**, api_id `_f917a76c9c06455c6eff63c7646`) renders with spouse cards almost touching “like siblings”, even though it is a couple (⚭ hub between them). Other couples mostly look correct after recent fixes.

This appears correlated with one spouse (**I2760**, api_id `_f8d0dc0263a4f29e25d4a184b02`) also being the single visible parent of a **single-parent family** in the same view, which introduces strong constraints/junction handling.

The system has two layout phases:
1. Graphviz DOT layout generation (JS): `api/static/relchart/js/chart/dot.js`
2. SVG post-processing (JS): `api/static/relchart/js/chart/render.js`

The bug persists despite multiple DOT- and SVG-level spacing attempts.

## Environment
- OS: Windows
- App: Tree “relchart” viewer served by API
- Viewer: `http://127.0.0.1:8080/demo/relationship`
- Primary repro payload: neighborhood request (example):
  - `GET /graph/neighborhood?id=I0063&depth=5&max_nodes=1000&layout=family`

## Entities / IDs
- Family hub of interest:
  - F1592 api_id: `_f917a76c9c06455c6eff63c7646`
- Spouses of F1592 (from payload):
  - Father: I2760 api_id `_f8d0dc0263a4f29e25d4a184b02`
  - Mother: I3128 api_id `_f917a806b1b660665d891286a1`
- Related single-parent family involving I2760:
  - F1379 api_id `_f8d0dbfd4a1211010179dfe547c` (parents_total=1, children_total=1)

## Expected Behavior
- Couple spouse cards have a visually “couple-like” separation (more breathing room than sibling spacing).
- The ⚭ hub is centered between spouses.
- Edges from spouses to their parent/child families originate from the spouse cards (not from an artificial gap).
- Single-parent families should not cause unrelated couple blocks to float to the top row.

## Actual Behavior
- For F1592, spouse cards remain almost touching (reads like sibling spacing) even after attempts to widen the hub spacing.
- Other couples in the same view can look correct.
- Hub centering and “no floating to top” have been mostly resolved, but F1592 spacing remains problematic.

## Why This Is Tricky
Graphviz’s DOT layout is a global optimization influenced by constraints:
- Strong constraints to keep subgraphs coherent can unintentionally tug distant structures.
- Single-parent families are represented as invisible family junction nodes to keep child edges connected.
- The viewer then performs SVG post-processing that moves certain nodes (junctions/hubs) after Graphviz has already routed edges.

This bug likely arises from a mismatch between:
- The intended couple ordering/spacing (spouse—hub—spouse), and
- The constraints introduced by a spouse participating in a single-parent family/junction.

## Key Files
- DOT generator: `api/static/relchart/js/chart/dot.js`
- SVG postprocess + edge smoothing: `api/static/relchart/js/chart/render.js`
- Edge smoothing: `convertEdgeElbowsToRoundedPaths` and helpers in `render.js`

## Hypotheses (Root Causes)

### H1) Single-parent family constraints distort nearby couple spacing
The invisible edge(s) used to anchor the single-parent family junction can add rank/ordering pressure that compresses the spouse–hub–spouse chain for a different family.

### H2) Graphviz internal spacing ignores certain “gap node” strategies
Nodes with `shape=point` and/or `style=invis` may not always reserve width as expected in graphviz.js output.

### H3) Multi-phase layout (DOT → SVG moves) breaks assumptions
If we move spouse cards or junction nodes after DOT routes edges, edge endpoints appear to originate from the wrong place unless endpoint snapping is updated.

### H4) Bounding-box math in SVG postprocess uses inconsistent coordinate spaces
`getBBox()` ignores transforms; incorrect measurement can lead to “no effect” changes or incorrect clamps.

### H5) Incomplete family membership detection
The code may misclassify whether a couple is “special” or whether hidden parents/children exist, causing spacing logic not to trigger.

## Investigation: Confirmed Facts
- Payload shows F1592 has both parents visible (father+mother edges present).
- I2760 is the single visible parent of F1379 in the same payload.
- The “floating to top row” symptom was linked to weak/no anchoring for the single-parent family junction.

## Work Done (Chronological)

### 1) Prevent single-parent branch “floating to top row”
Change: DOT single-parent `parent -> family` edge was toggled between weaker/non-constraint and stronger/constraint.
- Weakening it reduced tug but did not stop floating.
- Restoring it as a strong constraint anchored the single-parent branch, stopping the “jump to top row”.

Status: This aspect is mostly fixed.

### 2) Keep hubs centered between spouses
Problem: strong constraints for single-parent families could cause the couple hub to drift left of the spouses.
Fix attempt: In SVG postprocess, compute spouse card centers and move the hub to the midpoint.

Issues encountered:
- A scoping bug caused `peopleIds` to be referenced before initialization, breaking rendering and removing edge rounding.
- A later scoping issue prevented hub-centering from reading the spouse card centers.

Status: Hub centering works now.

### 3) Restore curved edges
Curved edges depend on post-processing; runtime error prevented it.
Fix: Initialize `peopleIds` / `familyIds` before use.

Status: Curved edges restored.

### 4) Increase couple spacing for F1592 (DOT-level)
Attempt A: Insert invisible “gap” nodes inside the couple cluster around the hub.
- Added `COUPLE_HUB_SIDE_GAP_IN` and created `fid__hub_gap_l` / `fid__hub_gap_r`.
- Triggered initially only for `hasHiddenChildren` (children_total > visible child edges).

Outcome:
- User observed changing the value had no effect for F1592.

Attempt B: Make spacer nodes `shape=box` instead of `shape=point`.
- This helped for some other couples but still not F1592.

Attempt C: Trigger gap not only on hidden children, but also when either spouse participates in a single-parent family in-view.
- Still no visible change for F1592.

Interpretation:
- Either the trigger does not apply in practice for F1592’s DOT graph, or the DOT layout is dominated by other constraints.

Status: DOT-only gap strategy did not fix F1592.

### 5) Increase couple spacing for F1592 (SVG-level)
Attempt A: Nudge spouse cards outward in SVG when hub-to-card gap is too small.
- This caused major side effects:
  - I2760 shifted left by ~card width in some iterations.
  - Edge anchors moved to originate from the “gap” rather than the card.

Conclusion:
- Moving person cards post-layout is unsafe unless all edge endpoints are re-snapped accordingly.

Attempt B: Remove spouse nudges; instead push hub down if it overlaps.
- This fixed overlap but changed vertical placement, which was not desired.

Attempt C: Clamp hub X position between spouse cards with a minimum side gap.
- This became correct after replacing bounding-box math with a more reliable method.

Bounding box fixes:
- `getBBox()` ignored transforms; we tried `getCTM()` based conversion.
- Ultimately replaced with `getBoundingClientRect()` mapped back into SVG user-space using `svg.getScreenCTM().inverse()`.

Outcome:
- Hub horizontal position became correct.
- But F1592 spouse cards remained almost touching.

Attempt D: Avoid affecting other couples.
- Default couples: restore tight look via slight hub ellipse enlargement (“bump”) and `minSideGap=0`.
- Special couples (spouse is parent in single-parent family): apply `minSideGap` only for those.

Outcome:
- Other couples returned to normal.
- F1592 still looks too close.

Status: SVG-only hub clamping fixes hub placement but still does not produce desired spouse spacing.

## Current State (Latest)
- Floating/jumping branch behavior: mostly fixed.
- Hub centering: correct for F1592.
- Other couples: spacing back to normal.
- Remaining bug: F1592 spouse cards still too close (sibling-like gap).

## Likely Remaining Root Cause
At this point, the strongest evidence suggests:
- The *spouse-to-spouse distance* is primarily determined by DOT layout (node positions), not by hub position.
- Even with the hub centered and clamped, DOT is placing the spouse cards unusually close for this couple.

That implies the fix should likely be in DOT constraints for couples, but in a way that:
- Applies specifically to couples where one spouse is also involved in a single-parent family, and
- Does not introduce global rank pressure that breaks other couple blocks.

## Candidate Next Steps (for a fresh AI)

### A) Add DOT-level “minimum separation” between spouse nodes
Instead of relying on a hub-side spacer, add a dedicated invisible node/edge chain with enforced `minlen` that Graphviz respects more reliably.
Ideas:
- Add an invisible “separator node” between spouses with `width` and connect spouses through it using `constraint=true` and `minlen>=1`.
- Use `nodesep` or per-subgraph `nodesep` if supported by graphviz.js.

### B) Use `rank=same` ordering edges with explicit `minlen`
Currently the spouse-hub ordering edges use `minlen=0`. Consider bumping to `minlen=1` for special couples.

### C) Use a per-couple subgraph attribute for spacing
Graphviz supports `nodesep` globally; per-cluster behavior may require different technique.

### D) Instrument DOT output for just F1592
Add a temporary debug mode to:
- Highlight the nodes/edges for F1592 and its spouse’s single-parent family.
- Log or export the generated DOT for this payload to inspect what constraints exist.

### E) Avoid SVG person movement; if needed, also re-snap edges
If ever moving person cards in SVG, update `convertEdgeElbowsToRoundedPaths` endpoint snapping logic so endpoints follow the moved cards.

## Notes / Pitfalls
- Any postprocess movement of person nodes can break edge origin/termination visually.
- Transform handling is critical: Graphviz’s SVG uses nested transforms and local coordinate spaces.
- The hub size “bump” is a stylistic tweak that reduces visible whitespace; it should be disabled for any case where you are trying to *increase* visible spacing.

## Quick Repro Checklist
1. Open `http://127.0.0.1:8080/demo/relationship`
2. Load neighborhood `I0063 depth=5` (or the UI equivalent).
3. Locate family hub F1592 (api_id `_f917a76c9c06455c6eff63c7646`).
4. Compare spouse spacing to other couples in the same view.

## What NOT to Retry
- Weakening single-parent anchoring edges too much: tends to reintroduce “jump to top row”.
- Moving spouse cards in SVG without updating edge snapping: causes edges to start in mid-gap.

## Appendix: Related Prior Notes
- Existing bug log: `FID_MISALIGNMENT_BUGLOG.md` (different issue; hub alignment/float behaviors are adjacent).
