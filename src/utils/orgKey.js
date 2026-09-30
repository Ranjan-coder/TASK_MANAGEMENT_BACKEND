/**
 * Normalised key for department / designation names, stored in a unique index so
 * "TECH", " tech " and "Tech" can't all exist. "&" and "and" are treated alike, and
 * punctuation and spacing are ignored ("Pre-Sales" = "Pre Sales" = "presales").
 */
const orgKey = (name) =>
  String(name || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "");

module.exports = { orgKey };
