"use strict";

const fs = require("node:fs");

function expireFinishedJobs(jobs, { now = Date.now(), ttlMs, removeDirectory = (dir) => fs.rmSync(dir, { recursive: true, force: true }) }) {
  for (const [id, job] of jobs) {
    if (job.status !== "done" && job.status !== "error") continue;
    if (now - job.created <= ttlMs) continue;
    try {
      if (job.dir) removeDirectory(job.dir);
      jobs.delete(id);
    } catch {
      // Keep the record until a later sweep can finish deleting its files.
    }
  }
}

module.exports = { expireFinishedJobs };
