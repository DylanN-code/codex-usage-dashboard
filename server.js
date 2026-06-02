const { execFile } = require("node:child_process");
const crypto = require("node:crypto");
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
const costUploadRoot = path.join(os.tmpdir(), "codex-usage-cost-uploads");
const maxCostFiles = Number(process.env.COST_PAYLOAD_MAX_FILES || 5000);
const maxCostBytes = Number(process.env.COST_PAYLOAD_MAX_BYTES || 500 * 1024 * 1024);
const maxCostFileBytes = Number(process.env.COST_PAYLOAD_MAX_FILE_BYTES || 100 * 1024 * 1024);
const maxCostChunkBytes = Number(process.env.COST_PAYLOAD_MAX_CHUNK_BYTES || 10 * 1024 * 1024);
const costUploadTtlMs = Number(process.env.COST_UPLOAD_TTL_MS || 30 * 60 * 1000);

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

async function defaultRunUsageReports(speed, envOverrides = {}) {
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

let usageReportsRunner = defaultRunUsageReports;

function setUsageReportsRunner(runner) {
  usageReportsRunner = runner;
}

function resetUsageReportsRunner() {
  usageReportsRunner = defaultRunUsageReports;
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
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});
app.use(express.json({ limit: process.env.COST_PAYLOAD_LIMIT || "70mb" }));
app.use(compression());
app.get("/favicon.ico", (req, res) => res.status(204).end());
app.use(express.static(publicDir));

function badRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function validateCostMetadata(body = {}) {
  const payload = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const speed = speedModes.has(String(payload.speed)) ? String(payload.speed) : "auto";
  const sourceLabel = typeof payload.sourceLabel === "string" && payload.sourceLabel.trim()
    ? payload.sourceLabel.trim().slice(0, 200)
    : "{basePath}/.codex";

  return { speed, sourceLabel };
}

function validateCostRelativePath(value, index = 0) {
  const relativePath = String(value || "").replaceAll("\\", "/");
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

  return { relativePath, isConfig, isSessionJsonl };
}

function validateJsonlContent(content, relativePath) {
  for (const [lineIndex, line] of content.split(/\n/).entries()) {
    if (!line.trim()) continue;
    try {
      JSON.parse(line);
    } catch {
      throw badRequest(`${relativePath} contains invalid JSON on line ${lineIndex + 1}.`);
    }
  }
}

function validateCostFile(file, index = 0) {
  if (!file || typeof file !== "object" || Array.isArray(file)) {
    throw badRequest(`files[${index}] must be an object.`);
  }

  const { relativePath, isSessionJsonl } = validateCostRelativePath(file.relativePath, index);
  const content = file.content;
  if (typeof content !== "string") {
    throw badRequest(`files[${index}].content must be a string.`);
  }

  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > maxCostFileBytes) {
    throw badRequest(`files[${index}] is too large. Maximum file size is ${maxCostFileBytes} bytes.`);
  }

  if (isSessionJsonl) {
    validateJsonlContent(content, relativePath);
  }

  return { relativePath, content, bytes, isSessionJsonl };
}

async function validateUploadedFile(relativePath, isSessionJsonl, filePath) {
  const content = await fs.promises.readFile(filePath, "utf8");
  if (isSessionJsonl) {
    validateJsonlContent(content, relativePath);
  }
}

function validateCostPayload(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw badRequest("Request body must be an object.");
  }

  const { speed, sourceLabel } = validateCostMetadata(body);

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
  let hasSessionJsonl = false;
  const files = body.files.map((file, index) => {
    const validated = validateCostFile(file, index);
    totalBytes += validated.bytes;
    if (totalBytes > maxCostBytes) {
      throw badRequest(`Payload is too large. Maximum total size is ${maxCostBytes} bytes.`);
    }
    if (seen.has(validated.relativePath)) {
      throw badRequest(`Duplicate file path: ${validated.relativePath}`);
    }
    seen.add(validated.relativePath);
    hasSessionJsonl = hasSessionJsonl || validated.isSessionJsonl;

    return { relativePath: validated.relativePath, content: validated.content };
  });

  if (!hasSessionJsonl) {
    throw badRequest("files must include at least one JSONL session file.");
  }

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

function validateUploadId(uploadId) {
  const id = String(uploadId || "");
  if (!/^[a-f0-9-]{36}$/i.test(id)) {
    throw badRequest("uploadId is invalid.");
  }
  return id;
}

function uploadDir(uploadId) {
  return path.join(costUploadRoot, validateUploadId(uploadId));
}

function uploadMetaPath(uploadId) {
  return path.join(uploadDir(uploadId), "meta.json");
}

async function readUploadMeta(uploadId) {
  try {
    const raw = await fs.promises.readFile(uploadMetaPath(uploadId), "utf8");
    return JSON.parse(raw);
  } catch {
    throw badRequest("Upload session was not found. Start a new cost calculation.");
  }
}

async function writeUploadMeta(meta) {
  await fs.promises.writeFile(uploadMetaPath(meta.uploadId), JSON.stringify(meta), "utf8");
}

async function cleanupExpiredCostUploads() {
  let entries = [];
  try {
    entries = await fs.promises.readdir(costUploadRoot, { withFileTypes: true });
  } catch {
    return;
  }

  const now = Date.now();
  await Promise.all(entries
    .filter((entry) => entry.isDirectory())
    .map(async (entry) => {
      const dir = path.join(costUploadRoot, entry.name);
      try {
        const meta = JSON.parse(await fs.promises.readFile(path.join(dir, "meta.json"), "utf8"));
        if (now - Number(meta.updatedAt || meta.createdAt || 0) > costUploadTtlMs) {
          await fs.promises.rm(dir, { recursive: true, force: true });
        }
      } catch {
        await fs.promises.rm(dir, { recursive: true, force: true });
      }
    }));
}

async function writeUploadedCostFile(uploadId, file) {
  const root = path.join(uploadDir(uploadId), ".codex");
  const destination = path.join(root, file.relativePath);
  if (!destination.startsWith(root + path.sep)) {
    throw badRequest(`Unsafe file path: ${file.relativePath}`);
  }
  await fs.promises.mkdir(path.dirname(destination), { recursive: true });
  await fs.promises.writeFile(destination, file.content, "utf8");
}

function pendingUploadBytes(meta) {
  return Object.values(meta.pendingFiles || {}).reduce((sum, file) => sum + Number(file.bytes || 0), 0);
}

function uploadedCostFilePath(uploadId, relativePath) {
  const root = path.join(uploadDir(uploadId), ".codex");
  const destination = path.join(root, relativePath);
  if (!destination.startsWith(root + path.sep)) {
    throw badRequest(`Unsafe file path: ${relativePath}`);
  }
  return destination;
}

async function appendUploadedCostFileChunk(uploadId, chunk) {
  const destination = uploadedCostFilePath(uploadId, chunk.relativePath);
  await fs.promises.mkdir(path.dirname(destination), { recursive: true });
  await fs.promises.appendFile(`${destination}.uploading`, chunk.content, "utf8");
  return destination;
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
    const reports = await usageReportsRunner(speed);

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

app.post("/api/cost-upload/start", async (req, res) => {
  try {
    await cleanupExpiredCostUploads();
    const uploadId = crypto.randomUUID();
    const { speed, sourceLabel } = validateCostMetadata(req.body);
    const dir = uploadDir(uploadId);
    await fs.promises.mkdir(path.join(dir, ".codex"), { recursive: true });
    const now = Date.now();
    const meta = {
      uploadId,
      createdAt: now,
      updatedAt: now,
      speed,
      sourceLabel,
      uploadedBytes: 0,
      uploadedFiles: 0,
      pendingFiles: {},
      paths: [],
    };
    await writeUploadMeta(meta);
    res.json({
      uploadId,
      maxFiles: maxCostFiles,
      maxBytes: maxCostBytes,
      maxFileBytes: maxCostFileBytes,
      ttlMs: costUploadTtlMs,
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      error: error.statusCode ? "Invalid upload session request." : "Unable to start cost upload session.",
      detail: error.message,
    });
  }
});

app.post("/api/cost-upload/file", async (req, res) => {
  try {
    const uploadId = validateUploadId(req.body?.uploadId);
    const meta = await readUploadMeta(uploadId);
    meta.pendingFiles ||= {};
    const file = validateCostFile(req.body?.file, meta.uploadedFiles);

    if (meta.paths.includes(file.relativePath)) {
      throw badRequest(`Duplicate file path: ${file.relativePath}`);
    }
    if (meta.pendingFiles[file.relativePath]) {
      throw badRequest(`File is already being uploaded in chunks: ${file.relativePath}`);
    }
    if (meta.uploadedFiles + 1 > maxCostFiles) {
      throw badRequest(`Too many files. Maximum is ${maxCostFiles}.`);
    }
    if (meta.uploadedBytes + pendingUploadBytes(meta) + file.bytes > maxCostBytes) {
      throw badRequest(`Payload is too large. Maximum total size is ${maxCostBytes} bytes.`);
    }

    await writeUploadedCostFile(uploadId, file);
    meta.uploadedFiles += 1;
    meta.uploadedBytes += file.bytes;
    meta.updatedAt = Date.now();
    meta.paths.push(file.relativePath);
    await writeUploadMeta(meta);

    res.json({
      ok: true,
      uploadedFiles: meta.uploadedFiles,
      uploadedBytes: meta.uploadedBytes,
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      error: error.statusCode ? "Invalid cost upload file." : "Unable to upload cost file.",
      detail: error.message,
    });
  }
});

app.post("/api/cost-upload/chunk", async (req, res) => {
  try {
    const uploadId = validateUploadId(req.body?.uploadId);
    const meta = await readUploadMeta(uploadId);
    meta.pendingFiles ||= {};

    const { relativePath, isSessionJsonl } = validateCostRelativePath(req.body?.relativePath, meta.uploadedFiles);
    const content = req.body?.content;
    const chunkIndex = Number(req.body?.chunkIndex);
    const totalChunks = Number(req.body?.totalChunks);
    if (typeof content !== "string") {
      throw badRequest("content must be a string.");
    }
    if (!Number.isInteger(chunkIndex) || chunkIndex < 0) {
      throw badRequest("chunkIndex must be a non-negative integer.");
    }
    if (!Number.isInteger(totalChunks) || totalChunks < 1) {
      throw badRequest("totalChunks must be a positive integer.");
    }
    if (chunkIndex >= totalChunks) {
      throw badRequest("chunkIndex must be less than totalChunks.");
    }
    if (meta.paths.includes(relativePath)) {
      throw badRequest(`Duplicate file path: ${relativePath}`);
    }
    if (meta.uploadedFiles + Object.keys(meta.pendingFiles).length + 1 > maxCostFiles && !meta.pendingFiles[relativePath]) {
      throw badRequest(`Too many files. Maximum is ${maxCostFiles}.`);
    }

    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > maxCostChunkBytes) {
      throw badRequest(`Chunk is too large. Maximum chunk size is ${maxCostChunkBytes} bytes.`);
    }

    if (chunkIndex === 0) {
      if (meta.pendingFiles[relativePath]) {
        throw badRequest(`File is already being uploaded: ${relativePath}`);
      }
      const destination = uploadedCostFilePath(uploadId, relativePath);
      await fs.promises.rm(`${destination}.uploading`, { force: true });
      meta.pendingFiles[relativePath] = {
        bytes: 0,
        isSessionJsonl,
        nextChunkIndex: 0,
        totalChunks,
      };
    }

    const pending = meta.pendingFiles[relativePath];
    if (!pending) {
      throw badRequest(`Chunk upload was not started for: ${relativePath}`);
    }
    if (pending.totalChunks !== totalChunks) {
      throw badRequest(`totalChunks changed for: ${relativePath}`);
    }
    if (pending.nextChunkIndex !== chunkIndex) {
      throw badRequest(`Expected chunk ${pending.nextChunkIndex} for ${relativePath}.`);
    }
    if (pending.bytes + bytes > maxCostFileBytes) {
      throw badRequest(`File is too large. Maximum file size is ${maxCostFileBytes} bytes.`);
    }
    if (meta.uploadedBytes + pendingUploadBytes(meta) + bytes > maxCostBytes) {
      throw badRequest(`Payload is too large. Maximum total size is ${maxCostBytes} bytes.`);
    }

    const destination = await appendUploadedCostFileChunk(uploadId, { relativePath, content });
    pending.bytes += bytes;
    pending.nextChunkIndex += 1;
    meta.updatedAt = Date.now();

    let completed = false;
    if (pending.nextChunkIndex === totalChunks) {
      await validateUploadedFile(relativePath, pending.isSessionJsonl, `${destination}.uploading`);
      await fs.promises.rename(`${destination}.uploading`, destination);
      meta.uploadedFiles += 1;
      meta.uploadedBytes += pending.bytes;
      meta.paths.push(relativePath);
      delete meta.pendingFiles[relativePath];
      completed = true;
    }

    await writeUploadMeta(meta);
    res.json({
      ok: true,
      completed,
      uploadedFiles: meta.uploadedFiles,
      uploadedBytes: meta.uploadedBytes,
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      error: error.statusCode ? "Invalid cost upload chunk." : "Unable to upload cost file chunk.",
      detail: error.message,
    });
  }
});

app.post("/api/cost-upload/finish", async (req, res) => {
  let dir = null;

  try {
    const uploadId = validateUploadId(req.body?.uploadId);
    dir = uploadDir(uploadId);
    const meta = await readUploadMeta(uploadId);
    if (Object.keys(meta.pendingFiles || {}).length) {
      throw badRequest("Upload session still has unfinished file chunks.");
    }
    if (!meta.paths.some((filePath) => filePath.endsWith(".jsonl"))) {
      throw badRequest("Upload session does not contain any JSONL files.");
    }

    const reports = await usageReportsRunner(meta.speed, {
      HOME: dir,
      USERPROFILE: dir,
    });

    res.json({
      generatedAt: new Date().toISOString(),
      speed: meta.speed,
      costSource: "ccusage",
      localParse: true,
      localSourceLabel: meta.sourceLabel,
      uploadedFiles: meta.uploadedFiles,
      uploadedBytes: meta.uploadedBytes,
      uploadMode: "session",
      codexHomes: [
        {
          home: meta.sourceLabel,
          exists: true,
          sessionsExists: meta.paths.some((filePath) => filePath.startsWith("sessions/")),
          archivedSessionsExists: meta.paths.some((filePath) => filePath.startsWith("archived_sessions/")),
        },
      ],
      ...reports,
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      error: error.statusCode ? "Invalid cost upload session." : "Unable to calculate Codex usage cost.",
      detail: error.message,
    });
  } finally {
    if (dir) {
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  }
});

app.post("/api/cost", async (req, res) => {
  let tempHome = null;

  try {
    const payload = validateCostPayload(req.body);
    const temp = await writeCostPayloadToTempCodex(payload.files);
    tempHome = temp.tempHome;

    const reports = await usageReportsRunner(payload.speed, {
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

app.use((error, req, res, next) => {
  if (error?.type === "entity.too.large" || error?.status === 413) {
    res.status(413).json({
      error: "Request body is too large.",
      detail: "The selected .codex folder is too large for a single request. Refresh and try again; the app will use file-by-file upload for backend cost calculation.",
    });
    return;
  }
  next(error);
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

if (require.main === module) {
  listen(preferredPort);
}

module.exports = {
  app,
  listen,
  resetUsageReportsRunner,
  setUsageReportsRunner,
  validateCostFile,
  validateCostPayload,
  validateCostRelativePath,
  weeklyFromDaily,
};
