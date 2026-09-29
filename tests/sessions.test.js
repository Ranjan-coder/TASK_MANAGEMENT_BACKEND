process.env.NODE_ENV = "test";

const jwt = require("jsonwebtoken");
const config = require("../src/config/env");
const { describeDevice } = require("../src/utils/device");
const authService = require("../src/services/auth.service");

describe("device labels", () => {
  test.each([
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36", "Chrome on Windows"],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1", "Safari on iOS"],
    ["Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Mobile Safari/537.36", "Chrome on Android"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36 Edg/128.0", "Edge on Windows"],
    ["", "Browser on unknown OS"]
  ])("%s", (ua, label) => expect(describeDevice(ua)).toBe(label));
});

describe("session tokens", () => {
  const user = { _id: "64b7f0c2a1b2c3d4e5f60718", role: "customer", tokenVersion: 3 };

  test("both tokens carry the session id", () => {
    const { accessToken, refreshToken } = authService.generateTokens(user, { sessionId: "sess-1", trusted: true });
    expect(jwt.verify(accessToken, config.jwt.accessSecret).sid).toBe("sess-1");
    const refresh = jwt.verify(refreshToken, config.jwt.refreshSecret);
    expect(refresh.sid).toBe("sess-1");
    expect(refresh.trusted).toBe(true);
  });

  test("untrusted devices get a short refresh token", () => {
    const { refreshToken } = authService.generateTokens(user, { sessionId: "s", trusted: false });
    const { iat, exp, trusted } = jwt.verify(refreshToken, config.jwt.refreshSecret);
    expect(trusted).toBe(false);
    expect(exp - iat).toBe(12 * 60 * 60);
  });

  test("untrusted cookies end with the browser session", () => {
    const cookies = {};
    const res = { cookie: (name, value, opts) => (cookies[name] = opts) };
    authService.setTokenCookies(res, "a", "r", "customer", { trusted: false });
    expect(cookies.refreshToken.maxAge).toBeUndefined();
    expect(cookies.refreshToken.httpOnly).toBe(true);
    authService.setTokenCookies(res, "a", "r", "customer", { trusted: true });
    expect(cookies.refreshToken.maxAge).toBe(7 * 24 * 60 * 60 * 1000);
  });

  test("session list never exposes refresh token hashes and marks this device", () => {
    const list = authService.describeSessions(
      {
        currentSessions: [
          { sessionId: "a", deviceName: "Chrome on Windows", ipAddress: "1.1.1.1", refreshTokenHash: "secret", trusted: true, lastActive: new Date(1), createdAt: new Date(1) },
          { sessionId: "b", deviceName: "Safari on iOS", ipAddress: "2.2.2.2", refreshTokenHash: "secret2", trusted: false, lastActive: new Date(2), createdAt: new Date(2) }
        ]
      },
      "a"
    );
    expect(JSON.stringify(list)).not.toContain("secret");
    expect(list[0]).toMatchObject({ sessionId: "a", current: true });
    expect(list[1]).toMatchObject({ sessionId: "b", current: false, trusted: false });
  });
});
