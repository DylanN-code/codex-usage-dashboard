const query = new URLSearchParams(window.location.search);
const validViews = new Set(["daily", "weekly", "monthly", "sessions"]);
const validMetrics = new Set([
  "costUSD",
  "totalTokens",
  "inputTokens",
  "cachedInputTokens",
  "outputTokens",
  "reasoningOutputTokens",
]);
const validRanges = new Set(["7", "14", "30", "all"]);
const validSpeeds = new Set(["auto", "standard", "fast"]);
const validThemes = new Set(["dark", "light", "system"]);
const compositionKeys = ["inputTokens", "cachedInputTokens", "outputTokens", "reasoningOutputTokens"];
const billingKeys = ["cachedInputTokens", "inputTokens", "outputTokens", "reasoningOutputTokens"];
const MODEL_PRICING_USD_PER_1M = [
  { pattern: /^gpt-5\.5($|[-:])/i, input: 5.0, cachedInput: 0.5, output: 30.0 },
  { pattern: /^gpt-5\.4($|[-:])/i, input: 2.5, cachedInput: 0.25, output: 15.0 },
  { pattern: /^gpt-5\.3-codex($|[-:])/i, input: 1.75, cachedInput: 0.175, output: 14.0 },
  { pattern: /^gpt-5($|[-:])/i, input: 1.25, cachedInput: 0.125, output: 10.0 },
  { pattern: /^chat-latest($|[-:])/i, input: 5.0, cachedInput: 0.5, output: 30.0 },
];
const DEFAULT_MODEL_PRICING_USD_PER_1M = { input: 1.25, cachedInput: 0.125, output: 10.0 };

const state = {
  data: null,
  sourceMode: query.get("source") === "local" ? "local" : "api",
  localCodexHandle: null,
  localSourceLabel: "",
  apiBase: "",
  view: validViews.has(query.get("view")) ? query.get("view") : "daily",
  metric: validMetrics.has(query.get("metric")) ? query.get("metric") : "costUSD",
  range: validRanges.has(query.get("range")) ? query.get("range") : "30",
  speed: validSpeeds.has(query.get("speed")) ? query.get("speed") : "auto",
  theme: validThemes.has(query.get("theme"))
    ? query.get("theme")
    : localStorage.getItem("codex-usage-theme") || "system",
  activityMetric: validMetrics.has(query.get("activityMetric")) ? query.get("activityMetric") : "totalTokens",
  compositionVisible: (() => {
    const picked = (query.get("composition") || "")
      .split(",")
      .map((value) => value.trim())
      .filter((value) => compositionKeys.includes(value));
    const activeSet = new Set(picked.length ? picked : compositionKeys);
    return Object.fromEntries(compositionKeys.map((key) => [key, activeSet.has(key)]));
  })(),
  billingVisible: (() => {
    const picked = (query.get("billing") || "")
      .split(",")
      .map((value) => value.trim())
      .filter((value) => billingKeys.includes(value));
    const activeSet = new Set(picked.length ? picked : billingKeys);
    return Object.fromEntries(billingKeys.map((key) => [key, activeSet.has(key)]));
  })(),
  modelVisible: {},
  filters: {
    q: query.get("q") || "",
    start: query.get("start") || "",
    end: query.get("end") || "",
    model: query.get("model") || "all",
  },
  widgets: {
    hidden: new Set(JSON.parse(localStorage.getItem("codex-usage-hidden-widgets") || "[]")),
    sizes: JSON.parse(localStorage.getItem("codex-usage-widget-sizes") || "{}"),
    widths: JSON.parse(localStorage.getItem("codex-usage-widget-widths") || "{}"),
  },
};

const metricLabels = {
  costUSD: "Cost",
  totalTokens: "Total Tokens",
  inputTokens: "Input Tokens",
  cachedInputTokens: "Cached Input",
  outputTokens: "Output Tokens",
  reasoningOutputTokens: "Thinking Tokens",
};

const metricColors = {
  costUSD: "--teal",
  totalTokens: "--blue",
  inputTokens: "--coral",
  cachedInputTokens: "--amber",
  outputTokens: "--blue",
  reasoningOutputTokens: "--teal-dark",
};

const els = {
  status: document.querySelector("#status"),
  refreshButton: document.querySelector("#refreshButton"),
  loadLocalButton: document.querySelector("#loadLocalButton"),
  widgetsButton: document.querySelector("#widgetsButton"),
  dashboardPanels: document.querySelector("#dashboardPanels"),
  dashboardTooltip: document.querySelector("#dashboardTooltip"),
  widgetSidebar: document.querySelector("#widgetSidebar"),
  widgetList: document.querySelector("#widgetList"),
  resetWidgetsButton: document.querySelector("#resetWidgetsButton"),
  closeWidgetsButton: document.querySelector("#closeWidgetsButton"),
  widgetBackdrop: document.querySelector("#widgetBackdrop"),
  dataSource: document.querySelector("#dataSource"),
  totalCost: document.querySelector("#totalCost"),
  totalTokens: document.querySelector("#totalTokens"),
  cachedTokens: document.querySelector("#cachedTokens"),
  outputTokens: document.querySelector("#outputTokens"),
  summaryScope: document.querySelector("#summaryScope"),
  insights: document.querySelector("#insights"),
  insightWindow: document.querySelector("#insightWindow"),
  searchInput: document.querySelector("#searchInput"),
  startDateInput: document.querySelector("#startDateInput"),
  endDateInput: document.querySelector("#endDateInput"),
  modelSelect: document.querySelector("#modelSelect"),
  clearFiltersButton: document.querySelector("#clearFiltersButton"),
  metricSelect: document.querySelector("#metricSelect"),
  rangeSelect: document.querySelector("#rangeSelect"),
  chart: document.querySelector("#chart"),
  chartTitle: document.querySelector("#chartTitle"),
  chartSubtitle: document.querySelector("#chartSubtitle"),
  chartTotal: document.querySelector("#chartTotal"),
  modelPie: document.querySelector("#modelPie"),
  billingChart: document.querySelector("#billingChart"),
  compositionChart: document.querySelector("#compositionChart"),
  activityHeatmap: document.querySelector("#activityHeatmap"),
  modelMix: document.querySelector("#modelMix"),
  topSessions: document.querySelector("#topSessions"),
  tableTitle: document.querySelector("#tableTitle"),
  tableCount: document.querySelector("#tableCount"),
  tableHead: document.querySelector("#tableHead"),
  tableBody: document.querySelector("#tableBody"),
  analyticsGrid: document.querySelector("#analyticsGrid"),
  sessionsSplit: document.querySelector("#sessionsSplit"),
};

const widgetSizes = {
  auto: "",
  s: "180px",
  m: "260px",
  l: "360px",
  xl: "500px",
};

const widgetWidths = {
  auto: "",
  n: "40%",
  h: "50%",
  w: "75%",
  f: "100%",
};

const defaultPanelOrder = ["filters", "summary", "insights", "usage-chart", "analytics", "sessions", "table"];

function number(value) {
  return Number(value || 0);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatInt(value) {
  return new Intl.NumberFormat().format(Math.round(number(value)));
}

function formatCompact(value) {
  return new Intl.NumberFormat(undefined, {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(number(value));
}

function formatMoney(value) {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(number(value));
}

function formatMetric(value, metric = state.metric) {
  return metric === "costUSD" ? formatMoney(value) : formatCompact(value);
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function formatPercent(value) {
  if (!Number.isFinite(value)) return "0%";
  return new Intl.NumberFormat(undefined, {
    maximumFractionDigits: 1,
    style: "percent",
  }).format(value);
}

function platformCodexPathHint() {
  const platform = (navigator.userAgentData?.platform || navigator.platform || navigator.userAgent || "").toLowerCase();
  if (platform.includes("win")) return "%USERPROFILE%\\.codex";
  if (platform.includes("android")) return "$HOME/.codex";
  return "$HOME/.codex";
}

function pricingForModel(model = "") {
  const normalized = String(model || "").toLowerCase();
  for (const rule of MODEL_PRICING_USD_PER_1M) {
    if (rule.pattern.test(normalized)) {
      return rule;
    }
  }
  return DEFAULT_MODEL_PRICING_USD_PER_1M;
}

function estimateCostUsd({ model, inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens }) {
  const pricing = pricingForModel(model);
  const totalOutput = number(outputTokens) + number(reasoningOutputTokens);
  const inputCost = number(inputTokens) * (pricing.input / 1_000_000);
  const cachedInputCost = number(cachedInputTokens) * (pricing.cachedInput / 1_000_000);
  const outputCost = totalOutput * (pricing.output / 1_000_000);
  return inputCost + cachedInputCost + outputCost;
}

function sum(rows, key) {
  return rows.reduce((total, row) => total + number(row[key]), 0);
}

function addUsage(target, source) {
  for (const key of [
    "costUSD",
    "totalTokens",
    "inputTokens",
    "cachedInputTokens",
    "outputTokens",
    "reasoningOutputTokens",
  ]) {
    target[key] = number(target[key]) + number(source[key]);
  }
  return target;
}

function labelForRow(row) {
  if (row.date) return row.date;
  if (row.weekStart && row.weekEnd) return `${row.weekStart} to ${row.weekEnd}`;
  if (row.month) return row.month;
  if (row.lastActivity) return new Date(row.lastActivity).toLocaleDateString();
  return row.sessionFile || row.sessionId || "-";
}

function rowDate(row) {
  if (row.date) return row.date;
  if (row.weekStart) return row.weekStart;
  if (row.month) return `${row.month}-01`;
  if (row.lastActivity) return new Date(row.lastActivity).toISOString().slice(0, 10);
  return "";
}

function sourceRows(view = state.view) {
  if (!state.data) return [];
  if (view === "sessions") return state.data.sessions || [];
  if (view === "monthly") return state.data.monthly || [];
  if (view === "weekly") return state.data.weekly || [];
  return state.data.daily || [];
}

function rowMatchesFilters(row) {
  const date = rowDate(row);
  if (state.filters.start && date && date < state.filters.start) return false;
  if (state.filters.end && date && date > state.filters.end) return false;

  const models = Object.keys(row.models || {});
  if (state.filters.model !== "all" && !models.includes(state.filters.model)) {
    return false;
  }

  const q = state.filters.q.trim().toLowerCase();
  if (q) {
    const haystack = [
      labelForRow(row),
      row.sessionFile,
      row.sessionId,
      row.directory,
      models.join(" "),
    ].filter(Boolean).join(" ").toLowerCase();
    if (!haystack.includes(q)) return false;
  }

  return true;
}

function filteredRows(view = state.view, { applyRange = true } = {}) {
  const rows = sourceRows(view).filter(rowMatchesFilters);
  const sorted = [...rows];

  if (view === "sessions") {
    sorted.sort((a, b) => new Date(a.lastActivity || 0) - new Date(b.lastActivity || 0));
  }

  if (!applyRange || state.range === "all") return sorted;
  return sorted.slice(-Number(state.range));
}

function filteredDaily({ applyRange = false } = {}) {
  return filteredRows("daily", { applyRange });
}

function aggregateRows(rows) {
  return rows.reduce((total, row) => addUsage(total, row), {
    cachedInputTokens: 0,
    costUSD: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
  });
}

function setLoading(isLoading) {
  els.refreshButton.disabled = isLoading;
  if (els.loadLocalButton) els.loadLocalButton.disabled = isLoading;
  els.refreshButton.textContent = isLoading ? "Refreshing" : "Refresh";
}

function syncUrl() {
  const params = new URLSearchParams();
  params.set("view", state.view);
  params.set("metric", state.metric);
  params.set("range", state.range);
  params.set("speed", state.speed);
  params.set("theme", state.theme);
  params.set("source", state.sourceMode);
  params.set("activityMetric", state.activityMetric);
  const activeComposition = compositionKeys.filter((key) => state.compositionVisible[key]);
  if (activeComposition.length !== compositionKeys.length) {
    params.set("composition", activeComposition.join(","));
  }
  const activeBilling = billingKeys.filter((key) => state.billingVisible[key]);
  if (activeBilling.length !== billingKeys.length) {
    params.set("billing", activeBilling.join(","));
  }
  const modelKeys = Object.keys(state.modelVisible);
  if (modelKeys.length) {
    const activeModels = modelKeys.filter((key) => state.modelVisible[key]);
    if (activeModels.length !== modelKeys.length) {
      params.set("modelVisible", activeModels.join(","));
    }
  }
  if (state.filters.q) params.set("q", state.filters.q);
  if (state.filters.start) params.set("start", state.filters.start);
  if (state.filters.end) params.set("end", state.filters.end);
  if (state.filters.model !== "all") params.set("model", state.filters.model);
  window.history.replaceState({}, "", `${window.location.pathname}?${params.toString()}`);
}

function renderDataSource(payload) {
  if (payload.localParse) {
    const source = payload.localSourceLabel || "{basePath}/.codex";
    const hint = platformCodexPathHint();
    const costSource = payload.costSource === "ccusage"
      ? "Cost calculated by backend ccusage."
      : "Cost estimated in browser.";
    els.dataSource.textContent = `Data source: ${source} loaded from local Codex JSONL files. Default path hint: ${hint}. ${costSource}`;
    return;
  }
  const sources = (payload.codexHomes || []).map((item) => item.home).join(", ");
  const fallback = payload.defaultCodexHome ? ` (default ${payload.defaultCodexHome})` : "";
  els.dataSource.textContent = `Data source: ${sources || "unknown"}${fallback} via ccusage codex daily, monthly, and session reports.`;
}

function startOfIsoWeek(date) {
  const copy = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = copy.getUTCDay() || 7;
  copy.setUTCDate(copy.getUTCDate() - day + 1);
  return copy;
}

function weeklyFromDailyRows(dailyRows) {
  const weeks = new Map();
  for (const row of dailyRows) {
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
    const target = weeks.get(week);
    addUsage(target, row);
    for (const [model, details] of Object.entries(row.models || {})) {
      target.models[model] ||= {
        cachedInputTokens: 0,
        inputTokens: 0,
        isFallback: false,
        outputTokens: 0,
        reasoningOutputTokens: 0,
        totalTokens: 0,
      };
      addUsage(target.models[model], details);
    }
  }
  return [...weeks.values()].sort((a, b) => a.week.localeCompare(b.week));
}

async function ensureReadPermission(handle) {
  if (typeof handle.queryPermission !== "function") return true;
  const options = { mode: "read" };
  if ((await handle.queryPermission(options)) === "granted") return true;
  return (await handle.requestPermission(options)) === "granted";
}

async function getCodexRootHandleFromPicker() {
  if (typeof window.showDirectoryPicker !== "function") {
    throw new Error("Your browser does not support local directory picker. Use a Chromium-based browser.");
  }
  const picked = await window.showDirectoryPicker({ mode: "read" });
  if (!(await ensureReadPermission(picked))) {
    throw new Error("Local directory read permission was not granted.");
  }
  if (picked.name === ".codex") {
    return { codexHandle: picked, label: "{basePath}/.codex" };
  }
  try {
    const codexHandle = await picked.getDirectoryHandle(".codex", { create: false });
    if (!(await ensureReadPermission(codexHandle))) {
      throw new Error("Local .codex folder read permission was not granted.");
    }
    return { codexHandle, label: `${picked.name}/.codex` };
  } catch {
    throw new Error("Selected folder does not contain a .codex directory.");
  }
}

async function collectJsonlFiles(dirHandle, prefix = "") {
  const files = [];
  for await (const handle of dirHandle.values()) {
    if (handle.kind === "directory") {
      const nested = await collectJsonlFiles(handle, `${prefix}${handle.name}/`);
      files.push(...nested);
      continue;
    }
    if (handle.kind === "file" && handle.name.endsWith(".jsonl")) {
      files.push({ handle, relativePath: `${prefix}${handle.name}` });
    }
  }
  return files;
}

function usageFromTokenCount(lastTokenUsage = {}) {
  const output = number(lastTokenUsage.output_tokens);
  const reasoning = number(lastTokenUsage.reasoning_output_tokens);
  const inputTokens = number(lastTokenUsage.input_tokens);
  const cachedInputTokens = number(lastTokenUsage.cached_input_tokens);
  const outputTokens = Math.max(output - reasoning, 0);
  const reasoningOutputTokens = reasoning;
  return {
    cachedInputTokens,
    costUSD: 0,
    inputTokens,
    outputTokens,
    reasoningOutputTokens,
    totalTokens: number(lastTokenUsage.total_tokens),
  };
}

async function parseSessionJsonlFile(fileHandle, relativePath, scopeName) {
  const file = await fileHandle.getFile();
  const text = await file.text();
  const lines = text.split(/\n+/);
  const turns = [];

  let currentModel = "unknown";
  let latestTokenUsage = null;
  let sessionId = file.name.replace(/\.jsonl$/i, "");
  let cwd = "";

  for (const line of lines) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }

    if (row.type === "session_meta") {
      sessionId = row.payload?.id || sessionId;
      cwd = row.payload?.cwd || cwd;
      continue;
    }

    if (row.type === "turn_context" && row.payload?.model) {
      currentModel = row.payload.model;
      continue;
    }

    if (row.type === "event_msg" && row.payload?.type === "token_count") {
      const usage = row.payload?.info?.last_token_usage;
      if (usage && typeof usage === "object") {
        latestTokenUsage = usage;
      }
      continue;
    }

    if (row.type === "event_msg" && row.payload?.type === "task_complete" && latestTokenUsage) {
      const completedAt = number(row.payload?.completed_at);
      const eventDate = completedAt
        ? new Date(completedAt * 1000)
        : new Date(row.timestamp || file.lastModified);
      const usage = usageFromTokenCount(latestTokenUsage);
      usage.costUSD = estimateCostUsd({
        model: currentModel || "unknown",
        inputTokens: usage.inputTokens,
        cachedInputTokens: usage.cachedInputTokens,
        outputTokens: usage.outputTokens,
        reasoningOutputTokens: usage.reasoningOutputTokens,
      });
      turns.push({
        ...usage,
        date: isoDate(eventDate),
        directory: cwd || `${scopeName}/unknown`,
        lastActivity: eventDate.toISOString(),
        model: currentModel || "unknown",
        sessionFile: relativePath,
        sessionId,
      });
      latestTokenUsage = null;
    }
  }

  return turns;
}

async function postJson(endpoint, body) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const isJson = (response.headers.get("content-type") || "").includes("application/json");
  const payload = isJson ? await response.json() : null;

  if (!response.ok || !payload) {
    throw new Error(payload?.detail || payload?.error || `Request failed (${response.status}).`);
  }

  return payload;
}

async function uploadCostFile(uploadId, relativePath, file) {
  await postJson("/api/cost-upload/file", {
    uploadId,
    file: {
      relativePath,
      content: await file.text(),
    },
  });
}

async function calculateCostWithBackend(fileEntries, localSourceLabel, codexHandle) {
  els.status.textContent = "Starting backend ccusage upload...";
  const session = await postJson("/api/cost-upload/start", {
    speed: state.speed,
    sourceLabel: localSourceLabel,
  });

  for (let index = 0; index < fileEntries.length; index += 1) {
    const entry = fileEntries[index];
    els.status.textContent = `Uploading local .codex files for backend cost calculation... ${index + 1}/${fileEntries.length}`;
    const file = await entry.handle.getFile();
    await uploadCostFile(session.uploadId, entry.relativePath, file);
  }

  try {
    const configHandle = await codexHandle.getFileHandle("config.toml", { create: false });
    const configFile = await configHandle.getFile();
    els.status.textContent = "Uploading local .codex config for backend cost calculation...";
    await uploadCostFile(session.uploadId, "config.toml", configFile);
  } catch {
    // config.toml is optional; ccusage can still calculate with explicit speed modes.
  }

  els.status.textContent = "Calculating cost with backend ccusage...";
  return postJson("/api/cost-upload/finish", { uploadId: session.uploadId });
}

function aggregateLocalTurns(turns, localSourceLabel) {
  const daily = new Map();
  const monthly = new Map();
  const sessions = new Map();
  const totals = {
    cachedInputTokens: 0,
    costUSD: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
  };

  for (const turn of turns) {
    addUsage(totals, turn);

    if (!daily.has(turn.date)) {
      daily.set(turn.date, {
        date: turn.date,
        cachedInputTokens: 0,
        costUSD: 0,
        inputTokens: 0,
        models: {},
        outputTokens: 0,
        reasoningOutputTokens: 0,
        totalTokens: 0,
      });
    }
    const day = daily.get(turn.date);
    addUsage(day, turn);
    day.models[turn.model] ||= {
      cachedInputTokens: 0,
      inputTokens: 0,
      isFallback: false,
      outputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 0,
    };
    addUsage(day.models[turn.model], turn);

    const monthKey = turn.date.slice(0, 7);
    if (!monthly.has(monthKey)) {
      monthly.set(monthKey, {
        month: monthKey,
        cachedInputTokens: 0,
        costUSD: 0,
        inputTokens: 0,
        models: {},
        outputTokens: 0,
        reasoningOutputTokens: 0,
        totalTokens: 0,
      });
    }
    const month = monthly.get(monthKey);
    addUsage(month, turn);
    month.models[turn.model] ||= {
      cachedInputTokens: 0,
      inputTokens: 0,
      isFallback: false,
      outputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 0,
    };
    addUsage(month.models[turn.model], turn);

    const sessionKey = turn.sessionFile || turn.sessionId;
    if (!sessions.has(sessionKey)) {
      sessions.set(sessionKey, {
        sessionId: turn.sessionId,
        sessionFile: turn.sessionFile,
        directory: turn.directory,
        lastActivity: turn.lastActivity,
        cachedInputTokens: 0,
        costUSD: 0,
        inputTokens: 0,
        models: {},
        outputTokens: 0,
        reasoningOutputTokens: 0,
        totalTokens: 0,
      });
    }
    const session = sessions.get(sessionKey);
    addUsage(session, turn);
    if (turn.lastActivity > session.lastActivity) {
      session.lastActivity = turn.lastActivity;
    }
    session.models[turn.model] ||= {
      cachedInputTokens: 0,
      inputTokens: 0,
      isFallback: false,
      outputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 0,
    };
    addUsage(session.models[turn.model], turn);
  }

  const dailyRows = [...daily.values()].sort((a, b) => a.date.localeCompare(b.date));
  const monthlyRows = [...monthly.values()].sort((a, b) => a.month.localeCompare(b.month));
  const sessionRows = [...sessions.values()].sort((a, b) => new Date(a.lastActivity) - new Date(b.lastActivity));

  return {
    generatedAt: new Date().toISOString(),
    localParse: true,
    localSourceLabel,
    speed: "local",
    codexHomes: [
      {
        home: localSourceLabel,
        exists: true,
        sessionsExists: true,
        archivedSessionsExists: true,
      },
    ],
    daily: dailyRows,
    weekly: weeklyFromDailyRows(dailyRows),
    monthly: monthlyRows,
    sessions: sessionRows,
    totals,
  };
}

function normalizeApiBase(base) {
  if (!base) return "";
  return String(base).replace(/\/+$/, "");
}

function usageCandidates() {
  const set = new Set();
  const currentBase = normalizeApiBase(state.apiBase);

  if (currentBase) set.add(currentBase);
  set.add("");

  return [...set];
}

async function fetchUsageFromBase(apiBase) {
  const base = normalizeApiBase(apiBase);
  const endpoint = `${base}/api/usage?speed=${encodeURIComponent(state.speed)}`;
  const response = await fetch(endpoint);
  const isJson = (response.headers.get("content-type") || "").includes("application/json");
  const payload = isJson ? await response.json() : null;

  if (!isJson || !payload) {
    throw new Error(`API usage endpoint is unavailable at ${base || window.location.origin}.`);
  }

  if (!response.ok) {
    const baseError = payload?.detail || payload?.error || `Request failed (${response.status})`;
    const homes = payload?.codexHomes || [];
    const pathList = homes.map((home) => home.home).filter(Boolean);
    const pathHint = pathList.length ? ` Checked: ${pathList.join(", ")}.` : "";
    throw new Error(`${baseError}${pathHint}`);
  }

  return { payload, base };
}

async function loadUsageFromLocalHandle(codexHandle, localSourceLabel) {
  setLoading(true);
  els.status.classList.remove("error");
  els.status.textContent = "Reading local .codex files...";

  try {
    const fileEntries = [];
    for (const bucket of ["sessions", "archived_sessions"]) {
      try {
        const dir = await codexHandle.getDirectoryHandle(bucket, { create: false });
        if (!(await ensureReadPermission(dir))) continue;
        const found = await collectJsonlFiles(dir, `${bucket}/`);
        fileEntries.push(...found.map((entry) => ({ ...entry, scopeName: bucket })));
      } catch {
        continue;
      }
    }

    if (!fileEntries.length) {
      throw new Error("No .jsonl session files found under .codex/sessions or .codex/archived_sessions.");
    }

    let data;
    try {
      data = await calculateCostWithBackend(fileEntries, localSourceLabel, codexHandle);
    } catch (backendError) {
      els.status.textContent = `Backend ccusage unavailable. Reading local .codex files in browser...`;
      const turns = [];
      for (let index = 0; index < fileEntries.length; index += 1) {
        if (index % 40 === 0) {
          els.status.textContent = `Reading local .codex files... ${index}/${fileEntries.length}`;
        }
        const entry = fileEntries[index];
        const parsed = await parseSessionJsonlFile(entry.handle, entry.relativePath, entry.scopeName);
        turns.push(...parsed);
      }

      if (!turns.length) {
        throw new Error("No usable token usage records were found in selected .codex files.");
      }
      data = aggregateLocalTurns(turns, localSourceLabel);
      data.costSource = "browser-estimate";
      data.backendCostError = backendError.message;
    }

    state.localCodexHandle = codexHandle;
    state.localSourceLabel = localSourceLabel;
    state.sourceMode = "local";
    state.data = data;
    initializeModelVisibility();
    populateModelFilter();
    syncControls();
    renderDataSource(state.data);
    const costSource = state.data.costSource === "ccusage" ? "backend ccusage" : "browser estimate";
    els.status.textContent = `Updated ${new Date(state.data.generatedAt).toLocaleString()} from local .codex using ${costSource}`;
    render();
  } catch (error) {
    els.status.classList.add("error");
    els.status.textContent = error.message;
  } finally {
    setLoading(false);
  }
}

async function loadUsageFromLocalPicker() {
  try {
    const { codexHandle, label } = await getCodexRootHandleFromPicker();
    await loadUsageFromLocalHandle(codexHandle, label);
  } catch (error) {
    if (error?.name === "AbortError") {
      els.status.classList.remove("error");
      els.status.textContent = "Local folder selection canceled. Use Select .codex Path when you're ready.";
      return;
    }
    els.status.classList.add("error");
    els.status.textContent = error.message;
  }
}

function renderInitialLocalAccessPrompt() {
  return new Promise((resolve) => {
    els.status.classList.remove("error");
    els.status.innerHTML = `
      <div class="status-consent">
        <span>Allow local usage lookup? If you agree, the app will first search the assumed default path <code>{basePath}/.codex</code>. If you skip, use <strong>Select .codex Path</strong> anytime.</span>
        <div class="status-consent-actions">
          <button class="primary" type="button" data-local-consent="allow">Allow and search default .codex path</button>
          <button class="secondary" type="button" data-local-consent="skip">Not now</button>
        </div>
      </div>
    `;

    const allowButton = els.status.querySelector('[data-local-consent="allow"]');
    const skipButton = els.status.querySelector('[data-local-consent="skip"]');

    allowButton?.addEventListener("click", async () => {
      await loadUsage();
      resolve();
    }, { once: true });

    skipButton?.addEventListener("click", () => {
      els.status.classList.remove("error");
      els.status.textContent = "Local access skipped. Use Select .codex Path to load local usage data.";
      resolve();
    }, { once: true });
  });
}

async function loadInitialData() {
  if (typeof window.showDirectoryPicker === "function") {
    await renderInitialLocalAccessPrompt();
    return;
  }

  await loadUsage();
}

function allWidgets() {
  return [...document.querySelectorAll("[data-widget-id]")];
}

function applyWidgetSize(widget, size) {
  const picked = widgetSizes[size] !== undefined ? size : "auto";
  widget.dataset.widgetSize = picked;
  widget.style.minHeight = widgetSizes[picked] || "";
}

function applyWidgetWidth(widget, width) {
  const picked = widgetWidths[width] !== undefined ? width : "auto";
  widget.dataset.widgetWidth = picked;
  widget.style.width = widgetWidths[picked] || "";
  widget.style.justifySelf = picked === "auto" || picked === "f" ? "stretch" : "start";
}

function applyWidgetState() {
  for (const widget of allWidgets()) {
    const id = widget.dataset.widgetId;
    widget.classList.toggle("is-hidden", state.widgets.hidden.has(id));
    applyWidgetSize(widget, state.widgets.sizes[id] || "auto");
    applyWidgetWidth(widget, state.widgets.widths[id] || "auto");
  }
  updateWidgetContainers();
}

function persistWidgets() {
  localStorage.setItem("codex-usage-hidden-widgets", JSON.stringify([...state.widgets.hidden]));
  localStorage.setItem("codex-usage-widget-sizes", JSON.stringify(state.widgets.sizes));
  localStorage.setItem("codex-usage-widget-widths", JSON.stringify(state.widgets.widths));
}

function updateWidgetContainers() {
  const analyticsHiddenByToggle = state.widgets.hidden.has("usage-analytics");
  const analyticsCards = [...els.analyticsGrid.querySelectorAll(".analytics-card")];
  const visibleAnalytics = analyticsCards.some((card) => !card.classList.contains("is-hidden"));
  els.analyticsGrid.classList.toggle("is-hidden", analyticsHiddenByToggle || !visibleAnalytics);

  const sessionsHiddenByToggle = state.widgets.hidden.has("sessions-panel");
  const splitCards = [...els.sessionsSplit.querySelectorAll(".widget")];
  const visibleSplit = splitCards.filter((card) => !card.classList.contains("is-hidden"));
  els.sessionsSplit.classList.toggle("is-hidden", sessionsHiddenByToggle || visibleSplit.length === 0);
  els.sessionsSplit.classList.toggle("split-single", visibleSplit.length === 1);
}

function renderWidgetSidebar() {
  const options = allWidgets().map((widget) => {
    const id = widget.dataset.widgetId;
    const label = widget.dataset.widgetLabel || id;
    const visible = !state.widgets.hidden.has(id);
    const size = state.widgets.sizes[id] || "auto";
    const width = state.widgets.widths[id] || "auto";
    return `
      <div class="widget-item">
        <label>
          <input type="checkbox" data-widget-toggle="${escapeHtml(id)}" ${visible ? "checked" : ""}>
          <span>${escapeHtml(label)}</span>
        </label>
        <select data-widget-size="${escapeHtml(id)}">
          <option value="auto" ${size === "auto" ? "selected" : ""}>Auto</option>
          <option value="s" ${size === "s" ? "selected" : ""}>S</option>
          <option value="m" ${size === "m" ? "selected" : ""}>M</option>
          <option value="l" ${size === "l" ? "selected" : ""}>L</option>
          <option value="xl" ${size === "xl" ? "selected" : ""}>XL</option>
        </select>
        <select data-widget-width="${escapeHtml(id)}" aria-label="${escapeHtml(label)} width">
          <option value="auto" ${width === "auto" ? "selected" : ""}>Auto width</option>
          <option value="n" ${width === "n" ? "selected" : ""}>Narrow</option>
          <option value="h" ${width === "h" ? "selected" : ""}>Half</option>
          <option value="w" ${width === "w" ? "selected" : ""}>Wide</option>
          <option value="f" ${width === "f" ? "selected" : ""}>Full</option>
        </select>
      </div>
    `;
  }).join("");
  els.widgetList.innerHTML = options;
}

function setWidgetSidebar(open) {
  els.widgetSidebar.classList.toggle("open", open);
  els.widgetSidebar.setAttribute("aria-hidden", open ? "false" : "true");
  els.widgetBackdrop.hidden = !open;
  els.widgetsButton?.setAttribute("aria-expanded", open ? "true" : "false");
}

function resetWidgetLayout() {
  state.widgets.hidden = new Set();
  state.widgets.sizes = {};
  state.widgets.widths = {};
  localStorage.removeItem("codex-usage-hidden-widgets");
  localStorage.removeItem("codex-usage-widget-sizes");
  localStorage.removeItem("codex-usage-widget-widths");
  localStorage.removeItem("codex-usage-panel-order");

  for (const id of defaultPanelOrder) {
    const panel = els.dashboardPanels.querySelector(`[data-panel-id="${CSS.escape(id)}"]`);
    if (panel) els.dashboardPanels.append(panel);
  }

  applyWidgetState();
  renderWidgetSidebar();
}

function initializeModelVisibility() {
  const models = [...new Set((state.data?.daily || []).flatMap((row) => Object.keys(row.models || {})))].sort();
  const picked = (query.get("modelVisible") || "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => models.includes(value));
  const activeSet = new Set(picked.length ? picked : models);
  state.modelVisible = Object.fromEntries(models.map((model) => [model, activeSet.has(model)]));
}

function syncControls() {
  els.metricSelect.value = state.metric;
  els.rangeSelect.value = state.range;
  els.searchInput.value = state.filters.q;
  els.startDateInput.value = state.filters.start;
  els.endDateInput.value = state.filters.end;
  els.modelSelect.value = state.filters.model;

  document.querySelectorAll("[data-view]").forEach((item) => {
    item.classList.toggle("active", item.dataset.view === state.view);
  });
  document.querySelectorAll("[data-speed]").forEach((item) => {
    item.classList.toggle("active", item.dataset.speed === state.speed);
  });
  document.querySelectorAll("[data-activity-metric]").forEach((item) => {
    item.classList.toggle("active", item.dataset.activityMetric === state.activityMetric);
  });
}

function populateModelFilter() {
  const current = state.filters.model;
  const models = [...new Set((state.data?.daily || []).flatMap((row) => Object.keys(row.models || {})))].sort();
  els.modelSelect.innerHTML = [
    `<option value="all">All models</option>`,
    ...models.map((model) => `<option value="${escapeHtml(model)}">${escapeHtml(model)}</option>`),
  ].join("");
  state.filters.model = current === "all" || models.includes(current) ? current : "all";
  els.modelSelect.value = state.filters.model;
}

async function loadUsage() {
  setLoading(true);
  els.status.classList.remove("error");
  els.status.textContent = "Loading Codex usage...";

  try {
    let loaded = null;
    let lastError = null;

    for (const candidate of usageCandidates()) {
      try {
        loaded = await fetchUsageFromBase(candidate);
        break;
      } catch (error) {
        lastError = error;
      }
    }

    if (!loaded) {
      throw lastError || new Error("API usage endpoint is unavailable in this deployment.");
    }

    const { payload, base } = loaded;
    state.data = payload;
    state.apiBase = base;
    state.sourceMode = "api";
    initializeModelVisibility();
    populateModelFilter();
    syncControls();
    renderDataSource({ ...payload, apiBase: base });
    els.status.textContent = `Updated ${new Date(payload.generatedAt).toLocaleString()}`;
    render();
  } catch (error) {
    els.status.classList.add("error");
    const hint = typeof window.showDirectoryPicker === "function"
      ? ` Click "Select .codex Path" for local estimate mode.`
      : "";
    els.status.textContent = `${error.message}${hint}`;
    if (els.dataSource) {
      els.dataSource.textContent = "Data source: public API unavailable. Select {basePath}/.codex path for local estimate mode.";
    }
  } finally {
    setLoading(false);
  }
}

function renderTotals() {
  const rows = filteredDaily({ applyRange: false });
  const totals = aggregateRows(rows);
  els.totalCost.textContent = formatMoney(totals.costUSD);
  els.totalTokens.textContent = formatCompact(totals.totalTokens);
  els.cachedTokens.textContent = formatCompact(totals.cachedInputTokens);
  els.outputTokens.textContent = formatCompact(number(totals.outputTokens) + number(totals.reasoningOutputTokens));

  const activeFilters = [
    state.filters.q ? `search "${state.filters.q}"` : "",
    state.filters.start ? `from ${state.filters.start}` : "",
    state.filters.end ? `to ${state.filters.end}` : "",
    state.filters.model !== "all" ? state.filters.model : "",
  ].filter(Boolean);
  els.summaryScope.textContent = activeFilters.length ? activeFilters.join(" / ") : "All usage";
}

function describeChange(current, previous) {
  if (!previous && current) return "new activity";
  if (!previous) return "flat";
  const change = (current - previous) / previous;
  const direction = change >= 0 ? "up" : "down";
  return `${direction} ${formatPercent(Math.abs(change))}`;
}

function tokenInsights() {
  const daily = filteredDaily({ applyRange: false });
  const totals = aggregateRows(daily);
  const recent = daily.slice(-7);
  const previous = daily.slice(-14, -7);
  const recentTotal = sum(recent, "totalTokens");
  const previousTotal = sum(previous, "totalTokens");
  const busiest = daily.reduce((best, row) => number(row.totalTokens) > number(best?.totalTokens) ? row : best, null);
  const inputTokens = number(totals.inputTokens);
  const cachedInputTokens = number(totals.cachedInputTokens);
  const outputTokens = number(totals.outputTokens);
  const reasoningTokens = number(totals.reasoningOutputTokens);
  const totalTokens = number(totals.totalTokens);
  const allInput = inputTokens + cachedInputTokens;

  return [
    {
      title: "Total tokens",
      value: formatCompact(totalTokens),
      context: `${formatCompact(recentTotal)} in the latest 7 active days, ${describeChange(recentTotal, previousTotal)} vs the previous 7.`,
      note: busiest ? `Busiest day: ${busiest.date} at ${formatCompact(busiest.totalTokens)}.` : "No usage days yet.",
    },
    {
      title: "Input tokens",
      value: formatCompact(inputTokens),
      context: `${formatCompact(cachedInputTokens)} cached input, ${formatPercent(cachedInputTokens / Math.max(allInput, 1))} of all input-like tokens.`,
      note: "High cache share usually means repeated context is being reused efficiently.",
    },
    {
      title: "Output tokens",
      value: formatCompact(outputTokens),
      context: `${formatPercent(outputTokens / Math.max(totalTokens, 1))} of total tokens.`,
      note: `${formatCompact(Math.max(outputTokens - reasoningTokens, 0))} visible/non-reasoning output tokens.`,
    },
    {
      title: "Thinking tokens",
      value: formatCompact(reasoningTokens),
      context: `${formatPercent(reasoningTokens / Math.max(outputTokens, 1))} of generated tokens are internal reasoning.`,
      note: `${formatPercent(reasoningTokens / Math.max(totalTokens, 1))} of total token volume.`,
    },
  ];
}

function renderInsights() {
  const daily = filteredDaily({ applyRange: false });
  const first = daily[0]?.date;
  const last = daily[daily.length - 1]?.date;
  els.insightWindow.textContent = first && last ? `${first} to ${last}` : "-";
  els.insights.innerHTML = tokenInsights().map((item) => `
    <article class="insight-card" data-tooltip="${escapeHtml(`${item.title}: ${item.value}. ${item.context}`)}">
      <div>
        <span>${escapeHtml(item.title)}</span>
        <strong>${escapeHtml(item.value)}</strong>
      </div>
      <p>${escapeHtml(item.context)}</p>
      <small>${escapeHtml(item.note)}</small>
    </article>
  `).join("");
}

function renderChart(rows) {
  const metric = state.metric;
  const values = rows.map((row) => number(row[metric]));
  const max = Math.max(...values, 0);
  const total = sum(rows, metric);
  const width = 1000;
  const height = 300;
  const pad = { top: 12, right: 20, bottom: 54, left: 66 };
  const plotWidth = width - pad.left - pad.right;
  const plotHeight = height - pad.top - pad.bottom;
  const gap = rows.length > 28 ? 4 : 8;
  const barWidth = rows.length ? Math.max(6, (plotWidth - gap * (rows.length - 1)) / rows.length) : 0;
  const color = cssVar(metricColors[metric] || metricColors.costUSD);
  const mutedColor = cssVar("--muted");
  const lineColor = cssVar("--line");

  els.chartTitle.textContent = `${state.view[0].toUpperCase()}${state.view.slice(1)} ${metricLabels[metric]}`;
  els.chartSubtitle.textContent = `${rows.length} ${rows.length === 1 ? "row" : "rows"} shown`;
  els.chartTotal.textContent = formatMetric(total);

  if (!rows.length || max === 0) {
    els.chart.innerHTML = `<div class="empty">No usage rows available for this view.</div>`;
    return;
  }

  const bars = rows.map((row, index) => {
    const value = number(row[metric]);
    const barHeight = (value / max) * plotHeight;
    const x = pad.left + index * (barWidth + gap);
    const y = pad.top + plotHeight - barHeight;
    const label = labelForRow(row);
    const labelText = rows.length > 20 ? label.slice(5) : label;
    const tooltip = `${label}\n${metricLabels[metric]}: ${formatMetric(value, metric)}\nTotal: ${formatCompact(row.totalTokens)}\nInput: ${formatCompact(row.inputTokens)}\nOutput: ${formatCompact(row.outputTokens)}\nThinking: ${formatCompact(row.reasoningOutputTokens)}`;

    return `
      <g>
        <rect data-tooltip="${escapeHtml(tooltip)}" x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${barWidth.toFixed(2)}" height="${barHeight.toFixed(2)}" rx="4" fill="${color}"></rect>
        <text x="${(x + barWidth / 2).toFixed(2)}" y="${height - 20}" text-anchor="middle" font-size="12" fill="${mutedColor}" transform="rotate(-34 ${(x + barWidth / 2).toFixed(2)} ${height - 20})">${escapeHtml(labelText)}</text>
      </g>
    `;
  }).join("");

  const grid = [0.25, 0.5, 0.75, 1].map((tick) => {
    const y = pad.top + plotHeight - plotHeight * tick;
    const value = max * tick;
    return `
      <line x1="${pad.left}" x2="${width - pad.right}" y1="${y}" y2="${y}" stroke="${lineColor}"></line>
      <text x="${pad.left - 10}" y="${y + 4}" text-anchor="end" font-size="12" fill="${mutedColor}">${formatMetric(value, metric)}</text>
    `;
  }).join("");

  els.chart.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">
      ${grid}
      <line x1="${pad.left}" x2="${width - pad.right}" y1="${pad.top + plotHeight}" y2="${pad.top + plotHeight}" stroke="${lineColor}"></line>
      ${bars}
    </svg>
  `;
}

function aggregateModels(rows = filteredDaily({ applyRange: false })) {
  const models = new Map();

  for (const row of rows) {
    for (const [model, details] of Object.entries(row.models || {})) {
      const current = models.get(model) || {
        model,
        costUSD: 0,
        totalTokens: 0,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
      };

      current.totalTokens += number(details.totalTokens);
      current.inputTokens += number(details.inputTokens);
      current.cachedInputTokens += number(details.cachedInputTokens);
      current.outputTokens += number(details.outputTokens);
      current.reasoningOutputTokens += number(details.reasoningOutputTokens);
      current.costUSD += number(row.costUSD) * (number(details.totalTokens) / Math.max(number(row.totalTokens), 1));
      models.set(model, current);
    }
  }

  return [...models.values()].sort((a, b) => b.totalTokens - a.totalTokens);
}

function renderModelMix() {
  const rows = aggregateModels();
  const max = Math.max(...rows.map((row) => row.totalTokens), 0);

  if (!rows.length) {
    els.modelMix.innerHTML = `<div class="empty">No model data available.</div>`;
    return;
  }

  els.modelMix.innerHTML = rows.map((row) => `
    <div class="model-row" data-tooltip="${escapeHtml(`${row.model}: ${formatCompact(row.totalTokens)} tokens, ${formatMoney(row.costUSD)} estimated`)}">
      <div class="row-top">
        <span>${escapeHtml(row.model)}</span>
        <span>${formatCompact(row.totalTokens)}</span>
      </div>
      <div class="bar-track"><div class="bar-fill" style="width: ${(row.totalTokens / max) * 100}%"></div></div>
      <div class="session-meta">${formatMoney(row.costUSD)} estimated, ${formatCompact(row.cachedInputTokens)} cached input</div>
    </div>
  `).join("");
}

function renderTopSessions() {
  const rows = filteredRows("sessions", { applyRange: false })
    .sort((a, b) => number(b.costUSD) - number(a.costUSD))
    .slice(0, 8);

  if (!rows.length) {
    els.topSessions.innerHTML = `<div class="empty">No session data available.</div>`;
    return;
  }

  els.topSessions.innerHTML = rows.map((row) => `
    <div class="session-row" data-tooltip="${escapeHtml(`${row.sessionFile || row.sessionId}\n${formatMoney(row.costUSD)}\n${formatCompact(row.totalTokens)} total tokens`)}">
      <div class="row-top">
        <span>${formatMoney(row.costUSD)}</span>
        <span>${formatCompact(row.totalTokens)}</span>
      </div>
      <div class="session-meta">${new Date(row.lastActivity).toLocaleString()} / ${escapeHtml(row.sessionFile || row.sessionId)}</div>
    </div>
  `).join("");
}

function pieSlicePath(cx, cy, r, startAngle, endAngle) {
  const startX = cx + r * Math.cos(startAngle);
  const startY = cy + r * Math.sin(startAngle);
  const endX = cx + r * Math.cos(endAngle);
  const endY = cy + r * Math.sin(endAngle);
  const largeArc = endAngle - startAngle > Math.PI ? 1 : 0;
  return `M ${cx} ${cy} L ${startX} ${startY} A ${r} ${r} 0 ${largeArc} 1 ${endX} ${endY} Z`;
}

function renderModelPie() {
  const rows = aggregateModels();
  const visibleRows = rows.filter((row) => state.modelVisible[row.model] ?? true);
  const total = sum(visibleRows, "totalTokens");
  const colors = [cssVar("--teal"), cssVar("--blue"), cssVar("--amber"), cssVar("--coral"), cssVar("--teal-dark")];

  if (!rows.length) {
    els.modelPie.innerHTML = `<div class="empty">No model usage available.</div>`;
    return;
  }

  if (!visibleRows.length || total === 0) {
    const legendOnly = rows.map((row, index) => `
      <button class="legend-toggle" data-model-key="${escapeHtml(row.model)}" type="button" aria-pressed="false">
        <i style="background:${colors[index % colors.length]}"></i>${escapeHtml(row.model)}
      </button>
    `).join("");
    els.modelPie.innerHTML = `<div class="empty">Select at least one model.</div><div class="chart-legend toggles">${legendOnly}</div>`;
    return;
  }

  let angle = -Math.PI / 2;
  const slices = visibleRows.map((row, index) => {
    const next = angle + (number(row.totalTokens) / total) * Math.PI * 2;
    const percent = number(row.totalTokens) / total;
    const color = colors[index % colors.length];
    const path = percent >= 0.999
      ? `<circle data-tooltip="${escapeHtml(`${row.model}: ${formatPercent(percent)} (${formatCompact(row.totalTokens)})`)}" cx="170" cy="150" r="112" fill="${color}"></circle>`
      : `<path data-tooltip="${escapeHtml(`${row.model}: ${formatPercent(percent)} (${formatCompact(row.totalTokens)})`)}" d="${pieSlicePath(170, 150, 112, angle, next)}" fill="${color}"></path>`;
    angle = next;
    return path;
  }).join("");

  const legend = rows.map((row, index) => {
    const visible = state.modelVisible[row.model] ?? true;
    const activeRow = visibleRows.find((item) => item.model === row.model);
    const percent = activeRow ? number(activeRow.totalTokens) / total : 0;
    return `
      <button class="legend-toggle${visible ? " active" : ""}" data-model-key="${escapeHtml(row.model)}" type="button" aria-pressed="${visible ? "true" : "false"}">
        <i style="background:${colors[index % colors.length]}"></i>${escapeHtml(row.model)} ${activeRow ? formatPercent(percent) : "0%"}
      </button>
    `;
  }).join("");

  els.modelPie.innerHTML = `
    <svg viewBox="0 0 480 300" aria-hidden="true">${slices}</svg>
    <div class="chart-legend">${legend}</div>
  `;
}

function renderBillingChart() {
  const dailyRows = filteredDaily({ applyRange: false });
  const latestDate = dailyRows[dailyRows.length - 1]?.date;
  if (!latestDate) {
    els.billingChart.innerHTML = `<div class="empty">No billing-style usage available.</div>`;
    return;
  }
  const latest = new Date(`${latestDate}T00:00:00Z`);
  const byDate = new Map(dailyRows.map((row) => [row.date, row]));
  const rows = [];
  for (let offset = 29; offset >= 0; offset -= 1) {
    const date = new Date(latest);
    date.setUTCDate(latest.getUTCDate() - offset);
    const iso = isoDate(date);
    rows.push(byDate.get(iso) || {
      date: iso,
      cachedInputTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
    });
  }
  const keys = billingKeys;
  const labels = {
    cachedInputTokens: "Cached",
    inputTokens: "Input",
    outputTokens: "Output",
    reasoningOutputTokens: "Thinking",
  };
  const colors = {
    cachedInputTokens: cssVar("--teal"),
    inputTokens: cssVar("--blue"),
    outputTokens: cssVar("--amber"),
    reasoningOutputTokens: cssVar("--coral"),
  };
  const visibleKeys = keys.filter((key) => state.billingVisible[key]);
  const max = Math.max(...rows.map((row) => visibleKeys.reduce((total, key) => total + number(row[key]), 0)), 0);

  if (!visibleKeys.length) {
    const legendOnly = keys.map((key) => `
      <button class="legend-toggle" data-billing-key="${key}" type="button" aria-pressed="false">
        <i style="background:${colors[key]}"></i>${labels[key]}
      </button>
    `).join("");
    els.billingChart.innerHTML = `<div class="empty">Select at least one category.</div><div class="chart-legend toggles">${legendOnly}</div>`;
    return;
  }

  if (max === 0) {
    els.billingChart.innerHTML = `<div class="empty">No billing-style usage available.</div>`;
    return;
  }

  const width = 900;
  const height = 280;
  const pad = { top: 20, right: 18, bottom: 42, left: 48 };
  const plotHeight = height - pad.top - pad.bottom;
  const plotWidth = width - pad.left - pad.right;
  const step = plotWidth / rows.length;
  const barWidth = Math.max(6, step - 5);

  const bars = rows.map((row, index) => {
    const x = pad.left + index * step + (step - barWidth) / 2;
    let y = pad.top + plotHeight;
    const parts = visibleKeys.map((key) => {
      const h = (number(row[key]) / max) * plotHeight;
      y -= h;
      return `<rect data-tooltip="${escapeHtml(`${row.date}\n${labels[key]}: ${formatCompact(row[key])}`)}" x="${x}" y="${y}" width="${barWidth}" height="${h}" rx="3" fill="${colors[key]}"></rect>`;
    }).join("");
    const showTick = rows.length <= 12 || index % 2 === 0;
    const tick = showTick
      ? `<text x="${x + barWidth / 2}" y="${height - 15}" text-anchor="middle" font-size="11" fill="${cssVar("--muted")}">${row.date.slice(5)}</text>`
      : "";
    return `${parts}${tick}`;
  }).join("");

  const legend = keys.map((key) => `
    <button class="legend-toggle${state.billingVisible[key] ? " active" : ""}" data-billing-key="${key}" type="button" aria-pressed="${state.billingVisible[key] ? "true" : "false"}">
      <i style="background:${colors[key]}"></i>${labels[key]}
    </button>
  `).join("");
  els.billingChart.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" aria-hidden="true">
      <line x1="${pad.left}" x2="${width - pad.right}" y1="${pad.top + plotHeight}" y2="${pad.top + plotHeight}" stroke="${cssVar("--line")}"></line>
      ${bars}
    </svg>
    <div class="chart-legend toggles">${legend}</div>
  `;
}

function renderCompositionChart() {
  const rows = filteredDaily({ applyRange: false }).slice(-14);
  const keys = compositionKeys;
  const colors = [cssVar("--teal"), cssVar("--blue"), cssVar("--amber"), cssVar("--coral")];
  const labels = ["Input", "Cached", "Output", "Thinking"];
  const visibleKeys = keys.filter((key) => state.compositionVisible[key]);
  const max = Math.max(...rows.map((row) => visibleKeys.reduce((total, key) => total + number(row[key]), 0)), 0);

  if (!visibleKeys.length) {
    const legendOnly = labels.map((label, index) => `
      <button class="legend-toggle" data-comp-key="${keys[index]}" type="button" aria-pressed="false">
        <i style="background:${colors[index]}"></i>${label}
      </button>
    `).join("");
    els.compositionChart.innerHTML = `<div class="empty">Select at least one token type.</div><div class="chart-legend toggles">${legendOnly}</div>`;
    return;
  }

  if (rows.length < 2 || max === 0) {
    els.compositionChart.innerHTML = `<div class="empty">Need at least two usage days for composition trend.</div>`;
    return;
  }

  const width = 720;
  const height = 280;
  const pad = { top: 20, right: 20, bottom: 38, left: 42 };
  const plotWidth = width - pad.left - pad.right;
  const plotHeight = height - pad.top - pad.bottom;
  const xFor = (index) => pad.left + (index / Math.max(rows.length - 1, 1)) * plotWidth;
  const yFor = (value) => pad.top + plotHeight - (value / max) * plotHeight;

  const orderedVisible = keys.filter((key) => state.compositionVisible[key]);
  const layers = orderedVisible.map((key) => {
    const keyIndex = keys.indexOf(key);
    const lower = rows.map((row) => orderedVisible
      .slice(0, orderedVisible.indexOf(key))
      .reduce((total, item) => total + number(row[item]), 0));
    const upper = rows.map((row, index) => lower[index] + number(row[key]));
    const top = upper.map((value, index) => `${index === 0 ? "M" : "L"} ${xFor(index)} ${yFor(value)}`).join(" ");
    const bottom = lower.map((value, index) => `L ${xFor(rows.length - 1 - index)} ${yFor(lower[rows.length - 1 - index])}`).join(" ");
    const lastRow = rows[rows.length - 1];
    return `<path data-tooltip="${escapeHtml(`${labels[keyIndex]}\nLatest: ${formatCompact(lastRow[key])}`)}" d="${top} ${bottom} Z" fill="${colors[keyIndex]}" opacity="0.72"></path>`;
  }).join("");

  const ticks = rows.map((row, index) => {
    if (rows.length > 8 && index % 2) return "";
    return `<text x="${xFor(index)}" y="${height - 12}" text-anchor="middle" font-size="12" fill="${cssVar("--muted")}">${row.date.slice(5)}</text>`;
  }).join("");
  const legend = labels.map((label, index) => `
    <button class="legend-toggle${state.compositionVisible[keys[index]] ? " active" : ""}" data-comp-key="${keys[index]}" type="button" aria-pressed="${state.compositionVisible[keys[index]] ? "true" : "false"}">
      <i style="background:${colors[index]}"></i>${label}
    </button>
  `).join("");

  els.compositionChart.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" aria-hidden="true">
      <line x1="${pad.left}" x2="${width - pad.right}" y1="${pad.top + plotHeight}" y2="${pad.top + plotHeight}" stroke="${cssVar("--line")}"></line>
      ${layers}
      ${ticks}
    </svg>
    <div class="chart-legend toggles">${legend}</div>
  `;
}

function monthName(date) {
  return new Intl.DateTimeFormat(undefined, { month: "long" }).format(date);
}

function streaks(rows) {
  const dates = new Set(rows.filter((row) => number(row[state.activityMetric]) > 0).map((row) => row.date));
  const allDates = [...dates].sort();
  let longest = 0;
  let current = 0;
  let previous = null;

  for (const item of allDates) {
    const date = new Date(`${item}T00:00:00Z`);
    if (previous && (date - previous) / 86400000 === 1) {
      current += 1;
    } else {
      current = 1;
    }
    longest = Math.max(longest, current);
    previous = date;
  }

  const lastUsageDate = allDates.at(-1);
  const today = new Date();
  const todayIso = today.toISOString().slice(0, 10);
  const currentStreak = lastUsageDate === todayIso ? current : 0;
  return { longest, current: currentStreak };
}

function renderActivityHeatmap() {
  const rows = filteredDaily({ applyRange: false });
  const byDate = new Map(rows.map((row) => [row.date, row]));
  const metric = state.activityMetric;
  const values = rows.map((row) => number(row[metric]));
  const max = Math.max(...values, 0);

  if (!rows.length) {
    els.activityHeatmap.innerHTML = `<div class="empty">No activity data available.</div>`;
    return;
  }

  const latestDate = new Date(`${rows[rows.length - 1].date}T00:00:00Z`);
  const end = new Date(latestDate);
  end.setUTCDate(end.getUTCDate() + (6 - end.getUTCDay()));
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (52 * 7 - 1));
  const cursor = new Date(start);

  const weeks = [];
  const monthLabels = [];
  for (let weekIndex = 0; weekIndex < 52; weekIndex += 1) {
    const weekStart = new Date(start);
    weekStart.setUTCDate(start.getUTCDate() + weekIndex * 7);
    const monthLabel = weekStart.getUTCDate() <= 7
      ? weekStart.toLocaleString(undefined, { month: "short", timeZone: "UTC" }).slice(0, 1)
      : "";
    monthLabels.push(`<span>${monthLabel}</span>`);

    const week = [];
    for (let day = 0; day < 7; day += 1) {
      const date = cursor.toISOString().slice(0, 10);
      const row = byDate.get(date);
      const value = number(row?.[metric]);
      const level = max ? Math.ceil((value / max) * 4) : 0;
      week.push(`<span class="heat-cell level-${level}" data-tooltip="${escapeHtml(`${date}\n${metricLabels[metric]}: ${formatMetric(value, metric)}`)}"></span>`);
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    weeks.push(`<div class="heat-week">${week.join("")}</div>`);
  }

  const windowRows = rows.filter((row) => row.date >= isoDate(start) && row.date <= isoDate(end));
  const byMonth = windowRows.reduce((acc, row) => {
    const key = row.date.slice(0, 7);
    acc[key] = number(acc[key]) + number(row[metric]);
    return acc;
  }, {});
  const mostActiveMonth = Object.entries(byMonth).sort((a, b) => b[1] - a[1])[0]?.[0] || "-";
  const mostActiveDay = windowRows.reduce((best, row) => number(row[metric]) > number(best?.[metric]) ? row : best, null);
  const streak = streaks(windowRows);

  els.activityHeatmap.innerHTML = `
    <div class="heat-shell">
      <div class="heat-corner" aria-hidden="true"></div>
      <div class="heat-months">${monthLabels.join("")}</div>
      <div class="heat-days"><span>S</span><span>M</span><span>T</span><span>W</span><span>T</span><span>F</span><span>S</span></div>
      <div class="heat-grid">${weeks.join("")}</div>
    </div>
    <div class="activity-stats">
      <div><span>Most Active Month</span><strong>${mostActiveMonth === "-" ? "-" : monthName(new Date(`${mostActiveMonth}-01T00:00:00Z`))}</strong></div>
      <div><span>Most Active Day</span><strong>${mostActiveDay ? mostActiveDay.date : "-"}</strong></div>
      <div><span>Longest Streak</span><strong>${streak.longest}d</strong></div>
      <div><span>Current Streak</span><strong>${streak.current}d</strong></div>
    </div>
    <div class="heat-legend"><span>Fewer</span><i class="level-1"></i><i class="level-2"></i><i class="level-3"></i><i class="level-4"></i><span>More</span></div>
  `;
}

function renderTable(rows) {
  const primary = state.view === "monthly"
    ? "Month"
    : state.view === "weekly"
      ? "Week"
      : state.view === "sessions"
        ? "Session"
        : "Date";
  els.tableTitle.textContent = `${state.view[0].toUpperCase()}${state.view.slice(1)} Rows`;
  els.tableCount.textContent = `${rows.length} ${rows.length === 1 ? "row" : "rows"}`;
  els.tableHead.innerHTML = `
    <tr>
      <th>${primary}</th>
      <th>Cost</th>
      <th>Total</th>
      <th>Input</th>
      <th>Cached</th>
      <th>Output</th>
      <th>Reasoning</th>
      <th>Models</th>
    </tr>
  `;

  els.tableBody.innerHTML = rows.map((row) => {
    const label = state.view === "sessions" ? row.sessionFile || row.sessionId : labelForRow(row);
    const models = Object.keys(row.models || {}).join(", ") || "-";

    return `
      <tr data-tooltip="${escapeHtml(`${label}\n${formatMoney(row.costUSD)}\n${formatCompact(row.totalTokens)} total tokens`)}">
        <td title="${escapeHtml(label)}">${escapeHtml(label)}</td>
        <td>${formatMoney(row.costUSD)}</td>
        <td>${formatInt(row.totalTokens)}</td>
        <td>${formatInt(row.inputTokens)}</td>
        <td>${formatInt(row.cachedInputTokens)}</td>
        <td>${formatInt(row.outputTokens)}</td>
        <td>${formatInt(row.reasoningOutputTokens)}</td>
        <td>${escapeHtml(models)}</td>
      </tr>
    `;
  }).join("");
}

function render() {
  const rows = filteredRows(state.view);
  renderTotals();
  renderInsights();
  renderChart(rows);
  renderModelPie();
  renderBillingChart();
  renderCompositionChart();
  renderActivityHeatmap();
  renderModelMix();
  renderTopSessions();
  renderTable(rows);
  updateWidgetContainers();
  syncUrl();
}

function applyTheme() {
  const systemDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const effectiveTheme = state.theme === "system" ? (systemDark ? "dark" : "light") : state.theme;
  document.documentElement.dataset.theme = effectiveTheme;
  document.querySelectorAll("[data-theme-mode]").forEach((item) => {
    item.classList.toggle("active", item.dataset.themeMode === state.theme);
  });
  if (state.data) render();
}

function setupControls() {
  syncControls();

  if (els.loadLocalButton && typeof window.showDirectoryPicker !== "function") {
    els.loadLocalButton.disabled = true;
    els.loadLocalButton.title = "Directory picker requires a Chromium-based browser.";
  }

  document.querySelectorAll("[data-view]").forEach((button) => {
    button.addEventListener("click", () => {
      state.view = button.dataset.view;
      syncControls();
      render();
    });
  });

  document.querySelectorAll("[data-speed]").forEach((button) => {
    button.addEventListener("click", async () => {
      state.speed = button.dataset.speed;
      syncControls();

      if (state.sourceMode === "local" && state.localCodexHandle) {
        await loadUsageFromLocalHandle(state.localCodexHandle, state.localSourceLabel || "{basePath}/.codex");
        return;
      }

      if (state.sourceMode === "api" && state.data) {
        await loadUsage();
        return;
      }

      els.status.classList.remove("error");
      els.status.textContent = "Speed updated. Load .codex data to refresh usage.";
      syncUrl();
    });
  });

  document.querySelectorAll("[data-theme-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      state.theme = button.dataset.themeMode;
      localStorage.setItem("codex-usage-theme", state.theme);
      applyTheme();
    });
  });

  document.querySelectorAll("[data-activity-metric]").forEach((button) => {
    button.addEventListener("click", () => {
      state.activityMetric = button.dataset.activityMetric;
      syncControls();
      render();
    });
  });

  els.metricSelect.addEventListener("change", () => {
    state.metric = els.metricSelect.value;
    render();
  });

  els.rangeSelect.addEventListener("change", () => {
    state.range = els.rangeSelect.value;
    render();
  });

  els.searchInput.addEventListener("input", () => {
    state.filters.q = els.searchInput.value;
    render();
  });

  els.startDateInput.addEventListener("change", () => {
    state.filters.start = els.startDateInput.value;
    render();
  });

  els.endDateInput.addEventListener("change", () => {
    state.filters.end = els.endDateInput.value;
    render();
  });

  els.modelSelect.addEventListener("change", () => {
    state.filters.model = els.modelSelect.value;
    render();
  });

  els.clearFiltersButton.addEventListener("click", () => {
    state.filters = { q: "", start: "", end: "", model: "all" };
    syncControls();
    render();
  });

  document.addEventListener("click", (event) => {
    const button = event.target.closest("[data-comp-key]");
    if (!button) return;
    const key = button.dataset.compKey;
    if (!compositionKeys.includes(key)) return;
    state.compositionVisible[key] = !state.compositionVisible[key];
    render();
  });

  document.addEventListener("click", (event) => {
    const button = event.target.closest("[data-billing-key]");
    if (!button) return;
    const key = button.dataset.billingKey;
    if (!billingKeys.includes(key)) return;
    state.billingVisible[key] = !state.billingVisible[key];
    render();
  });

  document.addEventListener("click", (event) => {
    const button = event.target.closest("[data-model-key]");
    if (!button) return;
    const model = button.dataset.modelKey;
    if (!(model in state.modelVisible)) return;
    state.modelVisible[model] = !state.modelVisible[model];
    render();
  });

  els.widgetsButton?.addEventListener("click", () => {
    renderWidgetSidebar();
    setWidgetSidebar(true);
  });

  els.closeWidgetsButton?.addEventListener("click", () => {
    setWidgetSidebar(false);
  });

  els.resetWidgetsButton?.addEventListener("click", () => {
    resetWidgetLayout();
  });

  els.widgetBackdrop?.addEventListener("click", () => {
    setWidgetSidebar(false);
  });

  els.widgetList?.addEventListener("change", (event) => {
    const toggle = event.target.closest("[data-widget-toggle]");
    if (toggle) {
      const id = toggle.dataset.widgetToggle;
      if (toggle.checked) {
        state.widgets.hidden.delete(id);
      } else {
        state.widgets.hidden.add(id);
      }
      applyWidgetState();
      persistWidgets();
      return;
    }

    const sizeSelect = event.target.closest("[data-widget-size]");
    if (sizeSelect) {
      const id = sizeSelect.dataset.widgetSize;
      state.widgets.sizes[id] = sizeSelect.value;
      applyWidgetState();
      persistWidgets();
      return;
    }

    const widthSelect = event.target.closest("[data-widget-width]");
    if (widthSelect) {
      const id = widthSelect.dataset.widgetWidth;
      state.widgets.widths[id] = widthSelect.value;
      applyWidgetState();
      persistWidgets();
    }
  });

  els.loadLocalButton?.addEventListener("click", loadUsageFromLocalPicker);
  els.refreshButton.addEventListener("click", async () => {
    if (state.sourceMode === "local" && state.localCodexHandle) {
      await loadUsageFromLocalHandle(state.localCodexHandle, state.localSourceLabel || ".codex");
      return;
    }
    await loadUsage();
  });
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyTheme);
}

function setupTooltips() {
  const show = (event) => {
    const target = event.target.closest("[data-tooltip]");
    if (!target) return;
    els.dashboardTooltip.textContent = target.dataset.tooltip;
    els.dashboardTooltip.classList.add("visible");
  };
  const move = (event) => {
    if (!els.dashboardTooltip.classList.contains("visible")) return;
    els.dashboardTooltip.style.left = `${event.clientX + 14}px`;
    els.dashboardTooltip.style.top = `${event.clientY + 14}px`;
  };
  const hide = () => {
    els.dashboardTooltip.classList.remove("visible");
  };

  document.addEventListener("pointerover", show);
  document.addEventListener("pointermove", move);
  document.addEventListener("pointerout", (event) => {
    if (event.target.closest("[data-tooltip]")) hide();
  });
}

function setupDragAndDrop() {
  const saved = JSON.parse(localStorage.getItem("codex-usage-panel-order") || "[]");
  for (const id of saved) {
    const panel = els.dashboardPanels.querySelector(`[data-panel-id="${CSS.escape(id)}"]`);
    if (panel) els.dashboardPanels.append(panel);
  }

  let dragged = null;
  els.dashboardPanels.querySelectorAll(".draggable-panel").forEach((panel) => {
    const handle = panel.querySelector(".drag-handle");
    panel.draggable = false;
    if (handle) handle.draggable = true;

    if (!handle) return;

    handle.addEventListener("dragstart", (event) => {
      dragged = panel;
      panel.classList.add("dragging");
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", panel.dataset.panelId);
    });
    handle.addEventListener("dragend", () => {
      panel.classList.remove("dragging");
      dragged = null;
      const order = [...els.dashboardPanels.querySelectorAll(".draggable-panel")].map((item) => item.dataset.panelId);
      localStorage.setItem("codex-usage-panel-order", JSON.stringify(order));
    });
    panel.addEventListener("dragover", (event) => {
      event.preventDefault();
      if (!dragged || dragged === panel) return;
      const rect = panel.getBoundingClientRect();
      const after = event.clientY > rect.top + rect.height / 2;
      els.dashboardPanels.insertBefore(dragged, after ? panel.nextSibling : panel);
    });
  });
}

function setupWidgets() {
  applyWidgetState();
  renderWidgetSidebar();
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && els.widgetSidebar.classList.contains("open")) {
      setWidgetSidebar(false);
    }
  });
}

setupControls();
setupTooltips();
setupDragAndDrop();
setupWidgets();
applyTheme();
loadInitialData();
