const zlib = require("zlib");
const { stripImageMetadata } = require("../src/utils/imageMetadata");

const seg = (marker, body) => Buffer.concat([Buffer.from([0xff, marker]), Buffer.from([(body.length + 2) >> 8, (body.length + 2) & 255]), body]);
const SECRET = Buffer.from("GPS 12.9716N 77.5946E");

describe("image metadata stripping", () => {
  test("JPEG: removes EXIF/XMP and comments, keeps JFIF, colour profile and image data", () => {
    const jpeg = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      seg(0xe0, Buffer.from("JFIF\0\x01\x01")),
      seg(0xe1, Buffer.concat([Buffer.from("Exif\0\0"), SECRET])),
      seg(0xe2, Buffer.from("ICC_PROFILE\0")),
      seg(0xfe, SECRET),
      seg(0xdb, Buffer.alloc(65, 1)),
      seg(0xda, Buffer.from([1, 2, 3])),
      Buffer.from([9, 9, 9, 0xff, 0xd9])
    ]);
    const out = stripImageMetadata(jpeg, "image/jpeg");
    expect(out.includes(SECRET)).toBe(false);
    expect(out.includes(Buffer.from("Exif"))).toBe(false);
    expect(out.includes(Buffer.from("JFIF"))).toBe(true);
    expect(out.includes(Buffer.from("ICC_PROFILE"))).toBe(true);
    expect(out.subarray(-5)).toEqual(Buffer.from([9, 9, 9, 0xff, 0xd9]));
  });

  test("PNG: removes text and EXIF chunks, keeps image chunks", () => {
    const chunk = (type, data) => {
      const len = Buffer.alloc(4);
      len.writeUInt32BE(data.length);
      return Buffer.concat([len, Buffer.from(type, "latin1"), data, Buffer.alloc(4)]);
    };
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", Buffer.alloc(13)),
      chunk("tEXt", Buffer.concat([Buffer.from("Comment\0"), SECRET])),
      chunk("eXIf", SECRET),
      chunk("IDAT", zlib.deflateSync(Buffer.alloc(4))),
      chunk("IEND", Buffer.alloc(0))
    ]);
    const out = stripImageMetadata(png, "image/png");
    expect(out.includes(SECRET)).toBe(false);
    expect(out.includes(Buffer.from("IHDR"))).toBe(true);
    expect(out.includes(Buffer.from("IDAT"))).toBe(true);
  });

  test("WebP: removes EXIF/XMP chunks and their flags, fixes the size", () => {
    const chunk = (type, data) => {
      const size = Buffer.alloc(4);
      size.writeUInt32LE(data.length);
      return Buffer.concat([Buffer.from(type, "latin1"), size, data, data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
    };
    const vp8x = Buffer.alloc(10);
    vp8x[0] = 0x08 | 0x04 | 0x10;
    const body = Buffer.concat([chunk("VP8X", vp8x), chunk("VP8L", Buffer.alloc(5, 7)), chunk("EXIF", SECRET), chunk("XMP ", SECRET)]);
    const header = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP")]);
    header.writeUInt32LE(body.length + 4, 4);
    const out = stripImageMetadata(Buffer.concat([header, body]), "image/webp");
    expect(out.includes(SECRET)).toBe(false);
    expect(out.readUInt32LE(4)).toBe(out.length - 8);
    expect(out[20] & 0x0c).toBe(0); // VP8X flags byte
    expect(out[20] & 0x10).toBe(0x10); // alpha flag kept
  });

  test("truncated files are refused", () => {
    expect(() => stripImageMetadata(Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x40, 0x00, 1]), "image/jpeg")).toThrow();
    expect(() => stripImageMetadata(Buffer.from("RIFF\0\0\0\0WEBX"), "image/webp")).toThrow();
  });
});
