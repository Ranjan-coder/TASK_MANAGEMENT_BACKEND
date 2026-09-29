const { changePasswordSchema, loginSchema } = require("../src/validators/auth.validator");
const { customerRegisterSchema, passwordResetWithOtpSchema } = require("../src/validators/customerAuth.validator");
const { createUserSchema, updateUserSchema } = require("../src/validators/user.validator");

const body = (b) => ({ body: b });
const AUTH_KEY = Buffer.alloc(32, 7).toString("base64");
const AUTH_KEY_2 = Buffer.alloc(32, 9).toString("base64");
const SALT = Buffer.alloc(16, 3).toString("base64");

describe("customer registration", () => {
  const valid = {
    name: "Asha Mehta",
    email: "Asha@Example.com",
    phone: "98765 43210",
    authKey: AUTH_KEY,
    kdfSalt: SALT,
    acceptTerms: true
  };

  test("normalises email and phone", () => {
    const parsed = customerRegisterSchema.parse(body(valid));
    expect(parsed.body.email).toBe("asha@example.com");
    expect(parsed.body.phone).toBe("+919876543210");
  });

  test.each([
    [{ role: "superadmin" }],
    [{ role: "admin" }],
    [{ status: "active" }],
    [{ createdBy: "64b7f0c2a1b2c3d4e5f60718" }],
    [{ phoneVerified: true }],
    [{ password: "Secure123" }]
  ])("rejects extra field %o", (extra) => {
    expect(() => customerRegisterSchema.parse(body({ ...valid, ...extra }))).toThrow();
  });

  test("requires consent", () => {
    expect(() => customerRegisterSchema.parse(body({ ...valid, acceptTerms: false }))).toThrow();
    const { acceptTerms, ...noConsent } = valid;
    expect(() => customerRegisterSchema.parse(body(noConsent))).toThrow();
  });

  test("rejects non-Indian numbers and malformed keys", () => {
    expect(() => customerRegisterSchema.parse(body({ ...valid, phone: "+14155552671" }))).toThrow();
    expect(() => customerRegisterSchema.parse(body({ ...valid, phone: "12345" }))).toThrow();
    expect(() => customerRegisterSchema.parse(body({ ...valid, authKey: "short" }))).toThrow();
    expect(() => customerRegisterSchema.parse(body({ ...valid, kdfSalt: Buffer.alloc(8).toString("base64") }))).toThrow();
  });

  test("password reset requires a 6-digit code", () => {
    expect(() => passwordResetWithOtpSchema.parse(body({ phone: "9876543210", code: "12345", authKey: AUTH_KEY, kdfSalt: SALT }))).toThrow();
    expect(passwordResetWithOtpSchema.parse(body({ phone: "9876543210", code: "123456", authKey: AUTH_KEY, kdfSalt: SALT }))).toBeTruthy();
  });
});

describe("login", () => {
  test("takes identifier + authKey, and the raw password only for legacy migration", () => {
    expect(loginSchema.parse(body({ identifier: "9876543210", authKey: AUTH_KEY })).body.identifier).toBe("9876543210");
    expect(loginSchema.parse(body({ identifier: "a@b.com", authKey: AUTH_KEY, password: "Old123pass" }))).toBeTruthy();
    expect(() => loginSchema.parse(body({ identifier: "a@b.com", password: "x" }))).toThrow();
    expect(() => loginSchema.parse(body({ identifier: "a@b.com", authKey: AUTH_KEY, role: "admin" }))).toThrow();
  });
});

describe("change password", () => {
  test("requires current credential, a different new key, and a valid bundle", () => {
    const base = { currentAuthKey: AUTH_KEY, newAuthKey: AUTH_KEY_2, newKdfSalt: SALT };
    expect(changePasswordSchema.parse(body(base))).toBeTruthy();
    expect(changePasswordSchema.parse(body({ ...base, keyBundle: { ciphertext: "A".repeat(40), iv: "A".repeat(16) } }))).toBeTruthy();
    expect(() => changePasswordSchema.parse(body({ ...base, newAuthKey: AUTH_KEY }))).toThrow();
    expect(() => changePasswordSchema.parse(body({ newAuthKey: AUTH_KEY_2, newKdfSalt: SALT }))).toThrow();
    expect(() => changePasswordSchema.parse(body({ ...base, keyBundle: { ciphertext: "A".repeat(40), iv: "bad" } }))).toThrow();
  });
});

describe("admin user management", () => {
  test("accepts the new roles", () => {
    for (const role of ["marketing", "customer", "user"]) {
      expect(
        createUserSchema.parse(body({ name: "Test User", email: "t@example.com", authKey: AUTH_KEY, kdfSalt: SALT, role }))
      ).toBeTruthy();
    }
  });

  test("rejects unknown roles", () => {
    expect(() =>
      createUserSchema.parse(body({ name: "Test", email: "t@example.com", authKey: AUTH_KEY, kdfSalt: SALT, role: "owner" }))
    ).toThrow();
  });

  test("avatarUrl blocks javascript:, http and svg data URLs", () => {
    expect(() => updateUserSchema.parse(body({ avatarUrl: "javascript:alert(1)" }))).toThrow();
    expect(() => updateUserSchema.parse(body({ avatarUrl: "data:image/svg+xml;base64,PHN2Zz4=" }))).toThrow();
    expect(() => updateUserSchema.parse(body({ avatarUrl: "http://example.com/a.png" }))).toThrow();
    expect(updateUserSchema.parse(body({ avatarUrl: "https://res.cloudinary.com/x/a.png" }))).toBeTruthy();
    expect(updateUserSchema.parse(body({ avatarUrl: "data:image/png;base64,iVBORw0KGgo=" }))).toBeTruthy();
  });
});
