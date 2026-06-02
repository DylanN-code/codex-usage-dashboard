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

  return {
    DEFAULT_COST_UPLOAD_CHUNK_BYTES,
    chunkRanges,
    shouldChunkFile,
  };
});
