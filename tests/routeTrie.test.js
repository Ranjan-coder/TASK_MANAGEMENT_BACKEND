const { createRouteTrie } = require("../src/utils/routeTrie");

describe("route trie", () => {
  const trie = createRouteTrie([
    ["/a", "A"],
    ["/a/:id/x", "X"],
    ["/a/b", "B"],
    ["/c/:id", "C"]
  ]);

  test("longest matching prefix wins", () => {
    expect(trie.lookup("/a")).toBe("A");
    expect(trie.lookup("/a/123")).toBe("A");
    expect(trie.lookup("/a/123/x")).toBe("X");
    expect(trie.lookup("/a/123/x/deeper")).toBe("X");
    expect(trie.lookup("/a/b/c")).toBe("B");
  });

  test("a wildcard alone doesn't make a parent match", () => {
    expect(trie.lookup("/c")).toBeNull();
    expect(trie.lookup("/c/1")).toBe("C");
  });

  test("unknown paths and empty input return null", () => {
    expect(trie.lookup("/zzz")).toBeNull();
    expect(trie.lookup("")).toBeNull();
  });

  test("mapping the same pattern to two values is refused", () => {
    expect(() => createRouteTrie([["/a", "A"], ["/a/", "B"]])).toThrow(/mapped twice/);
  });
});
