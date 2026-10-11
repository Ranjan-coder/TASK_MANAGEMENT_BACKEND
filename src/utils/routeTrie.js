/**
 * Path-prefix trie (module-access-plan.md, Phase 3): which module an API path
 * belongs to.
 *
 * Patterns are split into segments; ":param" segments become a wildcard child.
 * A lookup walks the request's segments once (exact child first, then the
 * wildcard) and returns the value of the deepest node that has one, i.e. the
 * longest matching prefix. Cost: O(number of segments), however many patterns
 * there are, instead of testing a list of regular expressions one by one.
 */
const WILDCARD = ":";

const createNode = () => ({ children: new Map(), wildcard: null, value: undefined });

const segmentsOf = (path) => String(path).split("/").filter(Boolean);

const createRouteTrie = (entries = []) => {
  const root = createNode();

  const insert = (pattern, value) => {
    let node = root;
    for (const seg of segmentsOf(pattern)) {
      if (seg.startsWith(WILDCARD)) {
        node.wildcard = node.wildcard || createNode();
        node = node.wildcard;
      } else {
        const key = seg.toLowerCase();
        if (!node.children.has(key)) node.children.set(key, createNode());
        node = node.children.get(key);
      }
    }
    if (node.value !== undefined && node.value !== value) {
      throw new Error(`Route pattern "${pattern}" is mapped twice (${node.value} and ${value})`);
    }
    node.value = value;
  };

  /** Value of the longest matching prefix, or null. `path` must already be normalised. */
  const lookup = (path) => {
    let node = root;
    let found = root.value ?? null;
    for (const seg of segmentsOf(path)) {
      node = node.children.get(seg) || node.wildcard;
      if (!node) break;
      if (node.value !== undefined) found = node.value;
    }
    return found;
  };

  for (const [pattern, value] of entries) insert(pattern, value);
  return { insert, lookup };
};

module.exports = { createRouteTrie };
