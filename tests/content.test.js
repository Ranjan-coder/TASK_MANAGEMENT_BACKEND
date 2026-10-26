process.env.NODE_ENV = "test";

const config = require("../src/config/env");
const v = require("../src/validators/content.validator");
const { isOwnMedia, _internals: media } = require("../src/services/media.service");
const { _internals: content } = require("../src/controllers/content.controller");
const { evaluateAccess } = require("../src/middlewares/accessPolicy");

const CLOUD = config.cloudinary.cloudName || "testcloud";
config.cloudinary.cloudName = CLOUD;
// Media checks run inside an organisation: files must be in its own folder
const tenant = require("../src/utils/tenantContext");
const ORG = "64b7f0c2a1b2c3d4e5f60799";
const OTHER_ORG = "64b7f0c2a1b2c3d4e5f60798";
const inOrg = (fn, org = ORG) => tenant.runInOrg(org, fn);
const ownMedia = (...args) => inOrg(() => isOwnMedia(...args));
const img = (id = `org_${ORG}/campaigns/123_abc`) => ({
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
const parse = (body) => inOrg(() => v.createCampaignSchema.parse({ body }));

describe("campaign validation", () => {
  test("accepts a basic image campaign with defaults", () => {
    const out = parse(base).body;
    expect(out.status).toBe("draft");
    expect(out.cta.type).toBe("none");
  });

  test("rejects media that wasn't uploaded through our Cloudinary folders", () => {
    expect(() => parse({ ...base, media: { ...img(), url: "https://evil.example.com/pixel.png" } })).toThrow();
    expect(() => parse({ ...base, media: img("other/folder/x") })).toThrow();
    expect(ownMedia(img().url, img().publicId, "catalog")).toBe(false);
    // Only URLs the server itself builds for that file: no remote "fetch" URLs, no other accounts, no path tricks
    const cloudBase = media.imageUrl(`org_${ORG}/campaigns/123_abc`).split("/image/")[0];
    expect(ownMedia(`${cloudBase}/image/fetch/https://tracker.example/x.png`, `org_${ORG}/campaigns/123_abc`, "campaign")).toBe(false);
    expect(ownMedia(`${cloudBase}/../othercloud/image/upload/x`, `org_${ORG}/campaigns/123_abc`, "campaign")).toBe(false);
    expect(ownMedia(media.imageUrl(`org_${ORG}/campaigns/../catalog/x`), `org_${ORG}/campaigns/../catalog/x`, "campaign")).toBe(false);
    expect(ownMedia(media.imageUrl(`org_${ORG}/campaigns/other_file`), `org_${ORG}/campaigns/123_abc`, "campaign")).toBe(false);
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

describe("media belongs to one organisation", () => {
  test("another organisation's files are refused, and so is everything outside a request", () => {
    const theirs = `org_${OTHER_ORG}/campaigns/123_abc`;
    expect(ownMedia(media.imageUrl(theirs), theirs, "campaign")).toBe(false);
    expect(inOrg(() => isOwnMedia(media.imageUrl(theirs), theirs, "campaign"), OTHER_ORG)).toBe(true);
    expect(isOwnMedia(img().url, img().publicId, "campaign")).toBe(false); // no organisation context
    // The old shared folder only counts for the first organisation (not this one)
    expect(ownMedia(media.imageUrl("bonito/campaigns/1_a"), "bonito/campaigns/1_a", "campaign")).toBe(false);
  });
});

describe("catalog validation", () => {
  test("images must come from the catalog folder; price is a whole number", () => {
    const ok = {
      kind: "service",
      category: "Modular Kitchen",
      name: "L-shaped kitchen",
      images: [{ url: media.imageUrl(`org_${ORG}/catalog/1_a`), publicId: `org_${ORG}/catalog/1_a` }],
      startingPrice: 150000
    };
    const cat = (body) => inOrg(() => v.createCatalogSchema.parse({ body }));
    expect(cat(ok).body.isPublished).toBe(false);
    expect(() => cat({ ...ok, images: [img()] })).toThrow();
    expect(() => cat({ ...ok, startingPrice: 99.5 })).toThrow();
    expect(() => cat({ ...ok, slug: "custom" })).toThrow();
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

describe("uploads land where isOwnMedia looks", () => {
  const cloudinary = require("../src/config/cloudinary");
  const { uploadMedia } = require("../src/services/media.service");
  const saved = { config: cloudinary.config(), stream: cloudinary.uploader.upload_stream };
  const calls = [];
  beforeAll(() => {
    cloudinary.config({ cloud_name: CLOUD, api_key: "k", api_secret: "s" });
    // Like an account in dynamic folder mode: `folder` never reaches the public id
    cloudinary.uploader.upload_stream = (opts, cb) => ({
      end: (buf) => {
        calls.push(opts);
        cb(null, { public_id: opts.public_id || "root_file", width: 4, height: 4, bytes: buf.length, ...(opts.resource_type === "video" ? { duration: 12 } : {}) });
      }
    });
  });
  afterAll(() => {
    cloudinary.uploader.upload_stream = saved.stream;
    cloudinary.config({ cloud_name: saved.config.cloud_name, api_key: saved.config.api_key, api_secret: saved.config.api_secret });
  });
  const png = Buffer.from("89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C489", "hex");
  const mp4 = (brand) => Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from(`ftyp${brand}`), Buffer.from([0, 0, 2, 0]), Buffer.from(`${brand}isomiso2`), Buffer.alloc(64, 1)]);

  test("a catalog image saves (regression: 'Upload images through the catalog editor')", async () => {
    const asset = await inOrg(() => uploadMedia(png, "catalog"));
    expect(asset.publicId).toMatch(new RegExp(`^org_${ORG}/catalog/\\d+_[a-f0-9]{16}$`));
    const body = { kind: "product", category: "Kitchen", name: "Island", images: [{ url: asset.url, publicId: asset.publicId }] };
    expect(() => inOrg(() => v.createCatalogSchema.parse({ body }))).not.toThrow();
  });

  test("campaign videos (mp4, mov, m4v) save, with a longer upload timeout", async () => {
    for (const brand of ["isom", "qt  ", "M4V "]) {
      const asset = await inOrg(() => uploadMedia(mp4(brand), "campaign"));
      expect(asset.resourceType).toBe("video");
      const { width, height, ...m } = asset;
      expect(() => parse({ ...base, kind: "video", media: { ...m, width, height } })).not.toThrow();
    }
    expect(calls.at(-1).timeout).toBeGreaterThanOrEqual(5 * 60 * 1000);
    expect(calls.every((c) => !("folder" in c))).toBe(true);
    // Catalog still takes images only
    await expect(inOrg(() => uploadMedia(mp4("isom"), "catalog"))).rejects.toThrow(/JPG, PNG or WebP/);
  });
});

describe("campaign videos uploaded straight to Cloudinary", () => {
  const cloudinary = require("../src/config/cloudinary");
  const { videoUploadTicket, finishVideoUpload } = require("../src/services/media.service");
  const saved = { config: cloudinary.config(), resource: cloudinary.api.resource, destroy: cloudinary.uploader.destroy };
  let stored = {};
  const destroyed = [];
  beforeAll(() => {
    cloudinary.config({ cloud_name: CLOUD, api_key: "k", api_secret: "s" });
    cloudinary.api.resource = async (id) => {
      if (!stored[id]) throw { error: { message: "Resource not found", http_code: 404 } };
      return { public_id: id, ...stored[id] };
    };
    cloudinary.uploader.destroy = async (id) => destroyed.push(id);
  });
  afterAll(() => {
    Object.assign(cloudinary.api, { resource: saved.resource });
    cloudinary.uploader.destroy = saved.destroy;
    cloudinary.config({ cloud_name: saved.config.cloud_name, api_key: saved.config.api_key, api_secret: saved.config.api_secret });
  });

  test("the ticket signs this organisation's folder and video formats only", () => {
    const t = inOrg(() => videoUploadTicket(28 * 1024 * 1024));
    expect(t.uploadUrl).toBe(`https://api.cloudinary.com/v1_1/${CLOUD}/video/upload`);
    expect(t.fields.public_id).toMatch(new RegExp(`^org_${ORG}/campaigns/\\d+_[a-f0-9]{16}$`));
    expect(t.fields.allowed_formats).toBe("mp4,mov,m4v,3gp,webm");
    const { signature, api_key, ...signed } = t.fields;
    expect(signature).toBe(cloudinary.utils.api_sign_request(signed, "s"));
    expect(api_key).toBe("k");
    // Cloudinary needs >5 MB pieces (except the last)
    expect(t.chunkBytes).toBeGreaterThan(5 * 1000 * 1000);
    expect(t.uploadId).toMatch(/^[a-f0-9]{32}$/);
    expect(() => inOrg(() => videoUploadTicket(51 * 1024 * 1024))).toThrow(/50 MB/);
  });

  test("finish checks what actually arrived; the result saves on a video campaign", async () => {
    const id = `org_${ORG}/campaigns/1_aaaaaaaaaaaaaaaa`;
    stored[id] = { format: "mp4", bytes: 28 * 1024 * 1024, width: 1280, height: 720, duration: 41.2 };
    const asset = await inOrg(() => finishVideoUpload(id, 28 * 1024 * 1024));
    expect(asset).toMatchObject({ publicId: id, resourceType: "video", duration: 41.2, bytes: 28 * 1024 * 1024 });
    expect(() => parse({ ...base, kind: "video", media: asset })).not.toThrow();
  });

  test("too long / too big / partial videos are deleted; other organisations and missing uploads are refused", async () => {
    const long = `org_${ORG}/campaigns/2_bbbbbbbbbbbbbbbb`;
    stored[long] = { format: "mov", bytes: 1000, duration: 95 };
    await expect(inOrg(() => finishVideoUpload(long, 1000))).rejects.toThrow(/60 seconds/);
    const big = `org_${ORG}/campaigns/3_cccccccccccccccc`;
    stored[big] = { format: "mp4", bytes: 80 * 1024 * 1024, duration: 10 };
    await expect(inOrg(() => finishVideoUpload(big, 80 * 1024 * 1024))).rejects.toThrow(/50 MB/);
    // Seen on a real account: only the last piece arrived, yet Cloudinary stored it as a file
    const partial = `org_${ORG}/campaigns/7_ffffffffffffffff`;
    stored[partial] = { format: "mp4", bytes: 512 * 1024, duration: 3 };
    await expect(inOrg(() => finishVideoUpload(partial, 28 * 1024 * 1024))).rejects.toThrow(/didn't upload completely/);
    expect(destroyed).toEqual([long, big, partial]);

    const theirs = `org_${OTHER_ORG}/campaigns/4_dddddddddddddddd`;
    stored[theirs] = { format: "mp4", bytes: 1000, duration: 5 };
    await expect(inOrg(() => finishVideoUpload(theirs, 1000))).rejects.toThrow(/campaign editor/);
    await expect(inOrg(() => finishVideoUpload(`org_${ORG}/catalog/5_e`, 1000))).rejects.toThrow(/campaign editor/);
    await expect(inOrg(() => finishVideoUpload(`org_${ORG}/campaigns/6_never_arrived`, 1000))).rejects.toThrow(/didn't finish/);
    expect(destroyed).toHaveLength(3);
  });
});

describe("live campaigns for customers", () => {
  const now = new Date("2026-10-25T00:00:00Z");
  test("no known city: city-targeted campaigns are not hidden", () => {
    const f = content.liveCampaignFilter(undefined, now);
    expect(f.status).toBe("published");
    expect(f.targetCities).toBeUndefined();
    expect(f.$and).toBeUndefined();
  });
  test("a city matches untargeted or same-city campaigns, case-insensitively and literally", () => {
    const rx = content.liveCampaignFilter(" pune ", now).$and[0].$or[1].targetCities;
    expect(rx.test("Pune")).toBe(true);
    expect(rx.test("Pune East")).toBe(false);
    expect(content.liveCampaignFilter(".*", now).$and[0].$or[1].targetCities.test("Mumbai")).toBe(false);
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
