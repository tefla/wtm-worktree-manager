const test = require("node:test");
const assert = require("node:assert/strict");

const { SettingsManager } = require("../../src/main/settingsManager");

function createManager() {
  return new SettingsManager({ filePath: "__test__/settings.json" });
}

test("normalizeQuickCommands retains advanced fields", () => {
  const manager = createManager();
  const result = manager.normalizeQuickCommands([
    {
      key: "custom",
      label: "Custom action",
      command: " npm ",
      args: [" run ", "test", "", "  "],
      env: {
        NODE_ENV: "test",
        EMPTY: "",
        COUNT: 1,
      },
      cwd: " packages/app ",
      quickCommand: " echo done ",
      description: "  Run test suite  ",
      icon: "🔥",
      autoRun: false,
    },
  ]);

  assert.equal(result.length, 1);
  assert.deepEqual(result[0], {
    key: "custom",
    label: "Custom action",
    command: "npm",
    args: ["run", "test"],
    env: { NODE_ENV: "test", COUNT: "1" },
    cwd: "packages/app",
    quickCommand: "echo done",
    description: "Run test suite",
    icon: "🔥",
    autoRun: false,
  });
});

test("normalizeQuickCommands slugifies missing keys", () => {
  const manager = createManager();
  const result = manager.normalizeQuickCommands([
    { label: "Run Build" },
    { label: "Run Build" },
  ]);

  assert.equal(result.length, 2);
  assert.equal(result[0].key, "run-build");
  assert.equal(result[1].key, "run-build-2");
});
