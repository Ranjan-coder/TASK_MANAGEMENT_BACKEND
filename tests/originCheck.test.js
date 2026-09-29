process.env.NODE_ENV = "test";
const originCheck = require("../src/middlewares/originCheck.middleware");
const config = require("../src/config/env");

const run = (method, headers) =>
  new Promise((resolve) => originCheck({ method, headers }, {}, (err) => resolve(err ? err.statusCode : "next")));

describe("origin check (CSRF defence in depth)", () => {
  test("the app's own origin is allowed", async () => {
    expect(await run("POST", { origin: config.clientUrl })).toBe("next");
    expect(await run("DELETE", { referer: `${config.clientUrl}/settings` })).toBe("next");
  });
  test("other sites are refused for changes", async () => {
    expect(await run("POST", { origin: "https://evil.example" })).toBe(403);
    expect(await run("PATCH", { referer: "https://evil.example/page" })).toBe(403);
    expect(await run("PUT", { origin: "null" })).toBe(403); // sandboxed iframe / file://
    expect(await run("POST", { origin: "not a url" })).toBe(403);
  });
  test("reads and header-less clients pass through to normal auth", async () => {
    expect(await run("GET", { origin: "https://evil.example" })).toBe("next");
    expect(await run("POST", {})).toBe("next");
  });
});
