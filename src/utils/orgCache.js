const { requireOrgId } = require("./tenantContext");

/**
 * Per-organisation in-memory cache (settings, department lists, …).
 *
 * - Map<orgId, { value, at }>: O(1) get/set. A Map keeps insertion order, so
 *   re-inserting on read makes it an LRU; the oldest organisation is evicted
 *   past `max`, so memory stays bounded however many organisations exist.
 * - Single flight per organisation: concurrent misses share one load.
 * - TTL covers changes made by another server; invalidate() clears at once.
 */
const createOrgCache = ({ ttlMs = 30 * 1000, max = 1000 } = {}) => {
  const entries = new Map(); // orgId → { value, at }
  const loading = new Map(); // orgId → Promise

  const get = async (loader, orgId = requireOrgId()) => {
    const key = String(orgId);
    const hit = entries.get(key);
    if (hit && Date.now() - hit.at < ttlMs) {
      entries.delete(key); // move to the newest end (LRU)
      entries.set(key, hit);
      return hit.value;
    }
    if (!loading.has(key)) {
      loading.set(
        key,
        (async () => {
          const value = await loader(orgId);
          entries.delete(key);
          entries.set(key, { value, at: Date.now() });
          if (entries.size > max) entries.delete(entries.keys().next().value);
          return value;
        })().finally(() => loading.delete(key))
      );
    }
    return loading.get(key);
  };

  const invalidate = (orgId = requireOrgId()) => entries.delete(String(orgId));
  const clear = () => entries.clear();

  return { get, invalidate, clear, size: () => entries.size };
};

module.exports = { createOrgCache };
