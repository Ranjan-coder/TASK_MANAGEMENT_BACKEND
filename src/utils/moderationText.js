/**
 * Text normalisation for the abuse check (plan §6.4). The app runs the same
 * algorithm on the device before sending (frontend/lib/moderation/normalize.ts);
 * the server uses it to store word-list terms in the same form. Keep the two
 * copies identical (tests/moderation.test.js checks the behaviour).
 *
 * Steps: Unicode NFKC + lowercase, drop invisible characters, undo leetspeak
 * inside words (@→a, $→s, 0→o, 1/!→i, 3→e, 4→a, 5→s, 7→t), split into words,
 * join spelled-out letters (i.d.i.o.t → idiot), and collapse repeated letters
 * (fuuuck → fuck, kill → kil). Terms and text go through the same steps, so
 * matching is exact per word and harmless words like "skill" or "killer"
 * don't match "kill".
 */

const INVISIBLE = /[​-‍⁠﻿­]/g;
const LEET = { "@": "a", 4: "a", 3: "e", 1: "i", "!": "i", 0: "o", $: "s", 5: "s", 7: "t" };
const LEET_RE = /[@4310!$57]/g;
const HAS_LETTER = /\p{L}/u;
const NON_LETTER = /[^\p{L}\p{M}]+/u;
const REPEATS = /(\p{L}\p{M}*)\1+/gu;

const normalizeToWords = (input) => {
  const text = String(input || "").normalize("NFKC").toLowerCase().replace(INVISIBLE, "");
  const words = [];
  for (const chunk of text.split(/\s+/)) {
    if (!chunk || !HAS_LETTER.test(chunk)) continue;
    const unleet = chunk.replace(LEET_RE, (c) => LEET[c]);
    for (const part of unleet.split(NON_LETTER)) if (part) words.push(part);
  }

  // Spelled-out words: 3+ single letters in a row become one word
  const merged = [];
  let run = [];
  const flush = () => {
    if (run.length >= 3) merged.push(run.join(""));
    else merged.push(...run);
    run = [];
  };
  for (const w of words) {
    if ([...w].length === 1) run.push(w);
    else {
      flush();
      merged.push(w);
    }
  }
  flush();

  return merged.map((w) => w.replace(REPEATS, "$1"));
};

/** A word-list entry in stored form: normalised words joined by one space. */
const normalizeTerm = (term) => normalizeToWords(term).join(" ");

/**
 * Finds word-list matches in a message. Overlapping matches count once
 * (the longest wins), so "jaan se maar dunga" is one threat, not three.
 * @param {string} text
 * @param {{term: string, severity: string}[]} lexicon  terms already normalised
 * @returns {{hitCount: number, severity: string|null}}
 */
const SEVERITY_RANK = { mild: 1, abusive: 2, threat: 3 };
const scanText = (text, lexicon) => {
  const words = normalizeToWords(text);
  const spans = [];
  for (const { term, severity } of lexicon) {
    const parts = term ? term.split(" ") : [];
    if (!parts.length) continue;
    for (let i = 0; i + parts.length <= words.length; i++) {
      if (parts.every((p, k) => words[i + k] === p)) spans.push({ start: i, end: i + parts.length, severity });
    }
  }
  spans.sort((a, b) => b.end - b.start - (a.end - a.start) || SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
  const taken = new Array(words.length).fill(false);
  let hitCount = 0;
  let severity = null;
  for (const sp of spans) {
    let free = true;
    for (let i = sp.start; i < sp.end; i++) if (taken[i]) free = false;
    if (!free) continue;
    for (let i = sp.start; i < sp.end; i++) taken[i] = true;
    hitCount += 1;
    if (!severity || SEVERITY_RANK[sp.severity] > SEVERITY_RANK[severity]) severity = sp.severity;
  }
  return { hitCount, severity };
};

module.exports = { normalizeToWords, normalizeTerm, scanText, SEVERITY_RANK };
