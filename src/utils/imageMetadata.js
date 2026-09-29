const ApiError = require("./ApiError");

/**
 * Removes hidden metadata (EXIF incl. GPS location, XMP, comments, text
 * chunks) from JPEG, PNG and WebP files without re-encoding the pixels.
 * Cloudinary keeps this metadata on upload, so evidence images are cleaned
 * here first.
 */

const unreadable = () => new ApiError(400, "This image couldn't be read. Please try a different screenshot.");

// JPEG: keep APP0 (JFIF), APP2 (ICC colour profile) and APP14 (Adobe colour); drop other APPn and comments
const JPEG_KEEP_APP = new Set([0xe0, 0xe2, 0xee]);

const stripJpeg = (buf) => {
  const out = [buf.subarray(0, 2)];
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xff) throw unreadable();
    const marker = buf[i + 1];
    if (marker === 0xff) { i += 1; continue; } // fill byte
    if (marker === 0xd9) { out.push(buf.subarray(i, i + 2)); break; } // end of image
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { out.push(buf.subarray(i, i + 2)); i += 2; continue; }
    if (i + 4 > buf.length) throw unreadable();
    const len = buf.readUInt16BE(i + 2);
    if (len < 2 || i + 2 + len > buf.length) throw unreadable();
    const segment = buf.subarray(i, i + 2 + len);
    if (marker === 0xda) {
      out.push(buf.subarray(i)); // start of scan: image data runs to the end
      break;
    }
    const isApp = marker >= 0xe0 && marker <= 0xef;
    if (!(isApp && !JPEG_KEEP_APP.has(marker)) && marker !== 0xfe) out.push(segment);
    i += 2 + len;
  }
  return Buffer.concat(out);
};

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_DROP = new Set(["tEXt", "zTXt", "iTXt", "eXIf", "tIME"]);

const stripPng = (buf) => {
  const out = [PNG_SIG];
  let i = 8;
  while (i < buf.length) {
    if (i + 12 > buf.length) throw unreadable();
    const len = buf.readUInt32BE(i);
    const type = buf.toString("latin1", i + 4, i + 8);
    const end = i + 12 + len;
    if (end > buf.length) throw unreadable();
    if (!PNG_DROP.has(type)) out.push(buf.subarray(i, end));
    i = end;
    if (type === "IEND") break;
  }
  return Buffer.concat(out);
};

const stripWebp = (buf) => {
  if (buf.toString("latin1", 0, 4) !== "RIFF" || buf.toString("latin1", 8, 12) !== "WEBP") throw unreadable();
  const chunks = [];
  let i = 12;
  while (i + 8 <= buf.length) {
    const type = buf.toString("latin1", i, i + 4);
    const size = buf.readUInt32LE(i + 4);
    const end = i + 8 + size + (size % 2);
    if (i + 8 + size > buf.length) throw unreadable();
    if (type !== "EXIF" && type !== "XMP ") {
      const chunk = Buffer.from(buf.subarray(i, Math.min(end, buf.length)));
      if (type === "VP8X") chunk[8] &= ~(0x08 | 0x04); // clear the "has EXIF / XMP" flags
      chunks.push(chunk);
    }
    i = end;
  }
  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(12);
  header.write("RIFF", 0, "latin1");
  header.writeUInt32LE(body.length + 4, 4);
  header.write("WEBP", 8, "latin1");
  return Buffer.concat([header, body]);
};

/** @param {Buffer} buf  @param {string} mime  image/jpeg | image/png | image/webp */
const stripImageMetadata = (buf, mime) => {
  if (mime === "image/jpeg") return stripJpeg(buf);
  if (mime === "image/png") return stripPng(buf);
  if (mime === "image/webp") return stripWebp(buf);
  throw unreadable();
};

module.exports = { stripImageMetadata };
