/**
 * The frontend's module list is generated from the backend registry; this fails if
 * someone changed a module or page without regenerating it.
 */
const fs = require("fs");
const { render, OUT } = require("../scripts/genModules");

test("frontend/lib/generated/modules.json is up to date (run: node scripts/genModules.js)", () => {
  expect(fs.readFileSync(OUT, "utf8")).toBe(render());
});
