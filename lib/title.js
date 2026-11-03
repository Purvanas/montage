"use strict";

const fs = require("fs");

const MAX_CHARS = 80;
const SIZES = { s: 0.045, m: 0.072, l: 0.11 };
const PLACES = new Set(["tl", "tc", "tr", "ml", "mc", "mr", "bl", "bc", "br"]);
const FONT_CANDIDATES = [
  "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
  "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
];

class TitleError extends Error {
  constructor(message) {
    super(message);
    this.publicMessage = message;
  }
}

function parseTitle(fields) {
  if (!fields || fields.title == null) return null;
  const text = String(fields.title)
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;
  if (Array.from(text).length > MAX_CHARS) throw new TitleError("Le titre est trop long.");
  const size = fields.titleSize == null || String(fields.titleSize).trim() === ""
    ? "m"
    : String(fields.titleSize).trim();
  const place = fields.titlePlace == null || String(fields.titlePlace).trim() === ""
    ? "bc"
    : String(fields.titlePlace).trim();
  if (!SIZES[size] || !PLACES.has(place)) throw new TitleError("Le titre n’est pas lisible.");
  return { text, size, place };
}

function fontFile() {
  const found = FONT_CANDIDATES.find((file) => fs.existsSync(file));
  if (!found) throw new TitleError("La police du titre est introuvable.");
  return found;
}

function escapeFilter(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

function escapeText(value) {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "’");
}

function titleFilter(title, height) {
  if (!title) return "";
  const ratio = SIZES[title.size];
  if (!ratio || !PLACES.has(title.place)) throw new TitleError("Le titre n’est pas lisible.");
  const frame = Math.max(2, Math.round(Number(height) || 0));
  const fontsize = Math.max(18, Math.round(frame * ratio));
  const border = Math.max(2, Math.round(fontsize * 0.08));
  const margin = Math.max(8, Math.round(frame * 0.05));
  const vertical = title.place[0];
  const horizontal = title.place[1];
  const x = horizontal === "l"
    ? String(margin)
    : horizontal === "r"
      ? `w-text_w-${margin}`
      : "(w-text_w)/2";
  const y = vertical === "t"
    ? String(margin)
    : vertical === "b"
      ? `h-text_h-${margin}`
      : "(h-text_h)/2";
  return [
    "drawtext=",
    `fontfile=${escapeFilter(fontFile())}`,
    `:text='${escapeText(title.text)}'`,
    ":expansion=none",
    ":fontcolor=white",
    `:borderw=${border}`,
    ":bordercolor=black@0.85",
    `:fontsize=${fontsize}`,
    `:x=${x}`,
    `:y=${y}`,
  ].join("");
}

function applyTitle(filter, vmap, title, height) {
  const draw = titleFilter(title, height);
  if (!draw) return { filter, vmap };
  const label = String(vmap).replace(/^\[|\]$/g, "");
  return {
    filter: `${filter};[${label}]${draw}[vtitle]`,
    vmap: "[vtitle]",
  };
}

module.exports = {
  TitleError,
  MAX_CHARS,
  parseTitle,
  titleFilter,
  applyTitle,
};
