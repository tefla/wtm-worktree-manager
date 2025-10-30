const test = require("node:test");
const assert = require("node:assert/strict");

const { ProjectService } = require("../../dist/main/services/projectService.js");

const sampleState = {
  projectPath: "/projects/foo",
  projectName: "Foo",
  projectIcon: "🚀",
  quickAccess: [],
  composeProjectName: null,
  composeServices: [],
  composeError: null,
};

test("ProjectService state transforms adjust returned project state", async () => {
  const manager = {
    getCurrentState: async () => ({ ...sampleState }),
    setCurrentProjectWithPrompt: async () => ({ ...sampleState }),
    setCurrentProject: async () => ({ ...sampleState }),
    listComposeServices: async () => ({ services: [], projectName: null }),
    updateConfig: async () => ({ ...sampleState }),
  };

  const service = new ProjectService(manager);
  service.registerStateTransform((state) => {
    if (!state) return state;
    return {
      ...state,
      projectName: `${state.projectName} ⭐`,
    };
  });

  const state = await service.getCurrentState();
  assert.equal(state?.projectName, "Foo ⭐");
});
