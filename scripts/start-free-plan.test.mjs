import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { CHILDREN, childEnvironment, supervise } from "./start-free-plan.mjs";

function fakeChild() {
  const child = new EventEmitter();
  child.signals = [];
  child.kill = (signal) => {
    child.signals.push(signal);
    queueMicrotask(() => child.emit("exit", null, signal));
    return true;
  };
  return child;
}

function harness() {
  const children = new Map();
  const signals = new EventEmitter();
  const events = [];
  const done = supervise({
    spawnChild: (spec) => { const child = fakeChild(); children.set(spec.name, child); return child; },
    signals,
    graceMs: 50,
    log: (event) => events.push(event),
  });
  return { children, signals, events, done };
}

test("runs the API and the sweep worker without re-running migrations", () => {
  assert.deepEqual(CHILDREN.map((child) => child.name), ["api", "worker"]);
  assert.equal(childEnvironment({ CAIAE_RUN_MIGRATIONS: "true", X: "1" }).CAIAE_RUN_MIGRATIONS, "false");
  assert.equal(childEnvironment({ X: "1" }).X, "1");
});

test("a platform shutdown signal stops both processes and exits cleanly", async () => {
  const { children, signals, done } = harness();
  signals.emit("SIGTERM");
  assert.equal(await done, 0);
  assert.deepEqual(children.get("api").signals, ["SIGTERM"]);
  assert.deepEqual(children.get("worker").signals, ["SIGTERM"]);
});

test("an unexpected worker exit stops the API and fails the container", async () => {
  const { children, events, done } = harness();
  children.get("worker").emit("exit", 1, null);
  assert.equal(await done, 1);
  assert.deepEqual(children.get("api").signals, ["SIGTERM"]);
  assert.ok(events.some((event) => event.child === "worker" && event.code === 1));
});

test("an unexpected clean API exit still fails the container", async () => {
  const { children, done } = harness();
  children.get("api").emit("exit", 0, null);
  assert.equal(await done, 1);
  assert.deepEqual(children.get("worker").signals, ["SIGTERM"]);
});
