/**
 * The Basic workflow (W1): today's 7 stages, the same keys, no sub-stages, so
 * existing projects map onto it without any data change.
 */
const { STAGES } = require("../../../config/projectStages");

const BASIC = Object.freeze({
  name: "Basic workflow",
  description: "Consultation to handover in seven stages. A ready-made starting point.",
  tree: Object.freeze({
    stages: STAGES.map((s) => ({ key: s.key, name: s.label, subOrder: "sequential", subStages: [] }))
  })
});

module.exports = { BASIC };
