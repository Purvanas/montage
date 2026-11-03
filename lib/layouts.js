"use strict";

// Canvas 1920×1080. The center panel of a 5-clip montage follows the
// hand sketch: outer box 1274×650, center box 513×208, centered.
// That is 40.27% of the width and 32.00% of the height. Snapped to
// even pixels so the encoder can use yuv420: 772×348.

const CANVAS_W = 1920;
const CANVAS_H = 1080;
const GAP = 8;
const CENTER_W = 772;
const CENTER_H = 348;
const CENTER_FRAME = 8;

const MAX_CLIPS = 5;
const MAX_DURATION = 180;
const MAX_FILE_BYTES = 500 * 1024 * 1024;

const NAMES = {
  1: ["Plein cadre"],
  2: ["Gauche", "Droite"],
  3: ["Gauche", "Haut droite", "Bas droite"],
  4: ["Haut gauche", "Haut droite", "Bas gauche", "Bas droite"],
  5: ["Haut gauche", "Haut droite", "Bas gauche", "Bas droite", "Centre"],
};

const CAPTIONS = {
  1: "Plein cadre.",
  2: "Côte à côte.",
  3: "Une grande à gauche, deux empilées à droite.",
  4: "Quatre cases, sans superposition.",
  5: "Quatre cases, et la cinquième au centre.",
};

function slot(count, index, x, y, w, h, extra = {}) {
  return {
    index,
    name: NAMES[count][index],
    x,
    y,
    w,
    h,
    frame: extra.frame || 0,
    center: Boolean(extra.center),
  };
}

function layoutFor(count) {
  if (!Number.isInteger(count) || count < 1 || count > MAX_CLIPS) {
    throw new Error("Entre 1 et 5 vidéos.");
  }

  const base = {
    width: CANVAS_W,
    height: CANVAS_H,
    fps: 30,
    gap: count === 1 ? 0 : GAP,
    background: "#f7f7f5",
    ffmpegBackground: "0xF7F7F5",
    caption: CAPTIONS[count],
  };

  let slots;
  if (count === 1) {
    slots = [slot(count, 0, 0, 0, CANVAS_W, CANVAS_H)];
  } else if (count === 2) {
    const w = (CANVAS_W - GAP) / 2;
    slots = [
      slot(count, 0, 0, 0, w, CANVAS_H),
      slot(count, 1, w + GAP, 0, w, CANVAS_H),
    ];
  } else if (count === 3) {
    const rightW = 640;
    const leftW = CANVAS_W - GAP - rightW;
    const rightH = (CANVAS_H - GAP) / 2;
    slots = [
      slot(count, 0, 0, 0, leftW, CANVAS_H),
      slot(count, 1, leftW + GAP, 0, rightW, rightH),
      slot(count, 2, leftW + GAP, rightH + GAP, rightW, rightH),
    ];
  } else {
    const w = (CANVAS_W - GAP) / 2;
    const h = (CANVAS_H - GAP) / 2;
    slots = [
      slot(count, 0, 0, 0, w, h),
      slot(count, 1, w + GAP, 0, w, h),
      slot(count, 2, 0, h + GAP, w, h),
      slot(count, 3, w + GAP, h + GAP, w, h),
    ];
    if (count === 5) {
      slots.push(slot(count, 4,
        (CANVAS_W - CENTER_W) / 2,
        (CANVAS_H - CENTER_H) / 2,
        CENTER_W,
        CENTER_H,
        { frame: CENTER_FRAME, center: true }));
    }
  }

  const layout = { ...base, slots };
  assertGeometry(layout);
  return layout;
}

function assertGeometry(layout) {
  for (const s of layout.slots) {
    for (const [key, value] of Object.entries({
      x: s.x, y: s.y, w: s.w, h: s.h, frame: s.frame,
    })) {
      if (!Number.isInteger(value) || value < 0 || value % 2 !== 0) {
        throw new Error(`géométrie impaire: ${key}=${value}`);
      }
    }
    if (s.x + s.w > layout.width || s.y + s.h > layout.height) {
      throw new Error("une case dépasse du cadre");
    }
    if (s.w - 2 * s.frame < 16 || s.h - 2 * s.frame < 16) {
      throw new Error("une case est trop petite");
    }
  }
}

function outputDuration(durations, span) {
  const longest = span === "long";
  let picked = longest ? 0 : Infinity;
  let seen = false;
  for (const value of durations) {
    if (!Number.isFinite(value) || value <= 0) continue;
    seen = true;
    picked = longest ? Math.max(picked, value) : Math.min(picked, value);
  }
  if (!seen) return NaN;
  return Math.min(MAX_DURATION, picked);
}

function catalog() {
  const layouts = {};
  for (let n = 1; n <= MAX_CLIPS; n += 1) layouts[String(n)] = layoutFor(n);
  return {
    maxClips: MAX_CLIPS,
    maxDuration: MAX_DURATION,
    maxFileBytes: MAX_FILE_BYTES,
    layouts,
  };
}

module.exports = {
  layoutFor,
  catalog,
  outputDuration,
  MAX_CLIPS,
  MAX_DURATION,
  MAX_FILE_BYTES,
};
