const channelSets = {
  lab: [
    { key: "L", label: "L*", name: "Lightness", min: 0, max: 100, step: 1, value: 55, className: "l" },
    { key: "a", label: "a*", name: "Green to red", min: -128, max: 127, step: 1, value: 25, className: "a" },
    { key: "b", label: "b*", name: "Blue to yellow", min: -128, max: 127, step: 1, value: 20, className: "b" },
  ],
  cmyk: [
    { key: "c", label: "C", name: "Cyan", min: 0, max: 100, step: 1, value: 22, className: "c" },
    { key: "m", label: "M", name: "Magenta", min: 0, max: 100, step: 1, value: 58, className: "m" },
    { key: "y", label: "Y", name: "Yellow", min: 0, max: 100, step: 1, value: 56, className: "y" },
    { key: "k", label: "K", name: "Black", min: 0, max: 100, step: 1, value: 4, className: "k" },
  ],
};

let mode = "lab";
const state = {};
const controls = {};
const elements = {
  sliders: document.querySelector("#sliders"),
  modeButtons: [...document.querySelectorAll("[data-mode]")],
  profile: document.querySelector("#profile"),
  customProfile: document.querySelector("#customProfile"),
  dropZone: document.querySelector("#dropZone"),
  fileInput: document.querySelector("#profileFile"),
  intent: document.querySelector("#intent"),
  status: document.querySelector("#status"),
  inputSwatch: document.querySelector("#inputSwatch"),
  outputSwatch: document.querySelector("#outputSwatch"),
  inputLabel: document.querySelector("#inputLabel"),
  inputText: document.querySelector("#inputText"),
  cmykReadout: document.querySelector("#cmykReadout"),
  cmykText: document.querySelector("#cmykText"),
  profileText: document.querySelector("#profileText"),
  outputLabText: document.querySelector("#outputLabText"),
  deltaReadout: document.querySelector("#deltaReadout"),
  deltaText: document.querySelector("#deltaText"),
};

let debounce;
let requestId = 0;
let activeRequest;

function createSliders() {
  elements.sliders.innerHTML = "";
  for (const key of Object.keys(controls)) delete controls[key];

  for (const channel of channelSets[mode]) {
    const row = document.createElement("label");
    row.className = `slider-row ${channel.className}`;
    row.innerHTML = `
      <span title="${channel.name}">${channel.label}</span>
      <input type="range" min="${channel.min}" max="${channel.max}" step="${channel.step}" value="${channel.value}" autocomplete="off" aria-label="${channel.name}">
      <input type="number" min="${channel.min}" max="${channel.max}" step="${channel.step}" value="${channel.value}" autocomplete="off" aria-label="${channel.name}">
    `;
    const range = row.querySelector('input[type="range"]');
    const number = row.querySelector('input[type="number"]');
    state[channel.key] = channel.value;
    controls[channel.key] = { range, number, channel };

    const update = (value) => {
      const clean = clampNumber(value, channel.min, channel.max, channel.value);
      state[channel.key] = clean;
      range.value = clean;
      number.value = clean;
      updateInputText();
      scheduleConvert();
    };
    range.addEventListener("input", (event) => update(event.target.value));
    number.addEventListener("input", (event) => update(event.target.value));
    elements.sliders.append(row);
  }
  updateInputText();
}

function clampNumber(value, min, max, fallback) {
  const numeric = Number(value);
  return Math.max(min, Math.min(max, Number.isFinite(numeric) ? numeric : fallback));
}

async function loadProfiles(selectPath) {
  const response = await fetch("/api/profiles", { cache: "no-store" });
  const data = await response.json();
  elements.profile.innerHTML = "";
  for (const profile of data.profiles) {
    const option = document.createElement("option");
    option.value = profile.path;
    option.textContent = profile.label;
    elements.profile.append(option);
  }
  if (selectPath) {
    elements.profile.value = selectPath;
  } else {
    const generic = [...elements.profile.options].find((option) => option.textContent === "Generic CMYK Profile");
    if (generic) elements.profile.value = generic.value;
  }
  elements.status.textContent = `${data.profiles.length} ICC profiles found`;
}

function profilePath() {
  return elements.customProfile.value.trim() || elements.profile.value;
}

function syncStateFromControls() {
  for (const key of Object.keys(controls)) {
    const { range, number, channel } = controls[key];
    const value = Number(document.activeElement === number ? number.value : range.value);
    const clean = clampNumber(value, channel.min, channel.max, channel.value);
    state[key] = clean;
    range.value = clean;
    number.value = clean;
  }
}

function activeProfileLabel() {
  if (elements.customProfile.value.trim()) return elements.customProfile.value.trim().split("/").pop();
  return elements.profile.options[elements.profile.selectedIndex]?.textContent || "-";
}

function scheduleConvert() {
  clearTimeout(debounce);
  debounce = setTimeout(convert, 80);
}

function formatLab(lab) {
  return `L*${lab.L.toFixed(2)} a*${lab.a.toFixed(2)} b*${lab.b.toFixed(2)}`;
}

function formatCmyk(cmyk) {
  return `${cmyk.c.toFixed(1)}% ${cmyk.m.toFixed(1)}% ${cmyk.y.toFixed(1)}% ${cmyk.k.toFixed(1)}%`;
}

function formatRgb(rgb) {
  return `rgb(${rgb.r} ${rgb.g} ${rgb.b})`;
}

function updateInputText() {
  elements.inputLabel.textContent = mode === "lab" ? "Input Lab" : "Input CMYK";
  elements.inputText.textContent =
    mode === "lab"
      ? formatLab({ L: state.L, a: state.a, b: state.b })
      : formatCmyk({ c: state.c, m: state.m, y: state.y, k: state.k });
  elements.cmykReadout.classList.toggle("hidden", mode === "cmyk");
  elements.deltaReadout.classList.toggle("hidden", mode === "cmyk");
}

function setMode(nextMode) {
  if (mode === nextMode) return;
  mode = nextMode;
  for (const button of elements.modeButtons) {
    button.classList.toggle("active", button.dataset.mode === mode);
  }
  createSliders();
  scheduleConvert();
}

async function uploadProfile(file) {
  if (!file || !/\.(icc|icm)$/i.test(file.name)) {
    elements.status.textContent = "Drop an .icc or .icm profile.";
    elements.status.classList.add("error");
    return;
  }

  elements.status.classList.remove("error");
  elements.status.textContent = "Uploading profile...";
  const response = await fetch("/api/upload-profile", {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "X-Profile-Name": file.name,
    },
    body: file,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Profile upload failed.");
  await loadProfiles(data.profile.path);
  elements.customProfile.value = "";
  elements.status.textContent = "Profile selected";
  scheduleConvert();
}

function degrees(value) {
  return (value * 180) / Math.PI;
}

function radians(value) {
  return (value * Math.PI) / 180;
}

function deltaE2000(lab1, lab2) {
  const l1 = lab1.L;
  const a1 = lab1.a;
  const b1 = lab1.b;
  const l2 = lab2.L;
  const a2 = lab2.a;
  const b2 = lab2.b;
  const c1 = Math.hypot(a1, b1);
  const c2 = Math.hypot(a2, b2);
  const cBar = (c1 + c2) / 2;
  const cBar7 = cBar ** 7;
  const g = 0.5 * (1 - Math.sqrt(cBar7 / (cBar7 + 25 ** 7)));
  const a1Prime = (1 + g) * a1;
  const a2Prime = (1 + g) * a2;
  const c1Prime = Math.hypot(a1Prime, b1);
  const c2Prime = Math.hypot(a2Prime, b2);
  const h1Prime = hueDegrees(a1Prime, b1);
  const h2Prime = hueDegrees(a2Prime, b2);
  const deltaLPrime = l2 - l1;
  const deltaCPrime = c2Prime - c1Prime;
  let deltahPrime = 0;
  if (c1Prime * c2Prime !== 0) {
    const diff = h2Prime - h1Prime;
    if (Math.abs(diff) <= 180) deltahPrime = diff;
    else if (diff > 180) deltahPrime = diff - 360;
    else deltahPrime = diff + 360;
  }
  const deltaHPrime = 2 * Math.sqrt(c1Prime * c2Prime) * Math.sin(radians(deltahPrime / 2));
  const lBarPrime = (l1 + l2) / 2;
  const cBarPrime = (c1Prime + c2Prime) / 2;
  const hBarPrime = meanHue(h1Prime, h2Prime, c1Prime, c2Prime);
  const t =
    1 -
    0.17 * Math.cos(radians(hBarPrime - 30)) +
    0.24 * Math.cos(radians(2 * hBarPrime)) +
    0.32 * Math.cos(radians(3 * hBarPrime + 6)) -
    0.20 * Math.cos(radians(4 * hBarPrime - 63));
  const deltaTheta = 30 * Math.exp(-(((hBarPrime - 275) / 25) ** 2));
  const cBarPrime7 = cBarPrime ** 7;
  const rC = 2 * Math.sqrt(cBarPrime7 / (cBarPrime7 + 25 ** 7));
  const sL = 1 + (0.015 * ((lBarPrime - 50) ** 2)) / Math.sqrt(20 + ((lBarPrime - 50) ** 2));
  const sC = 1 + 0.045 * cBarPrime;
  const sH = 1 + 0.015 * cBarPrime * t;
  const rT = -Math.sin(radians(2 * deltaTheta)) * rC;
  const lTerm = deltaLPrime / sL;
  const cTerm = deltaCPrime / sC;
  const hTerm = deltaHPrime / sH;
  return Math.sqrt(lTerm ** 2 + cTerm ** 2 + hTerm ** 2 + rT * cTerm * hTerm);
}

function hueDegrees(a, b) {
  if (a === 0 && b === 0) return 0;
  const angle = degrees(Math.atan2(b, a));
  return angle >= 0 ? angle : angle + 360;
}

function meanHue(h1, h2, c1, c2) {
  if (c1 * c2 === 0) return h1 + h2;
  if (Math.abs(h1 - h2) <= 180) return (h1 + h2) / 2;
  if (h1 + h2 < 360) return (h1 + h2 + 360) / 2;
  return (h1 + h2 - 360) / 2;
}

async function convert() {
  const id = ++requestId;
  if (activeRequest) activeRequest.abort();
  activeRequest = new AbortController();

  elements.status.classList.remove("error");
  elements.status.textContent = "Converting...";
  syncStateFromControls();
  updateInputText();

  try {
    const response = await fetch("/api/convert", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      signal: activeRequest.signal,
      body: JSON.stringify({
        mode,
        ...state,
        profilePath: profilePath(),
        intent: elements.intent.value,
      }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Conversion failed.");
    if (id !== requestId) return;

    const delta = deltaE2000(data.inputLab, data.outputLab);
    elements.inputSwatch.style.background = formatRgb(data.inputRgb);
    elements.outputSwatch.style.background = formatRgb(data.outputRgb);
    elements.cmykText.textContent = formatCmyk(data.cmyk);
    elements.profileText.textContent = activeProfileLabel();
    elements.outputLabText.textContent = formatLab(data.outputLab);
    elements.deltaText.textContent = delta.toFixed(3);
    elements.status.textContent = "Live";
  } catch (error) {
    if (error.name === "AbortError") return;
    if (id !== requestId) return;
    elements.status.textContent = error.message;
    elements.status.classList.add("error");
  }
}

elements.modeButtons.forEach((button) => {
  button.addEventListener("click", () => setMode(button.dataset.mode));
});
elements.profile.addEventListener("change", scheduleConvert);
elements.customProfile.addEventListener("input", scheduleConvert);
elements.intent.addEventListener("change", scheduleConvert);
elements.dropZone.addEventListener("click", () => elements.fileInput.click());
elements.fileInput.addEventListener("change", () => {
  uploadProfile(elements.fileInput.files[0]).catch((error) => {
    elements.status.textContent = error.message;
    elements.status.classList.add("error");
  });
});
for (const eventName of ["dragenter", "dragover"]) {
  elements.dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    elements.dropZone.classList.add("dragging");
  });
}
for (const eventName of ["dragleave", "drop"]) {
  elements.dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    elements.dropZone.classList.remove("dragging");
  });
}
elements.dropZone.addEventListener("drop", (event) => {
  uploadProfile(event.dataTransfer.files[0]).catch((error) => {
    elements.status.textContent = error.message;
    elements.status.classList.add("error");
  });
});

createSliders();
loadProfiles().then(convert).catch((error) => {
  elements.status.textContent = error.message;
  elements.status.classList.add("error");
});
