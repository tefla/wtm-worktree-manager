const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, readFile, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");

const { JiraTicketCache } = require("../../dist/main/jiraTicketCache.js");

async function withTempCache(callback) {
  const directory = await mkdtemp(path.join(tmpdir(), "jira-cache-"));
  const cachePath = path.join(directory, "jira-ticket-cache.json");
  try {
    return await callback({ cachePath, directory });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function withEnv(overrides, callback) {
  const original = new Map();
  const keys = Object.keys(overrides);
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(process.env, key)) {
      original.set(key, process.env[key]);
    } else {
      original.set(key, undefined);
    }
    const value = overrides[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    return await callback();
  } finally {
    for (const [key, value] of original.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test("listTickets uses configured command when provided", async () => {
  await withEnv(
    {
      WTM_JIRA_TICKET_COMMAND: "echo jira data",
      WTM_JIRA_DISABLE_ACLI: undefined,
      WTM_JIRA_ACLI_DISABLED: undefined,
    },
    async () => {
      await withTempCache(async ({ cachePath }) => {
        let executedCommand = null;
        const cache = new JiraTicketCache({
          cacheFilePath: cachePath,
          execAsync: async (command) => {
            executedCommand = command;
            return {
              stdout: JSON.stringify([{ key: "abc-1", summary: "Refine feature", url: "https://jira.test/browse/ABC-1" }]),
              stderr: "",
            };
          },
          execFileAsync: async () => {
            throw new Error("acli should not be invoked when command is configured");
          },
          now: () => 1_000_000,
        });

        const tickets = await cache.listTickets({ forceRefresh: true });

        assert.equal(executedCommand, "echo jira data");
        assert.deepEqual(tickets, [
          { key: "ABC-1", summary: "Refine feature", url: "https://jira.test/browse/ABC-1" },
        ]);

        const persisted = JSON.parse(await readFile(cachePath, "utf8"));
        assert.equal(Array.isArray(persisted.tickets), true);
        assert.equal(persisted.tickets[0].key, "ABC-1");
      });
    },
  );
});

test("falls back to Atlassian CLI when command is not configured", async () => {
  await withEnv(
    {
      WTM_JIRA_TICKET_COMMAND: undefined,
      WTM_JIRA_DISABLE_ACLI: undefined,
      WTM_JIRA_ACLI_DISABLED: undefined,
      WTM_JIRA_ACLI_EXTRA_ARGS: undefined,
    },
    async () => {
      await withTempCache(async ({ cachePath }) => {
        let capturedInvocation = null;
        const cache = new JiraTicketCache({
          cacheFilePath: cachePath,
          execAsync: async () => {
            throw new Error("custom command should not run when unset");
          },
          execFileAsync: async (file, args) => {
            capturedInvocation = { file, args };
            return {
              stdout: JSON.stringify({
                data: [
                  { issue: "demo-7", summary: "Investigate login issue", url: "https://jira.test/browse/DEMO-7" },
                  { issue: "demo-11", summary: "Update dependencies" },
                ],
              }),
              stderr: "",
            };
          },
          now: () => 2_000_000,
        });

        const tickets = await cache.listTickets({ forceRefresh: true });

        assert.ok(capturedInvocation, "acli invocation should be captured");
        assert.equal(capturedInvocation.file, "acli");
        assert.ok(capturedInvocation.args.includes("--action"));
        assert.ok(capturedInvocation.args.includes("getIssueList"));
        assert.deepEqual(tickets, [
          { key: "DEMO-7", summary: "Investigate login issue", url: "https://jira.test/browse/DEMO-7" },
          { key: "DEMO-11", summary: "Update dependencies" },
        ]);
      });
    },
  );
});

test("force refresh retries Atlassian CLI after previous ENOENT failure", async () => {
  await withEnv(
    {
      WTM_JIRA_TICKET_COMMAND: undefined,
      WTM_JIRA_DISABLE_ACLI: undefined,
      WTM_JIRA_ACLI_DISABLED: undefined,
    },
    async () => {
      await withTempCache(async ({ cachePath }) => {
        let callCount = 0;
        const cache = new JiraTicketCache({
          cacheFilePath: cachePath,
          execAsync: async () => {
            throw new Error("custom command should not run");
          },
          execFileAsync: async () => {
            callCount += 1;
            if (callCount === 1) {
              const error = new Error("acli missing");
              error.code = "ENOENT";
              throw error;
            }
            return {
              stdout: JSON.stringify({
                data: [{ issue: "ops-42", summary: "Restore integration" }],
              }),
              stderr: "",
            };
          },
          now: (() => {
            let current = 3_000_000;
            return () => {
              current += 1_000;
              return current;
            };
          })(),
        });

        const empty = await cache.listTickets({ forceRefresh: true });
        assert.deepEqual(empty, []);
        assert.equal(callCount, 1);

        const refreshed = await cache.listTickets({ forceRefresh: true });
        assert.deepEqual(refreshed, [{ key: "OPS-42", summary: "Restore integration" }]);
        assert.equal(callCount, 2);
      });
    },
  );
});
