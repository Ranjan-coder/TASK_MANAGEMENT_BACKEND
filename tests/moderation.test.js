const { normalizeToWords, normalizeTerm, scanText } = require("../src/utils/moderationText");
const SEED = require("../src/config/moderationLexicon.seed");

const lexicon = SEED.map((s) => ({ term: normalizeTerm(s.term), severity: s.severity }));
const scan = (t) => scanText(t, lexicon);

describe("abuse check: normalisation", () => {
  test("lowercase, leetspeak, spelled-out letters and repeats", () => {
    expect(normalizeToWords("SH!T")).toEqual(["shit"]);
    expect(normalizeToWords("$hit b1tch")).toEqual(["shit", "bitch"]);
    expect(normalizeToWords("i.d.i.o.t")).toEqual(["idiot"]);
    expect(normalizeToWords("f u c k")).toEqual(["fuck"]);
    expect(normalizeToWords("fuuuuck")).toEqual(["fuck"]);
    expect(normalizeToWords("ｆｕｃｋ")).toEqual(["fuck"]); // full-width letters (NFKC)
    expect(normalizeToWords("fu​ck")).toEqual(["fuck"]); // zero-width space
  });
  test("Devanagari words keep their vowel signs", () => {
    expect(normalizeToWords("तुम बेवकूफ हो")).toEqual(["तुम", "बेवकूफ", "हो"]);
  });
});

describe("abuse check: matching", () => {
  test("counts each abusive word", () => {
    expect(scan("you idiot, stupid moron")).toEqual({ hitCount: 3, severity: "mild" });
    expect(scan("f.u.c.k you idiot")).toEqual({ hitCount: 2, severity: "abusive" });
    expect(scan("chutiya bewakoof")).toEqual({ hitCount: 2, severity: "abusive" });
  });
  test("threats are phrases, counted once even when phrases overlap", () => {
    expect(scan("Main tujhe jaan se maar dunga")).toEqual({ hitCount: 1, severity: "threat" });
    expect(scan("I will kill u")).toEqual({ hitCount: 1, severity: "threat" });
    expect(scan("तुम बेवकूफ हो, मार दूंगा")).toEqual({ hitCount: 2, severity: "threat" });
  });
  test("harmless words and common Hindi phrases don't match", () => {
    for (const ok of [
      "This design is killer, great skill",
      "Please share the quote asap",
      "chod do yaar, main dekh lunga",
      "maa ki tabiyat theek nahi hai",
      "The class starts at 10am",
      "Assessment done, pass the scissors",
      "saala ji ki shaadi hai",
      "Kill the lights in the showroom at 7"
    ]) {
      expect(scan(ok)).toEqual({ hitCount: 0, severity: null });
    }
  });
  test("seed list has no duplicates after normalising", () => {
    const terms = lexicon.map((l) => l.term);
    expect(new Set(terms).size).toBe(terms.length);
    expect(terms.every((t) => t.replace(/ /g, "").length >= 2)).toBe(true);
  });
});

describe("abuse check: server-side flag validation", () => {
  const { parseModeration } = require("../src/services/moderation.service");
  const project = { project: { status: "active" } };
  test("accepts sane flags on project text messages", () => {
    expect(parseModeration({ flagged: true, severity: "abusive", hitCount: 3 }, { messageType: "text", conversation: project })).toEqual({
      flagged: true,
      severity: "abusive",
      hitCount: 3
    });
  });
  test("ignores flags outside project text messages, refuses out-of-range ones", () => {
    expect(parseModeration({ flagged: true, severity: "abusive", hitCount: 3 }, { messageType: "file", conversation: project })).toBeUndefined();
    expect(parseModeration({ flagged: true, severity: "abusive", hitCount: 3 }, { messageType: "text", conversation: {} })).toBeUndefined();
    expect(parseModeration({ flagged: false }, { messageType: "text", conversation: project })).toBeUndefined();
    expect(() => parseModeration({ flagged: true, severity: "abusive", hitCount: 99 }, { messageType: "text", conversation: project })).toThrow();
    expect(() => parseModeration({ flagged: true, severity: "nuclear", hitCount: 1 }, { messageType: "text", conversation: project })).toThrow();
    expect(() => parseModeration({ flagged: true, severity: "mild", hitCount: 1.5 }, { messageType: "text", conversation: project })).toThrow();
  });
});
