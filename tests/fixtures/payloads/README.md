# Graph Payload Fixtures

This folder stores JSON payloads returned by the graph endpoints so that layout/expand/selection bugs can be reproduced without a live DB.

## Recommended fixtures

- `I0063_depth5_family.json`
- `multi_spouse_example_family.json`
- `single_parent_example_family.json`

## How to capture

1. Restart API (`genealogy: restart api (detached 8081)`).
2. Fetch the payload from the API and save it here.

Example (PowerShell):

```powershell
$uri = 'http://127.0.0.1:8081/graph/neighborhood?id=I0063&depth=5&max_nodes=1000&layout=family'
Invoke-RestMethod $uri | ConvertTo-Json -Depth 100 | Out-File -Encoding utf8 .\tests\fixtures\payloads\I0063_depth5_family.json
```

Notes:
- Use `ConvertTo-Json -Depth 100` to avoid truncation.
- Keep fixtures small-ish (e.g. `max_nodes=1000`) so they’re easy to diff.
