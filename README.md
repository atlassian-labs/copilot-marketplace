# Atlassian Copilot Marketplace

A generic library for **Atlassian GitHub Copilot marketplace** listings and
plugins (canvas extensions and related CLI plugin packages). Add new plugins
under `plugins/` and their canvas source under `extensions/` without treating
this tree as a single-product repo.

The first shipped plugin is **jira-sprint-dashboard**: a live, read-only
Copilot Canvas dashboard for Jira issues in currently open sprints. That is
one marketplace plugin, not the whole library.

Suggested GitHub topics: `atlassian`, `copilot`, `marketplace`, `plugins`,
`canvas`, `jira`, `dashboard`, `sprint`.

This project is licensed under [Apache-2.0](LICENSE). See also
[NOTICE](NOTICE), [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md),
[CONTRIBUTING.md](CONTRIBUTING.md)

There is no product logo. [`extensions/assets/preview.png`](extensions/assets/preview.png)
is a dashboard screenshot used as the marketplace preview image for the Jira
sprint plugin, not a brand mark.

## Layout

```
./
├── .github/plugin/marketplace.json   # marketplace manifest (registry of plugins)
├── plugins/<plugin-name>/            # plugin.json + plugin README per plugin
└── extensions/                       # canvas / plugin source
```

Current plugin:

```
plugins/jira-sprint-dashboard/        # plugin.json + plugin README
extensions/                           # canvas: extension.mjs, server/, ui/, tests/
```

## Add the marketplace

```bash
copilot plugin marketplace add OWNER/REPO
```

## Install a plugin

```bash
copilot plugin install jira-sprint-dashboard@jira-canvas-marketplace
```

## Available plugins

| Plugin | Description |
| --- | --- |
| `jira-sprint-dashboard` | Live, read-only Copilot canvas dashboard for Jira issues in currently open sprints. |

## Canvas fallback install

Canvas extensions are distinct from CLI plugin components (agents, skills, hooks,
MCP, LSP). If `copilot plugin install` does not auto-wire the canvas in your CLI
version, copy the working canvas files into
`~/.copilot/extensions/jira-sprint-dashboard/` (user scope) or
`.github/extensions/jira-sprint-dashboard/` (project scope):

- `extension.mjs`
- `server/`
- `ui/`
- `package.json`

Those files live under `extensions/` at this repo root. Do not copy
`plugins/jira-sprint-dashboard/` — it contains only `plugin.json` and a README,
not `extension.mjs`.

## Validation

From the repository root:

```bash
node --check extensions/extension.mjs
node --check extensions/server/jira-client.mjs
node --check extensions/server/start-copilot.mjs
node --check extensions/ui/dashboard.mjs
node --test extensions/tests/*.test.mjs
```
