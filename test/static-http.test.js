"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createServer } = require("../server");

test("une URL mal encodée reçoit 400 sans interrompre le serveur", async (t) => {
  const server = createServer().listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;

  const malformed = await fetch(`${base}/%E0%A4%A`);
  assert.equal(malformed.status, 400);
  await malformed.text();

  const health = await fetch(`${base}/api/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true });
});
