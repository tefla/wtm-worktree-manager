const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");

function loadTsModule(tsPath) {
  const source = fs.readFileSync(tsPath, "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
      jsx: ts.JsxEmit.React,
    },
    fileName: tsPath,
  });
  const module = { exports: {} };
  const dirname = path.dirname(tsPath);
  const localRequire = (specifier) => {
    if (specifier.startsWith(".") || specifier.startsWith("/")) {
      const resolved = path.resolve(dirname, specifier);
      if (fs.existsSync(resolved)) {
        return require(resolved);
      }
      if (fs.existsSync(`${resolved}.ts`)) {
        return loadTsModule(`${resolved}.ts`);
      }
      if (fs.existsSync(`${resolved}.tsx`)) {
        return loadTsModule(`${resolved}.tsx`);
      }
      return require(resolved);
    }
    return require(specifier);
  };
  const factory = new Function(
    "require",
    "module",
    "exports",
    "__dirname",
    "__filename",
    `${outputText}\n//# sourceURL=${tsPath.replace(/\\/g, "/")}`,
  );
  factory(localRequire, module, module.exports, dirname, tsPath);
  return module.exports;
}

const { mergeWidgetDefinitions } = loadTsModule(path.resolve(__dirname, "../../src/renderer/widgets/registry.tsx"));
const { WorkspaceSidebar } = loadTsModule(path.resolve(__dirname, "../../src/renderer/components/WorkspaceSidebar.tsx"));

test("mergeWidgetDefinitions merges custom entries and preserves order", () => {
  const defaults = [
    { id: "alpha", order: 1 },
    { id: "beta", order: 2 },
  ];
  const overrides = [
    { id: "beta", order: 0 },
    { id: "gamma", order: 3 },
  ];

  const result = mergeWidgetDefinitions(defaults, overrides);
  assert.deepEqual(
    result.map((entry) => entry.id),
    ["beta", "alpha", "gamma"],
    "should sort by order and override duplicate identifiers",
  );
});

test("WorkspaceSidebar renders custom row actions", () => {
  const workspace = {
    id: "workspace-1",
    branch: "feature/one",
    path: "/projects/foo/.wtm/workspaces/feature-one",
    relativePath: "feature-one",
    headSha: "abc123",
    status: {
      clean: true,
      ahead: 0,
      behind: 0,
      upstream: undefined,
      changeCount: 0,
      summary: "No changes",
      sampleChanges: [],
    },
    kind: "worktree",
  };

  const markup = renderToStaticMarkup(
    React.createElement(WorkspaceSidebar, {
      loading: false,
      workspaces: [workspace],
      activeWorkspacePath: workspace.path,
      onSelect: () => {},
      onRefreshWorkspace: () => {},
      onDeleteWorkspace: () => {},
      onUpdateWorkspace: () => {},
      updatingPaths: {},
      rowActions: [
        {
          id: "push-action",
          render: ({ workspace: current }) =>
            React.createElement(
              "button",
              { className: "custom-action", "data-path": current.path },
              "Push",
            ),
        },
      ],
    }),
  );

  assert.ok(markup.includes("custom-action"), "custom row action should be rendered in sidebar");
  assert.ok(markup.includes(workspace.path), "custom action should receive workspace context");
});
