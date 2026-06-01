# Codex Usage Dashboard

Codex usage dashboard built on top of `ccusage`, with two runtime modes:

1. server/API mode (auto-reads local `~/.codex` by default)
2. browser-local mode (manual `.codex` folder selection, best for static hosting)

Production web app: [https://codex-usage-dashboard.netlify.app/](https://codex-usage-dashboard.netlify.app/)

## Stack

- Backend: `express`, `helmet`, `compression`
- Usage source: `ccusage` + `@ccusage/codex` compatibility package
- Frontend: vanilla HTML/CSS/JS in `public/`

## Project Structure

- [server.js](./server.js): serves app + `/api/usage` and `/api/health`
- [public/index.html](./public/index.html): dashboard layout/widgets
- [public/app.js](./public/app.js): data loading, parsing, rendering, interactions
- [public/styles.css](./public/styles.css): visual style and layout
- [netlify.toml](./netlify.toml): Netlify publish + redirect config
- [index.html](./index.html): root redirect fallback to `/public/index.html`

## Run Locally

Requirements:

- Node.js 20+ (22 recommended)
- `~/.codex` on your machine (or set `CODEX_HOME`)

Install and run:

```sh
npm install
npm run dashboard
```

Open the printed URL (default `http://127.0.0.1:3210`).

## Data Loading Behavior

### 1) API mode (default)

On load, the app calls `/api/usage` and runs:

```sh
ccusage codex daily --json --speed <auto|standard|fast>
ccusage codex monthly --json --speed <auto|standard|fast>
ccusage codex session --json --speed <auto|standard|fast>
```

Path resolution order:

1. `CODEX_HOME` (if set)
2. `~/.codex` (default)

If the default path is missing (or lacks `sessions/` and `archived_sessions/`), the API returns an error and the UI prompts the user to select a folder manually.

### 2) Browser-local mode (fallback/static-host friendly)

Click **Select .codex Path** and choose either:

- the `.codex` directory directly, or
- a parent directory that contains `.codex`

The app reads local JSONL files in-browser from:

- `.codex/sessions/**/*.jsonl`
- `.codex/archived_sessions/**/*.jsonl`

No local JSONL data is uploaded to the static host.

## Dashboard Features

- Theme modes: Dark, White, System
- Speed selector: Auto, Standard, Fast
- Views: Daily, Weekly, Monthly, Sessions
- Metrics: Cost, Total, Input, Cached, Output, Thinking
- Token insights/context cards
- Model usage pie, usage/billing bars, composition area, token activity heatmap
- 52-week style token activity matrix with metric toggle (All/Input/Output/Cached/Thinking)
- Filter panel with URL-synced params (`q`, `start`, `end`, `model`, etc.)
- Drag-and-drop panel ordering (drag handle only)
- Widget sidebar: show/hide, resize, width presets, reset layout
- Hover tooltips across charts, heatmaps, table rows, and legends

## Useful Query Parameters

Example:

```text
http://127.0.0.1:3210/?view=weekly&metric=totalTokens&range=all&theme=dark&speed=auto&start=2026-05-01&model=gpt-5.5&q=session
```

Supported keys include:

- `view`, `metric`, `range`, `speed`, `theme`
- `activityMetric`
- `source` (`api` or `local`)
- `q`, `start`, `end`, `model`
- `composition`, `billing`, `modelVisible`

## API Endpoints

- `GET /api/health`: server health + codex home path readiness
- `GET /api/usage?speed=auto|standard|fast`: aggregated daily/weekly/monthly/session usage

## Environment Variables

See [.env.example](./.env.example):

- `HOST` (default `127.0.0.1`)
- `PORT` (default `3210`)
- `CODEX_HOME` (optional override, supports comma-separated paths)

## Docker

```sh
docker build -t codex-usage-dashboard .
docker run --rm -p 3210:3210 \
  -v "$HOME/.codex:/codex:ro" \
  -e CODEX_HOME=/codex \
  codex-usage-dashboard
```

## Netlify Deployment Notes

This repo includes [netlify.toml](./netlify.toml):

- publish directory: `public`
- redirect: `/* -> /index.html`

If your deployed site still shows 404, verify:

1. deploy branch is `main`
2. publish directory is `public`
3. trigger **Clear cache and deploy site**

## Compatibility Note

`@ccusage/codex` is a compatibility package that points to current `ccusage` releases. This project keeps it installed for naming compatibility while using current `ccusage codex` commands.
