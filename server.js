const { execFile } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const compression = require("compression");
const express = require("express");
const helmet = require("helmet");

const app = express();
const host = process.env.HOST || "127.0.0.1";
const preferredPort = Number(process.env.PORT || 3210);
const publicDir = path.join(__dirname, "public");
const speedModes = new Set(["auto", "standard", "fast"]);

function codexHomes() {
  const raw = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  return raw.split(",").map((entry) => entry.trim()).filter(Boolean);
}

function ccusageBin() {
  const bin = process.platform === "win32" ? "ccusage.cmd" : "ccusage";
  return path.join(__dirname, "node_modules", ".bin", bin);
}

function runCcusage(report, speed) {
  const args = ["codex", report, "--json", "--speed", speed];

  return new Promise((resolve, reject) => {
    execFile(
      ccusageBin(),
      args,
      {
        cwd: __dirname,
        env: process.env,
        maxBuffer: 50 * 1024 * 1024,
        timeout: 120000,
      },
      (error, stdout, stderr) => {
        if (error) {
          error.message = `${error.message}\n${stderr || ""}`;
          reject(error);
          return;
        }

        try {
          resolve(JSON.parse(stdout));
        } catch (parseError) {
          parseError.message = `Failed to parse ccusage ${report} JSON: ${parseError.message}`;
          reject(parseError);
        }
      },
    );
  });
}

function homeStatus(home) {
  const sessions = path.join(home, "sessions");
  const archived = path.join(home, "archived_sessions");

  return {
    home,
    exists: fs.existsSync(home),
    sessionsExists: fs.existsSync(sessions),
    archivedSessionsExists: fs.existsSync(archived),
  };
}

function startOfIsoWeek(date) {
  const copy = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = copy.getUTCDay() || 7;
  copy.setUTCDate(copy.getUTCDate() - day + 1);
  return copy;
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function addUsage(target, source) {
  for (const key of [
    "cachedInputTokens",
    "costUSD",
    "inputTokens",
    "outputTokens",
    "reasoningOutputTokens",
    "totalTokens",
  ]) {
    target[key] = Number(target[key] || 0) + Number(source[key] || 0);
  }
}

function addModels(target, models = {}) {
  for (const [model, details] of Object.entries(models)) {
    target[model] ||= {
      cachedInputTokens: 0,
      inputTokens: 0,
      isFallback: Boolean(details.isFallback),
      outputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 0,
    };
    addUsage(target[model], details);
    target[model].isFallback = target[model].isFallback || Boolean(details.isFallback);
  }
}

function weeklyFromDaily(daily) {
  const weeks = new Map();

  for (const row of daily) {
    const date = new Date(`${row.date}T00:00:00Z`);
    const weekStart = startOfIsoWeek(date);
    const weekEnd = new Date(weekStart);
    weekEnd.setUTCDate(weekEnd.getUTCDate() + 6);
    const week = isoDate(weekStart);

    if (!weeks.has(week)) {
      weeks.set(week, {
        week,
        weekStart: isoDate(weekStart),
        weekEnd: isoDate(weekEnd),
        cachedInputTokens: 0,
        costUSD: 0,
        inputTokens: 0,
        models: {},
        outputTokens: 0,
        reasoningOutputTokens: 0,
        totalTokens: 0,
      });
    }

    const current = weeks.get(week);
    addUsage(current, row);
    addModels(current.models, row.models);
  }

  return [...weeks.values()].sort((a, b) => a.week.localeCompare(b.week));
}

app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(express.static(publicDir));

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    package: "@ccusage/codex",
    ccusageBin: ccusageBin(),
    codexHomes: codexHomes().map(homeStatus),
  });
});

app.get("/api/usage", async (req, res) => {
  const speed = speedModes.has(String(req.query.speed)) ? String(req.query.speed) : "auto";

  try {
    const [daily, monthly, sessions] = await Promise.all([
      runCcusage("daily", speed),
      runCcusage("monthly", speed),
      runCcusage("session", speed),
    ]);

    res.json({
      generatedAt: new Date().toISOString(),
      speed,
      codexHomes: codexHomes().map(homeStatus),
      daily: daily.daily || [],
      weekly: weeklyFromDaily(daily.daily || []),
      monthly: monthly.monthly || [],
      sessions: sessions.sessions || [],
      totals: daily.totals || monthly.totals || sessions.totals || {},
    });
  } catch (error) {
    res.status(500).json({
      error: "Unable to read Codex usage from ccusage.",
      detail: error.message,
    });
  }
});

function listen(port) {
  const server = app.listen(port, host, () => {
    const address = `http://${host}:${port}`;
    console.log(`Codex usage dashboard running at ${address}`);
    console.log(`Reading Codex logs from: ${codexHomes().join(", ")}`);
  });

  server.on("error", (error) => {
    if (error.code === "EADDRINUSE" && port < preferredPort + 20) {
      listen(port + 1);
      return;
    }

    throw error;
  });
}

listen(preferredPort);
