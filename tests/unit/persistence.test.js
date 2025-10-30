const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

function loadTsModule(tsPath) {
  const source = fs.readFileSync(tsPath, "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
      importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Preserve,
    },
    fileName: tsPath,
  });
  const module = { exports: {} };
  const dirname = path.dirname(tsPath);
  const localRequire = (specifier) => {
    if (specifier.startsWith(".") || specifier.startsWith("/")) {
      const candidate = path.resolve(dirname, specifier);
      if (fs.existsSync(candidate)) {
        return require(candidate);
      }
      if (fs.existsSync(`${candidate}.ts`)) {
        return loadTsModule(`${candidate}.ts`);
      }
      return require(candidate);
    }
    return require(specifier);
  };
  const sourceURL = tsPath.replace(/\\/g, "/");
  const factory = new Function(
    "require",
    "module",
    "exports",
    "__dirname",
    "__filename",
    `${outputText}\n//# sourceURL=${sourceURL}`,
  );
  factory(localRequire, module, module.exports, dirname, tsPath);
  return module.exports;
}

const {
  loadRecentProjects,
  persistRecentProjects,
  upsertRecentProject,
  loadPreferences,
  persistPreferences,
  RECENT_PROJECTS_STORAGE_KEY,
} = loadTsModule(path.resolve(__dirname, "../../src/renderer/store/persistence.ts"));

function withMockedLocalStorage(initial = {}) {
  const store = { ...initial };
  const localStorage = {
    getItem(key) {
      return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null;
    },
    setItem(key, value) {
      store[key] = value;
    },
    removeItem(key) {
      delete store[key];
    },
  };
  const originalWindow = global.window;
  global.window = { localStorage };
  return {
    localStorage,
    store,
    restore() {
      global.window = originalWindow;
    },
  };
}

test("loadRecentProjects normalises entries and ignores invalid items", () => {
  const entry = JSON.stringify([
    { path: " /tmp/project ", name: " Project " },
    { path: "", name: "ignored" },
    "invalid",
  ]);
  const env = withMockedLocalStorage({ [RECENT_PROJECTS_STORAGE_KEY]: entry });

  const projects = loadRecentProjects();
  assert.equal(projects.length, 1);
  assert.equal(projects[0].path, "/tmp/project");
  assert.equal(projects[0].name, "Project");

  env.restore();
});

test("persistRecentProjects stores a trimmed list respecting max entries", () => {
  const env = withMockedLocalStorage();
  const entries = Array.from({ length: 10 }, (_, index) => ({
    path: `/tmp/project-${index}`,
    name: `Project ${index}`,
  }));

  persistRecentProjects(entries);
  const stored = JSON.parse(env.store[RECENT_PROJECTS_STORAGE_KEY]);
  assert.equal(stored.length, 8, "should persist at most eight entries");
  assert.deepEqual(stored[0], entries[0]);
  env.restore();
});

test("upsertRecentProject promotes most recent entry to top", () => {
  const list = [
    { path: "/tmp/a", name: "A" },
    { path: "/tmp/b", name: "B" },
  ];
  const updated = upsertRecentProject(list, { path: "/tmp/b", name: "B updated" });
  assert.equal(updated[0].path, "/tmp/b");
  assert.equal(updated[0].name, "B updated");
  assert.equal(updated.length, 2);
});

test("loadPreferences falls back to defaults when storage missing or invalid", () => {
  const env = withMockedLocalStorage();
  let prefs = loadPreferences();
  assert.equal(prefs.openProjectsInNewWindow, false);

  env.localStorage.setItem("wtm:prefs", JSON.stringify({ openProjectsInNewWindow: true }));
  prefs = loadPreferences();
  assert.equal(prefs.openProjectsInNewWindow, true);

  env.localStorage.setItem("wtm:prefs", "not-json");
  prefs = loadPreferences();
  assert.equal(prefs.openProjectsInNewWindow, false);
  env.restore();
});

test("persistPreferences serialises preference payload", () => {
  const env = withMockedLocalStorage();
  persistPreferences({ openProjectsInNewWindow: true });
  assert.equal(env.store["wtm:prefs"], JSON.stringify({ openProjectsInNewWindow: true }));
  env.restore();
});
