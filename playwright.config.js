const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./tests/e2e",
  timeout: 60000,
  workers: 1,
  retries: process.env.CI ? 2 : 0,
  use: {
    screenshot: "only-on-failure",
    trace: "on-first-retry",
  },
});
