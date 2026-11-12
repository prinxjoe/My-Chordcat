const $ = id => document.getElementById(id);
const noteNames = ["C","C♯","D","D♯","E","F","F♯","G","G♯","A","A♯","B"];
const LOW = 21, HIGH = 108; // A0 .. C8
const activeNotes = new Set();   // keys currently held (physical or virtual)
const sounding = new Map();      // held key -> note actually sounding (octave shift)
const sustained = new Set();     // keys released while pedal down
const progression = [];
let midiAccess = null, midiRequest = null, lastProgressionKey = "", historyTimer = null;
let recorder = null, recordedChunks = [], recordingStream = null;
let shift = 0, sustainOn = false, sustainPedal = false;
let audioReady = false, master = null, limiter = null, audioRecorder = null;   // audioReady = audio graph built (once)
let masterVol = 0.8, masterMuted = false;
let pianoState = "loading", pianoLoadId = 0;                                   // loading | ready | error

/* ---------- Audio tuning (edit here if needed) ---------- */
const AUDIO_LATENCY_HINT = "interactive"; // "interactive" = lowest delay. If you still hear crackle, try "balanced" or "playback"
const AUDIO_LOOKAHEAD = 0.03;             // seconds. 0 caused late/glitchy note starts; Tone's default is 0.1
const MAX_HELD_NOTES = 40;                // held + pedal-sustained notes. Oldest are released first when exceeded
const DUP_WINDOW_MS = 20;                 // ignore a repeated note-on for the same key arriving within this window
const LOCAL_SAMPLES = "samples/salamander/"; // optional local copy of the piano samples (see instructions)

const isBlack = n => [1,3,6,8,10].includes(n % 12);
const noteName = n => noteNames[n % 12] + (Math.floor(n / 12) - 1);
const toneName = n => noteName(n).replace("♯", "#");

/* ---------- Status bar ---------- */
function setStatus(id, text, cls) {
  const el = $(id); el.textContent = text; el.className = cls || "";
}

/* ---------- Instruments ---------- */
const INST = [
  { id:"piano",   name:"Grand Piano",    on:true,  vol:0.8, mute:false },
  { id:"strings", name:"Strings",        on:false, vol:0.6, mute:false },
  { id:"bell",    name:"Bell",           on:false, vol:0.5, mute:false },
  { id:"epiano",  name:"Electric Piano", on:false, vol:0.7, mute:false }
];
const PRESETS = [
  ["Piano Only",["piano"]], ["Piano + Strings",["piano","strings"]],
  ["Piano + Bell",["piano","bell"]], ["Piano + Electric Piano",["piano","epiano"]],
  ["Strings + Bell",["strings","bell"]], ["Piano + Strings + Bell",["piano","strings","bell"]],
  ["Piano + Strings + E.Piano",["piano","strings","epiano"]], ["All Four",["piano","strings","bell","epiano"]]
];
const SALAMANDER = "https://tonejs.github.io/audio/salamander/";
const SALAMANDER_CDN = "https://cdn.jsdelivr.net/gh/Tonejs/audio@master/salamander/"; // mirror of the same files
// Salamander Grand Piano (Alexander Holm) - Creative Commons Attribution 3.0

function buildInstrumentUI() {
  const wrap = $("instruments");
  INST.forEach(i => {
    const d = document.createElement("div");
    d.className = "inst"; d.id = "i-" + i.id;
    d.innerHTML = `<div class="ihead"><span class="led"></span><b>${i.name}</b>
      <button data-a="onoff"></button></div>
      <input type="range" min="0" max="100" data-a="vol">
      <div class="ibtns"><button data-a="dn">−</button><span class="pct"></span>
      <button data-a="up">+</button><button data-a="mute">Mute</button></div>
      ${i.id === "piano" ? '<div class="muted" data-role="msg"></div>' : ""}`;
    d.addEventListener("click", e => {
      const a = e.target.dataset.a; if (!a) return;
      if (a === "onoff") i.on = !i.on;
      if (a === "mute") i.mute = !i.mute;
      if (a === "up") i.vol = Math.min(1, i.vol + 0.1);
      if (a === "dn") i.vol = Math.max(0, i.vol - 0.1);
      refreshInstruments();
    });
    d.querySelector("input").addEventListener("input", e => { i.vol = e.target.value / 100; refreshInstruments(); });
    wrap.appendChild(d);
  });
  PRESETS.forEach(([label, ids]) => {
    const b = document.createElement("button"); b.textContent = label;
    b.addEventListener("click", () => { INST.forEach(i => i.on = ids.includes(i.id)); refreshInstruments(); });
    $("presets").appendChild(b);
  });
  refreshInstruments();
}

function refreshInstruments() {
  INST.forEach(i => {
    const d = $("i-" + i.id);
    d.classList.toggle("enabled", i.on);
    const b = d.querySelector('[data-a="onoff"]');
    b.textContent = i.on ? "ON" : "OFF"; b.classList.toggle("on", i.on);
    const m = d.querySelector('[data-a="mute"]');
    m.classList.toggle("on", i.mute); m.textContent = i.mute ? "Muted" : "Mute";
    d.querySelector("input").value = Math.round(i.vol * 100);
    d.querySelector(".pct").textContent = Math.round(i.vol * 100) + "%";
    if (audioReady) i.gain.gain.rampTo(i.on && !i.mute ? i.vol : 0, 0.03);
  });
  if (audioReady) master.gain.rampTo(masterMuted ? 0 : masterVol, 0.03);
  $("masterMute").classList.toggle("on", masterMuted);
  $("masterMute").textContent = masterMuted ? "Muted" : "Mute";
}

/* ---------- Audio engine ---------- */
const PIANO_URLS = {};
["A0","C1","D#1","F#1","A1","C2","D#2","F#2","A2","C3","D#3","F#3","A3","C4","D#4","F#4",
 "A4","C5","D#5","F#5","A5","C6","D#6","F#6","A6","C7","D#7","F#7","A7","C8"]
  .forEach(n => PIANO_URLS[n] = n.replace("#", "s") + ".mp3");

// Built ONCE at page load (not on first click), so there is exactly one audio graph.
// Browsers only require a user gesture to *resume* audio, which initAudio() does.
function buildAudioGraph() {
  if (audioReady) return;
  if (typeof Tone === "undefined") {
    setStatus("stAudio", "Audio Engine: Tone.js failed to load (check internet connection)", "bad");
    setPianoState("error", "Samples: Not loaded (Tone.js missing)");
    return;
  }
  try {
    Tone.setContext(new Tone.Context({ latencyHint: AUDIO_LATENCY_HINT, lookAhead: AUDIO_LOOKAHEAD }), true);
    master = new Tone.Gain(masterVol);
    limiter = new Tone.Limiter(-1).toDestination();   // prevents clipping when many notes/layers add up
    master.connect(limiter);
    INST.forEach(i => { i.gain = new Tone.Gain(0).connect(master); });

    // Grand Piano: sampled only. Loaded by loadPiano() - there is NO synth fallback.

    // Other instruments are synthesised in the browser (no sample licences needed)
    const filt = new Tone.Filter(2200, "lowpass").connect(INST[1].gain);
    INST[1].synth = new Tone.PolySynth(Tone.Synth, { maxPolyphony: 48,
      oscillator:{type:"fatsawtooth", count:3, spread:20},
      envelope:{attack:.35, decay:.3, sustain:.8, release:1.4} }).connect(filt);
    INST[1].synth.volume.value = -10;
    INST[2].synth = new Tone.PolySynth(Tone.FMSynth, { maxPolyphony: 48, harmonicity:8, modulationIndex:2,
      oscillator:{type:"sine"}, envelope:{attack:.001, decay:2, sustain:0, release:2},
      modulation:{type:"square"}, modulationEnvelope:{attack:.002, decay:.2, sustain:0, release:.2} }).connect(INST[2].gain);
    INST[2].synth.volume.value = -8;
    INST[3].synth = new Tone.PolySynth(Tone.FMSynth, { maxPolyphony: 48, harmonicity:3.01, modulationIndex:14,
      oscillator:{type:"triangle"}, envelope:{attack:.01, decay:.8, sustain:.2, release:1.2},
      modulation:{type:"square"}, modulationEnvelope:{attack:.5, decay:0, sustain:1, release:.5} }).connect(INST[3].gain);
    INST[3].synth.volume.value = -8;

    audioReady = true;
    setStatus("stAudio", "Audio Engine: Built - click or press a key to start", "");
    refreshInstruments();
    loadPiano();
  } catch (err) {
    setStatus("stAudio", "Audio Engine: Error – " + err.message, "bad");
    setPianoState("error", "Samples: Error");
  }
}

// Called on user gestures: only resumes the (already built) audio context.
async function initAudio() {
  if (!audioReady) buildAudioGraph();
  if (!audioReady) return;
  const ctx = Tone.getContext();
  if (ctx.state === "running") return;
  try {
    await Tone.start();
    setStatus("stAudio", "Audio Engine: Ready", "ok");
    const raw = ctx.rawContext;
    const bl = raw && typeof raw.baseLatency === "number" ? " · base latency " + (raw.baseLatency * 1000).toFixed(1) + " ms" : "";
    setStatus("stOut", "Audio Output: System default · " + ctx.sampleRate + " Hz" + bl);
  } catch (err) {
    setStatus("stAudio", "Audio Engine: Error – " + err.message, "bad");
  }
}

/* ---------- Grand Piano sample loading (no silent fallback) ---------- */
function setPianoState(state, text) {
  pianoState = state;
  setStatus("stSamples", text, state === "ready" ? "ok" : state === "error" ? "bad" : "");
  const st = $("stSamples");
  st.style.cursor = state === "error" ? "pointer" : "";
  st.title = state === "error" ? "Click to retry loading the piano samples" : "";
  const msg = document.querySelector("#i-piano [data-role=msg]");
  if (msg) {
    msg.textContent = state === "loading" ? "Loading piano samples…"
      : state === "error" ? "Piano samples failed to load, so Grand Piano is silent. Click \u201cSamples\u201d in the status bar to retry."
      : "";
    msg.style.color = state === "error" ? "var(--red)" : "";
  }
}

async function urlExists(url) {
  try { const r = await fetch(url, { method: "HEAD", cache: "no-store" }); return r.ok; }
  catch (e) { return false; }
}

function makeSampler(baseUrl) {
  return new Promise((resolve, reject) => {
    let done = false, sampler = null, timer = null;
    const fail = err => {
      if (done) return; done = true; clearTimeout(timer);
      try { sampler && sampler.dispose(); } catch (e) {}
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    timer = setTimeout(() => fail(new Error("Timed out loading piano samples")), 30000);
    sampler = new Tone.Sampler({
      urls: PIANO_URLS, baseUrl, release: 1,
      onload: () => { if (done) return; done = true; clearTimeout(timer); resolve(sampler); },
      onerror: fail
    });
  });
}

async function loadPiano() {
  if (!audioReady) return;
  const myId = ++pianoLoadId;
  setPianoState("loading", "Samples: Loading Grand Piano…");
  const localAvailable = await urlExists(LOCAL_SAMPLES + "A0.mp3");
  const sources = localAvailable
    ? [[LOCAL_SAMPLES, "local files"]]
    : [[SALAMANDER_CDN, "online - jsDelivr"], [SALAMANDER, "online - GitHub Pages"]];
  let lastErr = null;
  for (const [base, label] of sources) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const s = await makeSampler(base);
        if (myId !== pianoLoadId) { s.dispose(); return; }
        s.connect(INST[0].gain);
        INST[0].synth = s;                       // only ever a real sampled piano
        setPianoState("ready", "Samples: Grand Piano loaded (" + label + ")");
        return;
      } catch (err) { lastErr = err; console.warn("Piano load failed (" + label + ", attempt " + attempt + "):", err); }
    }
  }
  setPianoState("error", "Samples: FAILED – Grand Piano unavailable (click to retry)");
  console.error("Grand Piano samples could not be loaded:", lastErr);
}

function play(n, vel) {
  if (!audioReady) return;
  if (Tone.getContext().state !== "running") {
    initAudio();
    setStatus("stAudio", "Audio Engine: Suspended - click anywhere on the page once", "bad");
    return;
  }
  const name = toneName(n), t = Tone.now(), v = Math.max(0.01, vel / 127);
  INST.forEach(i => {
    if (!i.on || i.mute || !i.synth) return;     // piano has no synth until real samples are loaded
    try { i.synth.triggerAttack(name, t, v); } catch (e) { console.warn(i.name + " could not play " + name, e); }
  });
}
function stop(key) {
  const s = sounding.get(key); if (s === undefined) return;
  sounding.delete(key);
  if (!audioReady) return;
  const name = toneName(s), t = Tone.now();
  INST.forEach(i => { try { i.synth && i.synth.triggerRelease(name, t); } catch (e) {} });
}

/* ---------- Note handling (MIDI + virtual share this) ---------- */
const lastOnTime = new Map();
function enforceVoiceLimit() {
  while (sounding.size > MAX_HELD_NOTES) {
    let victim = null;
    for (const k of sounding.keys()) { if (sustained.has(k)) { victim = k; break; } }  // pedal-held notes go first
    if (victim === null) victim = sounding.keys().next().value;                          // else the oldest note
    sustained.delete(victim); activeNotes.delete(victim);
    stop(victim);
  }
}
function noteOn(key, vel = 100) {
  if (key < LOW || key > HIGH) return;
  const now = performance.now();
  if (activeNotes.has(key) && now - (lastOnTime.get(key) || 0) < DUP_WINDOW_MS) return; // duplicate event
  lastOnTime.set(key, now);
  sustained.delete(key);
  if (sounding.has(key)) stop(key);        // re-strike while pedal holds it
  const s = Math.max(LOW, Math.min(HIGH, key + shift * 12));
  sounding.set(key, s);
  activeNotes.add(key);
  play(s, vel);                            // sound FIRST ...
  enforceVoiceLimit();
  render();                                // ... display is updated later, once per frame
}
function noteOff(key) {
  if (!activeNotes.has(key)) return;
  activeNotes.delete(key);
  if (sustainOn || sustainPedal) sustained.add(key); else stop(key);
  render();
}
function setSustain(down) {
  sustainPedal = down;
  if (!sustainOn && !down) releaseSustained();
  $("sustainBtn").textContent = "Sustain: " + (sustainOn || sustainPedal ? "ON" : "OFF");
}
function releaseSustained() { sustained.forEach(stop); sustained.clear(); }

/* ---------- Keyboard: exactly 88 keys, A0..C8 ---------- */
const keyEls = new Map();   // note number -> key element (so highlighting never queries the DOM)
let litNotes = new Set();
function createKeyboard() {
  const kb = $("keyboard"); kb.innerHTML = ""; keyEls.clear(); litNotes = new Set();
  const whiteCount = 52, w = 100 / whiteCount;
  let whites = 0;
  for (let n = LOW; n <= HIGH; n++) {
    const key = document.createElement("div");
    key.dataset.note = n;
    if (!isBlack(n)) {
      key.className = "white-key";
      const lab = document.createElement("span"); lab.className = "key-label";
      if (n % 12 === 0 || n === LOW) lab.textContent = noteName(n); // label every C (and A0)
      key.appendChild(lab); whites++;
    } else {
      key.className = "black-key";
      key.style.width = (w * 0.62) + "%";
      key.style.left = (whites * w - w * 0.31) + "%";
    }
    kb.appendChild(key); keyEls.set(n, key);
  }
  verifyKeyboard(whiteCount);
}
function verifyKeyboard(expectedWhite) {
  const all = document.querySelectorAll("#keyboard [data-note]");
  const wh = document.querySelectorAll("#keyboard .white-key").length;
  const bl = document.querySelectorAll("#keyboard .black-key").length;
  const first = noteName(Number(all[0].dataset.note));
  const last = noteName(Number(all[all.length - 1].dataset.note));
  const ok = all.length === 88 && wh === 52 && bl === 36 && first === "A0" && last === "C8";
  console.log(`Keyboard check: ${all.length} keys, ${wh} white, ${bl} black, ${first}–${last}`, ok ? "PASS" : "FAIL");
  setStatus("stKeys", ok ? `Keys: ${all.length} ✓ (${wh} white / ${bl} black, ${first}–${last})` : "Keys: structure error", ok ? "ok" : "bad");
}

// Virtual keyboard mouse / touch
const pointers = new Map();
$("keyboard").addEventListener("pointerdown", e => {
  const k = e.target.closest("[data-note]"); if (!k) return;
  initAudio();
  const n = Number(k.dataset.note);
  pointers.set(e.pointerId, n);
  noteOn(n, 100);
});
window.addEventListener("pointerup", e => { const n = pointers.get(e.pointerId); if (n !== undefined) { pointers.delete(e.pointerId); noteOff(n); } });
window.addEventListener("pointercancel", e => { const n = pointers.get(e.pointerId); if (n !== undefined) { pointers.delete(e.pointerId); noteOff(n); } });

/* ---------- Chord detection (your original, plus inversions) ---------- */
function chordName(notes) {
  const pcs = [...new Set(notes.map(n => n % 12))].sort((a,b) => a-b);
  if (pcs.length < 2) return pcs.length ? noteNames[pcs[0]] : "Ready to Play";

  const templates = [
    ["", [0,4,7]], ["m", [0,3,7]], ["dim", [0,3,6]], ["aug", [0,4,8]],
    ["sus2", [0,2,7]], ["sus4", [0,5,7]], ["7", [0,4,7,10]], ["maj7", [0,4,7,11]],
    ["m7", [0,3,7,10]], ["m7♭5", [0,3,6,10]], ["dim7", [0,3,6,9]]
  ];
  const bass = notes[0] % 12;
  const roots = [bass, ...pcs.filter(p => p !== bass)]; // try the lowest note as root first

  for (const root of roots) {
    const intervals = pcs.map(n => (n - root + 12) % 12).sort((a,b) => a-b);
    for (const [suffix, shape] of templates) {
      if (intervals.length === shape.length && intervals.every((v,i) => v === shape[i])) {
        return noteNames[root] + suffix + (root !== bass ? "/" + noteNames[bass] : "");
      }
    }
  }
  return pcs.map(n => noteNames[n]).join(" / ");
}

function drawStaff(notes) {
  const group = $("staffNotes"); group.innerHTML = "";
  notes.slice(0, 6).forEach((note, i) => {
    const y = 105 - (note % 12) * 4, x = 40 + i * 32;
    const cy = Math.max(40, Math.min(110, y));
    const el = document.createElementNS("http://www.w3.org/2000/svg", "ellipse");
    el.setAttribute("cx", x); el.setAttribute("cy", cy); el.setAttribute("rx", 7); el.setAttribute("ry", 5);
    group.appendChild(el);
    const stem = document.createElementNS("http://www.w3.org/2000/svg", "path");
    stem.setAttribute("d", `M ${x+6} ${cy} L ${x+6} ${Math.max(22, Math.min(95, y-30))}`);
    stem.setAttribute("stroke", "#ff454d"); stem.setAttribute("stroke-width", "2"); stem.setAttribute("fill", "none");
    group.appendChild(stem);
  });
}

let renderQueued = false;
function render() {                       // many MIDI events in one frame -> a single screen update
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; renderNow(); });
}
function renderNow() {
  const notes = [...activeNotes].sort((a,b) => a-b);
  litNotes.forEach(n => { if (!activeNotes.has(n)) { const k = keyEls.get(n); if (k) k.classList.remove("active"); } });
  activeNotes.forEach(n => { if (!litNotes.has(n)) { const k = keyEls.get(n); if (k) k.classList.add("active"); } });
  litNotes = new Set(activeNotes);
  $("liveLabel").textContent = notes.length ? "LIVE" : "READY";
  $("sideNotes").textContent = notes.length ? notes.map(noteName).join("  ") : "—";
  drawStaff(notes);

  if (!notes.length) {
    $("chordName").textContent = "Ready to Play";
    $("noteNames").textContent = "Connect your MIDI keyboard and play a chord.";
    lastProgressionKey = ""; clearTimeout(historyTimer);
    return;
  }
  const chord = chordName(notes);
  $("chordName").textContent = chord;
  $("noteNames").textContent = notes.map(noteName).join("   ");

  // Wait until the chord settles (300 ms) before logging, so building a chord
  // note-by-note doesn't create several entries, and holding it doesn't repeat.
  clearTimeout(historyTimer);
  if (notes.length >= 3) {
    historyTimer = setTimeout(() => {
      const now = [...activeNotes].sort((a,b) => a-b);
      if (now.length < 3) return;
      const c = chordName(now), key = c + "|" + now.join(",");
      if (key !== lastProgressionKey) { lastProgressionKey = key; addProgression(c, now); }
    }, 300);
  }
}

function addProgression(chord, notes) {
  const item = { chord, notes: notes.map(noteName), time: new Date().toLocaleTimeString() };
  progression.push(item);
  const empty = $("historyList").querySelector(".empty"); if (empty) empty.remove();
  const li = document.createElement("li");
  li.textContent = item.chord + " — " + item.notes.join(" ");
  const small = document.createElement("small"); small.textContent = item.time;
  li.appendChild(small);
  $("historyList").appendChild(li);
  $("historyList").scrollTop = $("historyList").scrollHeight;
  $("count").textContent = progression.length + " chord" + (progression.length === 1 ? "" : "s") + " saved";
}

/* ---------- MIDI ---------- */
function onMIDIMessage(e) {
  const [status, note, velocity] = e.data;
  const cmd = status & 0xf0;
  if (cmd === 0x90 && velocity > 0) noteOn(note, velocity);
  else if (cmd === 0x80 || (cmd === 0x90 && velocity === 0)) noteOff(note);
  else if (cmd === 0xb0 && note === 64) setSustain(velocity >= 64);   // sustain pedal
  else if (cmd === 0xb0 && (note === 123 || note === 120)) {            // all notes off
    [...activeNotes].forEach(noteOff);
  }
}

function bindInputs() {
  const inputs = [...midiAccess.inputs.values()].filter(i => i.state === "connected");
  const sel = $("midiIn"), prev = sel.value;
  sel.innerHTML = '<option value="all">All MIDI inputs</option>' +
    inputs.map(i => `<option value="${i.id}">${i.name}</option>`).join("");
  sel.value = inputs.some(i => i.id === prev) ? prev : "all";
  midiAccess.inputs.forEach(i => { i.onmidimessage = null; });
  inputs.forEach(i => { if (sel.value === "all" || sel.value === i.id) i.onmidimessage = onMIDIMessage; });

  $("midiStatus").textContent = inputs.length
    ? "● Connected: " + inputs.map(i => i.name).join(", ")
    : "● No MIDI input found. Connect your keyboard and try again.";
  $("midiStatus").style.color = inputs.length ? "#6fdc8c" : "#ccc";
  setStatus("stMidi", "MIDI Keyboard: " + (inputs.length ? "Connected" : "Disconnected"), inputs.length ? "ok" : "bad");
  if (!inputs.length) { [...activeNotes].forEach(noteOff); }   // unplugged mid-note
}

async function connectMIDI() {
  initAudio(); // the click is the user gesture browsers require for audio
  if (!navigator.requestMIDIAccess) {
    $("midiStatus").textContent = "MIDI unavailable. Use desktop Chrome or Edge.";
    return;
  }
  try {
    // Request MIDI access only once. A second request would create a second set of
    // input objects whose handlers stay attached, so every note would be processed twice.
    if (!midiRequest) midiRequest = navigator.requestMIDIAccess();
    if (!midiAccess) {
      midiAccess = await midiRequest;
      midiAccess.onstatechange = bindInputs;   // handles unplug / replug
    } else { await midiRequest; }
    bindInputs();
  } catch (err) {
    midiRequest = null; midiAccess = null;
    $("midiStatus").textContent = "MIDI access denied: " + err.message;
  }
}

/* ---------- Actions ---------- */
function clearAll() {
  progression.length = 0; lastProgressionKey = "";
  $("historyList").innerHTML = '<li class="empty">Your played chords will appear here.</li>';
  $("count").textContent = "0 chords saved";
}
function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function saveChords() {
  if (!progression.length) { alert("No chords to save yet. Play a chord first."); return; }
  const text = progression.map((p, i) => `${i + 1}. ${p.chord} — ${p.notes.join(" ")} (${p.time})`).join("\n");
  download(new Blob([text], { type: "text/plain" }), "chord-progression.txt");
}
function setLayout() {
  const app = $("app");
  app.classList.remove("social-portrait", "social-square");
  const v = $("layout").value;
  if (v === "portrait") app.classList.add("social-portrait");
  if (v === "square") app.classList.add("social-square");
}

async function startRecording() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
    alert("Screen recording isn't supported in this browser."); return;
  }
  try { recordingStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true }); }
  catch (err) { return; }
  recordedChunks = [];
  recorder = new MediaRecorder(recordingStream);
  recorder.ondataavailable = e => { if (e.data.size) recordedChunks.push(e.data); };
  recorder.onstop = () => {
    download(new Blob(recordedChunks, { type: "video/webm" }), "chordcat-recording.webm");
    recordingStream.getTracks().forEach(t => t.stop());
    $("record").disabled = false; $("stop").disabled = true;
  };
  recordingStream.getVideoTracks()[0].addEventListener("ended", () => {
    if (recorder && recorder.state !== "inactive") recorder.stop();
  });
  recorder.start();
  $("record").disabled = true; $("stop").disabled = false;
}
function stopRecording() { if (recorder && recorder.state !== "inactive") recorder.stop(); }

// Audio-only recording of the instruments (separate from screen recording)
async function toggleAudioRec() {
  await initAudio();
  if (!audioReady) return;
  try {
    if (!audioRecorder) { audioRecorder = new Tone.Recorder(); limiter.connect(audioRecorder); }
    if (audioRecorder.state === "started") {
      const blob = await audioRecorder.stop();
      download(blob, "chordcat-audio.webm");
      $("audioRec").textContent = "● Record Audio"; $("audioRec").classList.remove("on");
    } else {
      audioRecorder.start();
      $("audioRec").textContent = "■ Stop & Save Audio"; $("audioRec").classList.add("on");
    }
  } catch (err) { alert("Audio recording isn't supported here: " + err.message); }
}

/* ---------- Controls ---------- */
function setLayers(n) {
  const order = INST.map(i => i.id);
  const enabled = INST.filter(i => i.on).map(i => i.id);
  let keep = enabled.slice(0, n);
  for (const id of order) { if (keep.length >= n) break; if (!keep.includes(id)) keep.push(id); }
  INST.forEach(i => i.on = keep.includes(i.id));
  document.querySelectorAll(".layer").forEach(b => b.classList.toggle("on", Number(b.dataset.n) === n));
  refreshInstruments();
}
function allVol(d) { INST.forEach(i => i.vol = Math.max(0, Math.min(1, i.vol + d))); refreshInstruments(); }
function setOctave(d) {
  shift = Math.max(-3, Math.min(3, shift + d));
  $("octVal").textContent = (shift > 0 ? "+" : "") + shift;
}

/* ---------- Init ---------- */
$("connect").addEventListener("click", connectMIDI);
$("midiIn").addEventListener("change", () => midiAccess && bindInputs());
$("clear").addEventListener("click", clearAll);
$("saveChords").addEventListener("click", saveChords);
$("audioRec").addEventListener("click", toggleAudioRec);
$("layout").addEventListener("change", setLayout);
$("record").addEventListener("click", startRecording);
$("stop").addEventListener("click", stopRecording);
$("masterVol").addEventListener("input", e => { masterVol = e.target.value / 100; refreshInstruments(); });
$("masterMute").addEventListener("click", () => { masterMuted = !masterMuted; refreshInstruments(); });
$("allUp").addEventListener("click", () => allVol(0.1));
$("allDn").addEventListener("click", () => allVol(-0.1));
document.querySelectorAll(".layer").forEach(b => b.addEventListener("click", () => setLayers(Number(b.dataset.n))));
$("octUp").addEventListener("click", () => setOctave(1));
$("octDn").addEventListener("click", () => setOctave(-1));
$("sustainBtn").addEventListener("click", () => {
  sustainOn = !sustainOn;
  $("sustainBtn").classList.toggle("on", sustainOn);
  if (!sustainOn && !sustainPedal) releaseSustained();
  $("sustainBtn").textContent = "Sustain: " + (sustainOn || sustainPedal ? "ON" : "OFF");
});
$("about").addEventListener("click", () =>
  alert("J Prince ChordCat\nA MIDI workstation by J Prince Music Hub.\nPlay It. See It. Share It.\n\nPiano: Salamander Grand Piano (CC BY 3.0). Other sounds synthesised with Tone.js."));
document.addEventListener("pointerdown", initAudio);   // cheap no-op once the context is running
document.addEventListener("keydown", initAudio);
$("stSamples").addEventListener("click", () => { if (pianoState === "error") loadPiano(); });
window.addEventListener("online", () => { if (pianoState === "error") loadPiano(); });   // internet came back

buildInstrumentUI();
createKeyboard();
render();
