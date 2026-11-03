"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { expireFinishedJobs } = require("../lib/retention");

test("un rendu échoué expire même si son dossier a déjà disparu", () => {
  const jobs = new Map([
    ["old-error", { status: "error", created: 0, dir: "/already-removed" }],
    ["old-done", { status: "done", created: 0, dir: "/old-result" }],
    ["new-error", { status: "error", created: 95 }],
    ["running", { status: "running", created: 0 }],
    ["queued", { status: "queued", created: 0 }],
  ]);
  const removed = [];
  expireFinishedJobs(jobs, { now: 100, ttlMs: 10, removeDirectory: (dir) => removed.push(dir) });
  assert.deepEqual([...jobs.keys()], ["new-error", "running", "queued"]);
  assert.deepEqual(removed, ["/already-removed", "/old-result"]);
});

test("une suppression refusée reste suivie pour le prochain nettoyage", () => {
  const jobs = new Map([["retry", { status: "error", created: 0, dir: "/retry" }]]);
  expireFinishedJobs(jobs, { now: 100, ttlMs: 10, removeDirectory: () => { throw new Error("EACCES"); } });
  assert.equal(jobs.has("retry"), true);
});
