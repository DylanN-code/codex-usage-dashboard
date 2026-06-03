const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const { after, afterEach, before, test } = require("node:test");
const {
  app,
  resetUsageReportsRunner,
  setUsageReportsRunner,
  validateCostPayload,
  weeklyFromDaily,
} = require("../server");

let server;
let baseUrl;

function listen() {
  return new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
}

function close() {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function postJson(endpoint, body) {
  const response = await fetch(`${baseUrl}${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  return { response, payload };
}

function mockReports(costUSD = 1.23) {
  return {
    daily: [
      {
        date: "2026-06-01",
        cachedInputTokens: 3,
        costUSD,
        inputTokens: 5,
        models: {},
        outputTokens: 7,
        reasoningOutputTokens: 11,
        totalTokens: 26,
      },
    ],
    weekly: [],
    monthly: [],
    sessions: [],
    totals: {
      cachedInputTokens: 3,
      costUSD,
      inputTokens: 5,
      outputTokens: 7,
      reasoningOutputTokens: 11,
      totalTokens: 26,
    },
  };
}

before(listen);
after(close);
afterEach(resetUsageReportsRunner);

test("health and favicon endpoints are production-safe", async () => {
  const health = await fetch(`${baseUrl}/api/health`);
  assert.equal(health.status, 200);
  const payload = await health.json();
  assert.equal(payload.ok, true);
  assert.equal(payload.package, "@ccusage/codex");

  const favicon = await fetch(`${baseUrl}/favicon.ico`);
  assert.equal(favicon.status, 204);
});

test("validates and summarizes weekly rows", () => {
  const weeks = weeklyFromDaily([
    { date: "2026-06-01", costUSD: 1, totalTokens: 10, models: { "gpt-test": { totalTokens: 10 } } },
    { date: "2026-06-02", costUSD: 2, totalTokens: 20, models: { "gpt-test": { totalTokens: 20 } } },
  ]);

  assert.equal(weeks.length, 1);
  assert.equal(weeks[0].weekStart, "2026-06-01");
  assert.equal(weeks[0].weekEnd, "2026-06-07");
  assert.equal(weeks[0].costUSD, 3);
  assert.equal(weeks[0].totalTokens, 30);
  assert.equal(weeks[0].models["gpt-test"].totalTokens, 30);
});

test("legacy cost payload rejects duplicate files", () => {
  assert.throws(
    () => validateCostPayload({
      files: [
        { relativePath: "sessions/demo.jsonl", content: "{\"type\":\"event\"}\n" },
        { relativePath: "sessions/demo.jsonl", content: "{\"type\":\"event\"}\n" },
      ],
    }),
    /Duplicate file path/,
  );
});

test("upload endpoint rejects unsafe relative paths", async () => {
  const { payload: session } = await postJson("/api/cost-upload/start", {
    speed: "fast",
    sourceLabel: "/tmp/.codex",
  });
  const { response, payload } = await postJson("/api/cost-upload/file", {
    uploadId: session.uploadId,
    file: {
      relativePath: "../secret.jsonl",
      content: "{\"type\":\"event\"}\n",
    },
  });

  assert.equal(response.status, 400);
  assert.match(payload.detail, /relativePath is invalid/);
});

test("chunked upload rejects out-of-order chunks", async () => {
  const { payload: session } = await postJson("/api/cost-upload/start", {
    speed: "auto",
    sourceLabel: "/tmp/.codex",
  });
  const { response, payload } = await postJson("/api/cost-upload/chunk", {
    uploadId: session.uploadId,
    relativePath: "sessions/demo.jsonl",
    chunkIndex: 1,
    totalChunks: 2,
    content: "{\"type\":\"tail\"}\n",
  });

  assert.equal(response.status, 400);
  assert.match(payload.detail, /not started/);
});

test("chunked upload assembles files and calls the report runner", async () => {
  const jsonl = "{\"type\":\"first\"}\n{\"type\":\"second\"}\n";
  const midpoint = "{\"type\":\"first\"}\n".length;
  const relativePath = "sessions/demo.jsonl";

  const { payload: session } = await postJson("/api/cost-upload/start", {
    speed: "fast",
    sourceLabel: "/tmp/.codex",
  });
  const firstChunk = await postJson("/api/cost-upload/chunk", {
    uploadId: session.uploadId,
    relativePath,
    chunkIndex: 0,
    totalChunks: 2,
    content: jsonl.slice(0, midpoint),
  });
  assert.equal(firstChunk.response.status, 200);
  assert.equal(firstChunk.payload.completed, false);

  const secondChunk = await postJson("/api/cost-upload/chunk", {
    uploadId: session.uploadId,
    relativePath,
    chunkIndex: 1,
    totalChunks: 2,
    content: jsonl.slice(midpoint),
  });
  assert.equal(secondChunk.response.status, 200);
  assert.equal(secondChunk.payload.completed, true);

  setUsageReportsRunner(async (speed, envOverrides) => {
    assert.equal(speed, "fast");
    const uploaded = path.join(envOverrides.HOME, ".codex", relativePath);
    assert.equal(fs.readFileSync(uploaded, "utf8"), jsonl);
    return mockReports(4.56);
  });

  const { response, payload } = await postJson("/api/cost-upload/finish", {
    uploadId: session.uploadId,
  });

  assert.equal(response.status, 200);
  assert.equal(payload.speed, "fast");
  assert.equal(payload.costSource, "ccusage");
  assert.equal(payload.uploadMode, "session");
  assert.equal(payload.uploadedFiles, 1);
  assert.equal(payload.totals.costUSD, 4.56);
});

test("uploaded sessions can be recalculated for another speed without reuploading", async () => {
  const relativePath = "sessions/reusable.jsonl";
  const content = "{\"type\":\"event\"}\n";
  const { payload: session } = await postJson("/api/cost-upload/start", {
    speed: "auto",
    sourceLabel: "/tmp/.codex",
  });
  const uploaded = await postJson("/api/cost-upload/file", {
    uploadId: session.uploadId,
    file: { relativePath, content },
  });
  assert.equal(uploaded.response.status, 200);

  const seenSpeeds = [];
  setUsageReportsRunner(async (speed, envOverrides) => {
    seenSpeeds.push(speed);
    const uploadedPath = path.join(envOverrides.HOME, ".codex", relativePath);
    assert.equal(fs.readFileSync(uploadedPath, "utf8"), content);
    return mockReports(speed === "fast" ? 9 : 3);
  });

  const first = await postJson("/api/cost-upload/calculate", {
    uploadId: session.uploadId,
    speed: "standard",
  });
  const second = await postJson("/api/cost-upload/calculate", {
    uploadId: session.uploadId,
    speed: "fast",
  });

  assert.equal(first.response.status, 200);
  assert.equal(second.response.status, 200);
  assert.deepEqual(seenSpeeds, ["standard", "fast"]);
  assert.equal(first.payload.uploadedFiles, 1);
  assert.equal(second.payload.uploadedFiles, 1);
  assert.equal(first.payload.totals.costUSD, 3);
  assert.equal(second.payload.totals.costUSD, 9);
});

test("upload endpoint accepts gzip-base64 encoded JSONL files", async () => {
  const relativePath = "sessions/compressed.jsonl";
  const content = "{\"type\":\"event\"}\n";
  const { payload: session } = await postJson("/api/cost-upload/start", {
    speed: "standard",
    sourceLabel: "/tmp/.codex",
  });

  const uploaded = await postJson("/api/cost-upload/file", {
    uploadId: session.uploadId,
    file: {
      relativePath,
      content: zlib.gzipSync(content).toString("base64"),
      contentEncoding: "gzip-base64",
    },
  });
  assert.equal(uploaded.response.status, 200);

  setUsageReportsRunner(async (speed, envOverrides) => {
    assert.equal(speed, "standard");
    const uploadedPath = path.join(envOverrides.HOME, ".codex", relativePath);
    assert.equal(fs.readFileSync(uploadedPath, "utf8"), content);
    return mockReports(7.89);
  });

  const calculated = await postJson("/api/cost-upload/calculate", {
    uploadId: session.uploadId,
    speed: "standard",
  });
  assert.equal(calculated.response.status, 200);
  assert.equal(calculated.payload.totals.costUSD, 7.89);
});

test("upload endpoint rejects unsupported content encodings", async () => {
  const { payload: session } = await postJson("/api/cost-upload/start", {
    speed: "standard",
    sourceLabel: "/tmp/.codex",
  });

  const { response, payload } = await postJson("/api/cost-upload/file", {
    uploadId: session.uploadId,
    file: {
      relativePath: "sessions/unsupported-encoding.jsonl",
      content: "{\"type\":\"event\"}\n",
      contentEncoding: "brotli",
    },
  });

  assert.equal(response.status, 400);
  assert.match(payload.detail, /Unsupported contentEncoding/);
});

test("chunk endpoint accepts gzip-base64 encoded chunks", async () => {
  const relativePath = "sessions/compressed-chunk.jsonl";
  const content = "{\"type\":\"event\"}\n";
  const { payload: session } = await postJson("/api/cost-upload/start", {
    speed: "auto",
    sourceLabel: "/tmp/.codex",
  });

  const uploaded = await postJson("/api/cost-upload/chunk", {
    uploadId: session.uploadId,
    relativePath,
    chunkIndex: 0,
    totalChunks: 1,
    content: zlib.gzipSync(content).toString("base64"),
    contentEncoding: "gzip-base64",
  });
  assert.equal(uploaded.response.status, 200);
  assert.equal(uploaded.payload.completed, true);
});
