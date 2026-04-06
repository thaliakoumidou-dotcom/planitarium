/* ============================================================
   ATHANAS CORE ENGINE v1.0.0 (Quantum Edition)
   Advanced Physics, Neural Mesh, WebRTC Stubs & Render Pipeline
   ============================================================ */
'use strict';

// ─── 1. CORE CONSTANTS & MATH ────────────────────────────────
const CYPRUS = { LAT: 34.92, LNG: 33.41, ELEV: 220 };
const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

const STATE = {
    isRunning: false,
    frame: 0,
    time: 0,
    timeWarp: 1,
    targetFps: 60,
    fov: 180,
    magLimit: 6.5,
    camera: { x: 0, y: 0, zoom: 1 }
};

// ─── 2. ADVANCED STAR GENERATOR (Spectral Types) ─────────────
// Υπολογισμός πραγματικών χρωμάτων αστεριών βάσει θερμοκρασίας (O,B,A,F,G,K,M)
const SPECTRAL_COLORS = {
    'O': [155, 176, 255], 'B': [170, 191, 255], 'A': [202, 215, 255],
    'F': [248, 247, 255], 'G': [255, 244, 234], 'K': [255, 210, 161], 'M': [255, 204, 111]
};

class CelestialCatalog {
    constructor(maxStars = 8000) {
        this.stars = [];
        this.generate(maxStars);
    }

    generate(count) {
        const types = Object.keys(SPECTRAL_COLORS);
        for (let i = 0; i < count; i++) {
            const ra = Math.random() * 360; // Right Ascension
            const dec = (Math.asin(Math.random() * 2 - 1)) * RAD2DEG; // Declination
            const mag = Math.random() * 10;
            const type = types[Math.floor(Math.random() * types.length)];
            const rgb = SPECTRAL_COLORS[type];
            
            this.stars.push({
                ra, dec, mag, type,
                color: `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, `, // Alpha added in render
                phase: Math.random() * Math.PI * 2
            });
        }
    }
}

// ─── 3. RENDER PIPELINE (Canvas API acting as WebGPU) ────────
class RenderPipeline {
    constructor(canvasId) {
        this.canvas = document.getElementById(canvasId);
        this.ctx = this.canvas.getContext('2d', { alpha: false });
        this.resize();
        window.addEventListener('resize', () => this.resize());
    }

    resize() {
        this.W = this.canvas.width = window.innerWidth;
        this.H = this.canvas.height = window.innerHeight;
        this.CX = this.W / 2;
        this.CY = this.H / 2;
        this.R = Math.min(this.W, this.H) * 0.45;
    }

    // Convert Equatorial (RA/Dec) to Horizontal (Alt/Az) based on Time & Location
    getAltAz(ra, dec, lst) {
        const ha = (lst - ra) * DEG2RAD;
        const decRad = dec * DEG2RAD;
        const latRad = CYPRUS.LAT * DEG2RAD;

        const sinAlt = Math.sin(decRad)*Math.sin(latRad) + Math.cos(decRad)*Math.cos(latRad)*Math.cos(ha);
        const alt = Math.asin(sinAlt);
        const cosAz = (Math.sin(decRad) - Math.sin(latRad)*sinAlt) / (Math.cos(latRad)*Math.cos(alt));
        let az = Math.acos(Math.max(-1, Math.min(1, cosAz)));
        if (Math.sin(ha) > 0) az = 2*Math.PI - az;

        return { alt, az };
    }

    draw(catalog, t) {
        // Base sky
        this.ctx.fillStyle = '#050608';
        this.ctx.fillRect(0, 0, this.W, this.H);
        
        this.ctx.save();
        this.ctx.beginPath();
        this.ctx.arc(this.CX, this.CY, this.R, 0, Math.PI * 2);
        this.ctx.clip();

        // Local Sidereal Time (Simulated based on fast forward time)
        const LST = (t * 0.05 * STATE.timeWarp) % 360;
        let visibleCount = 0;

        const fovRad = STATE.fov * DEG2RAD;

        for (let i = 0; i < catalog.stars.length; i++) {
            const s = catalog.stars[i];
            if (s.mag > STATE.magLimit) continue;

            const { alt, az } = this.getAltAz(s.ra, s.dec, LST);
            if (alt < 0) continue; // Below horizon

            const zenithDist = (Math.PI/2) - alt;
            const rNorm = zenithDist / (fovRad/2);
            if (rNorm > 1) continue;

            visibleCount++;

            const sx = this.CX + this.R * rNorm * Math.sin(az);
            const sy = this.CY - this.R * rNorm * Math.cos(az);

            // Scintillation (Twinkle) & Atmospheric Extinction
            const airmass = 1 / Math.max(0.1, Math.sin(alt));
            const extinctMag = s.mag + (0.2 * airmass);
            if (extinctMag > STATE.magLimit) continue;

            const twinkle = 1 + 0.3 * Math.sin(t * 0.005 + s.phase);
            const alpha = Math.min(1, Math.max(0, (STATE.magLimit - extinctMag) / 4)) * twinkle;
            const size = Math.max(0.5, (8 - extinctMag) * 0.4);

            this.ctx.beginPath();
            this.ctx.arc(sx, sy, size, 0, Math.PI * 2);
            this.ctx.fillStyle = s.color + alpha + ')';
            this.ctx.fill();
        }

        this.ctx.restore();
        
        // Update DOM stats
        document.getElementById('met-stars').innerText = visibleCount;
        return visibleCount;
    }
}

// ─── 4. NEURAL EVOLUTION & MESH NETWORK ──────────────────────
class NeuralMesh {
    constructor() {
        this.generation = 0;
        this.population = Array.from({length: 64}, () => Math.random());
        this.peers = [];
    }

    evolve() {
        this.generation++;
        // Dummy Genetic crossover & mutation
        this.population = this.population.map(p => {
            let n = p + (Math.random() * 0.1 - 0.05);
            return Math.max(0, Math.min(1, n));
        });
        const fitness = (this.population.reduce((a,b)=>a+b, 0) / 64).toFixed(4);
        
        document.getElementById('evo-gen').innerText = this.generation;
        document.getElementById('evo-fit').innerText = fitness;

        const map = document.getElementById('chromo-map');
        map.innerHTML = this.population.map(p => {
            const r = Math.floor(102 * p);
            const g = Math.floor(252 * p);
            const b = Math.floor(241 * p);
            return `<div class="chromo-cell" style="background: rgb(${r},${g},${b});"></div>`;
        }).join('');
    }

    updateP2P() {
        if (Math.random() > 0.95 && this.peers.length < 8) {
            const id = 'ATH-' + Math.random().toString(16).substr(2,6).toUpperCase();
            this.peers.push({ id, ping: 10 + Math.floor(Math.random()*80) });
            Terminal.log(`P2P Handshake success: [${id}]`, 'net');
        }
        
        const list = document.getElementById('peer-list');
        list.innerHTML = this.peers.map(p => `
            <div class="peer-item">
                <div class="panel-led ok"></div>
                <span class="peer-id">${p.id}</span>
                <span class="peer-ping">${p.ping}ms</span>
            </div>
        `).join('');
    }
}

// ─── 5. TERMINAL OS & COMMAND PARSER ─────────────────────────
const Terminal = {
    el: document.getElementById('terminal-body'),
    input: document.getElementById('term-input'),
    
    init() {
        this.input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                const val = this.input.value.trim();
                if (val) this.parse(val);
                this.input.value = '';
            }
        });
        this.log('ATHANAS OS Kernel loaded.', 'sys');
    },

    log(msg, cat = 'sys') {
        const line = document.createElement('div');
        line.className = 'term-line';
        line.innerHTML = `<span class="term-ts">[${new Date().toISOString().split('T')[1].slice(0,-1)}]</span> <span class="term-cat ${cat}">[${cat.toUpperCase()}]</span> ${msg}`;
        this.el.appendChild(line);
        this.el.scrollTop = this.el.scrollHeight;
    },

    parse(cmd) {
        this.log(`> ${cmd}`, 'user');
        const args = cmd.toLowerCase().split(' ');

        switch(args[0]) {
            case 'help':
                this.log('Available Commands: help, clear, status, set, reboot', 'sys');
                break;
            case 'clear':
                this.el.innerHTML = '';
                break;
            case 'status':
                this.log(`Systems Nominal. Mem: ${performance.memory ? (performance.memory.usedJSHeapSize/1048576).toFixed(2)+'MB' : 'N/A'}. Stars: 8000.`, 'sys');
                break;
            case 'set':
                if(args[1] === 'fov' && args[2]) {
                    STATE.fov = parseInt(args[2]);
                    document.getElementById('sl-fov').value = STATE.fov;
                    document.getElementById('readout-fov').innerText = STATE.fov + '°';
                    this.log(`FOV set to ${STATE.fov}`, 'sys');
                } else if(args[1] === 'warp' && args[2]) {
                    STATE.timeWarp = parseInt(args[2]);
                    document.getElementById('sl-time').value = STATE.timeWarp;
                    document.getElementById('readout-time').innerText = STATE.timeWarp + 'x';
                    this.log(`Time Warp set to ${STATE.timeWarp}x`, 'sys');
                } else {
                    this.log('Usage: set [fov|warp] [value]', 'err');
                }
                break;
            case 'reboot':
                this.log('Initiating Core Reboot...', 'warn');
                setTimeout(() => location.reload(), 1000);
                break;
            default:
                this.log(`Command not found: ${args[0]}`, 'err');
        }
    }
};

// ─── 6. MAIN SYSTEM LOOP ─────────────────────────────────────
const catalog = new CelestialCatalog(8000);
const pipeline = new RenderPipeline('webgpu-canvas');
const mesh = new NeuralMesh();
let lastTime = performance.now();
let frames = 0, fpsTimer = 0;

function engineLoop(now) {
    if (!STATE.isRunning) return;
    
    const dt = now - lastTime;
    lastTime = now;
    STATE.time += dt;
    STATE.frame++;

    // FPS Calculation
    frames++;
    fpsTimer += dt;
    if (fpsTimer > 1000) {
        document.getElementById('met-fps').innerText = frames;
        document.getElementById('met-ftime').innerText = (1000/frames).toFixed(1);
        frames = 0;
        fpsTimer = 0;
    }

    // Update Clock & JD
    const d = new Date();
    const JD = (d.getTime() / 86400000) + 2440587.5; // Julian Date calc
    document.getElementById('top-clock').innerText = `${d.toISOString().split('T')[1].split('.')[0]} | JD ${JD.toFixed(2)}`;

    // Sub-systems tick
    pipeline.draw(catalog, STATE.time);
    
    if (STATE.frame % 30 === 0) mesh.evolve();
    if (STATE.frame % 120 === 0) mesh.updateP2P();

    requestAnimationFrame(engineLoop);
}

// ─── 7. BOOT SEQUENCE ────────────────────────────────────────
function bindUI() {
    document.getElementById('sl-fov').addEventListener('input', e => {
        STATE.fov = e.target.value;
        document.getElementById('readout-fov').innerText = STATE.fov + '°';
    });
    document.getElementById('sl-maglim').addEventListener('input', e => {
        STATE.magLimit = e.target.value;
        document.getElementById('readout-mag').innerText = STATE.magLimit;
    });
    document.getElementById('sl-time').addEventListener('input', e => {
        STATE.timeWarp = e.target.value;
        document.getElementById('readout-time').innerText = STATE.timeWarp + 'x';
    });
    document.getElementById('btn-reboot').addEventListener('click', () => location.reload());
    document.getElementById('btn-emergency').addEventListener('click', () => {
        STATE.isRunning = false;
        Terminal.log('EMERGENCY ABORT INITIATED. ENGINE HALTED.', 'err');
        document.getElementById('sys-status-text').innerText = 'SYSTEM_HALTED';
        document.querySelector('.pulse-dot').style.background = 'red';
        document.querySelector('.pulse-ring').style.display = 'none';
    });
}

window.onload = () => {
    Terminal.init();
    Terminal.log('Astrometric Catalog Loaded (8000 nodes).', 'sys');
    Terminal.log('WebGPU Render Pipeline Attached.', 'sys');
    
    bindUI();
    STATE.isRunning = true;
    requestAnimationFrame(engineLoop);
    
    document.getElementById('live-ticker').innerText = 'ATHANAS QUANTUM CORE ONLINE | TRACKING CELESTIAL BODIES...';
};
