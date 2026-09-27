# Codex plugin selection

Cadre disables `browser@openai-bundled` by default for every Codex terminal session. The setting uses Codex's documented [invocation-only configuration override](https://learn.chatgpt.com/docs/config-file/config-reference) as a nested key (`plugins."browser@openai-bundled".enabled=false`) so other plugin table entries are not replaced. It does not uninstall a plugin or change the user's persistent Codex configuration.

The browser plugin's `control-in-app-browser` skill is incompatible with the headless Fleet path: it directs explicit Playwright QA into an in-app browser context and forbids the external Playwright MCP. Testing with Codex CLI 0.153.0 confirmed that disabling the nested `enabled` key removes that skill from the launch prompt, while `enabled=true` restores it.

Callers can opt back in for an intentional in-app-browser workflow:

```json
{
  "provider": "codex",
  "codexPlugins": {
    "add": ["browser@openai-bundled"]
  }
}
```

`codexPlugins.remove` can disable additional installed plugins for one session. IDs must use the exact `plugin@marketplace` form. `add` wins when an ID appears in both lists, including the default removal list. An omitted selection gets the Fleet default. The normalized selection is saved with the session and reapplied on resume.

Raw Codex `args` may still contain unrelated `-c` and `--config` overrides. Overrides targeting the `plugins` table or its keys are rejected so they cannot bypass `codexPlugins` precedence.

## Separate launch controls

- `skills` are Fleet launch-skill IDs composed into the startup prompt. Their resolution, including Unslop, is unchanged.
- `mcpServers.add` and `mcpServers.remove` select MCP servers independently. Adding Playwright MCP does not re-enable the browser plugin.
- `codexPlugins` is accepted only for Codex sessions. In mixed collaboration and conference requests, a top-level selection is applied only to Codex participants.

## Installed plugin audit

The enabled plugins on the audit host were inspected on 2026-09-04 with `codex plugin list --json`, and their model-visible skills were checked with the real Codex prompt-input path. No installation or persistent configuration was changed.

| Installed plugin | Audit result |
| --- | --- |
| `browser@openai-bundled` | Default-excluded. Its browser skill has the concrete Playwright/headless conflict described above. |
| `sites@openai-bundled` | Retained. Site building and hosting skills activate for site work; no terminal conflict observed. |
| `visualize@openai-bundled` | Retained. Visualization skill is task-scoped; no terminal conflict observed. |
| `codex-app-tools@openai-bundled` | Retained. No conflicting always-visible skill appeared in the audited prompt. |
| `documents@openai-primary-runtime`, `pdf@openai-primary-runtime`, `spreadsheets@openai-primary-runtime`, `presentations@openai-primary-runtime`, `template-creator@openai-primary-runtime` | Retained. Artifact skills are task-scoped; no headless terminal conflict observed. |
| `openai-templates@openai-curated-remote` | Retained. No conflicting always-visible skill appeared in the audited prompt. |
| `deep-research-work@openai-curated-remote`, `plugin-management@openai-curated-remote` | Retained. Their skills have narrow explicit triggers; no headless terminal conflict observed. |
| `research-workbench@personal` | Retained. Its research skills are task-scoped and Fleet launch-skill composition remains separate. |

The exact default exclusion set is therefore only `browser@openai-bundled`. Re-audit after Codex plugin or CLI upgrades because installed contents and config behavior may change.
