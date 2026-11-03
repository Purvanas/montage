"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const { probeVideo } = require("../lib/render");
const { parseTitle } = require("../lib/title");
const {
  parseRangesField,
  parseVolume,
  normalizeRanges,
  buildCutGraph,
  renderCut,
} = require("../lib/cut");

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

function makeClip(dir, name, { seconds, audio = true }) {
  const output = path.join(dir, name);
  const args = [
    "-hide_banner", "-y",
    "-f", "lavfi", "-i", `color=c=red:s=320x180:r=30:d=${seconds}`,
  ];
  if (audio) args.push("-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`);
  args.push("-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-t", String(seconds));
  if (audio) args.push("-c:a", "aac", "-b:a", "96k");
  else args.push("-an");
  args.push(output);
  return run("ffmpeg", args).then(() => output);
}

function probeFile(file) {
  return new Promise((resolve, reject) => {
    const child = spawn("ffprobe", [
      "-v", "error", "-print_format", "json", "-show_format", "-show_streams", file,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.on("close", (code) => (code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error("ffprobe"))));
  });
}

test("les morceaux se recadrent, se fusionnent et se limitent", () => {
  assert.equal(parseRangesField(""), null);
  assert.equal(parseRangesField(undefined), null);
  assert.deepEqual(parseRangesField("[[0,1]]"), [[0, 1]]);
  assert.throws(() => parseRangesField("nope"), /lisibles/);
  assert.throws(() => parseRangesField("{\"a\":1}"), /lisibles/);
  assert.equal(parseVolume(""), 1);
  assert.equal(parseVolume("0"), 0);
  assert.equal(parseVolume("2"), 1);
  assert.equal(parseVolume("-3"), 0);
  assert.throws(() => parseVolume("fort"), /volume/);

  assert.deepEqual(
    normalizeRanges([[2, 3], [0, 1], [1.01, 2], [1.5, 2.4], [3, 3.02], [-4, 0.2]], 5),
    [[0, 3]]
  );
  assert.deepEqual(normalizeRanges([[-5, 2], [9, 12]], 10), [[0, 2], [9, 10]]);
  assert.throws(() => normalizeRanges([[0, 0.01]], 5), /morceau/);
  assert.throws(() => normalizeRanges([[0, 0.2]], 0.2), /trop courte/);
  assert.throws(() => normalizeRanges([[0, 601]], 700), /dix minutes/);
});

test("le graphe coupe sans mélanger, et le volume zéro retire le son", () => {
  const one = buildCutGraph({
    ranges: [[0.2, 0.8]],
    width: 320,
    height: 180,
    hasAudio: true,
    volume: 0.5,
  });
  assert.equal(one.hasAudio, true);
  assert.equal(one.vmap, "[v0]");
  assert.equal(one.amap, "[a0]");
  assert.match(one.filter, /volume=0\.500/);
  assert.match(one.filter, /trim=start=0\.200:end=0\.800/);
  assert.doesNotMatch(one.filter, /concat/);
  assert.doesNotMatch(one.filter, /amix/);
  assert.doesNotMatch(one.filter, /fps=/);
  assert.doesNotMatch(one.filter, /drawtext/);

  const two = buildCutGraph({
    ranges: [[0, 1], [2, 3]],
    width: 641,
    height: 361,
    hasAudio: true,
    volume: 0,
  });
  assert.equal(two.hasAudio, false);
  assert.equal(two.amap, null);
  assert.match(two.filter, /scale=640:360/);
  assert.match(two.filter, /concat=n=2:v=1:a=0/);
  assert.doesNotMatch(two.filter, /\[a0\]/);
  assert.doesNotMatch(two.filter, /\[aout\]/);
  assert.doesNotMatch(two.filter, /amix/);

  const heard = buildCutGraph({
    ranges: [[0, 1], [1.5, 2]],
    width: 320,
    height: 180,
    hasAudio: true,
    volume: 0.25,
  });
  assert.match(heard.filter, /volume=0\.250/);
  assert.match(heard.filter, /concat=n=2:v=0:a=1\[aout\]/);

  const silent = buildCutGraph({
    ranges: [[0, 1]],
    width: 100,
    height: 80,
    hasAudio: false,
    volume: 1,
  });
  assert.equal(silent.hasAudio, false);
  assert.doesNotMatch(silent.filter, /\[a0\]/);
});

test("le rendu garde le morceau choisi et son volume", { timeout: 120000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "montage-cut-"));
  try {
    const input = await makeClip(dir, "source.mp4", { seconds: 1.2 });
    const probe = await probeVideo(input);
    const cutOut = path.join(dir, "cut.mp4");
    const cut = await renderCut({
      file: input,
      probe,
      ranges: [[0.2, 0.8]],
      volume: 1,
      output: cutOut,
    });
    assert.ok(cut.duration > 0.45 && cut.duration < 0.75, `prévu ${cut.duration}`);
    const meta = await probeFile(cutOut);
    const got = Number(meta.format.duration);
    assert.ok(got > 0.4 && got < 0.95, `durée ${got}`);
    assert.equal(meta.streams.some((stream) => stream.codec_type === "audio"), true);
    const video = meta.streams.find((stream) => stream.codec_type === "video");
    assert.equal(video.width, 320);
    assert.equal(video.height, 180);

    const joinedOut = path.join(dir, "joined.mp4");
    await renderCut({
      file: input,
      probe,
      ranges: [[0.1, 0.4], [0.8, 1.1]],
      volume: 0.5,
      output: joinedOut,
    });
    const joined = await probeFile(joinedOut);
    const joinedDur = Number(joined.format.duration);
    assert.ok(joinedDur > 0.4 && joinedDur < 0.95, `deux morceaux ${joinedDur}`);
    assert.equal(joined.streams.some((stream) => stream.codec_type === "audio"), true);

    const quietOut = path.join(dir, "quiet.mp4");
    await renderCut({
      file: input,
      probe,
      ranges: [[0, probe.duration]],
      volume: 0,
      output: quietOut,
    });
    const quiet = await probeFile(quietOut);
    assert.equal(quiet.streams.some((stream) => stream.codec_type === "audio"), false);
    assert.equal(quiet.streams.some((stream) => stream.codec_type === "video"), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("l’API coupe une vidéo et refuse des coupes illisibles", { timeout: 120000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "montage-cut-http-"));
  process.env.MONTAGE_DATA = dir;
  delete require.cache[require.resolve("../server")];
  delete require.cache[require.resolve("../lib/cut")];
  delete require.cache[require.resolve("../lib/render")];
  const { createServer } = require("../server");
  const server = createServer().listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const bad = new FormData();
    bad.append("ranges", "nope");
    bad.append("volume", "0");
    bad.append("videos", new Blob([Buffer.from("x")], { type: "video/mp4" }), "a.mp4");
    const rejected = await fetch(`${base}/api/cuts`, { method: "POST", body: bad });
    const rejectedBody = await rejected.json();
    assert.equal(rejected.status, 400);
    assert.match(rejectedBody.error, /lisibles/);

    const loud = new FormData();
    loud.append("volume", "fort");
    loud.append("videos", new Blob([Buffer.from("x")], { type: "video/mp4" }), "a.mp4");
    const volumeRejected = await fetch(`${base}/api/cuts`, { method: "POST", body: loud });
    assert.equal(volumeRejected.status, 400);
    assert.match((await volumeRejected.json()).error, /volume/);

    const extra = new FormData();
    extra.append("videos", new Blob([Buffer.from("x")], { type: "video/mp4" }), "a.mp4");
    extra.append("videos", new Blob([Buffer.from("y")], { type: "video/mp4" }), "b.mp4");
    const tooMany = await fetch(`${base}/api/cuts`, { method: "POST", body: extra });
    assert.equal(tooMany.status, 400);
    assert.match((await tooMany.json()).error, /Une seule vidéo/);
    assert.deepEqual(
      fs.readdirSync(dir).filter((name) => /^[0-9a-f-]{36}$/i.test(name)),
      [],
      "les uploads refusés ne doivent laisser aucun dossier temporaire"
    );

    const source = await makeClip(dir, "source.mp4", { seconds: 1.2 });
    const body = new FormData();
    body.append("ranges", JSON.stringify([[0.2, 0.6]]));
    body.append("volume", "0");
    body.append("videos", new Blob([fs.readFileSync(source)], { type: "video/mp4" }), "source.mp4");
    const created = await fetch(`${base}/api/cuts`, { method: "POST", body });
    const job = await created.json();
    assert.equal(created.status, 202, JSON.stringify(job));
    assert.match(job.filename, /^[0-9a-f]{12}-\d{8}-\d{6}\.mp4$/);

    let done = null;
    for (let i = 0; i < 40; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 400));
      done = await (await fetch(`${base}/api/jobs/${job.id}`)).json();
      if (done.status === "done" || done.status === "error") break;
    }
    assert.equal(done.status, "done", done.error || done.status);
    assert.equal(done.filename, job.filename);
    const file = await fetch(`${base}/api/jobs/${job.id}/file`);
    assert.equal(file.status, 200);
    assert.equal(file.headers.get("content-disposition"), `attachment; filename="${job.filename}"`);
    const saved = path.join(dir, "api-cut.mp4");
    fs.writeFileSync(saved, Buffer.from(await file.arrayBuffer()));
    const meta = await probeFile(saved);
    const got = Number(meta.format.duration);
    assert.ok(got > 0.2 && got < 0.7, `durée ${got}`);
    assert.equal(meta.streams.some((stream) => stream.codec_type === "audio"), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function lightPixels(file) {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", [
      "-v", "error", "-i", file, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
    ], { stdio: ["ignore", "pipe", "pipe"] });
    const chunks = [];
    let stderr = "";
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr.slice(-400) || "frame"));
        return;
      }
      const buf = Buffer.concat(chunks);
      let light = 0;
      for (let i = 0; i < buf.length; i += 3) {
        if (buf[i] > 220 && buf[i + 1] > 220 && buf[i + 2] > 220) light += 1;
      }
      resolve(light);
    });
  });
}

test("un titre force le réencodage et s’écrit sur l’image", { timeout: 30000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "montage-title-"));
  try {
    const source = await makeClip(dir, "source.mp4", { seconds: 0.6 });
    const probe = await probeVideo(source);
    const output = path.join(dir, "out.mp4");
    await renderCut({
      file: source,
      probe,
      ranges: [[0, probe.duration]],
      volume: 1,
      title: parseTitle({ title: "l'été : 100%", titleSize: "l", titlePlace: "mc" }),
      output,
    });
    assert.ok(await lightPixels(output) > 20);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
