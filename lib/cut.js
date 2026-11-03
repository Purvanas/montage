"use strict";

const fs = require("fs");
const { RenderError, runFfmpeg } = require("./render");
const { applyTitle } = require("./title");

const MIN_RANGE = 0.05;
const MAX_KEPT = 600;
const MERGE_GAP = 0.02;
const MAX_RANGES = 80;

const COPY_VIDEO = new Set(["h264", "hevc", "av1", "mpeg4"]);
const COPY_AUDIO = new Set(["aac", "mp3"]);

class CutError extends RenderError {}

function evenSize(width, height) {
  let w = Math.max(2, Math.round(Number(width) || 0));
  let h = Math.max(2, Math.round(Number(height) || 0));
  if (w % 2) w -= 1;
  if (h % 2) h -= 1;
  return { width: Math.max(2, w), height: Math.max(2, h) };
}

function parseRangesField(text) {
  if (text == null || String(text).trim() === "") return null;
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new CutError("Les coupes ne sont pas lisibles.");
  }
  if (!Array.isArray(data)) throw new CutError("Les coupes ne sont pas lisibles.");
  return data;
}

function parseVolume(text) {
  if (text == null || String(text).trim() === "") return 1;
  const value = Number(text);
  if (!Number.isFinite(value)) throw new CutError("Le volume n’est pas lisible.");
  return Math.max(0, Math.min(1, value));
}

function normalizeRanges(ranges, duration) {
  const total = Number(duration);
  if (!Number.isFinite(total) || total < 0.4) {
    throw new CutError("Cette vidéo est trop courte.");
  }
  if (!Array.isArray(ranges)) throw new CutError("Les coupes ne sont pas lisibles.");

  const cleaned = [];
  for (const range of ranges) {
    if (!Array.isArray(range) || range.length < 2) continue;
    const rawStart = Number(range[0]);
    const rawEnd = Number(range[1]);
    if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd)) continue;
    const start = Math.max(0, Math.min(total, rawStart));
    const end = Math.max(0, Math.min(total, rawEnd));
    if (end - start < MIN_RANGE) continue;
    cleaned.push([start, end]);
  }
  cleaned.sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  const merged = [];
  for (const [start, end] of cleaned) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1] + MERGE_GAP) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  if (!merged.length) throw new CutError("Garde au moins un morceau.");
  if (merged.length > MAX_RANGES) throw new CutError("Trop de coupes d’un coup.");

  const kept = merged.reduce((sum, [start, end]) => sum + (end - start), 0);
  if (kept > MAX_KEPT + 0.05) throw new CutError("Garde au plus dix minutes.");

  return merged.map(([start, end]) => [
    Math.round(start * 1000) / 1000,
    Math.round(end * 1000) / 1000,
  ]);
}

function scaleChain(width, height) {
  const w = Number(width);
  const h = Number(height);
  if (!w || !h) return "scale=trunc(iw/2)*2:trunc(ih/2)*2:flags=bicubic,setsar=1,format=yuv420p";
  const size = evenSize(w, h);
  return `scale=${size.width}:${size.height}:flags=bicubic,setsar=1,format=yuv420p`;
}

function buildCutGraph({ ranges, width, height, hasAudio, volume }) {
  if (!Array.isArray(ranges) || !ranges.length) {
    throw new CutError("Garde au moins un morceau.");
  }
  const gain = Math.max(0, Math.min(1, Number(volume) || 0));
  const wantAudio = Boolean(hasAudio) && gain > 0.001;
  const picture = scaleChain(width, height);
  const parts = [];
  ranges.forEach(([start, end], index) => {
    const span = Math.max(0, end - start);
    parts.push(
      `[0:v]trim=start=${start.toFixed(3)}:end=${end.toFixed(3)},setpts=PTS-STARTPTS,${picture}[v${index}]`
    );
    if (wantAudio) {
      parts.push(
        `[0:a]atrim=start=${start.toFixed(3)}:end=${end.toFixed(3)},asetpts=PTS-STARTPTS,aresample=async=1:osr=48000:ochl=stereo:osf=fltp,volume=${gain.toFixed(3)},apad=whole_dur=${span.toFixed(3)}[a${index}]`
      );
    }
  });

  let vmap = "[v0]";
  let amap = wantAudio ? "[a0]" : null;
  if (ranges.length > 1) {
    const videos = ranges.map((_, index) => `[v${index}]`).join("");
    parts.push(`${videos}concat=n=${ranges.length}:v=1:a=0[vout]`);
    vmap = "[vout]";
    if (wantAudio) {
      const audios = ranges.map((_, index) => `[a${index}]`).join("");
      parts.push(`${audios}concat=n=${ranges.length}:v=0:a=1[aout]`);
      amap = "[aout]";
    }
  }

  const kept = ranges.reduce((sum, [start, end]) => sum + (end - start), 0);
  return {
    filter: parts.join(";"),
    vmap,
    amap,
    hasAudio: wantAudio,
    duration: Math.round(kept * 1000) / 1000,
    volume: gain,
  };
}

function nearlyFull(ranges, duration) {
  if (ranges.length !== 1) return false;
  const [start, end] = ranges[0];
  return start <= 0.02 && Math.abs(end - duration) <= 0.05;
}

function videoCopyable(probe) {
  return COPY_VIDEO.has(probe.videoCodec);
}

async function renderCut({ file, probe, ranges, volume, output, onProgress, title }) {
  const total = Number(probe.duration);
  const kept = normalizeRanges(ranges, total);
  const gain = Math.max(0, Math.min(1, Number(volume)));
  const hasAudio = Boolean(probe.hasAudio);
  const full = nearlyFull(kept, total);
  const copyVideo = videoCopyable(probe);
  let args;
  let encodeDuration = Math.round(kept.reduce((sum, [start, end]) => sum + (end - start), 0) * 1000) / 1000;

  // Whole file, no trim, no title: copy the picture. Re-encode when the cuts,
  // the gain, a title, or a codec the MP4 cannot carry require it.
  if (!title && full && copyVideo && (!hasAudio || gain <= 0.001)) {
    args = [
      "-hide_banner", "-y", "-i", file,
      "-map", "0:v:0", "-c:v", "copy", "-an",
    ];
    encodeDuration = total;
  } else if (!title && full && copyVideo && gain >= 0.999 && COPY_AUDIO.has(probe.audioCodec)) {
    args = [
      "-hide_banner", "-y", "-i", file,
      "-map", "0:v:0", "-c:v", "copy",
      "-map", "0:a:0", "-c:a", "copy",
    ];
    encodeDuration = total;
  } else if (!title && full && copyVideo && hasAudio) {
    args = [
      "-hide_banner", "-y", "-i", file,
      "-map", "0:v:0", "-c:v", "copy",
      "-map", "0:a:0",
      "-af", `volume=${gain.toFixed(3)}`,
      "-c:a", "aac", "-b:a", "160k", "-ac", "2",
    ];
    encodeDuration = total;
  } else {
    const graph = buildCutGraph({
      ranges: kept,
      width: probe.width,
      height: probe.height,
      hasAudio,
      volume: gain,
    });
    const size = evenSize(probe.width, probe.height);
    const titled = applyTitle(graph.filter, graph.vmap, title, size.height);
    encodeDuration = graph.duration;
    args = [
      "-hide_banner", "-y", "-i", file,
      "-filter_complex", titled.filter,
      "-map", titled.vmap,
    ];
    if (graph.hasAudio) args.push("-map", graph.amap, "-c:a", "aac", "-b:a", "160k", "-ac", "2");
    else args.push("-an");
    args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p");
  }

  args.push("-movflags", "+faststart", "-progress", "pipe:1", "-nostats", output);
  await runFfmpeg(args, encodeDuration, onProgress);
  if (!fs.existsSync(output) || fs.statSync(output).size < 200) {
    throw new CutError("L’encodage n’a rien produit.");
  }
  return { duration: encodeDuration, ranges: kept, volume: gain };
}

module.exports = {
  CutError,
  MIN_RANGE,
  MAX_KEPT,
  parseRangesField,
  parseVolume,
  normalizeRanges,
  buildCutGraph,
  renderCut,
};
