"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const test = require("node:test");
const { layoutFor, outputDuration } = require("../lib/layouts");
const { buildGraph, parseAudioSelection, parseProgress, parseTiming, probeVideo, renderToFile } = require("../lib/render");
const { parseTitle, titleFilter } = require("../lib/title");

function overlaps(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.slice(-800) || `${command} ${code}`));
    });
  });
}

function makeClip(dir, name, { color, seconds, size = "1280x720", audio = true, freq = 440 }) {
  const output = path.join(dir, name);
  const args = [
    "-hide_banner", "-y",
    "-f", "lavfi", "-i", `color=c=${color}:s=${size}:r=30:d=${seconds}`,
  ];
  if (audio) args.push("-f", "lavfi", "-i", `sine=frequency=${freq}:duration=${seconds}`);
  args.push("-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-t", String(seconds));
  if (audio) args.push("-c:a", "aac", "-b:a", "128k");
  else args.push("-an");
  args.push(output);
  return run("ffmpeg", args).then(() => output);
}

function sample(file, x, y, at) {
  return new Promise((resolve, reject) => {
    const args = ["-v", "error", "-i", file];
    if (at) args.push("-ss", String(at));
    args.push("-vf", `format=rgb24,crop=1:1:${x}:${y}`, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1");
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks = [];
    let stderr = "";
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("close", (code) => {
      const buf = Buffer.concat(chunks);
      if (code !== 0 || buf.length < 3) reject(new Error(stderr || "échantillon vide"));
      else resolve({ r: buf[0], g: buf[1], b: buf[2] });
    });
  });
}

function expectColor(pixel, kind) {
  const { r, g, b } = pixel;
  const text = `${kind} obtenu ${r},${g},${b}`;
  if (kind === "red") assert.ok(r > 100 && r > g + 40 && r > b + 40, text);
  else if (kind === "green") assert.ok(g > 100 && g > r + 40 && g > b + 40, text);
  else if (kind === "blue") assert.ok(b > 80 && b > r + 30 && b > g + 20, text);
  else if (kind === "yellow") assert.ok(r > 100 && g > 100 && b < 90 && Math.min(r, g) > b + 40, text);
  else if (kind === "magenta") assert.ok(r > 100 && b > 80 && g < 90 && r > g + 40 && b > g + 30, text);
  else if (kind === "light") assert.ok(r > 200 && g > 200 && b > 200, text);
  else if (kind === "black") assert.ok(r < 40 && g < 40 && b < 40, text);
  else throw new Error(kind);
}

async function probe(file) {
  const raw = await new Promise((resolve, reject) => {
    const child = spawn("ffprobe", [
      "-v", "error", "-print_format", "json", "-show_format", "-show_streams", file,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.on("close", (code) => (code === 0 ? resolve(stdout) : reject(new Error("ffprobe"))));
  });
  return JSON.parse(raw);
}

test("la géométrie suit le croquis et ne déborde pas", () => {
  for (const count of [1, 2, 3, 4, 5]) {
    const layout = layoutFor(count);
    assert.equal(layout.slots.length, count);
    assert.equal(layout.caption.length > 0, true);
    const tiles = layout.slots.filter((slot) => !slot.center);
    for (let i = 0; i < tiles.length; i += 1) {
      for (let j = i + 1; j < tiles.length; j += 1) {
        assert.equal(overlaps(tiles[i], tiles[j]), false, `${count} cases ${i} et ${j}`);
      }
    }
  }

  const five = layoutFor(5);
  const center = five.slots[4];
  assert.equal(center.center, true);
  assert.equal(center.x * 2 + center.w, five.width);
  assert.equal(center.y * 2 + center.h, five.height);
  assert.ok(Math.abs(center.w / five.width - 0.4027) < 0.005);
  assert.ok(Math.abs(center.h / five.height - 0.32) < 0.005);
  for (const tile of five.slots.slice(0, 4)) assert.equal(overlaps(center, tile), true);

  const four = layoutFor(4);
  assert.equal(four.slots.some((slot) => slot.center), false);
  assert.equal(outputDuration([10, 200, 50]), 10);
  assert.equal(outputDuration([200, 400]), 180);
  assert.equal(outputDuration([10, 40, 50], "long"), 50);
  assert.equal(outputDuration([10, 200, 50], "long"), 180);
  assert.equal(outputDuration([200, 400], "long"), 180);
});

test("le graphe garde une seule piste", () => {
  const five = layoutFor(5);
  const probes = [
    { hasAudio: true },
    { hasAudio: false },
    { hasAudio: true },
    { hasAudio: true },
    { hasAudio: false },
  ];
  const chosen = buildGraph(five, probes, 1.5, 3);
  assert.equal(chosen.hasAudio, true);
  assert.equal(chosen.audioIndex, 3);
  assert.match(chosen.filter, /overlay=574:366/);
  assert.match(chosen.filter, /pad=772:348/);
  assert.match(chosen.filter, /scale=756:332/);
  assert.match(chosen.filter, /\[3:a\]/);
  assert.doesNotMatch(chosen.filter, /\[0:a\]/);
  assert.doesNotMatch(chosen.filter, /amix/);
  assert.equal(chosen.vmap, "[vout]");
  assert.doesNotMatch(chosen.filter, /drawtext/);

  const fallback = buildGraph(five, probes, 1.5);
  assert.equal(fallback.audioIndex, 0);
  assert.match(fallback.filter, /\[0:a\]/);
  assert.doesNotMatch(fallback.filter, /\[2:a\]/);

  const silentFirst = buildGraph(layoutFor(3), [
    { hasAudio: false },
    { hasAudio: true },
    { hasAudio: true },
  ], 1);
  assert.equal(silentFirst.audioIndex, 1);
  assert.match(silentFirst.filter, /\[1:a\]/);
  assert.doesNotMatch(silentFirst.filter, /\[2:a\]/);

  const chosenSilent = buildGraph(layoutFor(2), [
    { hasAudio: true },
    { hasAudio: false },
  ], 1, 1);
  assert.equal(chosenSilent.hasAudio, false);
  assert.doesNotMatch(chosenSilent.filter, /\[aout\]/);

  const silent = buildGraph(layoutFor(1), [{ hasAudio: false }], 1);
  assert.equal(silent.hasAudio, false);
  assert.doesNotMatch(silent.filter, /\[aout\]/);

  const mix = buildGraph(five, probes, 1.5, [0, 2, 4]);
  assert.equal(mix.hasAudio, true);
  assert.deepEqual(mix.audioIndexes, [0, 2]);
  assert.match(mix.filter, /\[0:a\]/);
  assert.match(mix.filter, /\[2:a\]/);
  assert.match(mix.filter, /amix=inputs=2/);
  assert.doesNotMatch(mix.filter, /\[4:a\]/);

  const none = buildGraph(layoutFor(2), [
    { hasAudio: true },
    { hasAudio: true },
  ], 1, []);
  assert.equal(none.hasAudio, false);
  assert.doesNotMatch(none.filter, /amix/);
  assert.doesNotMatch(none.filter, /\[aout\]/);

  assert.deepEqual(parseAudioSelection("0, 2, 2", 5), [0, 2]);
  assert.deepEqual(parseAudioSelection("all", 3), [0, 1, 2]);
  assert.deepEqual(parseAudioSelection("none", 3), []);
  assert.equal(parseAudioSelection("", 3), null);
  assert.throws(() => parseAudioSelection("non", 3), /piste/);
  assert.throws(() => parseAudioSelection("5", 3), /piste/);

  assert.equal(parseProgress("out_time_ms=1500000", 3), 50);
  assert.equal(parseProgress("out_time=00:00:01.500000", 3), 50);
  assert.equal(parseProgress("progress=end", 3), 100);
});

test("le rendu place chaque couleur au bon endroit", { timeout: 180000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "montage-render-"));
  try {
    const fiveFiles = await Promise.all([
      makeClip(dir, "red.mp4", { color: "red", seconds: 2, size: "720x1280", freq: 440 }),
      makeClip(dir, "green.mp4", { color: "green", seconds: 2, freq: 554 }),
      makeClip(dir, "blue.mp4", { color: "blue", seconds: 2, freq: 659 }),
      makeClip(dir, "yellow.mp4", { color: "yellow", seconds: 2, freq: 880 }),
      makeClip(dir, "magenta.mp4", { color: "magenta", seconds: 1.25, audio: false }),
    ]);
    const fiveOut = path.join(dir, "five.mp4");
    let maxProgress = 0;
    const five = await renderToFile({
      files: fiveFiles,
      probes: [
        { hasAudio: true, duration: 2 },
        { hasAudio: true, duration: 2 },
        { hasAudio: true, duration: 2 },
        { hasAudio: true, duration: 2 },
        { hasAudio: false, duration: 1.25 },
      ],
      output: fiveOut,
      onProgress(value) { maxProgress = Math.max(maxProgress, value); },
    });
    assert.ok(five.duration > 1.1 && five.duration < 1.45, `durée ${five.duration}`);
    assert.ok(maxProgress >= 50, `progression ${maxProgress}`);
    const meta = await probe(fiveOut);
    const video = meta.streams.find((stream) => stream.codec_type === "video");
    assert.equal(video.width, 1920);
    assert.equal(video.height, 1080);
    assert.equal(meta.streams.some((stream) => stream.codec_type === "audio"), true);
    expectColor(await sample(fiveOut, 200, 200), "red");
    expectColor(await sample(fiveOut, 1700, 200), "green");
    expectColor(await sample(fiveOut, 200, 900), "blue");
    expectColor(await sample(fiveOut, 1700, 900), "yellow");
    expectColor(await sample(fiveOut, 960, 540), "magenta");
    expectColor(await sample(fiveOut, 960, 370), "light");
    expectColor(await sample(fiveOut, 960, 200), "light");

    const fourFiles = fiveFiles.slice(0, 4);
    const fourOut = path.join(dir, "four.mp4");
    await renderToFile({
      files: fourFiles,
      probes: fourFiles.map(() => ({ hasAudio: true, duration: 2 })),
      output: fourOut,
    });
    expectColor(await sample(fourOut, 960, 540), "light");
    expectColor(await sample(fourOut, 200, 200), "red");
    expectColor(await sample(fourOut, 1700, 900), "yellow");

    const threeOut = path.join(dir, "three.mp4");
    await renderToFile({
      files: [
        fiveFiles[0],
        await makeClip(dir, "green-silent.mp4", { color: "green", seconds: 2, audio: false }),
        fiveFiles[2],
      ],
      probes: [
        { hasAudio: true, duration: 2 },
        { hasAudio: false, duration: 2 },
        { hasAudio: true, duration: 2 },
      ],
      output: threeOut,
    });
    expectColor(await sample(threeOut, 400, 540), "red");
    expectColor(await sample(threeOut, 1600, 200), "green");
    expectColor(await sample(threeOut, 1600, 800), "blue");
    expectColor(await sample(threeOut, 1276, 200), "light");
    const threeMeta = await probe(threeOut);
    assert.equal(threeMeta.streams.some((stream) => stream.codec_type === "audio"), true);

    const mixOut = path.join(dir, "mix.mp4");
    await renderToFile({
      files: [fiveFiles[0], fiveFiles[1]],
      probes: [
        { hasAudio: true, duration: 2 },
        { hasAudio: true, duration: 2 },
      ],
      output: mixOut,
      audioIndex: [0, 1],
    });
    const mixMeta = await probe(mixOut);
    assert.equal(mixMeta.streams.filter((stream) => stream.codec_type === "audio").length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("un gros envoi en deux fois reçoit une réponse", { timeout: 20000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "montage-hold-"));
  process.env.MONTAGE_DATA = dir;
  delete require.cache[require.resolve("../server")];
  const { createServer } = require("../server");
  const server = createServer().listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address();
  try {
    const boundary = "----hold";
    const audio = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="audio"\r\n\r\n1\r\n`
    );
    const head = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="videos"; filename="a.mp4"\r\nContent-Type: video/mp4\r\n\r\n`
    );
    const mid = Buffer.from(
      `\r\n--${boundary}\r\nContent-Disposition: form-data; name="videos"; filename="b.mp4"\r\nContent-Type: video/mp4\r\n\r\n`
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const first = Buffer.concat([audio, head, Buffer.alloc(200 * 1024, 1), mid, Buffer.alloc(40 * 1024, 2)]);
    const second = Buffer.concat([Buffer.alloc(80 * 1024, 3), tail]);
    const status = await new Promise((resolve, reject) => {
      const req = http.request({
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/api/jobs",
        headers: {
          "content-type": `multipart/form-data; boundary=${boundary}`,
          "content-length": first.length + second.length,
        },
      }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      });
      req.on("error", reject);
      req.write(first);
      setTimeout(() => req.end(second), 200);
      setTimeout(() => reject(new Error("toujours en préparation")), 8000);
    });
    assert.equal(status, 400);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("l’API refuse un texte et rend une vraie vidéo", { timeout: 120000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "montage-http-"));
  process.env.MONTAGE_DATA = dir;
  delete require.cache[require.resolve("../server")];
  const { createServer } = require("../server");
  const server = createServer().listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const health = await fetch(`${base}/api/health`);
    assert.equal(health.status, 200);
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Jusqu’à cinq vidéos/);

    const bad = new FormData();
    bad.append("videos", new Blob(["bonjour"], { type: "text/plain" }), "note.txt");
    const rejected = await fetch(`${base}/api/jobs`, { method: "POST", body: bad });
    assert.equal(rejected.status, 400);

    const red = await makeClip(dir, "red.mp4", { color: "red", seconds: 0.8, freq: 440 });
    const green = await makeClip(dir, "green.mp4", { color: "green", seconds: 0.8, freq: 554 });
    const body = new FormData();
    body.append("videos", new Blob([fs.readFileSync(red)], { type: "video/mp4" }), "rouge.mp4");
    body.append("videos", new Blob([fs.readFileSync(green)], { type: "video/mp4" }), "vert.mp4");
    const created = await fetch(`${base}/api/jobs`, { method: "POST", body });
    const job = await created.json();
    assert.equal(created.status, 202, JSON.stringify(job));
    assert.match(job.filename, /^[0-9a-f]{12}-\d{8}-\d{6}\.mp4$/);

    let done = null;
    for (let i = 0; i < 40; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const status = await fetch(`${base}/api/jobs/${job.id}`);
      done = await status.json();
      if (done.status === "done" || done.status === "error") break;
    }
    assert.equal(done.status, "done", done.error || done.status);
    assert.equal(done.filename, job.filename);
    const file = await fetch(`${base}/api/jobs/${job.id}/file`);
    assert.equal(file.status, 200);
    assert.match(file.headers.get("content-type") || "", /video/);
    assert.equal(file.headers.get("content-disposition"), `attachment; filename="${job.filename}"`);
    const saved = path.join(dir, "api-out.mp4");
    fs.writeFileSync(saved, Buffer.from(await file.arrayBuffer()));
    expectColor(await sample(saved, 200, 540), "red");
    expectColor(await sample(saved, 1500, 540), "green");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("le titre s’incruste, une ligne, trois tailles, neuf positions", () => {
  assert.equal(parseTitle(null), null);
  assert.equal(parseTitle({ title: "  \n  " }), null);
  assert.deepEqual(parseTitle({ title: "  Bonjour\tle monde  " }), {
    text: "Bonjour le monde",
    size: "m",
    place: "bc",
  });
  assert.equal(parseTitle({ title: "a".repeat(80) }).text.length, 80);
  assert.throws(() => parseTitle({ title: "a".repeat(81) }), /trop long/);
  assert.throws(() => parseTitle({ title: "Salut", titlePlace: "zz" }), /pas lisible/);

  const title = parseTitle({ title: "l'été : 100%", titleSize: "m", titlePlace: "bc" });
  const filter = titleFilter(title, 1080);
  assert.match(filter, /text='l’été \\: 100%'/);
  assert.match(filter, /expansion=none/);
  assert.match(filter, /fontsize=78/);
  assert.match(filter, /x=\(w-text_w\)\/2/);
  assert.match(filter, /y=h-text_h-54/);
  const corner = titleFilter({ text: "A", size: "s", place: "tl" }, 1080);
  assert.match(corner, /fontsize=49/);
  assert.match(corner, /x=54:y=54/);

  const graph = buildGraph(layoutFor(1), [{ hasAudio: false }], 1, 0, title);
  assert.equal(graph.vmap, "[vtitle]");
  assert.ok(graph.filter.includes(filter));

  assert.deepEqual(parseTiming({}), { span: "short", finish: "black" });
  assert.deepEqual(parseTiming({ span: "long", finish: "loop" }), { span: "long", finish: "loop" });
  assert.throws(() => parseTiming({ span: "moyenne" }), /durée/);
  assert.throws(() => parseTiming({ finish: "fige" }), /fin/);
  const pair = layoutFor(2);
  const probes = [
    { hasAudio: false, duration: 1 },
    { hasAudio: false, duration: 3 },
  ];
  const black = buildGraph(pair, probes, 3, 0, null, "black");
  const chains = black.filter.split(";");
  assert.match(chains.find((part) => part.startsWith("[0:v]")), /tpad=stop_mode=add:color=black:stop_duration=2\.033/);
  assert.doesNotMatch(chains.find((part) => part.startsWith("[1:v]")), /tpad/);
  const looped = buildGraph(pair, probes, 3, 0, null, "loop");
  assert.doesNotMatch(looped.filter, /tpad/);
});

test("le fichier téléchargé s’appelle hash-date, heure de Paris", () => {
  const crypto = require("crypto");
  const { downloadName } = require("../server");
  const id = "9d34e1f3-7e28-4ef5-a388-a134d61e93a2";
  const hash = crypto.createHash("sha256").update(id).digest("hex").slice(0, 12);
  assert.equal(downloadName(id, Date.UTC(2026, 9, 22, 14, 4, 50)), `${hash}-20261022-160450.mp4`);
  assert.equal(downloadName(id, Date.UTC(2026, 0, 15, 23, 30, 0)), `${hash}-20260116-003000.mp4`);
  assert.notEqual(
    downloadName(id, Date.UTC(2026, 9, 22, 14, 4, 50)).slice(0, 12),
    downloadName("11111111-1111-4111-8111-111111111111", Date.UTC(2026, 9, 22, 14, 4, 50)).slice(0, 12)
  );
});

test("une vidéo plus courte boucle ou passe au noir", { timeout: 90000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "montage-span-"));
  try {
    const red = await makeClip(dir, "red.mp4", { color: "red", seconds: 0.5, size: "320x180", audio: false });
    const blue = await makeClip(dir, "blue.mp4", { color: "blue", seconds: 0.5, size: "320x180", audio: false });
    const split = path.join(dir, "split.mp4");
    await run("ffmpeg", [
      "-hide_banner", "-y", "-i", red, "-i", blue,
      "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", split,
    ]);
    const green = await makeClip(dir, "green.mp4", { color: "green", seconds: 1.5, size: "320x180", audio: false });
    const probes = [await probeVideo(split), await probeVideo(green)];
    const files = [split, green];
    const blackOut = path.join(dir, "black.mp4");
    const loopOut = path.join(dir, "loop.mp4");
    await renderToFile({ files, probes, output: blackOut, span: "long", end: "black" });
    await renderToFile({ files, probes, output: loopOut, span: "long", end: "loop" });
    const at = probes[0].duration + 0.2;
    expectColor(await sample(blackOut, 200, 540, at), "black");
    expectColor(await sample(blackOut, 1400, 540, at), "green");
    expectColor(await sample(loopOut, 200, 540, at), "red");
    expectColor(await sample(loopOut, 1400, 540, at), "green");
    const meta = await probe(blackOut);
    const wanted = outputDuration(probes.map((item) => item.duration), "long");
    assert.ok(Math.abs(Number(meta.format.duration) - wanted) < 0.25, `durée ${meta.format.duration}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
