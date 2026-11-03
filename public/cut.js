"use strict";

(() => {
const viewCut = document.getElementById("view-cut");
const viewEnsemble = document.getElementById("view-ensemble");
const tabCut = document.getElementById("tab-couper");
const tabEnsemble = document.getElementById("tab-ensemble");
const pageTitle = document.getElementById("page-title");
const pageLede = document.getElementById("page-lede");
const stage = document.getElementById("cut-stage");
const video = document.getElementById("cut-video");
const empty = document.getElementById("cut-empty");
const playBtn = document.getElementById("cut-play");
const splitBtn = document.getElementById("cut-split");
const caption = document.getElementById("cut-caption");
const timeline = document.getElementById("cut-timeline");
const drop = document.getElementById("cut-drop");
const dropTitle = document.getElementById("cut-drop-title");
const dropSub = document.getElementById("cut-drop-sub");
const fileInput = document.getElementById("cut-file");
const warnBox = document.getElementById("cut-warn");
const slider = document.getElementById("cut-volume");
const volumeValue = document.getElementById("cut-volume-value");
const muteBtn = document.getElementById("cut-mute");
const summary = document.getElementById("cut-summary");
const renderBtn = document.getElementById("cut-render");
const statusBox = document.getElementById("cut-status");
const statusText = document.getElementById("cut-status-text");
const bar = document.getElementById("cut-bar");
const errorBox = document.getElementById("cut-error");
const download = document.getElementById("cut-download");
const titleInput = document.getElementById("cut-title");
const titleSizes = document.getElementById("cut-title-sizes");
const titlePlaces = document.getElementById("cut-title-places");
const titleLayer = document.createElement("div");
const titleNode = document.createElement("p");
titleLayer.className = "title-layer";
titleNode.className = "film-title";
titleLayer.hidden = true;
titleLayer.append(titleNode);
stage.append(titleLayer);

const MAX_BYTES = 500 * 1024 * 1024;
const MAX_KEPT = 600;

let file = null;
let objectUrl = "";
let duration = 0;
let segments = [];
let level = 100;
let titleSize = "m";
let titlePlace = "bc";
let savedLevel = 100;
let hasAudio = null;
let busy = false;
let jobSignature = "";
let warnTimer = 0;
let drag = null;
let pendingIndex = -1;
let ignoreClick = false;

function cutVisible() {
  return viewCut && !viewCut.hidden;
}

function fmt(seconds) {
  const rounded = Math.max(0, Math.round(Number(seconds) || 0));
  return `${Math.floor(rounded / 60)}:${String(rounded % 60).padStart(2, "0")}`;
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
}

function isVideoFile(next) {
  if (next.type.startsWith("video/")) return true;
  return /\.(mp4|m4v|mov|webm|mkv|ogv|ogg|mpg|mpeg)$/i.test(next.name);
}

function showWarn(message) {
  warnBox.textContent = message;
  warnBox.hidden = false;
  clearTimeout(warnTimer);
  warnTimer = setTimeout(() => { warnBox.hidden = true; }, 5000);
}

function showError(message) {
  errorBox.textContent = message;
  errorBox.hidden = false;
  statusBox.hidden = true;
}

function setStatus(text, ratio) {
  errorBox.hidden = true;
  statusBox.hidden = false;
  statusText.textContent = text;
  bar.style.width = `${Math.max(0, Math.min(100, ratio))}%`;
}

function keptSeconds() {
  return segments
    .filter((seg) => seg.keep)
    .reduce((sum, seg) => sum + (seg.end - seg.start), 0);
}

function keptRanges() {
  return segments
    .filter((seg) => seg.keep && seg.end - seg.start >= 0.05)
    .map((seg) => [round3(seg.start), round3(seg.end)]);
}

function titleText() {
  return titleInput.value.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
}

function signature() {
  if (!file) return "";
  const ranges = keptRanges().map((range) => range.join("-")).join("|");
  return `${file.name}:${file.size}:${file.lastModified}|${level}|${ranges}|${titleText()}|${titleSize}|${titlePlace}`;
}

function fitTitleLayer() {
  const text = titleText();
  titleNode.textContent = text;
  titleNode.dataset.size = titleSize;
  titleNode.dataset.place = titlePlace;
  if (!text || video.hidden || !video.videoWidth) {
    titleLayer.hidden = true;
    return;
  }
  const box = stage.getBoundingClientRect();
  if (box.width < 8 || box.height < 8) return;
  const scale = Math.min(box.width / video.videoWidth, box.height / video.videoHeight);
  const w = video.videoWidth * scale;
  const h = video.videoHeight * scale;
  titleLayer.hidden = false;
  titleLayer.style.left = `${(box.width - w) / 2}px`;
  titleLayer.style.top = `${(box.height - h) / 2}px`;
  titleLayer.style.width = `${w}px`;
  titleLayer.style.height = `${h}px`;
}

function applyPreviewVolume() {
  video.muted = false;
  try { video.volume = level / 100; } catch { /* métadonnées pas encore là */ }
}

function paintHead() {
  const head = timeline.querySelector(".playhead");
  if (head && duration) head.style.left = `${(Math.min(duration, video.currentTime || 0) / duration) * 100}%`;
  if (duration) caption.textContent = `${fmt(video.currentTime || 0)} / ${fmt(duration)}`;
}

function paintTimeline() {
  const at = video.currentTime || 0;
  timeline.replaceChildren();
  if (!duration || !segments.length) {
    timeline.hidden = true;
    return;
  }
  timeline.hidden = false;
  segments.forEach((seg, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = seg.keep ? "piece" : "piece is-out";
    button.style.flexGrow = String(Math.max(0.001, seg.end - seg.start));
    button.dataset.index = String(index);
    button.setAttribute("aria-pressed", seg.keep ? "true" : "false");
    const state = seg.keep ? "gardé, cliquer pour retirer" : "retiré, cliquer pour remettre";
    button.setAttribute("aria-label", `${fmt(seg.start)} à ${fmt(seg.end)}, ${state}`);
    timeline.appendChild(button);
  });
  const head = document.createElement("div");
  head.className = "playhead";
  head.setAttribute("aria-hidden", "true");
  head.style.left = `${(Math.min(duration, at) / duration) * 100}%`;
  timeline.appendChild(head);
}

function refresh() {
  const ready = Number.isFinite(duration) && duration >= 0.4;
  const kept = keptSeconds();
  const tooLong = kept > MAX_KEPT + 0.05;
  const tooShort = !ready || kept < 0.05;
  playBtn.disabled = !ready || busy;
  splitBtn.disabled = !ready || busy;
  slider.disabled = !ready || busy;
  muteBtn.disabled = !ready || busy;
  renderBtn.disabled = busy || tooShort || tooLong;
  slider.value = String(level);
  volumeValue.textContent = `${level}\u00a0%`;
  const silent = level === 0;
  muteBtn.textContent = silent ? "Remettre le son" : "Couper le son";
  muteBtn.setAttribute("aria-pressed", String(silent));
  applyPreviewVolume();
  timeline.style.pointerEvents = busy ? "none" : "";

  if (!file) summary.textContent = "";
  else if (!ready) summary.textContent = "Lecture de la durée…";
  else if (kept < 0.05) summary.textContent = "Garde au moins un morceau.";
  else {
    let text = `On garde ${fmt(kept)} sur ${fmt(duration)}.`;
    if (hasAudio === false) text += " Cette vidéo n’a pas de son.";
    else if (silent) text += " Le son sera coupé.";
    else if (level < 100) text += ` Son à ${level}\u00a0%.`;
    if (tooLong) text += " Dix minutes maximum.";
    summary.textContent = text;
  }

  paintTimeline();
  fitTitleLayer();
  if (!duration) caption.textContent = "";
  if (jobSignature && jobSignature !== signature()) download.hidden = true;
}

function detectAudio() {
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

function loadFile(next) {
  if (next.size > MAX_BYTES) {
    showWarn("Cette vidéo dépasse 500 Mo.");
    return;
  }
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  file = next;
  objectUrl = URL.createObjectURL(next);
  duration = 0;
  segments = [];
  level = 100;
  savedLevel = 100;
  hasAudio = null;
  jobSignature = "";
  download.hidden = true;
  errorBox.hidden = true;
  statusBox.hidden = true;
  warnBox.hidden = true;
  video.hidden = false;
  empty.hidden = true;
  stage.classList.add("has-video");
  dropTitle.textContent = "Changer de vidéo";
  dropSub.textContent = next.name;
  video.src = objectUrl;
  refresh();
}

function addFiles(list) {
  const incoming = [...list];
  const videos = incoming.filter(isVideoFile);
  if (!videos.length) {
    if (incoming.length) showWarn("Ce fichier n’est pas une vidéo.");
    return;
  }
  if (incoming.length > 1) showWarn("Une seule vidéo : la première est gardée.");
  if (busy) {
    showWarn("Un rendu est en cours.");
    return;
  }
  loadFile(videos[0]);
}

function segmentAt(time) {
  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i];
    const last = i === segments.length - 1;
    if (time >= seg.start && (time < seg.end || (last && time <= seg.end + 0.001))) return seg;
  }
  return null;
}

function nextKept(time) {
  for (const seg of segments) {
    if (seg.keep && seg.end > time + 0.02) return Math.max(seg.start, time);
  }
  return null;
}

function skipRemoved() {
  if (video.paused || !segments.length) return;
  const seg = segmentAt(video.currentTime);
  if (!seg || seg.keep) return;
  const next = nextKept(video.currentTime);
  if (next == null) {
    video.pause();
    return;
  }
  if (next > video.currentTime + 0.03) video.currentTime = next;
}

function togglePlay() {
  if (!duration || playBtn.disabled) return;
  if (video.paused) video.play().catch(() => {});
  else video.pause();
}

function splitAtPlayhead() {
  if (!duration || busy) return;
  const time = video.currentTime || 0;
  const next = [];
  let did = false;
  for (const seg of segments) {
    if (!did && time > seg.start + 0.05 && time < seg.end - 0.05) {
      next.push({ start: seg.start, end: time, keep: seg.keep });
      next.push({ start: time, end: seg.end, keep: seg.keep });
      did = true;
    } else next.push(seg);
  }
  if (!did) {
    showWarn("Place le curseur au milieu d’un morceau.");
    return;
  }
  segments = next;
  refresh();
}

function togglePiece(index) {
  const seg = segments[index];
  if (!seg || busy) return;
  seg.keep = !seg.keep;
  refresh();
}

function show(name) {
  const cut = name === "cut";
  if ((cut && !viewCut.hidden) || (!cut && viewCut.hidden)) return;
  viewCut.hidden = !cut;
  viewEnsemble.hidden = cut;
  tabCut.classList.toggle("is-on", cut);
  tabEnsemble.classList.toggle("is-on", !cut);
  tabCut.setAttribute("aria-selected", String(cut));
  tabEnsemble.setAttribute("aria-selected", String(!cut));
  pageTitle.innerHTML = cut
    ? "Coupe les bouts<br>en trop."
    : "Jusqu’à cinq vidéos,<br>en même temps.";
  pageLede.textContent = cut
    ? "Tu retires les morceaux qui ne servent pas, et tu baisses ou tu coupes le son."
    : "Tu les déposes. Elles jouent ensemble, dans un seul film. À cinq, la dernière se pose au centre.";
  document.title = cut ? "Montage — couper une vidéo" : "Montage — vidéos ensemble";
  for (const item of document.querySelectorAll("video")) item.pause();
  const ensemblePlay = document.getElementById("play");
  if (ensemblePlay) ensemblePlay.textContent = "Lecture";
  playBtn.textContent = "Lecture";
  const hash = cut ? "#couper" : location.pathname;
  if (cut ? location.hash !== "#couper" : location.hash) history.replaceState(null, "", hash);
  if (cut) requestAnimationFrame(fitTitleLayer);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function queueText(ahead) {
  if (!ahead) return "Ça commence…";
  if (ahead === 1) return "En file. Un rendu passe avant le tien.";
  return `En file. ${ahead} rendus passent avant le tien.`;
}

function upload(onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/cuts");
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
      reject(new Error("Le serveur n’a pas démarré la coupe. Relance-la."));
    };
    const body = new FormData();
    body.append("ranges", JSON.stringify(keptRanges()));
    body.append("volume", String(level / 100));
    body.append("title", titleText());
    body.append("titleSize", titleSize);
    body.append("titlePlace", titlePlace);
    body.append("videos", file, file.name);
    xhr.send(body);
  });
}

async function poll(id) {
  const started = Date.now();
  for (;;) {
    await sleep(1000);
    if (Date.now() - started > 20 * 60 * 1000) throw new Error("L’encodage ne répond plus.");
    const response = await fetch(`/api/jobs/${id}`);
    const job = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(job.error || "La coupe est introuvable.");
    if (job.status === "error") throw new Error(job.error || "L’encodage a échoué.");
    if (job.status === "done") {
      setStatus("Prêt.", 100);
      download.href = `/api/jobs/${id}/file`;
      if (job.filename) download.download = job.filename;
      download.hidden = false;
      jobSignature = signature();
      return;
    }
    if (job.status === "queued") setStatus(queueText(job.ahead), 0);
    else setStatus(`Encodage… ${job.progress || 0}\u00a0%`, job.progress || 0);
  }
}

async function renderCut() {
  if (busy || renderBtn.disabled || !file) return;
  const kept = keptSeconds();
  if (kept < 0.05) {
    showError("Garde au moins un morceau.");
    return;
  }
  if (kept > MAX_KEPT + 0.05) {
    showError("Garde au plus dix minutes.");
    return;
  }
  busy = true;
  download.hidden = true;
  refresh();
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
    refresh();
  }
}

tabEnsemble.addEventListener("click", () => show("ensemble"));
tabCut.addEventListener("click", () => show("cut"));

fileInput.addEventListener("change", () => {
  addFiles(fileInput.files);
  fileInput.value = "";
});

document.addEventListener("dragover", (event) => {
  if (!cutVisible()) return;
  if (![...event.dataTransfer.types].includes("Files")) return;
  event.preventDefault();
  drop.classList.add("over");
});

document.addEventListener("dragleave", (event) => {
  if (event.target === document.documentElement) drop.classList.remove("over");
});

document.addEventListener("drop", (event) => {
  if (!cutVisible()) return;
  if (![...event.dataTransfer.types].includes("Files")) return;
  event.preventDefault();
  drop.classList.remove("over");
  addFiles(event.dataTransfer.files);
});

playBtn.addEventListener("click", togglePlay);
splitBtn.addEventListener("click", splitAtPlayhead);
video.addEventListener("click", togglePlay);

video.addEventListener("loadedmetadata", () => {
  duration = video.duration;
  if (!Number.isFinite(duration) || duration < 0.4) {
    duration = 0;
    showError("Cette vidéo est trop courte, ou sa durée est illisible.");
    refresh();
    return;
  }
  segments = [{ start: 0, end: duration, keep: true }];
  hasAudio = detectAudio();
  refresh();
});

video.addEventListener("play", () => {
  skipRemoved();
  playBtn.textContent = "Pause";
});

video.addEventListener("pause", () => {
  playBtn.textContent = "Lecture";
});

video.addEventListener("timeupdate", () => {
  if (!video.paused) skipRemoved();
  paintHead();
});

video.addEventListener("seeked", paintHead);

slider.addEventListener("input", () => {
  level = Number(slider.value);
  if (level > 0) savedLevel = level;
  refresh();
});

muteBtn.addEventListener("click", () => {
  if (level > 0) {
    savedLevel = level;
    level = 0;
  } else {
    level = savedLevel || 100;
  }
  refresh();
});

timeline.addEventListener("pointerdown", (event) => {
  if (!duration || busy || event.button) return;
  ignoreClick = false;
  const piece = event.target.closest(".piece");
  pendingIndex = piece ? Number(piece.dataset.index) : -1;
  drag = { id: event.pointerId, x: event.clientX, moved: false };
  timeline.setPointerCapture(event.pointerId);
});

timeline.addEventListener("pointermove", (event) => {
  if (!drag || drag.id !== event.pointerId) return;
  if (Math.abs(event.clientX - drag.x) <= 4) return;
  drag.moved = true;
  const rect = timeline.getBoundingClientRect();
  const ratio = rect.width ? (event.clientX - rect.left) / rect.width : 0;
  video.currentTime = Math.min(duration, Math.max(0, ratio * duration));
  paintHead();
});

timeline.addEventListener("pointerup", (event) => {
  if (!drag || drag.id !== event.pointerId) return;
  if (drag.moved) {
    ignoreClick = true;
    pendingIndex = -1;
  }
  drag = null;
});

timeline.addEventListener("pointercancel", () => {
  drag = null;
  pendingIndex = -1;
});

timeline.addEventListener("click", (event) => {
  if (ignoreClick) {
    ignoreClick = false;
    return;
  }
  const piece = event.target.closest(".piece");
  const index = piece ? Number(piece.dataset.index) : pendingIndex;
  pendingIndex = -1;
  if (index >= 0) togglePiece(index);
});

renderBtn.addEventListener("click", () => { renderCut(); });

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
    fitTitleLayer();
    if (jobSignature && jobSignature !== signature()) download.hidden = true;
  });
}

titleInput.addEventListener("input", () => {
  fitTitleLayer();
  if (jobSignature && jobSignature !== signature()) download.hidden = true;
});
chooseTitle(titleSizes, "data-size", (value) => { titleSize = value; });
chooseTitle(titlePlaces, "data-place", (value) => { titlePlace = value; });
if (typeof ResizeObserver === "function") new ResizeObserver(() => fitTitleLayer()).observe(stage);

document.addEventListener("keydown", (event) => {
  if (event.code !== "Space" || !cutVisible()) return;
  const tag = event.target && event.target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "BUTTON" || tag === "A") return;
  event.preventDefault();
  togglePlay();
});

if (location.hash === "#couper") show("cut");
})();
