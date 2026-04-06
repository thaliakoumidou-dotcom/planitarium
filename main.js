// ============================================================
//  ATHANAS — main.ts
//  Frontend Controller: Worker bridge · Telemetry HUD · Canvas
//  Zero-Server · WebGPU · Rust/Wasm · Cyprus Planetarium
// ============================================================

'use strict';

// ── Type declarations ─────────────────────────────────────────
interface WorkerMessage {
  type: string;
  payload: Record<string, unknown>;
}

interface TelemetryFrame {
  fps:           number;
  frameTimeMs:   number;
  gpuLoadPct:    number;
  vramMiB:       number;
  shaderCallsK:  number;
  heapMiB:       number;
  gcPressure:    'LOW' | 'MED' | 'HIGH';
  inferMs:       number;
  throughputGF:  number;
  aiState:       string;
  generation:    number;
  bestFitness:   number;
  wgsConfig:     string;
  syncRatePkgS:  number;
  gpuBytesTotal: number;
}

interface Peer {
  id:         string;
  latencyMs:  number;
  color:      string;
}

interface StarConfig {
  fovDeg:     number;
  tiltDeg:    number;
  magLimit:   number;
  extinction: number;
  timeWarp:   number;
  showMW:     boolean;
  showScint:  boolean;
  showConst:  boolean;
  showGrid:   boolean;
}

// ── Query helper ──────────────────────────────────────────────
const $  = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const $$ = (sel: string): NodeListOf<Element> => document.querySelectorAll(sel);

// ── State ─────────────────────────────────────────────────────
let worker:      Worker | null = null;
let renderMode:  string = 'dome';
let peers:       Peer[] = [];
let generation:  number = 0;
let bestFitness: number = 0;
let simTime:     number = 0; // seconds, for time warp
let animHandle:  number = 0;

let starConfig: StarConfig = {
  fovDeg:     180,
  tiltDeg:    23.0,
  magLimit:   6.5,
  extinction: 0.30,
  timeWarp:   1,
  showMW:     true,
  showScint:  true,
  showConst:  false,
  showGrid:   true,
};

// Telemetry history for sparkline
const inferHistory: number[] = new Array(60).fill(0);

// ── Canvas setup ──────────────────────────────────────────────
const canvas = $<HTMLCanvasElement>('gpu-canvas');
const ctx    = canvas.getContext('2d')!;
let W = 0, H = 0, CX = 0, CY = 0, R = 0;

function resizeCanvas(): void {
  W  = canvas.width  = window.innerWidth;
  H  = canvas.height = window.innerHeight;
  CX = W / 2;
  CY = H / 2;
  R  = Math.min(W, H) * 0.46;
}

window.addEventListener('resize', resizeCanvas);
resizeCanvas();

// ── Star generation (Cyprus sky) ─────────────────────────────
interface Star {
  alt: number;   // radians
  az:  number;   // radians
  mag: number;
  bv:  number;   // B-V color index
  id:  number;   // For pseudo-stable animation seed
}

let stars: Star[] = [];

function generateStars(n: number): Star[] {
  const list: Star[] = [];
  const seed = 0xDEADBEEF;
  let s = seed;
  const rand = () => {
    s = (s ^ (s << 13)) >>> 0;
    s = (s ^ (s >> 7))  >>> 0;
    s = (s ^ (s << 17)) >>> 0;
    return s / 0xFFFFFFFF;
  };

  for (let i = 0; i < n; i++) {
    // Distribute as uniform sphere — rejection sample above horizon
    let alt: number, az: number;
    do {
      // Cosine-weighted distribution for realistic sky density
      alt = Math.asin(rand() * 2 - 1);
      az  = rand() * Math.PI * 2;
    } while (alt < -0.15); // allow slightly below horizon for realism

    // IMF-based magnitude distribution: more faint stars than bright
    const mag = 0.5 + rand() * 5.5 + rand() * 1.5;
    // B-V: weighted toward G-type (solar, yellow-white)
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

function renderFrame(timestamp: number): void {
  animHandle = requestAnimationFrame(renderFrame);

  const dt = (timestamp - lastFrame) / 1000;
  lastFrame = timestamp;
  simTime  += dt * starConfig.timeWarp;

  // FPS averaging
  fpsAccum += dt;
  fpsCount++;
  if (fpsAccum >= 0.5) {
    currentFps = Math.round(fpsCount / fpsAccum);
    fpsAccum   = fpsCount = 0;
  }

  renderDome(timestamp);
  updateTelemetryDisplay(timestamp);
  updateClock();
}

function renderDome(t: number): void {
  ctx.clearRect(0, 0, W, H);

  // ── Absolute black background ──
  ctx.fillStyle = '#050608';
  ctx.fillRect(0, 0, W, H);

  // ── Dome clip region ──────────────────────────────────────
  ctx.save();
  ctx.beginPath();
  ctx.arc(CX, CY, R, 0, Math.PI * 2);
  ctx.clip();

  // ── Deep space gradient ───────────────────────────────────
  const bgGrad = ctx.createRadialGradient(CX, CY - R * 0.2, 0, CX, CY, R);
  bgGrad.addColorStop(0,   'rgba(3, 5, 18, 1)');
  bgGrad.addColorStop(0.5, 'rgba(2, 4, 14, 1)');
  bgGrad.addColorStop(1,   'rgba(4, 6, 20, 1)');
  ctx.fillStyle = bgGrad;
  ctx.fillRect(CX - R, CY - R, R * 2, R * 2);

  // ── Milky Way band ─────────────────────────────────────────
  if (starConfig.showMW) {
    const mwAngle = Math.PI / 6 + simTime * 0.00002;
    const mwGrad  = ctx.createLinearGradient(
      CX + Math.cos(mwAngle) * R, CY + Math.sin(mwAngle) * R,
      CX - Math.cos(mwAngle) * R, CY - Math.sin(mwAngle) * R
    );
    mwGrad.addColorStop(0,    'rgba(160,140,220,0)');
    mwGrad.addColorStop(0.35, 'rgba(145,125,200,0.05)');
    mwGrad.addColorStop(0.5,  'rgba(155,135,215,0.09)');
    mwGrad.addColorStop(0.65, 'rgba(145,125,200,0.05)');
    mwGrad.addColorStop(1,    'rgba(160,140,220,0)');
    ctx.fillStyle = mwGrad;
    ctx.fillRect(CX - R, CY - R, R * 2, R * 2);
  }

  // ── Alt/Az grid ────────────────────────────────────────────
  if (starConfig.showGrid) {
    ctx.strokeStyle = 'rgba(102, 252, 241, 0.06)';
    ctx.lineWidth   = 0.5;
    // Altitude circles: 30°, 60° above horizon
    for (let alt = 0; alt <= 90; alt += 30) {
      const altR = alt / 90; // normalized radius from horizon
      const circR = R * (1 - altR);
      ctx.beginPath();
      ctx.arc(CX, CY, circR, 0, Math.PI * 2);
      ctx.stroke();
    }
    // Azimuth spokes every 30°
    for (let az = 0; az < 360; az += 30) {
      const rad = (az - 90) * Math.PI / 180;
      ctx.beginPath();
      ctx.moveTo(CX, CY);
      ctx.lineTo(CX + R * Math.cos(rad), CY + R * Math.sin(rad));
      ctx.stroke();
    }
    // Cardinal labels
    ctx.fillStyle = 'rgba(102, 252, 241, 0.35)';
    ctx.font      = '10px "JetBrains Mono", monospace';
    ctx.textAlign = 'center';
    const cardinals = ['N', 'E', 'S', 'W'];
    const cAngles   = [-90, 0, 90, 180];
    for (let i = 0; i < 4; i++) {
      const rad = cAngles[i] * Math.PI / 180;
      const lx  = CX + (R + 14) * Math.cos(rad);
      const ly  = CY + (R + 14) * Math.sin(rad) + 3;
      ctx.fillText(cardinals[i], lx, ly);
    }
  }

  // ── Stars ─────────────────────────────────────────────────
  let visibleCount = 0;
  const FOV = (starConfig.fovDeg * Math.PI) / 180;
  const tiltRad = (starConfig.tiltDeg * Math.PI) / 180;

  stars.forEach((star) => {
    if (star.mag > starConfig.magLimit) return;

    // Apply time warp: stars precess slowly
    const az  = star.az + simTime * 0.0001;
    let alt = star.alt;
    if (alt < 0) return;

    // Atmospheric extinction
    const airmass = Math.min(40, 1 / Math.max(Math.sin(alt), 0.025));
    const extMag  = star.mag + starConfig.extinction * (airmass - 1);
    if (extMag > starConfig.magLimit + 0.5) return;

    // Equidistant azimuthal fisheye projection
    const zenith  = Math.PI / 2 - alt;
    const rNorm   = zenith / FOV;
    if (rNorm > 1) return;

    // Apply dome tilt
    const screenAz = az;
    let sx = CX + R * rNorm * Math.sin(screenAz);
    let sy = CY - R * rNorm * Math.cos(screenAz) * Math.cos(tiltRad)
                + R * rNorm * Math.sin(tiltRad) * 0.3;

    // Clip to dome circle
    const dx = sx - CX, dy = sy - CY;
    if (Math.sqrt(dx*dx + dy*dy) > R * 0.98) return;

    // Brightness
    const bright = Math.pow(10, (starConfig.magLimit - extMag) / 2.5);
    const alpha  = Math.min(1, bright * 0.95);
    const size   = Math.max(0.35, Math.min(3.5, bright * 2.0));

    // B-V to RGB
    const bv = star.bv;
    let sr: number, sg: number, sb: number;
    if      (bv < -0.1) { sr = 155; sg = 176; sb = 255; }
    else if (bv <  0.3) { sr = 200; sg = 215; sb = 255; }
    else if (bv <  0.7) { sr = 255; sg = 244; sb = 230; }
    else if (bv <  1.2) { sr = 255; sg = 200; sb = 130; }
    else                { sr = 255; sg = 130; sb =  80; }

    // Scintillation
    let scint = 1.0;
    if (starConfig.showScint && alt < 0.5) {
      // Low-alt stars twinkle more (higher airmass)
      const twinkleAmp = Math.min(0.25, 0.08 * airmass);
      scint = 1 + twinkleAmp * Math.sin(t * 0.06 + star.id * 7.3);
    }

    // Draw star glow
    const grd = ctx.createRadialGradient(sx, sy, 0, sx, sy, size * 3 * scint);
    grd.addColorStop(0,   `rgba(${sr},${sg},${sb},${alpha})`);
    grd.addColorStop(0.35,`rgba(${sr},${sg},${sb},${alpha * 0.5})`);
    grd.addColorStop(1,   `rgba(${sr},${sg},${sb},0)`);

    ctx.beginPath();
    ctx.arc(sx, sy, size * 3 * scint, 0, Math.PI * 2);
    ctx.fillStyle = grd;
    ctx.fill();

    // Bright star diffraction spike (mag < 2)
    if (star.mag < 2.5) {
      const spikeLen = size * 12 * scint;
      ctx.strokeStyle = `rgba(${sr},${sg},${sb},${alpha * 0.3})`;
      ctx.lineWidth   = 0.5;
      ctx.beginPath();
      ctx.moveTo(sx - spikeLen, sy); ctx.lineTo(sx + spikeLen, sy);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(sx, sy - spikeLen); ctx.lineTo(sx, sy + spikeLen);
      ctx.stroke();
    }

    visibleCount++;
  });

  ctx.restore();

  // ── Dome ring ─────────────────────────────────────────────
  ctx.beginPath();
  ctx.arc(CX, CY, R, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(102, 252, 241, 0.18)';
  ctx.lineWidth   = 1.5;
  ctx.stroke();

  // Outer glow ring
  ctx.beginPath();
  ctx.arc(CX, CY, R + 2, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(102, 252, 241, 0.05)';
  ctx.lineWidth   = 6;
  ctx.stroke();

  // Update star count
  setInnerText('inf-stars', String(visibleCount));
  setInnerText('inf-maglim', starConfig.magLimit.toFixed(1));
}

// ── Telemetry simulation & display ───────────────────────────
let gpuLoad   = 0;
let vram      = 0;
let heapMiB   = 0;
let shaderKs  = 0;
let inferMs   = 0;
let throughGF = 0;
let syncRate  = 0;
const AI_STATES = ['INFERRING', 'COMPUTING', 'EVOLVING', 'SYNCING', 'IDLE'];
let aiStateIdx  = 0;
let aiStateTick = 0;

function updateTelemetryDisplay(t: number): void {
  // Smooth simulated metrics
  gpuLoad   = lerp(gpuLoad,   45 + 30 * Math.sin(t * 0.00065) + 10 * Math.random(), 0.05);
  vram      = lerp(vram,      14  +  6 * Math.sin(t * 0.0005),  0.03);
  heapMiB   = lerp(heapMiB,  28  + 12 * Math.cos(t * 0.0008),  0.04);
  shaderKs  = lerp(shaderKs,180  + 40 * Math.sin(t * 0.0012), 0.06);
  inferMs   = lerp(inferMs, 1.2  + 0.7 * Math.sin(t * 0.0009), 0.04);
  throughGF = lerp(throughGF, 3.4 + 1.2 * Math.cos(t * 0.0007), 0.04);
  syncRate  = peers.length > 0 ? lerp(syncRate, 24 + 8 * Math.sin(t * 0.002), 0.08) : 0;

  // Update sparkline history
  inferHistory.push(inferMs);
  inferHistory.shift();
  drawSparkline();

  // AI state cycling
  aiStateTick++;
  if (aiStateTick > 180 + Math.random() * 120) {
    aiStateIdx  = (aiStateIdx + 1) % AI_STATES.length;
    aiStateTick = 0;
  }
  const aiState = AI_STATES[aiStateIdx];

  // Left panel
  setMono('met-fps',        currentFps.toFixed(1));
  setMono('met-frametime',  (1000 / Math.max(1, currentFps)).toFixed(2));
  setMono('met-gpuload',    Math.round(gpuLoad).toString());
  setMono('met-vram',       Math.round(vram).toString());
  setMono('met-shaders',    Math.round(shaderKs) + 'K');
  setMono('met-heap',       Math.round(heapMiB).toString());
  setMono('met-infer',      inferMs.toFixed(2));
  setMono('met-throughput', throughGF.toFixed(1));
  setMono('met-ai-state',   aiState);
  setMono('met-syncrate',   Math.round(syncRate).toString());

  // Gauge bars
  setPct('gauge-gpu',  'gpu-util-pct',  gpuLoad);
  setPct('gauge-wasm', 'wasm-heap-pct', (heapMiB / 512) * 100);

  // Bottom bar
  setInnerText('chip-fps',   currentFps.toFixed(0));
  setInnerText('chip-gpumem',Math.round(vram).toFixed(1) + ' MiB');
  setInnerText('chip-ai',    aiState);

  // Color the GPU load dynamically
  const gpuEl = $('met-gpuload');
  gpuEl.className = 'metric-value ' + (gpuLoad > 80 ? 'err' : gpuLoad > 60 ? 'warn' : 'ok');
  const gcEl  = $('met-gc');
  gcEl.textContent  = heapMiB > 420 ? 'HIGH' : heapMiB > 300 ? 'MED' : 'LOW';
  gcEl.className    = 'metric-value ' + (heapMiB > 420 ? 'err' : heapMiB > 300 ? 'warn' : 'ok');
}

// ── Sparkline renderer ─────────────────────────────────────────
function drawSparkline(): void {
  const sc  = $<HTMLCanvasElement>('sparkline-infer');
  const sctx = sc.getContext('2d');
  if (!sctx) return;
  const sw = sc.width  = sc.offsetWidth * devicePixelRatio;
  const sh = sc.height = sc.offsetHeight * devicePixelRatio;
  sctx.clearRect(0, 0, sw, sh);

  const min   = Math.min(...inferHistory) * 0.9;
  const max   = Math.max(...inferHistory, 0.1) * 1.1;
  const range = max - min || 1;

  // Draw filled area
  sctx.beginPath();
  inferHistory.forEach((v, i) => {
    const x = (i / (inferHistory.length - 1)) * sw;
    const y = sh - ((v - min) / range) * sh * 0.85 - sh * 0.05;
    i === 0 ? sctx.moveTo(x, y) : sctx.lineTo(x, y);
  });
  sctx.lineTo(sw, sh); sctx.lineTo(0, sh); sctx.closePath();
  const grad = sctx.createLinearGradient(0, 0, 0, sh);
  grad.addColorStop(0,   'rgba(102,252,241,0.35)');
  grad.addColorStop(1,   'rgba(102,252,241,0.02)');
  sctx.fillStyle = grad;
  sctx.fill();

  // Draw line
  sctx.beginPath();
  inferHistory.forEach((v, i) => {
    const x = (i / (inferHistory.length - 1)) * sw;
    const y = sh - ((v - min) / range) * sh * 0.85 - sh * 0.05;
    i === 0 ? sctx.moveTo(x, y) : sctx.lineTo(x, y);
  });
  sctx.strokeStyle = 'rgba(102,252,241,0.8)';
  sctx.lineWidth   = 1.5 * devicePixelRatio;
  sctx.stroke();
}

// ── Clock ─────────────────────────────────────────────────────
function updateClock(): void {
  const now = new Date();
  // UTC+2 for Cyprus
  const cy  = new Date(now.getTime() + 2 * 3600_000);
  const hh  = String(cy.getUTCHours()).padStart(2, '0');
  const mm  = String(cy.getUTCMinutes()).padStart(2, '0');
  const ss  = String(cy.getUTCSeconds()).padStart(2, '0');
  setInnerText('top-clock', `${hh}:${mm}:${ss}`);

  // Julian Date
  const jd = now.getTime() / 86_400_000 + 2_440_587.5;
  setInnerText('top-jd', jd.toFixed(5));
}

// ── Web Worker bridge ─────────────────────────────────────────
function initWorker(): void {
  try {
    worker = new Worker('./workers/athanas_worker.js', { type: 'module' });
    worker.onmessage = handleWorkerMessage;
    worker.onerror   = (e) => log(`Worker error: ${e.message}`, 'err');
    log('Web Worker spawned — athanas_worker.js', 'gpu');
  } catch (e) {
    log(`Worker init failed: ${e}`, 'err');
    $('chip-wasm').textContent  = 'WORKER FAIL';
    $('chip-wasm').className    = 'chip-val err';
  }
}

function handleWorkerMessage(event: MessageEvent<WorkerMessage>): void {
  const { type, payload } = event.data;

  switch (type) {
    case 'STATUS':
      handleWorkerStatus(payload as { code: string; data: unknown });
      break;
    case 'NEURAL_RESULT':
      handleNeuralResult(payload as { execMs: number; fitness: number; totalGpuBytes: number });
      break;
    case 'EVOLVE_RESULT':
      handleEvolveResult(payload as { generation: number; bestFitness: number; workgroupSizeX: number; workgroupSizeY: number });
      break;
    case 'P2P_WEIGHTS_RECEIVED':
      handleP2PWeights(payload as { peerId: string });
      break;
    case 'DOME_FRAME_DONE':
      break;
    case 'ERROR':
      log(`[WORKER] ${(payload as { message: string }).message}`, 'err');
      break;
  }
}

function handleWorkerStatus(payload: { code: string; data: unknown }): void {
  const { code, data } = payload;
  const msgs: Record<string, string> = {
    INIT_START:       'Neural engine boot sequence started',
    WASM_OK:          'Rust/Wasm module compiled and loaded',
    PREFLIGHT_OK:     'WebGPU preflight checks passed',
    INIT_COMPLETE:    'GPU device acquired — pipeline initialized',
    P2P_READY:        'WebRTC P2P layer initialized',
    P2P_CHANNEL_OPEN: 'DataChannel established with peer',
    SHUTDOWN_COMPLETE:'Engine shutdown complete',
  };
  log(msgs[code] || `${code}: ${JSON.stringify(data)}`, code.startsWith('P2P') ? 'p2p' : 'gpu');

  if (code === 'PREFLIGHT_OK') {
    const d = data as { maxBufferSize: number; hasTimestamps: boolean; hasShaderF16: boolean };
    const mib = Math.round(d.maxBufferSize / (1024 * 1024));
    log(`maxBufferSize=${mib}MiB · timestamps=${d.hasTimestamps} · f16=${d.hasShaderF16}`, 'gpu');
    $('chip-webgpu').textContent = 'ACTIVE';
    $('chip-webgpu').className   = 'chip-val ok';
  }
  if (code === 'WASM_OK') {
    $('chip-wasm').textContent = 'ACTIVE';
    $('chip-wasm').className   = 'chip-val ok';
    flashStatus('WASM LOADED');
  }
}

function handleNeuralResult(payload: { execMs: number; fitness: number; totalGpuBytes: number }): void {
  log(`Inference: ${payload.execMs.toFixed(2)}ms · fitness=${payload.fitness.toFixed(1)} · GPU=${Math.round(payload.totalGpuBytes/1024)}KB`, 'gen');
  flashValue('met-infer');
}

function handleEvolveResult(payload: { generation: number; bestFitness: number; workgroupSizeX: number; workgroupSizeY: number }): void {
  generation  = payload.generation;
  bestFitness = payload.bestFitness;

  setMono('met-gen',     String(generation).padStart(4, '0'));
  setMono('met-fitness', bestFitness.toFixed(2));
  setMono('met-wgs',     `${payload.workgroupSizeX}×${payload.workgroupSizeY}`);
  $('evo-gen').textContent = String(generation);
  $('evo-fit').textContent = bestFitness.toFixed(2);

  updateChromoMap();
  log(`Gen ${generation}: best_fitness=${bestFitness.toFixed(2)} · wgs=${payload.workgroupSizeX}×${payload.workgroupSizeY}`, 'gen');
  flashValue('met-gen');
  flashValue('met-fitness');
  flashStatus(`GEN ${generation} EVOLVED`);
}

function handleP2PWeights(payload: { peerId: string }): void {
  log(`Weights received from ${payload.peerId} · syncing`, 'p2p');
}

// ── Genetic chromosome map ────────────────────────────────────
function initChromoMap(): void {
  const map = $('chromo-map');
  map.innerHTML = '';
  for (let i = 0; i < 32; i++) {
    const cell  = document.createElement('div');
    cell.className = 'chromo-cell';
    cell.id        = `chromo-${i}`;
    cell.setAttribute('title', `Chromosome ${i}`);
    cell.addEventListener('click', () => {
      log(`Chromosome ${i} selected for inspection`, 'gen');
    });
    map.appendChild(cell);
  }
}

function updateChromoMap(): void {
  for (let i = 0; i < 32; i++) {
    const el   = $(`chromo-${i}`);
    if (!el) continue;
    const fit  = Math.random() * bestFitness;
    const norm = Math.min(1, fit / (bestFitness || 1));
    const r    = Math.floor(20  + norm * 40);
    const g    = Math.floor(60  + norm * 140);
    const b    = Math.floor(40  + norm * 30);
    el.style.background = `rgba(${r},${g},${b},0.4)`;
    el.classList.toggle('best', i === generation % 32);
    el.textContent = i === generation % 32 ? '★' : '';

    // Estimate ETA
    const remaining  = Math.max(0, 100 - generation);
    const etaGens    = remaining > 0 ? `~${remaining} gen` : 'CONVERGED';
    setInnerText('evo-div',  (Math.random() * 0.4 + 0.3).toFixed(2));
    setInnerText('evo-eta',  etaGens);
  }
}

// ── Peer management ────────────────────────────────────────────
function addPeer(id: string, latencyMs: number, color: string): void {
  peers.push({ id, latencyMs, color });
  renderPeerList();
  flashStatus(`P2P PEER JOINED: ${id}`);
  log(`Peer connected: ${id} (${latencyMs}ms RTT)`, 'p2p');
}

function renderPeerList(): void {
  const list = $('peer-list');
  if (peers.length === 0) {
    list.innerHTML = '<div class="peer-item offline"><div class="peer-dot"></div><span class="peer-id">Awaiting peers...</span></div>';
    return;
  }
  list.innerHTML = peers.map(p => `
    <div class="peer-item online">
      <div class="peer-dot" style="background:${p.color};box-shadow:0 0 6px ${p.color}"></div>
      <span class="peer-id">${p.id}</span>
      <span class="peer-latency">${p.latencyMs}ms</span>
    </div>`).join('');
}

// ── Terminal system ────────────────────────────────────────────
const LOG_MAX = 120;
const logHistory: Array<{ ts: string; cat: string; msg: string; type: string }> = [];

function log(msg: string, type: 'ok' | 'warn' | 'err' | 'gpu' | 'gen' | 'p2p' | string = 'ok'): void {
  const now = new Date();
  const ts  = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}.${String(now.getMilliseconds()).padStart(3,'0')}`;

  const catMap: Record<string, string> = {
    ok:  '[SYS]',
    warn:'[WARN]',
    err: '[ERR]',
    gpu: '[GPU]',
    gen: '[GENE]',
    p2p: '[P2P]',
  };
  const cat = catMap[type] ?? '[SYS]';

  logHistory.push({ ts, cat, msg, type });
  if (logHistory.length > LOG_MAX) logHistory.shift();

  // DOM update
  const body = $('terminal-body');
  const line = document.createElement('div');
  line.className = 'term-line';
  line.innerHTML = `
    <span class="term-ts">${ts}</span>
    <span class="term-cat ${type}">${cat}</span>
    <span class="term-msg">${escapeHtml(msg)}</span>`;
  body.appendChild(line);
  // Keep to last 40 DOM lines
  while (body.children.length > 40) body.removeChild(body.firstChild!);
  body.scrollTop = body.scrollHeight;

  // Live ticker (bottom bar)
  const ticker = $('live-ticker');
  ticker.textContent = msg;
  ticker.style.animation = 'none';
  void ticker.offsetWidth; // reflow
  ticker.style.animation = '';
}

function escapeHtml(s: string): string {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── Terminal commands ──────────────────────────────────────────
const COMMANDS: Record<string, (args: string[]) => void> = {
  help: () => {
    const cmds = Object.keys(COMMANDS).join(', ');
    log(`Available: ${cmds}`, 'ok');
  },
  clear: () => {
    $('terminal-body').innerHTML = '';
    logHistory.length = 0;
  },
  status: () => {
    log(`Engine: ACTIVE · GPU: ${Math.round(gpuLoad)}% · FPS: ${currentFps} · Heap: ${Math.round(heapMiB)}MiB`, 'ok');
  },
  evolve: () => {
    handleEvolveCommand();
  },
  peers: () => {
    if (peers.length === 0) log('No peers connected', 'warn');
    else peers.forEach(p => log(`${p.id} — ${p.latencyMs}ms`, 'p2p'));
  },
  dome: (args) => {
    if (args[0] === 'fov')   { starConfig.fovDeg = parseFloat(args[1]) || 180; log(`FOV set to ${starConfig.fovDeg}°`, 'ok'); }
    if (args[0] === 'tilt')  { starConfig.tiltDeg = parseFloat(args[1]) || 23; log(`Tilt set to ${starConfig.tiltDeg}°`, 'ok'); }
    if (args[0] === 'warp')  { starConfig.timeWarp = parseFloat(args[1]) || 1; log(`Time warp: ${starConfig.timeWarp}×`, 'ok'); }
  },
  version: () => log('Athanas v0.9.1-alpha · WebGPU · Rust/Wasm · Cyprus Planetarium', 'gpu'),
  shutdown: () => {
    worker?.postMessage({ type: 'SHUTDOWN' });
    log('Shutdown command sent to worker', 'warn');
  },
};

$<HTMLInputElement>('term-input').addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key !== 'Enter') return;
  const input = e.target as HTMLInputElement;
  const raw   = input.value.trim();
  if (!raw) return;

  log(`> ${raw}`, 'gpu');
  const [cmd, ...args] = raw.split(/\s+/);
  if (cmd && COMMANDS[cmd]) COMMANDS[cmd](args);
  else log(`Unknown command: ${cmd}. Type 'help'.`, 'warn');

  input.value = '';
});

// ── Mode selector ─────────────────────────────────────────────
function initModeSelector(): void {
  $$('.mode-opt').forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = (btn as HTMLElement).dataset.mode ?? 'dome';
      switchMode(mode);
    });
  });
}

function switchMode(mode: string): void {
  renderMode = mode;

  $$('.mode-opt').forEach(btn => {
    const active = (btn as HTMLElement).dataset.mode === mode;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-checked', String(active));
  });

  const labels: Record<string, string> = {
    dome:    'DOME · FISHEYE PROJECTION',
    neural:  'NEURAL RENDER · GEMM ACTIVE',
    genetic: 'GENETIC EVOLUTION · OPTIMIZING',
  };
  setInnerText('mode-label', labels[mode] ?? '');

  const chip = $('chip-ai');
  chip.textContent = mode === 'dome' ? 'PROJECTING' : mode === 'neural' ? 'INFERRING' : 'EVOLVING';

  log(`Mode switched: ${mode.toUpperCase()}`, 'gpu');
  flashStatus(`MODE: ${(labels[mode] ?? mode).toUpperCase()}`);
}

// ── Slider bindings ───────────────────────────────────────────
function initSliders(): void {
  bindSlider('sl-fov',       'out-fov',      (v) => { starConfig.fovDeg     = v; return `${v}°`; });
  bindSlider('sl-tilt',      'out-tilt',     (v) => { starConfig.tiltDeg    = v; return `${v.toFixed(1)}°`; });
  bindSlider('sl-maglim',    'out-maglim',   (v) => { starConfig.magLimit   = v; return v.toFixed(1); });
  bindSlider('sl-extinct',   'out-extinct',  (v) => { starConfig.extinction = v; return v.toFixed(2); });
  bindSlider('sl-timewarp',  'out-timewarp', (v) => { starConfig.timeWarp   = v; return `${v}×`; });
}

function bindSlider(sliderId: string, outputId: string, onChange: (v: number) => string): void {
  const sl = $<HTMLInputElement>(sliderId);
  const out = $(outputId);
  if (!sl || !out) return;
  sl.addEventListener('input', () => {
    const v = parseFloat(sl.value);
    out.textContent = onChange(v);
    flashValue(outputId);
  });
}

// ── Toggle buttons ────────────────────────────────────────────
function initToggles(): void {
  const toggleMap: Record<string, keyof StarConfig> = {
    'tog-milkyway':    'showMW',
    'tog-scintil':     'showScint',
    'tog-constellation':'showConst',
    'tog-grid':        'showGrid',
  };
  Object.entries(toggleMap).forEach(([id, key]) => {
    const btn = $(id);
    if (!btn) return;
    btn.addEventListener('click', () => {
      (starConfig[key] as boolean) = !(starConfig[key] as boolean);
      btn.classList.toggle('active', starConfig[key] as boolean);
      log(`${key}: ${starConfig[key] ? 'ON' : 'OFF'}`, 'ok');
    });
  });
}

// ── Terminal drag ─────────────────────────────────────────────
function initTerminalDrag(): void {
  const term   = $('terminal-window');
  const handle = $('term-handle');
  let dragging = false, ox = 0, oy = 0;

  handle.addEventListener('mousedown', (e: MouseEvent) => {
    dragging = true;
    const rect = term.getBoundingClientRect();
    ox = e.clientX - rect.left;
    oy = e.clientY - rect.top;
    e.preventDefault();
  });
  document.addEventListener('mousemove', (e: MouseEvent) => {
    if (!dragging) return;
    term.style.left   = `${Math.max(0, Math.min(W - 200, e.clientX - ox))}px`;
    term.style.bottom = 'auto';
    term.style.top    = `${Math.max(0, Math.min(H - 100, e.clientY - oy))}px`;
  });
  document.addEventListener('mouseup', () => { dragging = false; });

  // Minimize / Close
  $('term-minimize').addEventListener('click', () => {
    const body  = $('terminal-body');
    const input = $<HTMLElement>('terminal-input-row') ?? $('term-input').parentElement!;
    const collapsed = term.style.height === '36px';
    term.style.height    = collapsed ? '' : '36px';
    body.style.display   = collapsed ? '' : 'none';
    if (input) input.style.display = collapsed ? '' : 'none';
  });

  $('term-close').addEventListener('click', () => {
    term.setAttribute('hidden', '');
    $('btn-open-terminal').removeAttribute('hidden');
    log('Terminal hidden', 'ok');
  });

  $('btn-open-terminal').addEventListener('click', () => {
    term.removeAttribute('hidden');
    $('btn-open-terminal').setAttribute('hidden', '');
  });
}

// ── Evolution overlay ─────────────────────────────────────────
function initEvoOverlay(): void {
  $('btn-evolve').addEventListener('click', () => {
    $('evolution-overlay').removeAttribute('hidden');
    $('evolution-overlay').removeAttribute('aria-hidden');
    handleEvolveCommand();
  });

  $('evo-close').addEventListener('click', () => {
    $('evolution-overlay').setAttribute('hidden', '');
    $('evolution-overlay').setAttribute('aria-hidden', 'true');
  });
}

function handleEvolveCommand(): void {
  if (worker) {
    worker.postMessage({ type: 'EVOLVE' });
  } else {
    // Simulate evolution without worker
    generation++;
    bestFitness = Math.min(999, bestFitness + Math.random() * 20 + 5);
    handleEvolveResult({
      generation,
      bestFitness,
      workgroupSizeX: [8, 16, 32, 64][Math.floor(Math.random() * 4)],
      workgroupSizeY: [8, 16, 32, 64][Math.floor(Math.random() * 4)],
    });
  }
}

// ── Emergency halt ────────────────────────────────────────────
function initEmergencyHalt(): void {
  $('btn-emergency').addEventListener('click', () => {
    if (!confirm('HALT all neural processes?')) return;
    worker?.postMessage({ type: 'SHUTDOWN' });
    cancelAnimationFrame(animHandle);
    log('EMERGENCY HALT — all processes terminated', 'err');
    $('system-status-indicator').querySelector('.pulse-dot')!.setAttribute('style', 'background:var(--red-warn);box-shadow:0 0 8px var(--red-warn)');
    $('status-text').textContent = 'HALTED';
    $('status-text').style.color = 'var(--red-warn)';
    flashStatus('EMERGENCY HALT ENGAGED');
  });
}

// ── P2P connect ───────────────────────────────────────────────
function initP2PButton(): void {
  $('btn-p2p').addEventListener('click', () => {
    log('P2P connect requested — simulating peer join', 'p2p');
    setTimeout(() => addPeer(`browser-0x${Math.floor(Math.random()*0xFFFF).toString(16).toUpperCase()}`, Math.floor(20 + Math.random() * 80), '#3FB950'), 1200);
  });
}

// ── Status flash (top bar) ────────────────────────────────────
let statusTimeout: ReturnType<typeof setTimeout> | null = null;
function flashStatus(msg: string): void {
  const el = $('status-text');
  el.textContent = msg;
  if (statusTimeout) clearTimeout(statusTimeout);
  statusTimeout = setTimeout(() => { el.textContent = 'NOMINAL'; }, 3000);
}

// ── DOM helpers ───────────────────────────────────────────────
function setInnerText(id: string, val: string): void {
  const el = $(id);
  if (el) el.textContent = val;
}

function setMono(id: string, val: string): void {
  const el = $(id);
  if (el && el.textContent !== val) {
    el.textContent = val;
  }
}

function flashValue(id: string): void {
  const el = $(id);
  if (!el) return;
  el.classList.remove('value-updated');
  void el.offsetWidth;
  el.classList.add('value-updated');
}

function setPct(barId: string, labelId: string, pct: number): void {
  const bar   = $(barId);
  const label = $(labelId);
  const clamped = Math.min(100, Math.max(0, pct));
  if (bar)   bar.style.width = `${clamped.toFixed(1)}%`;
  if (label) label.textContent = `${Math.round(clamped)}%`;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

// ── Boot sequence ─────────────────────────────────────────────
function boot(): void {
  stars = generateStars(400);

  initModeSelector();
  initSliders();
  initToggles();
  initTerminalDrag();
  initEvoOverlay();
  initEmergencyHalt();
  initP2PButton();
  initChromoMap();
  initWorker();

  // Staggered boot log
  const bootMsgs: Array<[string, string, number]> = [
    ['Athanas Neural Engine v0.9.1-alpha booting', 'ok',  0],
    ['SharedArrayBuffer: ENABLED — cross-origin isolated', 'gpu', 320],
    ['Rust/Wasm module: 16-byte alignment verified', 'ok', 680],
    ['WebGPU preflight: maxBufferSize=268MiB · timestamps=YES', 'gpu', 1050],
    ['WGSL shaders compiled: neural_gemm_main + dome_vertex/fragment', 'gpu', 1450],
    ['StarChart initialized: Cyprus Lat=34.9°N Lon=33.0°E', 'ok', 1850],
    ['GeneticOptimizer: pop=32 · mut=5% · tile=16×16', 'gen', 2200],
    ['Fisheye dome projection: equidistant azimuthal · FOV=180°', 'ok', 2600],
    ['P2P WebRTC layer: ICE servers configured · DTLS ready', 'p2p', 3000],
    ['Engine ready — all systems nominal', 'ok', 3400],
  ];

  bootMsgs.forEach(([msg, type, delay]) => {
    setTimeout(() => log(msg, type as 'ok' | 'gpu' | 'gen' | 'p2p'), delay);
  });

  // Simulate first peer joining
  setTimeout(() => addPeer('browser-0xCF42', 38, '#66FCF1'), 4200);
  setTimeout(() => {
    handleEvolveResult({
      generation:     1,
      bestFitness:    42.3,
      workgroupSizeX: 16,
      workgroupSizeY: 16,
    });
  }, 5000);

  // Start render loop
  lastFrame = performance.now();
  animHandle = requestAnimationFrame(renderFrame);
}

// ── Entry point ───────────────────────────────────────────────
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}

export {};
['StarChart initialized: Cyprus Lat=34.7', 'ok', 1800],
    ['SYSTEM READY - STAGGERED BOOT COMPLETE', 'ok', 2200]
  ];

  bootMsgs.forEach(([msg, type, delay]) => {
    setTimeout(() => log(msg, type), delay);
  });

  // Έναρξη του Render Loop
  requestAnimationFrame(renderFrame);
}

// Εκτέλεση του Boot μόλις φορτώσει η σελίδα
window.addEventListener('DOMContentLoaded', boot);
