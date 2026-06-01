# Codex Usage Dashboard

Local dashboard for your Codex usage, powered by `@ccusage/codex` compatibility package and the maintained `ccusage` CLI.

## Run

```sh
npm run dashboard
```

Open the URL printed by the server, usually:

```text
http://127.0.0.1:3210
```

## Data

The dashboard supports two data modes:

1. API mode (local server):

```sh
ccusage codex daily --json
ccusage codex monthly --json
ccusage codex session --json
```

`ccusage` uses `CODEX_HOME` when set, otherwise it reads from `~/.codex`.

2. Browser local mode (Netlify/static-friendly):
- Click `Load .codex` in the UI.
- Pick either your `.codex` folder directly, or a base folder that contains `.codex`.
- The app reads `sessions/**/*.jsonl` and `archived_sessions/**/*.jsonl` directly in browser memory.
- No session JSONL data is uploaded to the deployed server.

## Features

- Theme modes: dark, white, and system.
- Daily, weekly, monthly, and session views.
- Token context for total, input, output, and reasoning tokens.
- URL-backed filters for `view`, `metric`, `range`, `theme`, `speed`, `start`, `end`, `model`, and `q`.
- Drag-and-drop dashboard panels with saved panel order.
- Hover tooltips for chart bars, model slices, heatmap cells, session rows, and table rows.
- Cursor-style analytics blocks for model usage, usage/billing-style token classes, token composition, and activity heatmap.

Example:

```text
http://127.0.0.1:3210/?view=weekly&metric=totalTokens&range=all&theme=dark&model=gpt-5.5&start=2026-05-01&q=2026
```

## Publish

For hosted static deployments (like Netlify), use `Load .codex` browser local mode.

For server-hosted mode that uses `CODEX_HOME`, run a private server with filesystem access:

```sh
docker build -t codex-usage-dashboard .
docker run --rm -p 3210:3210 \
  --env-file .env \
  -v "$HOME/.codex:/codex:ro" \
  -e CODEX_HOME=/codex \
  codex-usage-dashboard
```

Point a reverse proxy at port `3210` if you want to expose it beyond your machine.

## Notes

`@ccusage/codex@19.0.0` is deprecated and points to `ccusage@20`. This project installs both so the named package is present, while the dashboard calls the current `ccusage codex` reports.
