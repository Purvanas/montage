"use strict";

const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const test = require("node:test");

function waitFor(predicate, timeout = 3000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (predicate()) { resolve(); return; }
      if (Date.now() - started > timeout) { reject(new Error("condition non atteinte")); return; }
      setTimeout(check, 20);
    };
    check();
  });
}

function postChunked(port, pathname, boundary, chunks, delay = 0) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port,
      method: "POST",
      path: pathname,
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject);
    let index = 0;
    const writeNext = () => {
      if (index >= chunks.length) { req.end(); return; }
      req.write(chunks[index], () => {
        index += 1;
        setTimeout(writeNext, delay);
      });
    };
    writeNext();
  });
}

test("un upload abandonné ferme ses fichiers et supprime son dossier", async (t) => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "montage-abort-"));
  process.env.MONTAGE_DATA = data;
  delete require.cache[require.resolve("../server")];
  const { createServer } = require("../server");
  const server = createServer({ maxClips: 1, maxFileBytes: 64 * 1024, uploadOverheadBytes: 1024 })
    .listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  t.after(() => {
    fs.rmSync(data, { recursive: true, force: true });
    return new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    });
  });

  const boundary = "----abort-upload";
  const req = http.request({
    host: "127.0.0.1",
    port: server.address().port,
    method: "POST",
    path: "/api/jobs",
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  });
  const closed = new Promise((resolve) => {
    req.once("error", resolve);
    req.once("close", resolve);
  });
  req.write(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="videos"; filename="a.mp4"\r\nContent-Type: video/mp4\r\n\r\n`
  ));
  req.write(Buffer.alloc(4096, 1));
  await waitFor(() => fs.readdirSync(data).length === 1);
  req.destroy();
  await closed;
  await waitFor(() => fs.readdirSync(data).length === 0);
  assert.deepEqual(fs.readdirSync(data), []);
});

test("le plafond global couvre les champs ignorés et les octets après la boundary finale", async (t) => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "montage-total-"));
  process.env.MONTAGE_DATA = data;
  delete require.cache[require.resolve("../server")];
  const { createServer } = require("../server");
  const server = createServer({ maxClips: 1, maxFileBytes: 256, uploadOverheadBytes: 128 })
    .listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  t.after(() => {
    fs.rmSync(data, { recursive: true, force: true });
    return new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    });
  });
  const port = server.address().port;

  const ignoredBoundary = "----ignored";
  const ignored = Buffer.from(
    `--${ignoredBoundary}\r\nContent-Disposition: form-data; name="inconnu"\r\n\r\n${"x".repeat(600)}\r\n--${ignoredBoundary}--\r\n`
  );
  assert.equal(await postChunked(port, "/api/jobs", ignoredBoundary, [ignored.subarray(0, 150), ignored.subarray(150)]), 413);
  await waitFor(() => fs.readdirSync(data).length === 0);

  const trailingBoundary = "----trailing";
  const validEnd = Buffer.from(
    `--${trailingBoundary}\r\nContent-Disposition: form-data; name="title"\r\n\r\nok\r\n--${trailingBoundary}--\r\n`
  );
  const trailing = Buffer.alloc(500, 2);
  assert.equal(await postChunked(port, "/api/jobs", trailingBoundary, [validEnd, trailing], 50), 413);
  await waitFor(() => fs.readdirSync(data).length === 0);
});
