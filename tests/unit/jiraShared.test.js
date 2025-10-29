const test = require("node:test");
const assert = require("node:assert/strict");

const {
  normaliseTicketSummary,
  buildWorkspaceBranchName,
  ticketMatchesQuery,
} = require("../../dist/shared/jira.js");

test("normaliseTicketSummary removes special characters and uppercases", () => {
  const result = normaliseTicketSummary("Fix login flow (mobile)!");
  assert.equal(result, "FIX-LOGIN-FLOW-MOBILE");
});

test("buildWorkspaceBranchName composes ticket id and normalised summary", () => {
  const branch = buildWorkspaceBranchName({ key: "proj-123", summary: "Improve search filters" });
  assert.equal(branch, "PROJ-123_IMPROVE-SEARCH-FILTERS");
});

test("ticketMatchesQuery supports key, branch name, and summary lookups", () => {
  const ticket = { key: "PROJ-123", summary: "Improve search filters" };
  assert.equal(ticketMatchesQuery(ticket, "proj-1"), true);
  assert.equal(ticketMatchesQuery(ticket, "improve sea"), true);
  assert.equal(ticketMatchesQuery(ticket, "unknown"), false);
});
