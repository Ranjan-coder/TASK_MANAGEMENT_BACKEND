process.env.ENFORCE_PRIVILEGED_2FA = "false";
const { evaluateAccess, normalisePath } = require("../src/middlewares/accessPolicy");

const user = (role, extra = {}) => ({ role, isTwoFactorEnabled: false, mustChangePassword: false, ...extra });
const can = (u, method, url) => evaluateAccess({ user: u, method, originalUrl: url }).allowed;
const ID = "64b7f0c2a1b2c3d4e5f60718";

describe("normalisePath", () => {
  test.each([
    ["/api/v1/tasks", "/tasks"],
    ["/API/V1/Tasks/", "/tasks"],
    ["/api/v1//tasks//abc", "/tasks/abc"],
    ["/api/v1/chat/conversations?x=1", "/chat/conversations"]
  ])("%s -> %s", (input, expected) => expect(normalisePath(input)).toBe(expected));
});

describe("customer role (deny by default)", () => {
  const c = user("customer");

  test.each([
    ["GET", "/api/v1/auth/me"],
    ["POST", "/api/v1/auth/logout"],
    ["POST", "/api/v1/auth/change-password"],
    ["GET", "/api/v1/notifications"],
    ["PATCH", `/api/v1/notifications/${ID}/read`],
    ["PATCH", "/api/v1/users/profile"],
    ["POST", "/api/v1/uploads/avatar"],
    ["GET", "/api/v1/chat/conversations"],
    ["GET", `/api/v1/chat/conversations/${ID}/messages`],
    ["POST", `/api/v1/chat/conversations/${ID}/messages`],
    ["PATCH", `/api/v1/chat/messages/${ID}/read`]
  ])("allows %s %s", (m, url) => expect(can(c, m, url)).toBe(true));

  test.each([
    ["GET", "/api/v1/tasks"],
    ["POST", "/api/v1/tasks"],
    ["GET", `/api/v1/tasks/${ID}`],
    ["GET", "/api/v1/users"],
    ["GET", `/api/v1/users/${ID}`],
    ["PATCH", `/api/v1/users/${ID}/role`],
    ["GET", "/api/v1/dashboard/summary"],
    ["POST", "/api/v1/uploads"],
    ["POST", "/api/v1/chat/conversations"],
    ["POST", `/api/v1/chat/conversations/${ID}/members`],
    ["DELETE", `/api/v1/chat/conversations/${ID}/members/${ID}`],
    ["PATCH", `/api/v1/chat/conversations/${ID}`],
    ["PUT", `/api/v1/chat/conversations/${ID}/group-keys`],
    ["GET", `/api/v1/tasks/${ID}/comments`],
    ["GET", "/api/v1/some-future-route"]
  ])("denies %s %s", (m, url) => expect(can(c, m, url)).toBe(false));

  test("path tricks do not bypass the allow-list", () => {
    expect(can(c, "GET", "/API/v1/TASKS")).toBe(false);
    expect(can(c, "GET", "/api/v1//tasks/")).toBe(false);
    expect(can(c, "GET", "/api/v1/chat/conversations/../../tasks")).toBe(false);
    expect(can(c, "GET", "/api/v1/notificationsX")).toBe(false);
  });
});

describe("marketing role", () => {
  const m = user("marketing");
  test("can use chat, profile and notifications", () => {
    expect(can(m, "POST", "/api/v1/chat/conversations")).toBe(true);
    expect(can(m, "GET", "/api/v1/notifications")).toBe(true);
  });
  test("cannot use tasks, users or dashboard", () => {
    expect(can(m, "GET", "/api/v1/tasks")).toBe(false);
    expect(can(m, "GET", "/api/v1/users")).toBe(false);
    expect(can(m, "GET", "/api/v1/dashboard/summary")).toBe(false);
  });
});

describe("staff roles fall through to per-route RBAC", () => {
  test.each(["user", "admin", "superadmin"])("%s is not blocked by the policy", (role) => {
    expect(can(user(role), "GET", "/api/v1/tasks")).toBe(true);
  });
});

describe("forced password change", () => {
  const u = user("superadmin", { mustChangePassword: true });
  test("only auth routes are reachable", () => {
    expect(can(u, "POST", "/api/v1/auth/change-password")).toBe(true);
    expect(can(u, "GET", "/api/v1/auth/me")).toBe(true);
    expect(can(u, "GET", "/api/v1/users")).toBe(false);
    expect(evaluateAccess({ user: u, method: "GET", originalUrl: "/api/v1/tasks" }).code).toBe(
      "PASSWORD_CHANGE_REQUIRED"
    );
  });
});

describe("privileged 2FA enforcement", () => {
  afterEach(() => {
    process.env.ENFORCE_PRIVILEGED_2FA = "false";
  });

  test("when enabled, admins without 2FA reach only auth + profile", () => {
    process.env.ENFORCE_PRIVILEGED_2FA = "true";
    const a = user("admin");
    expect(can(a, "GET", "/api/v1/users")).toBe(false);
    expect(can(a, "POST", "/api/v1/auth/2fa/setup")).toBe(true);
    expect(can(a, "PATCH", "/api/v1/users/profile")).toBe(true);
    expect(can(user("admin", { isTwoFactorEnabled: true }), "GET", "/api/v1/users")).toBe(true);
    expect(can(user("user"), "GET", "/api/v1/tasks")).toBe(true);
  });
});

test("a missing role is always denied", () => {
  expect(can({ role: undefined }, "GET", "/api/v1/tasks")).toBe(false);
});
