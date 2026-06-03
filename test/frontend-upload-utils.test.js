const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  DEFAULT_COST_UPLOAD_CHUNK_BYTES,
  chunkRanges,
  encodePayloadText,
  shouldChunkFile,
} = require("../public/upload-utils");

test("small files use one frontend upload range", () => {
  assert.deepEqual(chunkRanges(1024), [{ start: 0, end: 1024 }]);
  assert.equal(shouldChunkFile(1024), false);
});

test("large files are split into stable frontend upload chunks", () => {
  const ranges = chunkRanges(12, 5);

  assert.deepEqual(ranges, [
    { start: 0, end: 5 },
    { start: 5, end: 10 },
    { start: 10, end: 12 },
  ]);
  assert.equal(shouldChunkFile(DEFAULT_COST_UPLOAD_CHUNK_BYTES + 1), true);
});

test("chunk range validation catches invalid frontend inputs", () => {
  assert.throws(() => chunkRanges(-1), /non-negative/);
  assert.throws(() => chunkRanges(10, 0), /positive/);
});

test("payload encoding falls back to raw text without CompressionStream", async () => {
  const originalCompressionStream = globalThis.CompressionStream;
  const originalBlob = globalThis.Blob;
  try {
    globalThis.CompressionStream = undefined;
    globalThis.Blob = undefined;
    assert.deepEqual(await encodePayloadText("hello"), { content: "hello" });
  } finally {
    globalThis.CompressionStream = originalCompressionStream;
    globalThis.Blob = originalBlob;
  }
});
