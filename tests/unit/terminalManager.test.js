const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const webContentsRegistry = new Map();

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") {
    return {
      webContents: {
        fromId(id) {
          return webContentsRegistry.get(id) ?? null;
        },
      },
    };
  }
  return originalLoad(request, parent, isMain);
};

const { TerminalManager } = require("../../dist/main/terminalManager.js");
const { TerminalSessionStore } = require("../../dist/main/terminalSessionStore.js");

Module._load = originalLoad;

class FakeHostClient extends EventEmitter {
  constructor() {
    super();
    this.ensureCalls = [];
    this.releaseCalls = [];
    this.disposeCalls = [];
    this.writeCalls = [];
    this.resizeCalls = [];
    this.sessionCounter = 0;
    this.pendingByKey = new Map();
    this.sessionByKey = new Map();
    this.sessionForId = new Map();
  }

  key(workspacePath, slot) {
    return `${workspacePath}::${slot}`;
  }

  setPendingOutput(workspacePath, slot, output) {
    this.pendingByKey.set(this.key(workspacePath, slot), output);
  }

  async ensureSession(payload) {
    this.ensureCalls.push(payload);
    const key = this.key(payload.workspacePath, payload.slot);
    let sessionId = this.sessionByKey.get(key);
    let existing = true;
    if (!sessionId) {
      sessionId = `session-${++this.sessionCounter}`;
      this.sessionByKey.set(key, sessionId);
      existing = false;
    }
    this.sessionForId.set(sessionId, key);
    const pending = this.pendingByKey.get(key) ?? "";
    this.pendingByKey.delete(key);
    return {
      sessionId,
      workspacePath: payload.workspacePath,
      slot: payload.slot,
      command: payload.command,
      args: payload.args,
      existing,
      pendingOutput: pending,
    };
  }

  async releaseSession(payload) {
    this.releaseCalls.push(payload);
  }

  async dispose(payload) {
    this.disposeCalls.push(payload);
    this.sessionForId.delete(payload.sessionId);
  }

  async write(payload) {
    this.writeCalls.push(payload);
  }

  async resize(payload) {
    this.resizeCalls.push(payload);
  }

  emitData(sessionId, data) {
    this.emit("session-data", { sessionId, data });
  }

  emitExit(sessionId, exitCode = null, signal = null) {
    this.emit("session-exit", { sessionId, exitCode, signal });
    const key = this.sessionForId.get(sessionId);
    if (key) {
      this.sessionForId.delete(sessionId);
      this.sessionByKey.delete(key);
    }
  }

  emitDisposed(sessionId, reason) {
    this.emit("session-disposed", { sessionId, reason });
    const key = this.sessionForId.get(sessionId);
    if (key) {
      this.sessionForId.delete(sessionId);
      this.sessionByKey.delete(key);
    }
  }
}

async function createStore() {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "wtm-terminal-test-"));
  const storePath = path.join(tmpDir, "terminals.json");
  const store = new TerminalSessionStore({ filePath: storePath });
  return { store, tmpDir };
}

async function cleanupStore(store, tmpDir) {
  try {
    await store.flush();
  } catch {
    // ignore flush errors in tests
  }
  await fs.rm(tmpDir, { recursive: true, force: true });
}

function stubWebContents(id, handler) {
  const stub = {
    send(channel, payload) {
      handler(channel, payload);
    },
    isDestroyed() {
      return false;
    },
  };
  webContentsRegistry.set(id, stub);
  return () => webContentsRegistry.delete(id);
}

async function settleImmediate() {
  await new Promise((resolve) => setImmediate(resolve));
}

test("TerminalManager ensureSession merges saved history and pending output", async () => {
  const { store, tmpDir } = await createStore();
  const host = new FakeHostClient();
  const manager = new TerminalManager(store, host);

  const workspacePath = path.join(tmpDir, "workspace-a");
  const slot = "primary";
  await store.ensureTerminal(workspacePath, slot, { label: "Main" });
  await store.appendHistory(workspacePath, slot, "saved\n");
  await store.markQuickCommandExecuted(workspacePath, slot);

  host.setPendingOutput(workspacePath, slot, "buffered\n");

  const result = await manager.ensureSession(
    {
      workspacePath,
      slot,
      command: "/bin/bash",
      args: ["-l"],
      cols: 100,
      rows: 30,
      env: { TEST_MODE: "1" },
      label: "Main",
    },
    1,
  );

  assert.equal(result.history, "saved\nbuffered\n");
  assert.equal(result.quickCommandExecuted, true);
  assert.equal(result.existing, false);
  const state = await store.getWorkspaceState(workspacePath);
  assert.ok(state.terminals[slot].history.endsWith("buffered\n"));

  await cleanupStore(store, tmpDir);
});

test("TerminalManager release detaches host when final subscriber leaves", async () => {
  const { store, tmpDir } = await createStore();
  const host = new FakeHostClient();
  const manager = new TerminalManager(store, host);

  const workspacePath = path.join(tmpDir, "workspace-b");
  const slot = "primary";

  const session = await manager.ensureSession({ workspacePath, slot }, 1);
  assert.equal(host.releaseCalls.length, 0);

  await manager.release(session.sessionId, 99);
  assert.equal(host.releaseCalls.length, 0, "non-subscribed release ignored");

  await manager.ensureSession({ workspacePath, slot }, 2);
  await manager.release(session.sessionId, 1);
  assert.equal(host.releaseCalls.length, 0, "still another subscriber");

  await manager.release(session.sessionId, 2);
  assert.equal(host.releaseCalls.length, 1, "host notified when last subscriber leaves");

  await cleanupStore(store, tmpDir);
});

test("TerminalManager forwards host data to renderer and persists history", async () => {
  const { store, tmpDir } = await createStore();
  const host = new FakeHostClient();
  const manager = new TerminalManager(store, host);

  const workspacePath = path.join(tmpDir, "workspace-c");
  const slot = "primary";
  const events = [];
  const disposeStub = stubWebContents(123, (channel, payload) => {
    events.push({ channel, payload });
  });

  const session = await manager.ensureSession({ workspacePath, slot }, 123);
  host.emitData(session.sessionId, "chunk-1");
  await settleImmediate();

  assert.equal(events.length, 1);
  assert.equal(events[0].channel, "terminal:data");
  assert.equal(events[0].payload.data, "chunk-1");

  const state = await store.getWorkspaceState(workspacePath);
  assert.ok(state.terminals[slot].history.endsWith("chunk-1"));

  disposeStub();
  await cleanupStore(store, tmpDir);
});

test("TerminalManager handles host exit events", async () => {
  const { store, tmpDir } = await createStore();
  const host = new FakeHostClient();
  const manager = new TerminalManager(store, host);

  const workspacePath = path.join(tmpDir, "workspace-d");
  const slot = "primary";
  const exitEvents = [];
  const disposeStub = stubWebContents(321, (channel, payload) => {
    exitEvents.push({ channel, payload });
  });

  const session = await manager.ensureSession({ workspacePath, slot }, 321);
  host.emitExit(session.sessionId, 0, "SIGTERM");
  await settleImmediate();

  assert.equal(exitEvents.length, 1);
  assert.equal(exitEvents[0].channel, "terminal:exit");
  assert.equal(exitEvents[0].payload.exitCode, 0);
  assert.equal(exitEvents[0].payload.signal, "SIGTERM");

  const state = await store.getWorkspaceState(workspacePath);
  assert.equal(state.terminals[slot].lastExitCode, 0);
  assert.equal(state.terminals[slot].lastSignal, "SIGTERM");

  const nextSession = await manager.ensureSession({ workspacePath, slot }, 321);
  assert.equal(nextSession.existing, false);

  disposeStub();
  await cleanupStore(store, tmpDir);
});

test("TerminalManager dispose clears persisted state", async () => {
  const { store, tmpDir } = await createStore();
  const host = new FakeHostClient();
  const manager = new TerminalManager(store, host);

  const workspacePath = path.join(tmpDir, "workspace-e");
  const slot = "primary";

  const session = await manager.ensureSession({ workspacePath, slot }, 1);
  await manager.dispose(session.sessionId);

  assert.equal(host.disposeCalls.length, 1);
  const state = await store.getWorkspaceState(workspacePath);
  assert.equal(Object.hasOwn(state.terminals, slot), false);

  await cleanupStore(store, tmpDir);
});
