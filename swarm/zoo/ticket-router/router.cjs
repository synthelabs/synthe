// Sends a support ticket to a team.
const RULES = [
  [/refund/, "billing"],
];

function route(text) {
  const t = text.toLowerCase();
  for (const [re, team] of RULES) if (re.test(t)) return team;
  return "general";
}

module.exports = route;
