(function attachUploadUtils(root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
    return;
  }
  root.CodexUsageUploadUtils = factory();
})(typeof globalThis !== "undefined" ? globalThis : window, function createUploadUtils() {
  const DEFAULT_COST_UPLOAD_CHUNK_BYTES = 5 * 1024 * 1024;

  function chunkRanges(size, chunkSize = DEFAULT_COST_UPLOAD_CHUNK_BYTES) {
    if (!Number.isFinite(size) || size < 0) {
      throw new TypeError("size must be a non-negative number.");
    }
    if (!Number.isFinite(chunkSize) || chunkSize <= 0) {
      throw new TypeError("chunkSize must be a positive number.");
    }
    if (size === 0) {
      return [{ start: 0, end: 0 }];
    }

    const ranges = [];
    for (let start = 0; start < size; start += chunkSize) {
      ranges.push({ start, end: Math.min(size, start + chunkSize) });
    }
    return ranges;
  }

  function shouldChunkFile(size, chunkSize = DEFAULT_COST_UPLOAD_CHUNK_BYTES) {
    return size > chunkSize;
  }

  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    const batchSize = 0x8000;
    for (let index = 0; index < bytes.length; index += batchSize) {
      binary += String.fromCharCode(...bytes.subarray(index, index + batchSize));
    }
    return btoa(binary);
  }

  async function encodePayloadText(text) {
    if (typeof CompressionStream !== "function" || typeof Blob !== "function") {
      return { content: text };
    }

    const compressed = new Blob([text])
      .stream()
      .pipeThrough(new CompressionStream("gzip"));
    const buffer = await new Response(compressed).arrayBuffer();
    return {
      content: arrayBufferToBase64(buffer),
      contentEncoding: "gzip-base64",
    };
  }

  function dateFromCodexRelativePath(relativePath) {
    const normalized = String(relativePath || "").replaceAll("\\", "/");
    const nested = normalized.match(/^sessions\/(\d{4})\/(\d{2})\/(\d{2})\//);
    if (nested) {
      return `${nested[1]}-${nested[2]}-${nested[3]}`;
    }

    const filename = normalized.split("/").pop() || "";
    const named = filename.match(/(?:rollout|session)-(\d{4})-(\d{2})-(\d{2})T/);
    if (named) {
      return `${named[1]}-${named[2]}-${named[3]}`;
    }

    return "";
  }

  function isDateInRange(date, start = "", end = "") {
    if (!date) return true;
    if (start && date < start) return false;
    if (end && date > end) return false;
    return true;
  }

  function filterEntriesByDateRange(entries, start = "", end = "") {
    if (!start && !end) return entries;
    return entries.filter((entry) => isDateInRange(dateFromCodexRelativePath(entry.relativePath), start, end));
  }

  return {
    DEFAULT_COST_UPLOAD_CHUNK_BYTES,
    chunkRanges,
    dateFromCodexRelativePath,
    encodePayloadText,
    filterEntriesByDateRange,
    isDateInRange,
    shouldChunkFile,
  };
});
