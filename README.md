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

### 2) Browser-local mode with backend cost calculation

Click **Select .codex Path** and choose either:

- the `.codex` directory directly, or
- a parent directory that contains `.codex`

The app reads local JSONL files in-browser from:

- `.codex/sessions/**/*.jsonl`
- `.codex/archived_sessions/**/*.jsonl`

After reading those files, the frontend sends the JSONL payload plus optional `.codex/config.toml` through the `/api/cost-upload/*` endpoints so the Node backend can run real `ccusage` cost calculation with the selected speed mode. Large JSONL files are uploaded in chunks. Supported browsers gzip upload payloads before sending them to the backend. If the backend is unavailable, the dashboard falls back to browser-side parsing and estimated cost.

Performance notes:

- Switching between Auto, Standard, and Fast reuses the existing backend upload session and recalculates cost without rereading local files.
- Set Start/End date filters before selecting `.codex` to upload only session files whose path date matches the selected range.
- Use Refresh when you need to reread local files after changing to a wider date range or after the backend upload session expires.

The backend validates file count, file size, relative paths, JSONL structure, and speed mode before calculation. Uploaded JSONL files are written only to a temporary `.codex` directory, processed by `ccusage`, and deleted after the response.

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

## Testing And CI

Run the local quality gate:

```sh
npm run check
```

That command runs:

- `npm run check:syntax`: JavaScript syntax checks for `server.js`, `public/app.js`, and `public/upload-utils.js`
- `npm test`: Node test runner coverage for backend upload APIs and frontend upload chunk utilities

The GitHub Actions workflow in [.github/workflows/ci.yml](./.github/workflows/ci.yml) runs the same gate on every pull request to `main` and every push to `main`.

To make tests required before merging into `main`, enable branch protection in GitHub:

1. Open the repository settings.
2. Go to **Branches**.
3. Add or edit the protection rule for `main`.
4. Enable **Require status checks to pass before merging**.
5. Select the `Test` status check from the `CI` workflow.

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
- `POST /api/cost`: compact legacy endpoint that validates frontend-selected `.codex` JSONL files, runs backend `ccusage`, and returns speed-aware daily/weekly/monthly/session usage with calculated cost
- `POST /api/cost-upload/start`: starts a file-by-file cost upload session for larger `.codex` histories
- `POST /api/cost-upload/file`: uploads one validated `sessions/` or `archived_sessions/` JSONL file, or optional `config.toml`
- `POST /api/cost-upload/chunk`: uploads one chunk of an oversized JSONL file, then validates the assembled file
- `POST /api/cost-upload/finish`: runs backend `ccusage` against the uploaded temporary `.codex` tree, returns calculated usage, then removes the temporary files

`POST /api/cost` expects:

```json
{
  "speed": "auto",
  "sourceLabel": "{basePath}/.codex",
  "files": [
    {
      "relativePath": "sessions/2026/06/example.jsonl",
      "content": "{\"type\":\"...\"}\n"
    },
    {
      "relativePath": "config.toml",
      "content": "service_tier = \"auto\""
    }
  ]
}
```

## Environment Variables

See [.env.example](./.env.example):

- `HOST` (default `0.0.0.0`)
- `PORT` (default `3210`)
- `CODEX_HOME` (optional override, supports comma-separated paths)
- `CCUSAGE_CORS_ORIGIN` (default `*`, for hosted frontend/backend deployments)
- `COST_PAYLOAD_LIMIT` (default `70mb`)
- `COST_PAYLOAD_MAX_FILES` (default `5000`)
- `COST_PAYLOAD_MAX_BYTES` (default `524288000`)
- `COST_PAYLOAD_MAX_FILE_BYTES` (default `104857600`)
- `COST_PAYLOAD_MAX_CHUNK_BYTES` (default `10485760`)
- `COST_UPLOAD_TTL_MS` (default `1800000`)

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
