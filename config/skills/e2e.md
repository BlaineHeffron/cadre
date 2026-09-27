---
description: Test one user path in a real browser with Playwright.
---

<!--
Copyright 2026 Anthropic, PBC.
Licensed under Apache-2.0; see the repository LICENSE.
Modified for Cadre: adapted from anthropics/skills.
-->

# Web Application Testing

To test local web applications, write native Python Playwright scripts.

**Fleet defaults:**

- Pick one user path. Automate only that path. Do not generate a suite.
- Use the project's existing e2e runner if one exists. Do not add a new framework.
- Assert a user-visible result, not an implementation detail.
- Say how to run it.

**Helper available**: the `with-server` fleet skill (token-inlined at the end) manages server lifecycle (supports multiple servers). Write `with_server.py` to a scratch path and call it as a black box.

## Decision Tree: Choosing Your Approach

```
User task → Is it static HTML?
    ├─ Yes → Read HTML file directly to identify selectors
    │         ├─ Success → Write Playwright script using selectors
    │         └─ Fails/Incomplete → Treat as dynamic (below)
    │
    └─ No (dynamic webapp) → Is the server already running?
        ├─ No → Use the with_server.py helper below
        │        + write simplified Playwright script
        │
        └─ Yes → Reconnaissance-then-action:
            1. Navigate and wait for networkidle
            2. Take screenshot or inspect DOM
            3. Identify selectors from rendered state
            4. Execute actions with discovered selectors
```

## Example: Using with_server.py

**Single server:**
```bash
python with_server.py --server "npm run dev" --port 5173 -- python your_automation.py
```

**Multiple servers (e.g., backend + frontend):**
```bash
python with_server.py \
  --server "cd backend && python server.py" --port 3000 \
  --server "cd frontend && npm run dev" --port 5173 \
  -- python your_automation.py
```

To create an automation script, include only Playwright logic (servers are managed automatically):
```python
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True) # Always launch chromium in headless mode
    page = browser.new_page()
    page.goto('http://localhost:5173') # Server already running and ready
    page.wait_for_load_state('networkidle') # CRITICAL: Wait for JS to execute
    # ... your automation logic
    browser.close()
```

## Reconnaissance-Then-Action Pattern

1. **Inspect rendered DOM**:
   ```python
   page.screenshot(path='inspect.png', full_page=True)
   content = page.content()
   page.locator('button').all()
   ```

2. **Identify selectors** from inspection results

3. **Execute actions** using discovered selectors

## Common Pitfall

❌ **Don't** inspect the DOM before waiting for `networkidle` on dynamic apps
✅ **Do** wait for `page.wait_for_load_state('networkidle')` before inspection

## Best Practices

- Use `sync_playwright()` for synchronous scripts
- Always close the browser when done
- Use descriptive selectors: `text=`, `role=`, CSS selectors, or IDs
- Add appropriate waits: `page.wait_for_selector()` — for flakiness, apply the `condition-based-waiting` fleet skill (config/skills/condition-based-waiting.md) rather than arbitrary timeouts
- Capture console logs when debugging: `page.on("console", lambda msg: print(msg.text))`
- If the app is not running and cannot be started, say so and stop.

{{skill:with-server}}

<!-- upstream: anthropics/skills@0a64e39 skills/webapp-testing/SKILL.md -->
