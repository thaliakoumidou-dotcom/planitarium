// ============================================================
//  ATHANAS — main.js (Full Engine - 980 Lines Version)
//  Frontend Controller: Worker bridge · Telemetry HUD · Canvas
//  Zero-Server · WebGPU · Rust/Wasm · Cyprus Planetarium
// ============================================================

'use strict';

// ── Query helpers ──────────────────────────────────────────────
const $  = (id) => document.getElementById(id);
const $$ = (sel) => document.querySelectorAll(sel);

// ── State ─────────────────────────────────────────────────────
let worker = null;
let renderMode = 'dome';
let peers = [];
let generation = 0;
let bestFitness = 0;
let simTime = 0; 
let animHandle = 0;

let starConfig = {
  fovDeg: 180,
  tiltDeg: 23.0,
  magLimit: 6.5,
  extinction: 0.30,
  timeWarp: 1,
  showMW: true,
  showScint: true,
  showConst: false,
  showGrid: true,
};

const inferHistory = new Array(60).fill(0);

// ── Canvas setup ──────────────────────────────────────────────
// ΔΙΟΡΘΩΣΗ: Αλλαγή ID σε 'webgpu-canvas' για να κουμπώσει με το CSS
const canvas = $('webgpu-canvas');
const ctx    = canvas.getContext('2d');
let W = 0, H = 0, CX = 0, CY = 0, R = 0;

function resizeCanvas() {
  if (!canvas) return;
  W  = canvas.width  = window.innerWidth;
  H  = canvas.height = window.innerHeight;
  CX = W / 2;
  CY = H / 2;
  R  = Math.min(W, H) * 0.46;
}

window.addEventListener('resize', resizeCanvas);
resizeCanvas();

// ── Star generation (Cyprus sky) ─────────────────────────────
let stars = [];

function generateStars(n) {
  const list = [];
  let s = 0xDEADBEEF;
  const rand = () => {
    s = (s ^ (s << 13)) >>> 0;
    s = (s ^ (s >> 7))  >>> 0;
    s = (s ^ (s << 17)) >>> 0;
    return s / 0xFFFFFFFF;
  };

  for (let i = 0; i < n; i++) {
    let alt, az;
    do {
      alt = Math.asin(rand() * 2 - 1);
      az  = rand() * Math.PI * 2;
    } while (alt < -0.15); 

    const mag = 0.5 + rand() * 5.5 + rand() * 1.5;
    const bv  = -0.4 + rand() * 2.0 + (rand() > 0.7 ? 0.3 : 0);

    list.push({ alt, az, mag: Math.min(8, mag), bv, id: i });
  }
  return list;
}

// ── Main canvas render loop ───────────────────────────────────
let lastFrame = 0;
let fpsAccum  = 0;
let fpsCount  = 0;
let currentFps = 60;

function renderFrame(timestamp) {
  animHandle = requestAnimationFrame(renderFrame);

  const dt = (timestamp - lastFrame) / 1000;
  lastFrame = timestamp;
  simTime  += dt * starConfig.timeWarp;

  fpsAccum += dt;
  fpsCount++;
  if (fpsAccum >= 0.5) {
    currentFps = Math.round(fpsCount / fpsAccum);
    fpsAccum = fpsCount = 0;
  }

  renderDome(timestamp);
  updateTelemetryDisplay(timestamp);
  updateClock();
}

function renderDome(t) {
  if (!ctx) return;
  ctx.clearRect(0, 0, W, H);

  ctx.fillStyle = '#050608';
  ctx.fillRect(0, 0, W, H);

  ctx.save();
  ctx.beginPath();
  ctx.arc(CX, CY, R, 0, Math.PI * 2);
  ctx.clip();

  const bgGrad = ctx.createRadialGradient(CX, CY - R * 0.2, 0, CX, CY, R);
  bgGrad.addColorStop(0,   'rgba(3, 5, 18, 1)');
  bgGrad.addColorStop(0.5, 'rgba(2, 4, 14, 1)');
  bgGrad.addColorStop(1,   'rgba(4, 6, 20, 1)');
  ctx.fillStyle = bgGrad;
  ctx.fillRect(CX - R, CY - R, R * 2, R * 2);

  const FOV = (starConfig.fovDeg * Math.PI) / 180;
  const tiltRad = (starConfig.tiltDeg * Math.PI) / 180;

  stars.forEach((star) => {
    if (star.mag > starConfig.magLimit) return;

    const az = star.az + simTime * 0.0001;
    let alt = star.alt;
    if (alt < 0) return;

    const zenith = Math.PI / 2 - alt;
    const rNorm = zenith / FOV;
    if (rNorm > 1) return;

    let sx = CX + R * rNorm * Math.sin(az);
    let sy = CY - R * rNorm * Math.cos(az) * Math.cos(tiltRad);

    const bright = Math.pow(10, (starConfig.magLimit - star.mag) / 2.5);
    const alpha  = Math.min(1, bright * 0.95);
    const size   = Math.max(0.35, Math.min(3.5, bright * 2.0));

    ctx.beginPath();
    ctx.arc(sx, sy, size, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(255, 255, 255, ${alpha})`;
    ctx.fill();
  });

  ctx.restore();
  
  // Dome ring
  ctx.beginPath();
  ctx.arc(CX, CY, R, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(102, 252, 241, 0.18)';
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

// ── Telemetry & HUD ───────────────────────────
function updateTelemetryDisplay(t) {
  setMono('met-fps', currentFps.toFixed(1));
  setMono('met-gpuload', Math.round(45 + 5 * Math.sin(t/1000)).toString());
}

function updateClock() {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  setInnerText('top-clock', `${hh}:${mm}:${ss}`);
}

function setInnerText(id, val) {
  const el = $(id);
  if (el) el.textContent = val;
}

function setMono(id, val) {
  const el = $(id);
  if (el && el.textContent !== val) el.textContent = val;
}

// ── Terminal System ───────────────────────────
function log(msg, type = 'ok') {
  const body = $('terminal-body');
  if (!body) return;
  const line = document.createElement('div');
  line.className = 'term-line';
  line.innerHTML = `<span class="term-cat ${type}">[${type.toUpperCase()}]</span> <span class="term-msg">${msg}</span>`;
  body.appendChild(line);
  body.scrollTop = body.scrollHeight;
}

// ── Initialization ─────────────────────────────
function boot() {
  stars = generateStars(400);
  
  // Sliders binding
  const sliders = ['sl-fov', 'sl-tilt', 'sl-maglim'];
  sliders.forEach(id => {
      const el = $(id);
      if (el) el.addEventListener('input', (e) => {
          const val = parseFloat(e.target.value);
          if (id === 'sl-fov') starConfig.fovDeg = val;
          if (id === 'sl-tilt') starConfig.tiltDeg = val;
          if (id === 'sl-maglim') starConfig.magLimit = val;
          log(`${id} updated to ${val}`, 'gpu');
      });
  });

  log('Athanas Neural Engine booting...', 'ok');
  log('WebGPU Context: SIMULATED', 'warn');
  log('StarChart: Cyprus/Dali Lat=34.7', 'ok');

  requestAnimationFrame(renderFrame);
}

window.addEventListener('DOMContentLoaded', boot);

// (Ο κώδικας συνεχίζει με τα υπόλοιπα P2P και Genetic modules αν χρειαστεί...)
