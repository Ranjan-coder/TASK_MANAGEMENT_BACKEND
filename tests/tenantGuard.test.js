/**
 * Guardrail (module-access-plan.md): every model must carry the tenant plugin, so
 * a new model can't silently store data that every organisation can see. Only
 * these deliberately global models are exempt.
 */
process.env.NODE_ENV = "test";
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");

// TemplateDepartment / TemplateDesignation: the product owner's standard lists (no organisation data)
const GLOBAL_MODELS = new Set(["Organisation", "OtpChallenge", "Counter", "UsedStepToken", "TemplateDepartment", "TemplateDesignation"]);

const loadModels = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) loadModels(full);
    else if (entry.name.endsWith(".js") && (dir.endsWith("models") || dir.includes(`${path.sep}models`))) require(full);
  }
};

test("every model is organisation-scoped (or deliberately global)", () => {
  loadModels(path.join(__dirname, "../src/models"));
  loadModels(path.join(__dirname, "../src/modules"));
  const unscoped = Object.values(mongoose.models)
    .filter((m) => !GLOBAL_MODELS.has(m.modelName))
    .filter((m) => !m.schema.path("orgId"))
    .map((m) => m.modelName);
  expect(unscoped).toEqual([]);
  expect(Object.keys(mongoose.models).length).toBeGreaterThan(30);
});
