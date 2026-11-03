"use strict";

// Montage — montage.purvanas.fr — 127.0.0.1:4710 — PM2: montage

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const {
  catalog,
  outputDuration,
  MAX_CLIPS,
  MAX_FILE_BYTES,
} = require("./lib/layouts");
const { RenderError, probeVideo, renderToFile, parseAudioSelection, parseTiming } = require("./lib/render");
const { parseRangesField, parseVolume, normalizeRanges, renderCut } = require("./lib/cut");
const { parseTitle } = require("./lib/title");

const PORT = Number(process.env.PORT || 4710);
const HOST = process.env.HOST || "127.0.0.1";
const DATA = process.env.MONTAGE_DATA || path.join(__dirname, "data");
const PUBLIC = path.join(__dirname, "public");
const TTL_MS = 2 * 60 * 60 * 1000;
const ORPHAN_MS = 30 * 60 * 1000;
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const EXT_OK = new Set([".mp4", ".m4v", ".mov", ".webm", ".mkv", ".ogv", ".ogg", ".mpg", ".mpeg"]);
const EXT_BY_MIME = {
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "video/quicktime": ".mov",
  "video/x-matroska": ".mkv",
  "video/ogg": ".ogv",
  "video/mpeg": ".mpg",
};
const STATIC_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

const jobs = new Map();
const queue = [];
let active = null;
const hits = new Map();

function clientIp(req) {
  const cf = req.headers["cf-connecting-ip"];
  if (typeof cf === "string" && /^[0-9a-fA-F:.]+$/.test(cf)) return cf;
  const real = req.headers["x-real-ip"];
  if (typeof real === "string" && /^[0-9a-fA-F:.]+$/.test(real)) return real;
  return String(req.socket.remoteAddress || "inconnu").replace(/^::ffff:/, "");
}

function tooMany(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((time) => now - time < 3600_000);
  hits.set(ip, recent);
  return recent.length >= 30;
}

function noteIp(ip) {
  const recent = hits.get(ip) || [];
  recent.push(Date.now());
  hits.set(ip, recent);
}

function extFor(file) {
  const ext = path.extname(file.originalname || "").toLowerCase();
  if (ext === ".m4v") return ".mp4";
  if (ext === ".ogg") return ".ogv";
  if (ext === ".mpeg") return ".mpg";
  if (EXT_OK.has(ext)) return ext;
  return EXT_BY_MIME[file.mimetype] || ".mp4";
}

function isAllowed(file) {
  const ext = path.extname(file.originalname || "").toLowerCase();
  return EXT_OK.has(ext) || Boolean(EXT_BY_MIME[file.mimetype]);
}

function safeName(name) {
  const base = path.basename(String(name || "vidéo")).replace(/[\u0000-\u001f]/g, " ").trim();
  return (base || "vidéo").slice(0, 80);
}

function uploadMessage(err, single) {
  if (err?.code === "LIMIT_FILE_SIZE") return "Chaque vidéo doit faire moins de 500 Mo.";
  if (err?.code === "LIMIT_FILE_COUNT") {
    return single ? "Une seule vidéo à la fois." : "Cinq vidéos maximum.";
  }
  if (err?.code === "RANGES") return "Les coupes ne sont pas lisibles.";
  if (err?.code === "TITLE") return "Le titre est trop long.";
  if (err?.code === "FORMAT") return "Format non accepté. Utilise MP4, MOV, WEBM ou MKV.";
  return "Envoi impossible.";
}

function sendJson(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": payload.length,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

function headerParam(header, key) {
  if (key === "filename") {
    const star = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header);
    if (star) {
      try { return decodeURIComponent(star[1].trim().replace(/^"|"$/g, "")); } catch { /* nom simple */ }
    }
  }
  const quoted = new RegExp(`${key}\\s*=\\s*"([^"]*)"`, "i").exec(header);
  if (quoted) return quoted[1];
  const plain = new RegExp(`${key}\\s*=\\s*([^;]+)`, "i").exec(header);
  return plain ? plain[1].trim() : "";
}

function readVideos(req, { maxFiles, maxFileBytes, accept }) {
  const contentType = req.headers["content-type"] || "";
  const found = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!found) {
    return Promise.reject(Object.assign(new Error("format"), { code: "FORMAT" }));
  }
  const boundary = found[1] || found[2];
  const firstBoundary = Buffer.from(`--${boundary}`);
  const crlfBoundary = Buffer.from(`\r\n--${boundary}`);
  const headerEnd = Buffer.from("\r\n\r\n");

  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    let state = "preamble";
    let stream = null;
    let discarding = false;
    let fieldName = null;
    let fieldChunks = [];
    let size = 0;
    let settled = false;
    let holdToken = 0;
    const files = [];
    const pending = [];
    const openStreams = new Map();

    // write() then end() never emits drain. Hold until drain, finish, or close,
    // otherwise the rest of the upload stays unread and the page waits forever.
    function hold(writable) {
      const token = ++holdToken;
      req.pause();
      const release = () => {
        writable.removeListener("drain", release);
        writable.removeListener("finish", release);
        writable.removeListener("close", release);
        if (holdToken !== token) return;
        process.nextTick(() => {
          if (holdToken === token) req.resume();
        });
      };
      writable.on("drain", release);
      writable.on("finish", release);
      writable.on("close", release);
    }

    function fail(err) {
      if (settled) return;
      settled = true;
      req.resume();
      const normalized = err.code ? err : Object.assign(err, { code: err.code || "FORMAT" });
      const closing = [];
      for (const [writable, closed] of openStreams) {
        closing.push(closed);
        if (!writable.destroyed) writable.destroy();
      }
      Promise.allSettled(closing).then(() => reject(normalized));
    }

    function writeBody(chunk) {
      if (!chunk.length) return;
      size += chunk.length;
      if (fieldName) {
        const limit = fieldName === "ranges" ? 8000 : fieldName === "title" ? 400 : 24;
        if (size > limit) {
          const code = fieldName === "ranges" ? "RANGES" : fieldName === "title" ? "TITLE" : "FORMAT";
          throw Object.assign(new Error("field"), { code });
        }
        fieldChunks.push(Buffer.from(chunk));
        return;
      }
      if (!discarding && size > maxFileBytes) {
        throw Object.assign(new Error("size"), { code: "LIMIT_FILE_SIZE" });
      }
      if (discarding || !stream) return;
      if (!stream.write(chunk)) hold(stream);
    }

    function closeBody() {
      if (fieldName) {
        const text = Buffer.concat(fieldChunks).toString("utf8").trim();
        if (!files.fields) files.fields = {};
        files.fields[fieldName] = text;
        if (fieldName === "audio" && /^\d+$/.test(text)) files.audioIndex = Number(text);
        fieldName = null;
        fieldChunks = [];
        discarding = false;
        size = 0;
        return;
      }
      if (stream) {
        const current = stream;
        pending.push(openStreams.get(current));
        current.end();
        stream = null;
      }
      discarding = false;
      size = 0;
    }

    function openHeaders(raw) {
      const headers = {};
      for (const line of raw.split("\r\n")) {
        const split = line.indexOf(":");
        if (split > 0) headers[line.slice(0, split).trim().toLowerCase()] = line.slice(split + 1).trim();
      }
      const disposition = headers["content-disposition"] || "";
      const name = headerParam(disposition, "name");
      const filename = headerParam(disposition, "filename");
      fieldName = null;
      fieldChunks = [];
      if ((name === "audio" || name === "volume" || name === "ranges" || name === "title" || name === "titleSize" || name === "titlePlace" || name === "span" || name === "finish") && !filename) {
        discarding = false;
        stream = null;
        fieldName = name;
        return;
      }
      if (name !== "videos" || !filename) {
        discarding = true;
        stream = null;
        return;
      }
      if (files.length >= maxFiles) {
        throw Object.assign(new Error("count"), { code: "LIMIT_FILE_COUNT" });
      }
      const meta = {
        originalname: filename,
        mimetype: (headers["content-type"] || "").split(";")[0].trim(),
      };
      const dest = accept(meta, files.length);
      if (!dest) throw Object.assign(new Error("format"), { code: "FORMAT" });
      stream = fs.createWriteStream(dest);
      stream.on("error", fail);
      const current = stream;
      const closed = new Promise((done) => current.once("close", done));
      openStreams.set(current, closed);
      current.once("close", () => openStreams.delete(current));
      files.push({ ...meta, path: dest });
      discarding = false;
    }

    function pump(final) {
      for (;;) {
        if (state === "done") return;
        if (state === "preamble") {
          const at = buffer.indexOf(firstBoundary);
          if (at < 0) {
            if (final || buffer.length > 1024 * 1024) {
              throw Object.assign(new Error("format"), { code: "FORMAT" });
            }
            const keep = firstBoundary.length - 1;
            if (buffer.length > keep) buffer = buffer.subarray(buffer.length - keep);
            return;
          }
          buffer = buffer.subarray(at + firstBoundary.length);
          state = "after";
          continue;
        }
        if (state === "after") {
          if (buffer.length < 2) {
            if (final) throw Object.assign(new Error("format"), { code: "FORMAT" });
            return;
          }
          if (buffer[0] === 45 && buffer[1] === 45) {
            buffer = buffer.subarray(2);
            state = "done";
            return;
          }
          if (buffer[0] === 13 && buffer[1] === 10) {
            buffer = buffer.subarray(2);
            state = "headers";
            continue;
          }
          throw Object.assign(new Error("format"), { code: "FORMAT" });
        }
        if (state === "headers") {
          const at = buffer.indexOf(headerEnd);
          if (at < 0) {
            if (final || buffer.length > 16384) {
              throw Object.assign(new Error("format"), { code: "FORMAT" });
            }
            return;
          }
          const raw = buffer.subarray(0, at).toString("utf8");
          buffer = buffer.subarray(at + 4);
          openHeaders(raw);
          state = "body";
          continue;
        }
        if (state === "body") {
          const at = buffer.indexOf(crlfBoundary);
          if (at < 0) {
            if (final) throw Object.assign(new Error("format"), { code: "FORMAT" });
            const keep = crlfBoundary.length - 1;
            if (buffer.length > keep) {
              writeBody(buffer.subarray(0, buffer.length - keep));
              buffer = buffer.subarray(buffer.length - keep);
            }
            return;
          }
          writeBody(buffer.subarray(0, at));
          buffer = buffer.subarray(at + crlfBoundary.length);
          closeBody();
          state = "after";
        }
      }
    }

    req.on("data", (chunk) => {
      if (settled) return;
      buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
      try { pump(false); } catch (err) { fail(err); }
    });
    req.on("end", () => {
      if (settled) return;
      try {
        pump(true);
        if (state !== "done") {
          fail(Object.assign(new Error("format"), { code: "FORMAT" }));
          return;
        }
        Promise.all(pending).then(
          () => { if (!settled) { settled = true; resolve(files); } },
          fail
        );
      } catch (err) { fail(err); }
    });
    req.on("error", fail);
  });
}

function aheadOf(id) {
  if (active?.id === id) return 0;
  let count = active ? 1 : 0;
  for (const job of queue) {
    if (job.id === id) return count;
    count += 1;
  }
  return 0;
}

function downloadName(id, created) {
  const hash = crypto.createHash("sha256").update(String(id)).digest("hex").slice(0, 12);
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(created));
  const pick = (type) => parts.find((part) => part.type === type).value;
  let hour = pick("hour");
  if (hour === "24") hour = "00";
  const stamp = `${pick("year")}${pick("month")}${pick("day")}-${hour}${pick("minute")}${pick("second")}`;
  return `${hash}-${stamp}.mp4`;
}

function present(job) {
  return {
    id: job.id,
    status: job.status,
    progress: job.progress || 0,
    ahead: job.status === "queued" ? aheadOf(job.id) : 0,
    duration: job.duration,
    filename: job.filename || null,
    error: job.error || null,
  };
}

function sweep() {
  if (!fs.existsSync(DATA)) return;
  const now = Date.now();
  for (const name of fs.readdirSync(DATA)) {
    if (!ID_RE.test(name)) continue;
    const job = jobs.get(name);
    if (job && (job.status === "queued" || job.status === "running")) continue;
    const dir = path.join(DATA, name);
    let age = ORPHAN_MS + 1;
    try { age = now - fs.statSync(dir).mtimeMs; } catch { continue; }
    if (age > (job ? TTL_MS : ORPHAN_MS)) {
      fs.rmSync(dir, { recursive: true, force: true });
      jobs.delete(name);
    }
  }
}

async function runJob(job) {
  job.status = "running";
  try {
    const result = job.kind === "cut"
      ? await renderCut({
        file: job.files[0],
        probe: job.probes[0],
        ranges: job.ranges,
        volume: job.volume,
        title: job.title,
        output: job.output,
        onProgress(progress) { job.progress = progress; },
      })
      : await renderToFile({
        files: job.files,
        probes: job.probes,
        output: job.output,
        audioIndex: job.audioIndexes != null ? job.audioIndexes : job.audioIndex,
        title: job.title,
        span: job.span,
        end: job.finish,
        onProgress(progress) { job.progress = progress; },
      });
    job.duration = result.duration;
    job.status = "done";
    job.progress = 100;
    for (const file of job.files) fs.rmSync(file, { force: true });
    job.files = [];
  } catch (err) {
    job.status = "error";
    job.error = err.publicMessage || "L’encodage a échoué.";
    console.error(`${job.kind === "cut" ? "coupe" : "montage"} ${job.id}`, err.message);
    fs.rmSync(job.dir, { recursive: true, force: true });
  }
}

function pumpQueue() {
  if (active || queue.length === 0) return;
  const job = queue.shift();
  active = job;
  runJob(job).finally(() => {
    if (active === job) active = null;
    pumpQueue();
  });
}

// Cloudflare keeps .js and .css for four hours and ignores our no-cache.
// The HTML is not cached, so stamp those assets with their mtime.
function stampAssets(html) {
  return html.replace(/(href|src)="(\/(?:style\.css|app\.js|cut\.js))"/g, (match, attr, url) => {
    let version = "0";
    try { version = String(Math.round(fs.statSync(path.join(PUBLIC, url)).mtimeMs)); } catch { /* missing */ }
    return `${attr}="${url}?v=${version}"`;
  });
}

function serveStatic(req, res) {
  const url = new URL(req.url, "http://localhost");
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";
  const file = path.normalize(path.join(PUBLIC, pathname));
  if (file !== PUBLIC && !file.startsWith(PUBLIC + path.sep)) {
    sendJson(res, 404, { error: "Introuvable." });
    return;
  }
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) {
      sendJson(res, 404, { error: "Introuvable." });
      return;
    }
    const type = STATIC_TYPES[path.extname(file).toLowerCase()] || "application/octet-stream";
    const cache = path.extname(file) === ".woff2" ? "public, max-age=86400" : "no-cache";
    const headers = {
      "Content-Type": type,
      "Cache-Control": cache,
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "same-origin",
    };
    if (pathname === "/index.html") {
      fs.readFile(file, (readErr, buf) => {
        if (readErr) {
          sendJson(res, 404, { error: "Introuvable." });
          return;
        }
        const body = Buffer.from(stampAssets(buf.toString("utf8")));
        res.writeHead(200, { ...headers, "Content-Length": body.length });
        res.end(body);
      });
      return;
    }
    res.writeHead(200, { ...headers, "Content-Length": stat.size });
    fs.createReadStream(file).pipe(res);
  });
}

async function handleCreate(req, res) {
  const ip = clientIp(req);
  if (tooMany(ip)) {
    sendJson(res, 429, { error: "Trop de montages pour le moment. Réessaie plus tard." });
    req.resume();
    return;
  }
  if (queue.length >= 3) {
    sendJson(res, 429, { error: "Plusieurs montages sont déjà en cours. Réessaie dans une minute." });
    req.resume();
    return;
  }
  const declared = Number(req.headers["content-length"] || 0);
  if (declared > MAX_CLIPS * MAX_FILE_BYTES + 1024 * 1024) {
    sendJson(res, 413, { error: "Envoi trop lourd." });
    req.resume();
    return;
  }

  const id = crypto.randomUUID();
  const dir = path.join(DATA, id);
  fs.mkdirSync(dir, { recursive: true });

  let stored;
  try {
    stored = await readVideos(req, {
      maxFiles: MAX_CLIPS,
      maxFileBytes: MAX_FILE_BYTES,
      accept(meta, index) {
        if (!isAllowed(meta)) return null;
        return path.join(dir, `in-${index}${extFor(meta)}`);
      },
    });
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    const status = err.code === "LIMIT_FILE_SIZE" ? 413 : 400;
    sendJson(res, status, { error: uploadMessage(err) });
    return;
  }

  if (stored.length < 1 || stored.length > MAX_CLIPS) {
    fs.rmSync(dir, { recursive: true, force: true });
    sendJson(res, 400, { error: "Ajoute entre 1 et 5 vidéos." });
    return;
  }

  noteIp(ip);
  try {
    const probes = [];
    for (const file of stored) {
      try {
        probes.push(await probeVideo(file.path));
      } catch (probeErr) {
        const why = probeErr.publicMessage || "illisible.";
        throw new RenderError(`« ${safeName(file.originalname)} » : ${why}`);
      }
    }
    const timing = parseTiming(stored.fields);
    const duration = outputDuration(probes.map((probe) => probe.duration), timing.span);
    if (!Number.isFinite(duration) || duration < 0.4) {
      throw new RenderError("Ces vidéos sont trop courtes.");
    }
    const audioIndexes = parseAudioSelection(stored.fields?.audio, probes.length);
    const title = parseTitle(stored.fields);
    const created = Date.now();
    const job = {
      id,
      dir,
      files: stored.map((file) => file.path),
      probes,
      audioIndex: stored.audioIndex,
      audioIndexes,
      title,
      span: timing.span,
      finish: timing.finish,
      output: path.join(dir, "out.mp4"),
      filename: downloadName(id, created),
      status: "queued",
      progress: 0,
      duration: Math.round(duration * 1000) / 1000,
      error: null,
      created,
    };
    jobs.set(id, job);
    queue.push(job);
    pumpQueue();
    sendJson(res, 202, present(job));
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    sendJson(res, 400, { error: err.publicMessage || "Ces fichiers ne sont pas lisibles." });
  }
}

async function handleCut(req, res) {
  const ip = clientIp(req);
  if (tooMany(ip)) {
    sendJson(res, 429, { error: "Trop de rendus pour le moment. Réessaie plus tard." });
    req.resume();
    return;
  }
  if (queue.length >= 3) {
    sendJson(res, 429, { error: "Plusieurs rendus sont déjà en cours. Réessaie dans une minute." });
    req.resume();
    return;
  }
  const declared = Number(req.headers["content-length"] || 0);
  if (declared > MAX_FILE_BYTES + 1024 * 1024) {
    sendJson(res, 413, { error: "Envoi trop lourd." });
    req.resume();
    return;
  }

  const id = crypto.randomUUID();
  const dir = path.join(DATA, id);
  fs.mkdirSync(dir, { recursive: true });

  let stored;
  try {
    stored = await readVideos(req, {
      maxFiles: 1,
      maxFileBytes: MAX_FILE_BYTES,
      accept(meta) {
        if (!isAllowed(meta)) return null;
        return path.join(dir, `in-0${extFor(meta)}`);
      },
    });
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    const status = err.code === "LIMIT_FILE_SIZE" ? 413 : 400;
    sendJson(res, status, { error: uploadMessage(err, true) });
    return;
  }

  if (stored.length !== 1) {
    fs.rmSync(dir, { recursive: true, force: true });
    sendJson(res, 400, { error: "Ajoute une vidéo." });
    return;
  }

  noteIp(ip);
  try {
    const volume = parseVolume(stored.fields?.volume);
    const rangesField = parseRangesField(stored.fields?.ranges);
    let probe;
    try {
      probe = await probeVideo(stored[0].path);
    } catch (probeErr) {
      const why = probeErr.publicMessage || "illisible.";
      throw new RenderError(`« ${safeName(stored[0].originalname)} » : ${why}`);
    }
    const ranges = normalizeRanges(rangesField || [[0, probe.duration]], probe.duration);
    const kept = ranges.reduce((sum, [start, end]) => sum + (end - start), 0);
    const title = parseTitle(stored.fields);
    const created = Date.now();
    const job = {
      id,
      kind: "cut",
      dir,
      files: [stored[0].path],
      probes: [probe],
      ranges,
      volume,
      title,
      filename: downloadName(id, created),
      output: path.join(dir, "out.mp4"),
      status: "queued",
      progress: 0,
      duration: Math.round(kept * 1000) / 1000,
      error: null,
      created,
    };
    jobs.set(id, job);
    queue.push(job);
    pumpQueue();
    sendJson(res, 202, present(job));
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    sendJson(res, 400, { error: err.publicMessage || "Cette vidéo n’est pas lisible." });
  }
}

function handle(req, res) {
  const url = new URL(req.url, "http://localhost");
  const pathname = url.pathname;
  if (req.method === "GET" && pathname === "/api/health") {
    sendJson(res, 200, { ok: true });
    return;
  }
  if (req.method === "GET" && pathname === "/api/layouts") {
    sendJson(res, 200, catalog());
    return;
  }
  if (req.method === "POST" && pathname === "/api/jobs") {
    handleCreate(req, res).catch((err) => {
      console.error(err);
      if (!res.headersSent) sendJson(res, 500, { error: "Erreur interne." });
    });
    return;
  }
  if (req.method === "POST" && pathname === "/api/cuts") {
    handleCut(req, res).catch((err) => {
      console.error(err);
      if (!res.headersSent) sendJson(res, 500, { error: "Erreur interne." });
    });
    return;
  }
  const fileMatch = pathname.match(/^\/api\/jobs\/([0-9a-f-]{36})\/file$/i);
  if (req.method === "GET" && fileMatch) {
    const job = jobs.get(fileMatch[1]);
    if (!job || job.status !== "done" || !job.output || !fs.existsSync(job.output)) {
      sendJson(res, 404, { error: "Le fichier n’est plus disponible." });
      return;
    }
    const stat = fs.statSync(job.output);
    res.writeHead(200, {
      "Content-Type": "video/mp4",
      "Content-Length": stat.size,
      "Content-Disposition": `attachment; filename="${job.filename || downloadName(job.id, job.created || Date.now())}"`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
    });
    fs.createReadStream(job.output).pipe(res);
    return;
  }
  const jobMatch = pathname.match(/^\/api\/jobs\/([0-9a-f-]{36})$/i);
  if (req.method === "GET" && jobMatch) {
    const job = jobs.get(jobMatch[1]);
    if (!job) {
      sendJson(res, 404, { error: "Montage introuvable." });
      return;
    }
    sendJson(res, 200, present(job));
    return;
  }
  if (pathname.startsWith("/api/")) {
    sendJson(res, 404, { error: "Introuvable." });
    return;
  }
  if (req.method === "GET" || req.method === "HEAD") {
    serveStatic(req, res);
    return;
  }
  sendJson(res, 405, { error: "Méthode refusée." });
}

function createServer() {
  return http.createServer(handle);
}

function start() {
  fs.mkdirSync(DATA, { recursive: true });
  const timer = setInterval(sweep, 10 * 60 * 1000);
  timer.unref();
  sweep();
  createServer().listen(PORT, HOST, () => {
    console.log(`montage on http://${HOST}:${PORT}`);
  });
}

if (require.main === module) start();

module.exports = { createServer, downloadName };
