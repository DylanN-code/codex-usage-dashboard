const { execFile } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const compression = require("compression");
const express = require("express");
const helmet = require("helmet");

const app = express();
const host = process.env.HOST || "0.0.0.0";
const preferredPort = Number(process.env.PORT || 3210);
const publicDir = path.join(__dirname, "public");
const speedModes = new Set(["auto", "standard", "fast"]);
const defaultCodexHome = path.join(os.homedir(), ".codex");
const corsOrigin = process.env.CCUSAGE_CORS_ORIGIN || "*";
const maxCostFiles = Number(process.env.COST_PAYLOAD_MAX_FILES || 2500);
const maxCostBytes = Number(process.env.COST_PAYLOAD_MAX_BYTES || 60 * 1024 * 1024);
const maxCostFileBytes = Number(process.env.COST_PAYLOAD_MAX_FILE_BYTES || 5 * 1024 * 1024);

function codexHomes() {
  const raw = process.env.CODEX_HOME || defaultCodexHome;
  return raw.split(",").map((entry) => entry.trim()).filter(Boolean);
}

function ccusageBin() {
  const bin = process.platform === "win32" ? "ccusage.cmd" : "ccusage";
  return path.join(__dirname, "node_modules", ".bin", bin);
}

function runCcusage(report, speed, envOverrides = {}) {
  const args = ["codex", report, "--json", "--speed", speed];

  return new Promise((resolve, reject) => {
    execFile(
      ccusageBin(),
      args,
      {
        cwd: __dirname,
        env: { ...process.env, ...envOverrides },
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

async function runUsageReports(speed, envOverrides = {}) {
  const [daily, monthly, sessions] = await Promise.all([
    runCcusage("daily", speed, envOverrides),
    runCcusage("monthly", speed, envOverrides),
    runCcusage("session", speed, envOverrides),
  ]);

  return {
    daily: daily.daily || [],
    weekly: weeklyFromDaily(daily.daily || []),
    monthly: monthly.monthly || [],
    sessions: sessions.sessions || [],
    totals: daily.totals || monthly.totals || sessions.totals || {},
  };
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

function codexHomeValidation() {
  const statuses = codexHomes().map(homeStatus);
  const hasExistingHome = statuses.some((entry) => entry.exists);
  const hasUsageFolders = statuses.some((entry) => entry.sessionsExists || entry.archivedSessionsExists);

  if (!hasExistingHome) {
    return {
      ok: false,
      statuses,
      detail: `Default Codex path not found: ${defaultCodexHome}`,
    };
  }

  if (!hasUsageFolders) {
    const paths = statuses.map((entry) => entry.home).join(", ");
    return {
      ok: false,
      statuses,
      detail: `No usage folders found under: ${paths}. Expected sessions/ or archived_sessions/.`,
    };
  }

  return { ok: true, statuses, detail: "" };
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
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", corsOrigin);
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});
app.use(express.json({ limit: process.env.COST_PAYLOAD_LIMIT || "70mb" }));
app.use(compression());
app.use(express.static(publicDir));

function badRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function validateCostPayload(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw badRequest("Request body must be an object.");
  }

  const speed = speedModes.has(String(body.speed)) ? String(body.speed) : "auto";
  const sourceLabel = typeof body.sourceLabel === "string" && body.sourceLabel.trim()
    ? body.sourceLabel.trim().slice(0, 200)
    : "{basePath}/.codex";

  if (!Array.isArray(body.files)) {
    throw badRequest("files must be an array.");
  }
  if (!body.files.length) {
    throw badRequest("files must include at least one JSONL file.");
  }
  if (body.files.length > maxCostFiles) {
    throw badRequest(`Too many files. Maximum is ${maxCostFiles}.`);
  }

  let totalBytes = 0;
  const seen = new Set();
  const files = body.files.map((file, index) => {
    if (!file || typeof file !== "object" || Array.isArray(file)) {
      throw badRequest(`files[${index}] must be an object.`);
    }

    const relativePath = String(file.relativePath || "").replaceAll("\\", "/");
    const content = file.content;
    if (!relativePath || path.isAbsolute(relativePath) || relativePath.includes("..")) {
      throw badRequest(`files[${index}].relativePath is invalid.`);
    }
    const isConfig = relativePath === "config.toml";
    const isSessionJsonl = relativePath.endsWith(".jsonl")
      && (relativePath.startsWith("sessions/") || relativePath.startsWith("archived_sessions/"));
    if (!isConfig && !isSessionJsonl) {
      throw badRequest(`files[${index}] must be config.toml or a .jsonl file under sessions/ or archived_sessions/.`);
    }
    if (!/^[A-Za-z0-9._/@-]+$/.test(relativePath)) {
      throw badRequest(`files[${index}].relativePath contains unsupported characters.`);
    }
    if (typeof content !== "string") {
      throw badRequest(`files[${index}].content must be a string.`);
    }

    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > maxCostFileBytes) {
      throw badRequest(`files[${index}] is too large. Maximum file size is ${maxCostFileBytes} bytes.`);
    }
    totalBytes += bytes;
    if (totalBytes > maxCostBytes) {
      throw badRequest(`Payload is too large. Maximum total size is ${maxCostBytes} bytes.`);
    }
    if (seen.has(relativePath)) {
      throw badRequest(`Duplicate file path: ${relativePath}`);
    }
    seen.add(relativePath);

    if (isSessionJsonl) {
      for (const [lineIndex, line] of content.split(/\n/).entries()) {
        if (!line.trim()) continue;
        try {
          JSON.parse(line);
        } catch {
          throw badRequest(`${relativePath} contains invalid JSON on line ${lineIndex + 1}.`);
        }
      }
    }

    return { relativePath, content };
  });

  return { speed, sourceLabel, files, totalBytes };
}

async function writeCostPayloadToTempCodex(files) {
  const tempHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-usage-"));
  const codexHome = path.join(tempHome, ".codex");

  try {
    for (const file of files) {
      const destination = path.join(codexHome, file.relativePath);
      if (!destination.startsWith(codexHome + path.sep)) {
        throw badRequest(`Unsafe file path: ${file.relativePath}`);
      }
      await fs.promises.mkdir(path.dirname(destination), { recursive: true });
      await fs.promises.writeFile(destination, file.content, "utf8");
    }
    return { tempHome, codexHome };
  } catch (error) {
    await fs.promises.rm(tempHome, { recursive: true, force: true });
    throw error;
  }
}

app.get("/api/health", (req, res) => {
  const validation = codexHomeValidation();
  res.json({
    ok: true,
    package: "@ccusage/codex",
    ccusageBin: ccusageBin(),
    defaultCodexHome,
    codexHomes: validation.statuses,
    codexHomeReady: validation.ok,
    codexHomeDetail: validation.detail,
  });
});

app.get("/api/usage", async (req, res) => {
  const speed = speedModes.has(String(req.query.speed)) ? String(req.query.speed) : "auto";
  const validation = codexHomeValidation();

  if (!validation.ok) {
    res.status(404).json({
      error: "Unable to find Codex usage at default path.",
      detail: validation.detail,
      defaultCodexHome,
      codexHomes: validation.statuses,
    });
    return;
  }

  try {
    const reports = await runUsageReports(speed);

    res.json({
      generatedAt: new Date().toISOString(),
      speed,
      defaultCodexHome,
      codexHomes: validation.statuses,
      ...reports,
    });
  } catch (error) {
    res.status(500).json({
      error: "Unable to read Codex usage from ccusage.",
      detail: error.message,
    });
  }
});

app.post("/api/cost", async (req, res) => {
  let tempHome = null;

  try {
    const payload = validateCostPayload(req.body);
    const temp = await writeCostPayloadToTempCodex(payload.files);
    tempHome = temp.tempHome;

    const reports = await runUsageReports(payload.speed, {
      HOME: tempHome,
      USERPROFILE: tempHome,
    });

    res.json({
      generatedAt: new Date().toISOString(),
      speed: payload.speed,
      costSource: "ccusage",
      localParse: true,
      localSourceLabel: payload.sourceLabel,
      uploadedFiles: payload.files.length,
      uploadedBytes: payload.totalBytes,
      codexHomes: [
        {
          home: payload.sourceLabel,
          exists: true,
          sessionsExists: payload.files.some((file) => file.relativePath.startsWith("sessions/")),
          archivedSessionsExists: payload.files.some((file) => file.relativePath.startsWith("archived_sessions/")),
        },
      ],
      ...reports,
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      error: error.statusCode ? "Invalid cost calculation payload." : "Unable to calculate Codex usage cost.",
      detail: error.message,
    });
  } finally {
    if (tempHome) {
      await fs.promises.rm(tempHome, { recursive: true, force: true });
    }
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
