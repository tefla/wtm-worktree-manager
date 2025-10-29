const test = require("node:test");
const assert = require("node:assert/strict");

const {
  defaultProjectConfig,
  normaliseProjectConfig,
  normaliseJiraProjectConfig,
} = require("../../dist/main/projectConfig.js");

test("defaultProjectConfig includes jira defaults", () => {
  const config = defaultProjectConfig();
  assert.ok(config.jira, "jira config should exist");
  assert.equal(config.jira.enabled, false);
  assert.equal(typeof config.jira.jql, "string");
  assert.ok(config.quickAccess.length > 0);
});

test("normaliseProjectConfig hydrates jira settings", () => {
  const config = normaliseProjectConfig({
    quickAccess: [],
    jira: {
      enabled: true,
      site: "example-site",
      jql: "project = TEST",
      maxResults: 25,
    },
  });

  assert.equal(config.quickAccess.length > 0, true);
  assert.equal(config.jira.enabled, true);
  assert.equal(config.jira.site, "example-site");
  assert.equal(config.jira.jql, "project = TEST");
  assert.equal(config.jira.maxResults, 25);
});

test("normaliseJiraProjectConfig disables integration when site missing", () => {
  const config = normaliseJiraProjectConfig({ enabled: true, site: "" });
  assert.equal(config.enabled, false);
  assert.equal(config.site, "");
});
