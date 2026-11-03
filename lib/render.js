"use strict";

const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const { layoutFor, outputDuration } = require("./layouts");
const { applyTitle } = require("./title");

const ENCODE_TIMEOUT_MS = 15 * 60 * 1000;
const FFMPEG_BIN = process.env.FFMPEG_BIN || "ffmpeg";
const FFPROBE_BIN = process.env.FFPROBE_BIN || "ffprobe";

class RenderError extends Error {
  constructor(publicMessage, detail) {
    super(detail || publicMessage);
    this.publicMessage = publicMessage;
  }
}

function runCapture(command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new RenderError("La lecture du fichier a pris trop de temps.", stderr));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > 2_000_000) stdout = stdout.slice(-2_000_000);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new RenderError("L’outil vidéo est indisponible.", err.message));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new RenderError("Ce fichier n’est pas une vidéo lisible.", stderr || `code ${code}`));
    });
  });
}

async function probeVideo(file) {
  const raw = await runCapture(FFPROBE_BIN, [
    "-v", "error",
    "-print_format", "json",
    "-show_format",
    "-show_streams",
    file,
  ], 20_000);

  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new RenderError("Ce fichier n’est pas une vidéo lisible.", err.message);
  }

  const streams = data.streams || [];
  const video = streams.find((stream) => {
    return stream.codec_type === "video" && !stream.disposition?.attached_pic;
  });
  if (!video) throw new RenderError("Ce fichier ne contient pas de vidéo.");

  const duration = Number(data.format?.duration || video.duration);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new RenderError("La durée de cette vidéo n’est pas lisible.");
  }
  if (duration < 0.4) throw new RenderError("Cette vidéo est trop courte.");

  const audio = streams.find((stream) => stream.codec_type === "audio");
  return {
    hasVideo: true,
    hasAudio: Boolean(audio),
    duration,
    width: video.width || 0,
    height: video.height || 0,
    videoCodec: String(video.codec_name || ""),
    audioCodec: String(audio?.codec_name || ""),
  };
}

function resolveAudioIndex(probes, audioIndex) {
  const count = probes.length;
  if (Number.isInteger(audioIndex) && audioIndex >= 0 && audioIndex < count) return audioIndex;
  const first = probes.findIndex((probe) => probe?.hasAudio);
  return first >= 0 ? first : 0;
}

function resolveAudioIndexes(probes, audio) {
  if (Array.isArray(audio)) {
    const count = probes.length;
    const seen = new Set();
    const indexes = [];
    for (const value of audio) {
      if (!Number.isInteger(value) || value < 0 || value >= count || seen.has(value)) continue;
      seen.add(value);
      indexes.push(value);
    }
    return indexes;
  }
  return [resolveAudioIndex(probes, audio)];
}

function parseAudioSelection(text, count) {
  if (text == null || String(text).trim() === "") return null;
  const raw = String(text).trim().toLowerCase();
  if (raw === "none") return [];
  if (raw === "all") return Array.from({ length: count }, (_, index) => index);
  const parts = raw.split(",").map((part) => part.trim()).filter(Boolean);
  if (!parts.length || parts.some((part) => !/^\d+$/.test(part))) {
    throw new RenderError("La piste son n’est pas lisible.");
  }
  const seen = new Set();
  const indexes = [];
  for (const part of parts) {
    const index = Number(part);
    if (index >= count) throw new RenderError("La piste son n’est pas lisible.");
    if (seen.has(index)) continue;
    seen.add(index);
    indexes.push(index);
  }
  return indexes;
}

function parseTiming(fields) {
  const spanRaw = fields?.span == null ? "" : String(fields.span).trim().toLowerCase();
  const finishRaw = fields?.finish == null ? "" : String(fields.finish).trim().toLowerCase();
  if (spanRaw && spanRaw !== "short" && spanRaw !== "long") {
    throw new RenderError("La durée choisie n’est pas lisible.");
  }
  if (finishRaw && finishRaw !== "loop" && finishRaw !== "black") {
    throw new RenderError("La fin des vidéos n’est pas lisible.");
  }
  return { span: spanRaw || "short", finish: finishRaw || "black" };
}

function buildGraph(layout, probes, duration, audioIndex, title, finish) {
  const seconds = duration.toFixed(3);
  const parts = [];
  const requested = resolveAudioIndexes(probes, audioIndex);
  const audible = requested.filter((index) => probes[index]?.hasAudio);
  const chosen = requested.length === 1
    ? requested[0]
    : (audible[0] ?? requested[0] ?? resolveAudioIndex(probes));

  parts.push(
    `color=c=${layout.ffmpegBackground}:s=${layout.width}x${layout.height}:r=${layout.fps}:d=${seconds},format=yuv420p[bg]`
  );

  layout.slots.forEach((slot, index) => {
    const frame = slot.frame || 0;
    const innerW = slot.w - 2 * frame;
    const innerH = slot.h - 2 * frame;
    const chain = [
      `[${index}:v]trim=duration=${seconds}`,
      "setpts=PTS-STARTPTS",
      `scale=${innerW}:${innerH}:force_original_aspect_ratio=increase:flags=bicubic`,
      `crop=${innerW}:${innerH}`,
      "setsar=1",
      `fps=${layout.fps}`,
      "format=yuv420p",
    ];
    if (frame > 0) {
      chain.push(`pad=${slot.w}:${slot.h}:(ow-iw)/2:(oh-ih)/2:color=white`);
    }
    const clipDuration = Number(probes[index]?.duration);
    if (finish !== "loop" && Number.isFinite(clipDuration) && clipDuration + 0.05 < duration) {
      const pad = (duration - clipDuration + 1 / layout.fps).toFixed(3);
      chain.push(`tpad=stop_mode=add:color=black:stop_duration=${pad}`);
    }
    parts.push(`${chain.join(",")}[v${index}]`);
  });

  let last = "bg";
  layout.slots.forEach((slot, index) => {
    const next = index === layout.slots.length - 1 ? "vout" : `t${index}`;
    parts.push(`[${last}][v${index}]overlay=${slot.x}:${slot.y}:format=auto[${next}]`);
    last = next;
  });

  if (audible.length === 1) {
    parts.push(
      `[${audible[0]}:a]atrim=duration=${seconds},asetpts=PTS-STARTPTS,aresample=async=1:osr=48000:ochl=stereo:osf=fltp,apad=whole_dur=${seconds}[aout]`
    );
  } else if (audible.length > 1) {
    const labels = audible.map((index) => {
      parts.push(
        `[${index}:a]atrim=duration=${seconds},asetpts=PTS-STARTPTS,aresample=async=1:osr=48000:ochl=stereo:osf=fltp,apad=whole_dur=${seconds}[m${index}]`
      );
      return `[m${index}]`;
    });
    const weights = audible.map(() => "1").join("\\ ");
    parts.push(
      `${labels.join("")}amix=inputs=${audible.length}:duration=longest:dropout_transition=0:normalize=1:weights=${weights}[aout]`
    );
  }

  const titled = applyTitle(parts.join(";"), "[vout]", title, layout.height);
  return {
    filter: titled.filter,
    vmap: titled.vmap,
    hasAudio: audible.length > 0,
    audioIndex: chosen,
    audioIndexes: audible,
  };
}

function parseProgress(line, duration) {
  if (line.startsWith("progress=") && line.endsWith("end")) return 100;
  let seconds = null;
  if (line.startsWith("out_time_us=") || line.startsWith("out_time_ms=")) {
    const value = Number(line.split("=")[1]);
    if (Number.isFinite(value)) seconds = value / 1e6;
  } else if (line.startsWith("out_time=")) {
    const match = line.match(/(\d+):(\d+):(\d+(?:\.\d+)?)/);
    if (match) seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
  }
  if (seconds == null || !duration) return null;
  return Math.max(0, Math.min(99, Math.round((100 * seconds) / duration)));
}

function runFfmpeg(args, duration, onProgress) {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG_BIN, args, { stdio: ["ignore", "pipe", "pipe"] });
    try { os.setPriority(child.pid, 12); } catch { /* best effort */ }

    let stderr = "";
    let stdout = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, ENCODE_TIMEOUT_MS);

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      let newline = stdout.indexOf("\n");
      while (newline >= 0) {
        const line = stdout.slice(0, newline).trim();
        stdout = stdout.slice(newline + 1);
        const progress = parseProgress(line, duration);
        if (progress != null && onProgress) onProgress(progress);
        newline = stdout.indexOf("\n");
      }
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new RenderError("L’outil vidéo est indisponible.", err.message));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new RenderError(
          "L’encodage a pris trop de temps. Essaie des vidéos plus courtes.",
          stderr
        ));
        return;
      }
      if (code === 0) resolve();
      else reject(new RenderError("L’encodage a échoué.", stderr || `code ${code}`));
    });
  });
}

async function renderToFile({ files, probes, output, audioIndex, onProgress, title, span, end }) {
  if (!files.length || files.length !== probes.length) {
    throw new RenderError("Ajoute entre 1 et 5 vidéos.");
  }
  const duration = Math.round(outputDuration(probes.map((probe) => probe.duration), span) * 1000) / 1000;
  if (!Number.isFinite(duration) || duration < 0.4) {
    throw new RenderError("Ces vidéos sont trop courtes.");
  }

  const finish = end === "loop" ? "loop" : "black";
  const layout = layoutFor(files.length);
  const graph = buildGraph(layout, probes, duration, audioIndex, title, finish);
  const args = ["-hide_banner", "-y"];
  files.forEach((file, index) => {
    const clipDuration = Number(probes[index]?.duration);
    if (finish === "loop" && Number.isFinite(clipDuration) && clipDuration + 0.05 < duration) {
      args.push("-stream_loop", "-1");
    }
    args.push("-i", file);
  });
  args.push("-filter_complex", graph.filter, "-map", graph.vmap);
  if (graph.hasAudio) {
    args.push("-map", "[aout]", "-c:a", "aac", "-b:a", "160k", "-ac", "2");
  }
  args.push(
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "20",
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    "-t", duration.toFixed(3),
    "-progress", "pipe:1",
    "-nostats",
    output
  );

  await runFfmpeg(args, duration, onProgress);
  if (!fs.existsSync(output) || fs.statSync(output).size < 1000) {
    throw new RenderError("L’encodage n’a rien produit.");
  }
  return { duration, layout };
}

module.exports = {
  RenderError,
  probeVideo,
  buildGraph,
  parseTiming,
  resolveAudioIndex,
  resolveAudioIndexes,
  parseAudioSelection,
  parseProgress,
  renderToFile,
  runFfmpeg,
};
