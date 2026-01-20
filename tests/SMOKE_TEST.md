# Manual Smoke Test Checklist

Run after any significant refactor.

## Setup

- [ ] Restart API via VS Code task: `genealogy: restart api (detached 8080)`
- [ ] Open: `http://127.0.0.1:8080/demo/relationship`

## Graph

- [ ] Default load works (no console errors)
- [ ] Select a person node (selection ring updates)
- [ ] Select a family hub (selection updates)
- [ ] Expand parents (▲) and verify new nodes appear
- [ ] Expand children (▼) and verify new nodes appear
- [ ] After expand, the clicked expand tab stays visually stable (no big jump)

## People Tab

- [ ] Surname groups render and are collapsible
- [ ] Search filters results
- [ ] Clicking a person recenters/updates selection in graph

## Families Tab

- [ ] Families list loads
- [ ] Search filters results
- [ ] Selecting a family updates selection in graph

## Events Tab

- [ ] Events list loads
- [ ] Search/filter works
- [ ] Selecting an event updates detail panel (if applicable)

## Places Tab

- [ ] Places list loads
- [ ] Selecting a place updates place-related panels

## Map Tab

- [ ] Map loads when switching to Map tab
- [ ] Pins/overlays render (when data available)
- [ ] Selecting a place recenters map (only when Map tab visible)
