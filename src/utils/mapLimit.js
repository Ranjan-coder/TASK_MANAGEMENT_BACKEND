/**
 * Runs `fn` over `items` with at most `limit` in flight at once.
 * Background jobs use it instead of a serial for…await loop (one slow item no longer
 * delays the whole batch) without flooding the database with 200 parallel queries.
 * Errors are the caller's job: `fn` should catch per item.
 */
const mapLimit = async (items, limit, fn) => {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
};

module.exports = { mapLimit };
