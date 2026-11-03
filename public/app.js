"use strict";

const SVGNS = "http://www.w3.org/2000/svg";

const stage = document.getElementById("stage");
const caption = document.getElementById("caption");
const drop = document.getElementById("drop");
const dropTitle = document.getElementById("drop-title");
const dropSub = document.getElementById("drop-sub");
const fileInput = document.getElementById("file");
const clipList = document.getElementById("clips");
const durationNote = document.getElementById("duration");
const renderBtn = document.getElementById("render");
const playBtn = document.getElementById("play");
const soundBtn = document.getElementById("sound");
const allAudioBtn = document.getElementById("all-audio");
const statusBox = document.getElementById("status");
const statusText = document.getElementById("status-text");
const bar = document.getElementById("bar");
const errorBox = document.getElementById("error");
const warnBox = document.getElementById("warn");
const downloadLink = document.getElementById("download");
const titleInput = document.getElementById("title");
const titleSizes = document.getElementById("title-sizes");
const titlePlaces = document.getElementById("title-places");
const spanChoice = document.getElementById("span-choice");
const endChoice = document.getElementById("end-choice");

const clips = [];
let catalog = null;
let soundOn = false;
const heardIds = new Set();
let audioChosen = false;
let busy = false;
let jobSignature = "";
let titleSize = "m";
let titlePlace = "bc";
let spanMode = "short";
let endMode = "black";
let previewOn = false;
let previewClock = 0;
let previewStarted = 0;
let warnTimer = 0;
let dragFrom = -1;

function uid() {
  return crypto.randomUUID();
}

function pct(value, total) {
  return `${(value / total) * 100}%`;
}

function fmtTime(seconds) {
  if (!Number.isFinite(seconds)) return "…";
  const rounded = Math.round(seconds);
  return `${Math.floor(rounded / 60)}:${String(rounded % 60).padStart(2, "0")}`;
}

function fmtBytes(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} Ko`;
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(mb >= 10 ? 0 : 1)} Mo`;
}

function heardClips() {
  if (audioChosen) return clips.filter((clip) => heardIds.has(clip.id));
  const first = clips.find((clip) => clip.hasAudio !== false);
  return first ? [first] : (clips[0] ? [clips[0]] : []);
}

function useCustomAudio() {
  if (audioChosen) return;
  for (const clip of heardClips()) heardIds.add(clip.id);
  audioChosen = true;
}

function hearAll() {
  audioChosen = true;
  heardIds.clear();
  const candidates = clips.filter((clip) => clip.hasAudio !== false);
  for (const clip of (candidates.length ? candidates : clips)) heardIds.add(clip.id);
}

function allTracksOn() {
  const target = clips.filter((clip) => clip.hasAudio !== false);
  const wanted = target.length ? target : clips;
  if (!wanted.length) return false;
  const heard = new Set(heardClips().map((clip) => clip.id));
  return wanted.every((clip) => heard.has(clip.id));
}

function titleText() {
  return titleInput.value.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
}

function signature() {
  const heard = heardClips().map((clip) => clip.id).join(",");
  const files = clips.map((clip) => `${clip.file.name}:${clip.file.size}:${clip.file.lastModified}`).join("|");
  return `${heard}|${files}|${titleText()}|${titleSize}|${titlePlace}|${spanMode}|${endMode}`;
}

function paintTitle() {
  let layer = stage.querySelector(".title-layer");
  if (!layer) {
    layer = document.createElement("div");
    layer.className = "title-layer is-full";
    const node = document.createElement("p");
    node.className = "film-title";
    layer.append(node);
  }
  const text = titleText();
  const node = layer.querySelector(".film-title");
  node.textContent = text;
  node.dataset.size = titleSize;
  node.dataset.place = titlePlace;
  layer.hidden = !text;
  stage.append(layer);
}

function clipHasAudio(video) {
  if (typeof video.mozHasAudio === "boolean") return video.mozHasAudio;
  if (video.audioTracks) return video.audioTracks.length > 0;
  const capture = video.captureStream || video.mozCaptureStream;
  if (!capture) return null;
  try {
    const stream = capture.call(video);
    const yes = stream.getAudioTracks().length > 0;
    for (const track of stream.getTracks()) track.stop();
    return yes;
  } catch {
    return null;
  }
}

function applyPreviewMute() {
  const heard = new Set(heardClips().map((clip) => clip.id));
  for (const clip of clips) {
    if (!clip.video) continue;
    clip.video.muted = !soundOn || !heard.has(clip.id);
  }
}

function isVideoFile(file) {
  if (file.type.startsWith("video/")) return true;
  return /\.(mp4|m4v|mov|webm|mkv|ogv|ogg|mpg|mpeg)$/i.test(file.name);
}

function showWarn(message) {
  warnBox.textContent = message;
  warnBox.hidden = false;
  clearTimeout(warnTimer);
  warnTimer = setTimeout(() => { warnBox.hidden = true; }, 5000);
}

function setStatus(text, ratio) {
  errorBox.hidden = true;
  statusBox.hidden = false;
  statusText.textContent = text;
  bar.style.width = `${Math.max(0, Math.min(100, ratio))}%`;
}

function showError(message) {
  errorBox.textContent = message;
  errorBox.hidden = false;
  statusBox.hidden = true;
}

function outputSeconds() {
  const known = clips.map((clip) => clip.duration).filter((value) => Number.isFinite(value));
  if (!known.length || known.length !== clips.length || !catalog) return null;
  const basis = spanMode === "long" ? Math.max(...known) : Math.min(...known);
  return Math.min(catalog.maxDuration, basis);
}

function svgEl(name, attrs, text) {
  const node = document.createElementNS(SVGNS, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  if (text != null) node.textContent = text;
  return node;
}

function sketchSVG(layout) {
  const width = layout.width;
  const height = layout.height;
  const center = layout.slots[4];
  const svg = svgEl("svg", {
    viewBox: `0 0 ${width} ${height}`,
    role: "img",
    "aria-label": "Cinq cases : quatre en grille, une au centre",
  });
  const stroke = "#e23d32";
  svg.append(
    svgEl("rect", {
      x: 8, y: 8, width: width - 16, height: height - 16,
      fill: "none", stroke, "stroke-width": 8,
    }),
    svgEl("line", { x1: width / 2, y1: 8, x2: width / 2, y2: height - 8, stroke, "stroke-width": 8 }),
    svgEl("line", { x1: 8, y1: height / 2, x2: width - 8, y2: height / 2, stroke, "stroke-width": 8 }),
    svgEl("rect", {
      x: center.x, y: center.y, width: center.w, height: center.h,
      fill: layout.background, stroke, "stroke-width": 8,
    })
  );
  const labels = [
    [width * 0.22, height * 0.30, "1"],
    [width * 0.78, height * 0.30, "2"],
    [width * 0.22, height * 0.76, "3"],
    [width * 0.78, height * 0.76, "4"],
    [width / 2, height / 2, "5"],
  ];
  for (const [x, y, label] of labels) {
    svg.append(svgEl("text", {
      x, y,
      fill: stroke,
      "font-family": "Caveat, cursive",
      "font-size": "150",
      "text-anchor": "middle",
      "dominant-baseline": "central",
    }, label));
  }
  return svg;
}

function ensureVideo(clip) {
  if (clip.video) {
    applyPreviewMute();
    return clip.video;
  }
  const video = document.createElement("video");
  video.src = clip.url;
  video.muted = true;
  video.playsInline = true;
  video.loop = true;
  video.autoplay = true;
  video.preload = "auto";
  video.addEventListener("loadedmetadata", () => {
    if (Number.isFinite(video.duration)) clip.duration = video.duration;
    const detected = clipHasAudio(video);
    if (detected != null) clip.hasAudio = detected;
    paintList();
    paintCopy();
    applyPreviewMute();
  });
  clip.video = video;
  applyPreviewMute();
  return video;
}

function paintStage() {
  const count = clips.length;
  stage.replaceChildren();
  stage.classList.toggle("is-sketch", count === 0);
  if (!catalog) {
    paintTitle();
    return;
  }
  if (count === 0) {
    stage.append(sketchSVG(catalog.layouts[5]));
    paintTitle();
    return;
  }
  const layout = catalog.layouts[count];
  stage.style.background = layout.background;
  for (const slot of layout.slots) {
    const el = document.createElement("div");
    el.className = slot.center ? "slot center" : "slot";
    el.style.left = pct(slot.x, layout.width);
    el.style.top = pct(slot.y, layout.height);
    el.style.width = pct(slot.w, layout.width);
    el.style.height = pct(slot.h, layout.height);
    const video = ensureVideo(clips[slot.index]);
    const insetX = (slot.frame / slot.w) * 100;
    const insetY = (slot.frame / slot.h) * 100;
    video.style.left = `${insetX}%`;
    video.style.top = `${insetY}%`;
    video.style.width = `${100 - 2 * insetX}%`;
    video.style.height = `${100 - 2 * insetY}%`;
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = String(slot.index + 1);
    const cover = document.createElement("div");
    cover.className = "slot-black";
    cover.hidden = true;
    el.append(video, cover, badge);
    stage.append(el);
  }
  paintTitle();
}

function paintList() {
  clipList.replaceChildren();
  if (!catalog || !clips.length) return;
  const layout = catalog.layouts[clips.length];
  clips.forEach((clip, index) => {
    const item = document.createElement("li");
    item.className = "clip";
    item.draggable = true;
    if (layout.slots[index].center) item.classList.add("is-center");

    const pos = document.createElement("span");
    pos.className = "pos";
    pos.textContent = String(index + 1);

    const text = document.createElement("div");
    const name = document.createElement("p");
    name.className = "name";
    name.textContent = clip.file.name;
    const meta = document.createElement("p");
    meta.className = "meta";
    meta.textContent = `${layout.slots[index].name} · ${fmtTime(clip.duration)} · ${fmtBytes(clip.file.size)}`;
    text.append(name, meta);

    const heard = heardClips().some((item) => item.id === clip.id);
    const actions = document.createElement("div");
    actions.className = "actions";
    actions.append(
      iconButton(
        heard ? "Retirer cette piste" : "Ajouter cette piste",
        speakerIcon(),
        false,
        () => {
          useCustomAudio();
          if (heardIds.has(clip.id)) heardIds.delete(clip.id);
          else heardIds.add(clip.id);
          paint();
        },
        { pressed: heard }
      ),
      iconButton("Monter", "↑", index === 0, () => moveClip(index, index - 1)),
      iconButton("Descendre", "↓", index === clips.length - 1, () => moveClip(index, index + 1)),
      iconButton("Retirer", "×", false, () => removeClip(clip.id))
    );
    item.append(pos, text, actions);

    item.addEventListener("dragstart", (event) => {
      dragFrom = index;
      item.classList.add("dragging");
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", String(index));
    });
    item.addEventListener("dragend", () => {
      item.classList.remove("dragging");
      dragFrom = -1;
    });
    item.addEventListener("dragover", (event) => {
      if ([...event.dataTransfer.types].includes("Files")) return;
      event.preventDefault();
      item.classList.add("drop-target");
    });
    item.addEventListener("dragleave", () => item.classList.remove("drop-target"));
    item.addEventListener("drop", (event) => {
      if ([...event.dataTransfer.types].includes("Files")) return;
      event.preventDefault();
      event.stopPropagation();
      item.classList.remove("drop-target");
      const from = Number.isInteger(dragFrom) && dragFrom >= 0
        ? dragFrom
        : Number(event.dataTransfer.getData("text/plain"));
      moveClip(from, index);
    });
    clipList.append(item);
  });
}

function speakerIcon() {
  const svg = document.createElementNS(SVGNS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(SVGNS, "path");
  path.setAttribute("fill", "currentColor");
  path.setAttribute("d", "M4 9h3.2L12 5.2v13.6L7.2 15H4V9zm11.2 3a3.2 3.2 0 0 0-1.4-2.64v5.28A3.2 3.2 0 0 0 15.2 12z");
  svg.append(path);
  return svg;
}

function iconButton(label, glyph, disabled, onClick, options = {}) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "iconbtn";
  button.setAttribute("aria-label", label);
  if (options.pressed != null) {
    button.classList.toggle("is-on", options.pressed);
    button.setAttribute("aria-pressed", options.pressed ? "true" : "false");
  }
  button.replaceChildren(glyph);
  button.disabled = disabled;
  button.addEventListener("click", onClick);
  return button;
}

function paintCopy() {
  const count = clips.length;
  drop.classList.toggle("compact", count > 0);
  drop.classList.toggle("full", count >= 5);
  fileInput.disabled = count >= 5;
  if (count >= 5) {
    dropTitle.textContent = "Cinq vidéos, c’est le maximum";
    dropSub.textContent = "Retire-en une pour la remplacer";
  } else if (count > 0) {
    dropTitle.textContent = "Ajouter une vidéo";
    dropSub.textContent = `${5 - count} place${count === 4 ? "" : "s"} restante${count === 4 ? "" : "s"}`;
  } else {
    dropTitle.textContent = "Dépose les vidéos ici";
    dropSub.textContent = "ou clique pour les choisir";
  }

  if (!catalog || count === 0) {
    caption.textContent = "À cinq, la dernière se pose au centre.";
  } else {
    caption.textContent = catalog.layouts[count].caption;
  }

  const seconds = outputSeconds();
  const heard = heardClips();
  let audioNote = "";
  if (count && !heard.length) audioNote = "Aucune piste son.";
  else if (heard.length === 1 && heard[0].hasAudio === false) {
    audioNote = `« ${heard[0].file.name} » n’a pas de son.`;
  } else if (heard.length === 1) audioNote = `On entend « ${heard[0].file.name} ».`;
  else if (heard.length > 1 && allTracksOn()) audioNote = "On entend toutes les pistes.";
  else if (heard.length > 1) audioNote = `On entend ${heard.length} pistes.`;
  if (!count) {
    durationNote.textContent = "";
  } else if (seconds == null) {
    durationNote.textContent = audioNote || "Lecture des durées…";
  } else {
    const known = clips.map((clip) => clip.duration);
    const basis = spanMode === "long" ? Math.max(...known) : Math.min(...known);
    const capped = basis > catalog.maxDuration + 0.05;
    const which = spanMode === "long" ? "longue" : "courte";
    let line = capped
      ? `Le film dure ${fmtTime(catalog.maxDuration)}. Au-delà, les vidéos sont coupées.`
      : `Le film dure ${fmtTime(seconds)}, le temps de la plus ${which}.`;
    const early = spanMode === "long" && known.some((value) => value + 0.05 < seconds);
    if (early) line += endMode === "loop" ? " Les plus courtes bouclent." : " Les plus courtes passent au noir.";
    durationNote.textContent = `${line} ${audioNote}`.trim();
  }
  const endLocked = spanMode !== "long";
  endChoice.classList.toggle("is-locked", endLocked);
  for (const button of endChoice.querySelectorAll("button")) button.disabled = endLocked;

  renderBtn.disabled = count === 0 || busy;
  renderBtn.textContent = busy ? "Rendu en cours…" : "Rendre la vidéo";
  playBtn.disabled = count === 0;
  soundBtn.disabled = count === 0;
  allAudioBtn.disabled = count === 0;
  allAudioBtn.classList.toggle("is-on", allTracksOn());
  allAudioBtn.setAttribute("aria-pressed", allTracksOn() ? "true" : "false");

  if (jobSignature && jobSignature !== signature()) downloadLink.hidden = true;
  if (!count && !busy) {
    statusBox.hidden = true;
    errorBox.hidden = true;
    downloadLink.hidden = true;
  }
}

function paint() {
  paintStage();
  paintList();
  paintCopy();
}

function moveClip(from, to) {
  if (!Number.isInteger(from) || from === to) return;
  if (from < 0 || to < 0 || from >= clips.length || to >= clips.length) return;
  const [clip] = clips.splice(from, 1);
  clips.splice(to, 0, clip);
  paint();
}

function removeClip(id) {
  const index = clips.findIndex((clip) => clip.id === id);
  if (index < 0) return;
  const [clip] = clips.splice(index, 1);
  clip.video?.pause();
  if (clip.video) clip.video.removeAttribute("src");
  URL.revokeObjectURL(clip.url);
  heardIds.delete(clip.id);
  paint();
}

function addFiles(fileList) {
  const incoming = [...fileList];
  const videos = incoming.filter(isVideoFile);
  const rejected = incoming.length - videos.length;
  if (rejected) {
    showWarn(rejected === 1
      ? "Un fichier ignoré : ce n’est pas une vidéo."
      : `${rejected} fichiers ignorés : ce ne sont pas des vidéos.`);
  }
  const room = 5 - clips.length;
  const taken = videos.slice(0, Math.max(0, room));
  const skipped = videos.length - taken.length;
  if (skipped) {
    showWarn(skipped === 1
      ? "Une vidéo ignorée : cinq maximum."
      : `${skipped} vidéos ignorées : cinq maximum.`);
  }
  for (const file of taken) {
    clips.push({
      id: uid(),
      file,
      url: URL.createObjectURL(file),
      duration: NaN,
      video: null,
    });
  }
  if (taken.length) paint();
  fileInput.value = "";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function queueText(ahead) {
  if (!ahead) return "Ça commence…";
  if (ahead === 1) return "En file. Un montage passe avant le tien.";
  return `En file. ${ahead} montages passent avant le tien.`;
}

function upload(onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/jobs");
    let preparationTimer = 0;
    const stopPreparationTimer = () => {
      clearTimeout(preparationTimer);
      preparationTimer = 0;
    };
    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) return;
      onProgress(event.loaded / event.total);
    };
    xhr.upload.onload = () => {
      onProgress(1);
      // The body has left the browser. Probing five files can take a while;
      // past this, the request is stuck and will not start encoding.
      preparationTimer = setTimeout(() => xhr.abort(), 120000);
    };
    xhr.onload = () => {
      stopPreparationTimer();
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch { /* réponse vide */ }
      if (xhr.status >= 200 && xhr.status < 300 && /^[0-9a-f-]{36}$/i.test(data.id || "")) resolve(data);
      else reject(new Error(data.error || "L’envoi a échoué."));
    };
    xhr.onerror = () => {
      stopPreparationTimer();
      reject(new Error("Connexion interrompue pendant l’envoi."));
    };
    xhr.onabort = () => {
      stopPreparationTimer();
      reject(new Error("Le serveur n’a pas démarré le montage. Relance-le."));
    };
    const body = new FormData();
    const indexes = heardClips().map((clip) => clips.indexOf(clip)).filter((index) => index >= 0);
    body.append("audio", indexes.length ? indexes.join(",") : "none");
    body.append("title", titleText());
    body.append("titleSize", titleSize);
    body.append("titlePlace", titlePlace);
    body.append("span", spanMode);
    body.append("finish", endMode);
    for (const clip of clips) body.append("videos", clip.file, clip.file.name);
    xhr.send(body);
  });
}

async function poll(id) {
  const started = Date.now();
  for (;;) {
    await sleep(1000);
    if (Date.now() - started > 20 * 60 * 1000) {
      throw new Error("L’encodage ne répond plus.");
    }
    const response = await fetch(`/api/jobs/${id}`);
    const job = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(job.error || "Le montage est introuvable.");
    if (job.status === "error") throw new Error(job.error || "L’encodage a échoué.");
    if (job.status === "done") {
      setStatus("Prêt.", 100);
      downloadLink.href = `/api/jobs/${id}/file`;
      if (job.filename) downloadLink.download = job.filename;
      downloadLink.hidden = false;
      jobSignature = signature();
      return;
    }
    if (job.status === "queued") setStatus(queueText(job.ahead), 0);
    else setStatus(`Encodage… ${job.progress || 0}\u00a0%`, job.progress || 0);
  }
}

async function renderFilm() {
  if (busy || !clips.length) return;
  busy = true;
  downloadLink.hidden = true;
  paintCopy();
  try {
    setStatus("Envoi… 0\u00a0%", 0);
    const created = await upload((ratio) => {
      if (ratio >= 1) setStatus("Préparation…", 100);
      else setStatus(`Envoi… ${Math.round(ratio * 100)}\u00a0%`, ratio * 100);
    });
    setStatus("Ça commence…", 0);
    await poll(created.id);
  } catch (err) {
    showError(err.message || "L’encodage a échoué.");
  } finally {
    busy = false;
    paintCopy();
  }
}

function ensembleVisible() {
  const view = document.getElementById("view-ensemble");
  return !view || !view.hidden;
}

fileInput.addEventListener("change", () => addFiles(fileInput.files));

document.addEventListener("dragover", (event) => {
  if (![...event.dataTransfer.types].includes("Files")) return;
  event.preventDefault();
  if (ensembleVisible()) drop.classList.add("over");
});

document.addEventListener("dragleave", (event) => {
  if (event.target === document.documentElement) drop.classList.remove("over");
});

document.addEventListener("drop", (event) => {
  if (![...event.dataTransfer.types].includes("Files")) return;
  event.preventDefault();
  drop.classList.remove("over");
  if (ensembleVisible()) addFiles(event.dataTransfer.files);
});

function filmTime() {
  if (!previewOn) return previewClock;
  return previewClock + (performance.now() - previewStarted) / 1000;
}

function syncPreview() {
  const videos = [...stage.querySelectorAll("video")];
  const limit = outputSeconds();
  if (!videos.length || limit == null) return;
  let now = filmTime();
  if (previewOn && now >= limit - 0.03) {
    previewClock = limit;
    previewOn = false;
    playBtn.textContent = "Lecture";
    now = limit;
  }
  for (const video of videos) {
    const cover = video.closest(".slot")?.querySelector(".slot-black");
    const clipDuration = Number(video.duration);
    const early = spanMode === "long"
      && Number.isFinite(clipDuration)
      && clipDuration > 0.05
      && clipDuration + 0.05 < limit
      && now >= clipDuration - 0.04;
    const black = early && endMode === "black";
    if (cover) cover.hidden = !black;
    video.loop = early && endMode === "loop";
    if (black || !previewOn) {
      if (!video.paused) video.pause();
      continue;
    }
    if (video.paused) video.play().catch(() => {});
    const target = early && endMode === "loop"
      ? now % clipDuration
      : Math.min(now, Math.max(0, clipDuration - 0.01));
    if (Math.abs(video.currentTime - target) > 0.3) video.currentTime = target;
  }
}

playBtn.addEventListener("click", () => {
  const videos = [...stage.querySelectorAll("video")];
  if (!videos.length) return;
  if (previewOn) {
    previewClock = filmTime();
    previewOn = false;
    for (const video of videos) video.pause();
    playBtn.textContent = "Lecture";
    return;
  }
  const limit = outputSeconds();
  if (limit != null && previewClock >= limit - 0.05) {
    previewClock = 0;
    for (const video of videos) {
      video.currentTime = 0;
      const cover = video.closest(".slot")?.querySelector(".slot-black");
      if (cover) cover.hidden = true;
    }
  }
  previewOn = true;
  previewStarted = performance.now();
  playBtn.textContent = "Pause";
  syncPreview();
});

stage.addEventListener("pause", () => {
  if (previewOn) return;
  const videos = [...stage.querySelectorAll("video")];
  if (videos.length && videos.every((video) => video.paused)) playBtn.textContent = "Lecture";
}, true);

soundBtn.addEventListener("click", () => {
  soundOn = !soundOn;
  applyPreviewMute();
  soundBtn.setAttribute("aria-pressed", String(soundOn));
  soundBtn.textContent = soundOn ? "Couper le son" : "Écouter";
});

allAudioBtn.addEventListener("click", () => {
  hearAll();
  paint();
});

renderBtn.addEventListener("click", () => { renderFilm(); });

function chooseTitle(root, attribute, apply) {
  root.addEventListener("click", (event) => {
    const button = event.target.closest(`button[${attribute}]`);
    if (!button || !root.contains(button)) return;
    apply(button.getAttribute(attribute));
    for (const item of root.querySelectorAll(`button[${attribute}]`)) {
      const on = item === button;
      item.classList.toggle("is-on", on);
      item.setAttribute("aria-pressed", on ? "true" : "false");
    }
    paintTitle();
    paintCopy();
  });
}

titleInput.addEventListener("input", () => {
  paintTitle();
  paintCopy();
});
chooseTitle(titleSizes, "data-size", (value) => { titleSize = value; });
chooseTitle(titlePlaces, "data-place", (value) => { titlePlace = value; });

function chooseTiming(root, attribute, apply) {
  root.addEventListener("click", (event) => {
    const button = event.target.closest(`button[${attribute}]`);
    if (!button || button.disabled || !root.contains(button)) return;
    apply(button.getAttribute(attribute));
    for (const item of root.querySelectorAll(`button[${attribute}]`)) {
      const on = item === button;
      item.classList.toggle("is-on", on);
      item.setAttribute("aria-pressed", on ? "true" : "false");
    }
    paintCopy();
    syncPreview();
  });
}

chooseTiming(spanChoice, "data-span", (value) => { spanMode = value; });
chooseTiming(endChoice, "data-finish", (value) => { endMode = value; });

setInterval(syncPreview, 200);

fetch("/api/layouts")
  .then((response) => {
    if (!response.ok) throw new Error("plan");
    return response.json();
  })
  .then((data) => {
    catalog = data;
    paint();
  })
  .catch(() => {
    caption.textContent = "Le plan des cases n’a pas pu être chargé.";
  });
