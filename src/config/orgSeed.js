/**
 * Starting departments and designations (approved 2026-09-30). Inserted once when
 * both lists are empty; after that superadmins manage them in Admin → Organisation.
 *
 * Designation levels: 1 board / top leadership … 9 entry. Levels 1–2 can only be
 * assigned by a superadmin. `suggestedRole` only pre-fills the role on the user form.
 */
const DEPARTMENTS = [
  "Tech", "Marketing", "Designer", "Operations", "Sales", "Front Desk", "IT", "Referral",
  "Digital Marketing", "Pre Sales", "Management", "Finance & Accounts", "HR", "Project Execution",
  "Procurement", "Production", "Installation & Logistics", "Quality Control", "Customer Success",
  "3D Visualisation", "Business Development", "Legal & Compliance", "Admin & Facilities"
];

const MGMT = ["Management"];
// [name, short, level, suggestedRole, departments (empty = any)]
const DESIGNATIONS = [
  ["Chairman", "", 1, "leadership", MGMT],
  ["Managing Director", "MD", 1, "leadership", MGMT],
  ["Chief Executive Officer", "CEO", 1, "leadership", MGMT],
  ["Chief Operating Officer", "COO", 2, "admin", ["Management", "Operations"]],
  ["Chief Financial Officer", "CFO", 2, "admin", ["Management", "Finance & Accounts"]],
  ["Chief Technology Officer", "CTO", 2, "admin", ["Management", "Tech", "IT"]],
  ["Chief Marketing Officer", "CMO", 2, "marketing", ["Management", "Marketing", "Digital Marketing"]],
  ["Vice President", "VP", 3, "admin", []],
  ["Director", "", 3, "admin", []],
  ["Business Head", "", 3, "admin", []],
  ["General Manager", "GM", 4, "admin", []],
  ["Deputy General Manager", "DGM", 4, "admin", []],
  ["Assistant General Manager", "AGM", 4, "admin", []],
  ["Branch Manager", "BM", 5, "admin", []],
  ["Regional Manager", "", 5, "admin", []],
  ["Department Head", "", 5, "admin", []],
  ["Go-To-Market Manager", "GTM", 5, "marketing", ["Marketing", "Digital Marketing", "Sales", "Business Development"]],
  ["Sales Manager", "", 6, "user", ["Sales", "Pre Sales", "Business Development"]],
  ["Project Manager", "PM", 6, "user", ["Project Execution", "Designer", "Operations"]],
  ["Design Manager", "", 6, "user", ["Designer", "3D Visualisation"]],
  ["Marketing Manager", "", 6, "marketing", ["Marketing", "Digital Marketing"]],
  ["Team Lead", "TL", 7, "user", []],
  ["Senior Interior Designer", "", 7, "user", ["Designer"]],
  ["Senior Executive", "", 7, "user", []],
  ["Marketing Executive", "", 8, "marketing", ["Marketing", "Digital Marketing"]],
  ["Digital Marketing Executive", "", 8, "marketing", ["Digital Marketing"]],
  ["Sales Executive", "", 8, "user", ["Sales"]],
  ["Pre-Sales Executive", "", 8, "user", ["Pre Sales"]],
  ["Relationship Manager", "RM", 8, "user", ["Sales", "Customer Success", "Referral"]],
  ["Referral Executive", "", 8, "user", ["Referral"]],
  ["Interior Designer", "", 8, "user", ["Designer"]],
  ["3D Visualiser", "", 8, "user", ["3D Visualisation", "Designer"]],
  ["Site Supervisor", "", 8, "user", ["Project Execution", "Installation & Logistics"]],
  ["Front Desk Executive", "", 8, "user", ["Front Desk"]],
  ["IT Executive", "", 8, "user", ["IT", "Tech"]],
  ["Software Engineer", "", 8, "user", ["Tech", "IT"]],
  ["Accountant", "", 8, "user", ["Finance & Accounts"]],
  ["HR Executive", "", 8, "user", ["HR"]],
  ["Operations Executive", "", 8, "user", ["Operations"]],
  ["Procurement Executive", "", 8, "user", ["Procurement"]],
  ["Associate", "", 9, "user", []],
  ["Trainee", "", 9, "user", []],
  ["Intern", "", 9, "user", []]
];

module.exports = { DEPARTMENTS, DESIGNATIONS };
