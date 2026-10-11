/**
 * Fractional indexing (planner-module-plan.md): an item's position is a string,
 * and moving an item writes ONE new string that sorts between its neighbours, so
 * nothing else in the list is renumbered. O(1) writes per move instead of O(n).
 *
 * Keys use base-62 digits and never end in the lowest digit, which guarantees a
 * key always exists strictly between any two keys. Keys grow by about one
 * character per ~6 moves into the same gap; past MAX_LENGTH the list is
 * rebalanced to short evenly spaced keys (rare, one bulk write).
 */
const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const BASE = DIGITS.length;
const MAX_LENGTH = 40;
const RANK_RE = /^[0-9A-Za-z]{1,64}$/;

/** A key strictly between a and b ("" = start of list, null = end). */
const between = (a = "", b = null) => {
  if (b !== null && a >= b) throw new Error(`rank: "${a}" is not before "${b}"`);
  if (a.endsWith("0") || (b && b.endsWith("0"))) throw new Error("rank: keys can't end in 0");
  if (b) {
    // Shared prefix: recurse after it
    let n = 0;
    while ((a[n] || "0") === b[n]) n++;
    if (n > 0) return b.slice(0, n) + between(a.slice(n), b.slice(n));
  }
  const digitA = a ? DIGITS.indexOf(a[0]) : 0;
  const digitB = b !== null ? DIGITS.indexOf(b[0]) : BASE;
  if (digitB - digitA > 1) return DIGITS[Math.round((digitA + digitB) / 2)];
  // Adjacent first digits: keep a's digit and go one level deeper
  if (b && b.length > 1) return b.slice(0, 1);
  return DIGITS[digitA] + between(a.slice(1), null);
};

/**
 * n evenly spaced short keys (for rebalancing): fixed width, so string order is
 * numeric order; a trailing "V" keeps them from ending in "0".
 */
const spread = (n) => {
  const width = Math.max(1, Math.ceil(Math.log(n + 1) / Math.log(BASE)));
  const step = Math.floor(BASE ** width / (n + 1)) || 1;
  return Array.from({ length: n }, (_, i) => {
    let v = (i + 1) * step;
    let s = "";
    for (let d = 0; d < width; d++) {
      s = DIGITS[v % BASE] + s;
      v = Math.floor(v / BASE);
    }
    return `${s}V`;
  });
};

const needsRebalance = (key) => key.length > MAX_LENGTH;

module.exports = { between, spread, needsRebalance, RANK_RE, MAX_LENGTH };
