const { changePasswordSchema, loginSchema } = require("../src/validators/auth.validator");
const { passwordResetWithOtpSchema } = require("../src/validators/customerAuth.validator");
const { createUserSchema, updateUserSchema } = require("../src/validators/user.validator");

const body = (b) => ({ body: b });
const AUTH_KEY = Buffer.alloc(32, 7).toString("base64");
const AUTH_KEY_2 = Buffer.alloc(32, 9).toString("base64");
const SALT = Buffer.alloc(16, 3).toString("base64");

describe("customer password reset", () => {
  test("needs a 6-digit code", () => {
    expect(() => passwordResetWithOtpSchema.parse(body({ phone: "9876543210", code: "12345", authKey: AUTH_KEY, kdfSalt: SALT }))).toThrow();
    expect(passwordResetWithOtpSchema.parse(body({ phone: "9876543210", code: "123456", authKey: AUTH_KEY, kdfSalt: SALT }))).toBeTruthy();
  });

  test("needs phone + code, or the reset token from choosing an organisation", () => {
    expect(() => passwordResetWithOtpSchema.parse(body({ authKey: AUTH_KEY, kdfSalt: SALT }))).toThrow();
    expect(() => passwordResetWithOtpSchema.parse(body({ phone: "9876543210", authKey: AUTH_KEY, kdfSalt: SALT }))).toThrow();
    const token = "x".repeat(40);
    expect(passwordResetWithOtpSchema.parse(body({ resetToken: token, organisation: "Alpha", authKey: AUTH_KEY, kdfSalt: SALT })).body.organisation).toBe("alpha");
    expect(() => passwordResetWithOtpSchema.parse(body({ resetToken: token, organisation: "bad code!", authKey: AUTH_KEY, kdfSalt: SALT }))).toThrow();
  });
});

describe("login", () => {
  test("takes organisation code + identifier + authKey, and the raw password only for legacy migration", () => {
    const org = { organisation: "Bonito" };
    expect(loginSchema.parse(body({ ...org, identifier: "9876543210", authKey: AUTH_KEY })).body).toMatchObject({ identifier: "9876543210", organisation: "bonito" });
    expect(loginSchema.parse(body({ ...org, identifier: "a@b.com", authKey: AUTH_KEY, password: "Old123pass" }))).toBeTruthy();
    expect(() => loginSchema.parse(body({ ...org, identifier: "a@b.com", password: "x" }))).toThrow();
    expect(() => loginSchema.parse(body({ ...org, identifier: "a@b.com", authKey: AUTH_KEY, role: "admin" }))).toThrow();
  });

  test("the organisation code is required (D-R1)", () => {
    expect(() => loginSchema.parse(body({ identifier: "a@b.com", authKey: AUTH_KEY }))).toThrow();
    expect(() => loginSchema.parse(body({ identifier: "a@b.com", authKey: AUTH_KEY, organisation: "" }))).toThrow();
    expect(() => loginSchema.parse(body({ identifier: "a@b.com", authKey: AUTH_KEY, organisation: "bad code!" }))).toThrow();
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
