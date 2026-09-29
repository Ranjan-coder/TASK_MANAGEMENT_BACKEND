process.env.NODE_ENV = "test";

const config = require("../src/config/env");
const v = require("../src/validators/content.validator");
const { isOwnMedia, _internals: media } = require("../src/services/media.service");
const { _internals: content } = require("../src/controllers/content.controller");
const { evaluateAccess } = require("../src/middlewares/accessPolicy");

const CLOUD = config.cloudinary.cloudName || "testcloud";
config.cloudinary.cloudName = CLOUD;
const img = (id = "bonito/campaigns/123_abc") => ({
  url: media.imageUrl(id),
  publicId: id,
  resourceType: "image"
});
const base = {
  title: "Monsoon kitchen offer",
  kind: "image",
  media: img(),
  startAt: "2026-10-01T00:00:00.000Z"
};
const parse = (body) => v.createCampaignSchema.parse({ body });

describe("campaign validation", () => {
  test("accepts a basic image campaign with defaults", () => {
    const out = parse(base).body;
    expect(out.status).toBe("draft");
    expect(out.cta.type).toBe("none");
  });

  test("rejects media that wasn't uploaded through our Cloudinary folders", () => {
    expect(() => parse({ ...base, media: { ...img(), url: "https://evil.example.com/pixel.png" } })).toThrow();
    expect(() => parse({ ...base, media: img("other/folder/x") })).toThrow();
    expect(isOwnMedia(img().url, img().publicId, "catalog")).toBe(false);
    // Only URLs the server itself builds for that file: no remote "fetch" URLs, no other accounts, no path tricks
    const cloudBase = media.imageUrl("bonito/campaigns/123_abc").split("/image/")[0];
    expect(isOwnMedia(`${cloudBase}/image/fetch/https://tracker.example/x.png`, "bonito/campaigns/123_abc", "campaign")).toBe(false);
    expect(isOwnMedia(`${cloudBase}/../othercloud/image/upload/x`, "bonito/campaigns/123_abc", "campaign")).toBe(false);
    expect(isOwnMedia(media.imageUrl("bonito/campaigns/../catalog/x"), "bonito/campaigns/../catalog/x", "campaign")).toBe(false);
    expect(isOwnMedia(media.imageUrl("bonito/campaigns/other_file"), "bonito/campaigns/123_abc", "campaign")).toBe(false);
  });

  test("end date must be after start date; media must match the kind", () => {
    expect(() => parse({ ...base, endAt: "2026-09-01T00:00:00.000Z" })).toThrow();
    expect(() => parse({ ...base, kind: "video" })).toThrow();
    expect(parse({ ...base, kind: "offer", media: null, offer: { badge: "Flat 20% off" } }).body.offer.badge).toBe("Flat 20% off");
  });

  test("CTA links are https only; phones are normalised", () => {
    const withCta = (cta) => parse({ ...base, cta }).body.cta;
    expect(() => withCta({ type: "link", value: "javascript:alert(1)" })).toThrow();
    expect(() => withCta({ type: "link", value: "http://example.com" })).toThrow();
    expect(() => withCta({ type: "link", value: "https://user:pw@example.com" })).toThrow();
    expect(withCta({ type: "link", value: "https://bonito.in/offers" }).value).toBe("https://bonito.in/offers");
    expect(withCta({ type: "whatsapp", value: "98765 43210" }).value).toBe("+919876543210");
    expect(() => withCta({ type: "whatsapp", value: "12345" })).toThrow();
    expect(withCta({ type: "call", value: "1800-123-4567" }).value).toBe("18001234567");
    expect(withCta({ type: "consultation", value: "ignored" }).value).toBe("");
  });

  test("unknown fields (stats, createdBy) are rejected", () => {
    expect(() => parse({ ...base, stats: { impressions: 1e6 } })).toThrow();
    expect(() => parse({ ...base, createdBy: "64b7f0c2a1b2c3d4e5f60718" })).toThrow();
  });

  test("control characters are stripped from text", () => {
    expect(parse({ ...base, title: "Kitchen\u0000 offer" }).body.title).toBe("Kitchen offer");
  });
});

describe("catalog validation", () => {
  test("images must come from the catalog folder; price is a whole number", () => {
    const ok = {
      kind: "service",
      category: "Modular Kitchen",
      name: "L-shaped kitchen",
      images: [{ url: media.imageUrl("bonito/catalog/1_a"), publicId: "bonito/catalog/1_a" }],
      startingPrice: 150000
    };
    expect(v.createCatalogSchema.parse({ body: ok }).body.isPublished).toBe(false);
    expect(() => v.createCatalogSchema.parse({ body: { ...ok, images: [img()] } })).toThrow();
    expect(() => v.createCatalogSchema.parse({ body: { ...ok, startingPrice: 99.5 } })).toThrow();
    expect(() => v.createCatalogSchema.parse({ body: { ...ok, slug: "custom" } })).toThrow();
  });

  test("slugs are URL-safe", () => {
    expect(content.slugify("Wardrobes & Storage — Premium!")).toBe("wardrobes-storage-premium");
    expect(content.slugify("Café Décor")).toBe("cafe-decor");
  });
});

describe("file sniffing", () => {
  test("detects real image bytes and ignores claimed types", async () => {
    const png = Buffer.from("89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C489", "hex");
    expect((await media.sniff(png))?.mime).toBe("image/png");
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    expect(["image/png", "image/jpeg", "image/webp"]).not.toContain((await media.sniff(svg))?.mime);
  });
});

describe("customer view of campaigns", () => {
  test("hides stats, authors and status", () => {
    const pub = content.publicCampaign({
      _id: "1",
      title: "T",
      description: "",
      kind: "image",
      media: { url: "u", publicId: "p", resourceType: "image" },
      cta: { type: "none" },
      startAt: new Date(),
      endAt: null,
      stats: { impressions: 5 },
      createdBy: "x",
      status: "published"
    });
    expect(pub).not.toHaveProperty("stats");
    expect(pub).not.toHaveProperty("createdBy");
    expect(pub).not.toHaveProperty("status");
    expect(pub.media).not.toHaveProperty("publicId");
  });
});

describe("access policy for content", () => {
  const can = (role, method, url) =>
    evaluateAccess({ user: { role, isTwoFactorEnabled: true }, method, originalUrl: url }).allowed;
  const ID = "64b7f0c2a1b2c3d4e5f60718";

  test("customers can view and interact, not manage", () => {
    expect(can("customer", "GET", "/api/v1/campaigns/live")).toBe(true);
    expect(can("customer", "POST", `/api/v1/campaigns/${ID}/lead`)).toBe(true);
    expect(can("customer", "GET", "/api/v1/catalog/l-shaped-kitchen")).toBe(true);
    expect(can("customer", "GET", "/api/v1/admin/campaigns")).toBe(false);
    expect(can("customer", "POST", "/api/v1/admin/media")).toBe(false);
  });

  test("marketing can manage content but not users or tasks", () => {
    expect(can("marketing", "POST", "/api/v1/admin/campaigns")).toBe(true);
    expect(can("marketing", "PUT", `/api/v1/admin/catalog/${ID}`)).toBe(true);
    expect(can("marketing", "POST", "/api/v1/admin/media")).toBe(true);
    expect(can("marketing", "GET", "/api/v1/users")).toBe(false);
  });
});

describe("log redaction", () => {
  test("secrets never reach error logs", () => {
    const handler = require("../src/middlewares/errorHandler.middleware");
    const logger = require("../src/utils/logger");
    const spy = jest.spyOn(logger, "error").mockImplementation(() => {});
    const res = { status: () => res, json: () => res };
    handler(
      new Error("boom"),
      { method: "POST", originalUrl: "/x", body: { identifier: "a@b.com", authKey: "SECRET1", password: "SECRET2", keyBundle: { ciphertext: "SECRET3" }, code: "123456" } },
      res,
      () => {}
    );
    const logged = JSON.stringify(spy.mock.calls);
    spy.mockRestore();
    expect(logged).not.toMatch(/SECRET|123456/);
    expect(logged).toContain("a@b.com");
  });
});
