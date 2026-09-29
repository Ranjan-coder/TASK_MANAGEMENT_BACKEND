process.env.NODE_ENV = "test";

const jwt = require("jsonwebtoken");
const config = require("../src/config/env");
const { normalizeIndianMobile, maskPhone, looksLikeEmail } = require("../src/utils/phone");
const { _internals } = require("../src/services/otp.service");
const authService = require("../src/services/auth.service");
const { sanitizeUser } = require("../src/services/customerAuth.service");
const authMiddleware = require("../src/middlewares/auth.middleware");

describe("phone normalisation", () => {
  test.each([
    ["9876543210", "+919876543210"],
    ["09876543210", "+919876543210"],
    ["+91 98765 43210", "+919876543210"],
    ["91-9876543210", "+919876543210"],
    ["(987) 654-3210", "+919876543210"]
  ])("%s -> %s", (input, expected) => expect(normalizeIndianMobile(input)).toBe(expected));

  test.each(["", "12345", "5876543210", "+14155552671", "98765432101", "9876abc210", null, 9876543210])(
    "rejects %p",
    (input) => expect(normalizeIndianMobile(input)).toBeNull()
  );

  test("masking hides all but the last 4 digits", () => {
    expect(maskPhone("+919876543210")).toBe("+91 ******3210");
  });

  test("email detection", () => {
    expect(looksLikeEmail("a@b.com")).toBe(true);
    expect(looksLikeEmail("9876543210")).toBe(false);
  });
});

describe("OTP codes", () => {
  test("are always 6 digits", () => {
    for (let i = 0; i < 500; i++) expect(_internals.generateCode()).toMatch(/^\d{6}$/);
  });

  test("hashes are bound to phone and purpose", () => {
    const h = _internals.hashCode("+919876543210", "verify_phone", "123456");
    expect(h).toHaveLength(64);
    expect(h).not.toContain("123456");
    expect(_internals.hashCode("+919876543211", "verify_phone", "123456")).not.toBe(h);
    expect(_internals.hashCode("+919876543210", "reset_password", "123456")).not.toBe(h);
    expect(_internals.safeEqualHex(h, _internals.hashCode("+919876543210", "verify_phone", "123456"))).toBe(true);
  });
});

describe("step tokens", () => {
  test("verify only for the expected stage", () => {
    const token = authService.signStepToken("64b7f0c2a1b2c3d4e5f60718", "phone_verify");
    expect(authService.verifyStepToken(token, "phone_verify").userId).toBe("64b7f0c2a1b2c3d4e5f60718");
    expect(() => authService.verifyStepToken(token, "2fa_pending")).toThrow();
    expect(() => authService.verifyStepToken("garbage", "phone_verify")).toThrow();
  });

  test.each(["2fa_pending", "phone_verify"])("a %s token is refused as an access token", async (stage) => {
    const token = jwt.sign({ userId: "64b7f0c2a1b2c3d4e5f60718", stage }, config.jwt.accessSecret);
    const req = { cookies: {}, headers: { authorization: `Bearer ${token}` }, method: "GET", originalUrl: "/api/v1/tasks" };
    const next = jest.fn();
    await authMiddleware(req, {}, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0][0].statusCode).toBe(401);
    expect(req.user).toBeUndefined();
  });
});

test("sanitizeUser strips secrets", () => {
  const out = sanitizeUser({
    name: "A",
    password: "hash",
    twoFactorSecret: "s",
    refreshTokens: ["t"],
    pendingPhone: "+919876543210",
    passwordResetToken: "r"
  });
  expect(out).toEqual({ name: "A" });
});
