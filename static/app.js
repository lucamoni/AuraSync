let config = {};
let fixtures = [];
let ws;
let isDirty = false;
let autoLightsActive = false;
let lastAutoBeatTime = 0;
let autoColorIndex = 0;
let autoMovementPhase = 0;
let studioVisualizer;
let canvas, ctx;
let isMasterTab = true;

// ═══════════════════════════════════════════════════════════════════
// TOAST NOTIFICATION SYSTEM — replaces native alert() everywhere
// ═══════════════════════════════════════════════════════════════════
function notify(message, type = 'info', duration = 5000) {
    let container = document.getElementById('toast-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toast-container';
        document.body.appendChild(container);
    }

    const icons = { success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️' };
    const titles = { success: 'Successo', error: 'Errore', warning: 'Attenzione', info: 'Info' };

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `
        <span class="toast-icon">${icons[type] || 'ℹ️'}</span>
        <div class="toast-body">
            <div class="toast-title">${titles[type] || 'Info'}</div>
            <div class="toast-msg">${message}</div>
        </div>
        <button class="toast-close" onclick="this.closest('.toast').remove()">×</button>
        <div class="toast-progress" style="animation-duration: ${duration}ms;"></div>
    `;
    toast.onclick = (e) => { if (!e.target.classList.contains('toast-close')) toast.remove(); };
    container.appendChild(toast);

    setTimeout(() => {
        toast.classList.add('toast-out');
        setTimeout(() => toast.remove(), 350);
    }, duration);
}

// Override native alert so all existing alert() calls use the toast system
window._nativeAlert = window.alert;
window.alert = (msg) => notify(String(msg), 'info', 6000);

// Custom confirm dialog — returns a Promise<boolean>
// Replaces native confirm() which is suppressed by pywebview/iframe contexts
function confirmDialog(message, title = 'Conferma') {
    return new Promise((resolve) => {
        // Remove any existing dialog
        document.getElementById('_aurasync_confirm')?.remove();

        const overlay = document.createElement('div');
        overlay.id = '_aurasync_confirm';
        overlay.style.cssText = `
            position:fixed; top:0; left:0; width:100%; height:100%;
            background:rgba(0,0,0,0.6); backdrop-filter:blur(6px);
            z-index:999999; display:flex; align-items:center; justify-content:center;
        `;

        overlay.innerHTML = `
            <div style="
                background:#111827; border:1px solid rgba(255,255,255,0.15);
                border-radius:16px; padding:2rem 2.5rem; max-width:400px; width:90%;
                box-shadow:0 20px 60px rgba(0,0,0,0.8); text-align:center;
                animation:toast-in 0.25s ease both;
            ">
                <div style="font-size:2rem; margin-bottom:0.75rem;">⚠️</div>
                <h3 style="color:#fff; margin:0 0 0.5rem; font-size:1rem;">${title}</h3>
                <p style="color:#aaa; font-size:0.85rem; margin:0 0 1.5rem;">${message}</p>
                <div style="display:flex; gap:12px; justify-content:center;">
                    <button id="_confirm_no" style="
                        padding:8px 24px; border-radius:8px; border:1px solid rgba(255,255,255,0.2);
                        background:rgba(255,255,255,0.05); color:#aaa; cursor:pointer; font-size:0.85rem;
                    ">Annulla</button>
                    <button id="_confirm_yes" style="
                        padding:8px 24px; border-radius:8px; border:none;
                        background:linear-gradient(135deg,#ff4455,#cc0020); color:#fff;
                        cursor:pointer; font-size:0.85rem; font-weight:600;
                    ">Conferma</button>
                </div>
            </div>
        `;

        document.body.appendChild(overlay);

        overlay.querySelector('#_confirm_yes').onclick = () => { overlay.remove(); resolve(true); };
        overlay.querySelector('#_confirm_no').onclick = () => { overlay.remove(); resolve(false); };
        overlay.onclick = (e) => { if (e.target === overlay) { overlay.remove(); resolve(false); } };
    });
}

// Override native confirm so all existing confirm() calls use the custom dialog
// Note: window.confirm must return synchronously, so we only override explicit calls
// via confirmDialog(). Existing confirm() calls in our code will be migrated below.
window._nativeConfirm = window.confirm;
window.confirm = () => { console.warn('Use confirmDialog() instead of confirm()'); return false; };

async function init() {
    window.AuraDesigner = new LightingDesigner();
    await loadConfig();
    setupWebSocket();
    renderSettings();
    setupTabs();
    if (document.getElementById('audio-input-select')) await loadAudioDevices();
    if (document.getElementById('venue-builder-canvas')) setupVenueBuilder();

    const saveBtn = document.getElementById('save-btn');
    if (saveBtn) saveBtn.onclick = saveConfig;

    const loadBtn = document.getElementById('load-workspace-btn');
    if (loadBtn) loadBtn.onclick = loadWorkspace;

    const addLfoBtn = document.getElementById('add-lfo-btn');
    if (addLfoBtn) addLfoBtn.onclick = addNewLFO;

    const autoLightsBtn = document.getElementById('auto-lights-btn');
    if (autoLightsBtn) autoLightsBtn.onclick = toggleAutoLights;

    // Professional Tabs Initialization
    ['functions', 'console', 'setup', 'auto', 'manual', 'studio'].forEach(id => {
        const btn = document.getElementById(`tab-${id}`);
        if (btn) btn.onclick = () => window.switchTab(`tab-${id}`);
    });

    // Professional Console Init
    if (window.AuraConsole) {
        AuraConsole.init();
    }

    // 3D Visualizer Setup
    if (document.getElementById('visualizer-container')) {
        studioVisualizer = new AuraVisualizer3D('visualizer-container');
    }

    // Hydrate State from Server
    try {
        const envRes = await fetch('/api/env/status');
        const env = await envRes.json();
        if (env) {
            autoLightsActive = !!env.auto_lights_enabled;
            const alBtn = document.getElementById('auto-lights-btn');
            if (alBtn) {
                alBtn.classList.toggle('active', autoLightsActive);
                alBtn.innerText = `AUTO LIGHTS: ${autoLightsActive ? 'ON' : 'OFF'}`;
            }
        }
    } catch (e) {
        console.warn("[Init] Failed to hydrate environment status:", e);
    }

    // Auto-load workspace if saved
    if (config && config.last_workspace_path) {
        const wpInput = document.getElementById('workspace-path');
        if (wpInput) wpInput.value = config.last_workspace_path;
        await loadWorkspace(config.last_workspace_path);
    }

    // Auto-restore saved fixture library
    try {
        const libRes = await fetch('/api/fixture/library');
        const libData = await libRes.json();
        if (libData.status === 'success' && libData.fixtures && libData.fixtures.length > 0) {
            // NOTE: We only populate the Setup tab library panel here.
            // Active fixture instances (with universe/address) are loaded via workspace or project.
            renderFixtureLibrary(libData.fixtures, `Libreria salvata — ${libData.count} fixture`);
            console.log(`[Fixtures] Restored ${libData.count} definitions to library.`);
        }
    } catch (e) { console.warn('[Fixtures] Could not restore library:', e); }

    // Auto-restore active instances from localStorage (if any) — SYNC WITH LIVE STUDIO
    try {
        const saved = localStorage.getItem('aurasync_fixtures');
        if (saved) {
            const parsed = JSON.parse(saved);
            if (Array.isArray(parsed) && parsed.length > 0) {
                fixtures = parsed;
                console.log(`[Studio 3D] Restored ${fixtures.length} fixtures from LocalStorage cache.`);
                if (typeof studioVisualizer !== 'undefined' && studioVisualizer) {
                    studioVisualizer.clearFixtures();
                    fixtures.forEach(f => studioVisualizer.addFixture(f));
                }
            }
        }
    } catch (e) {
        console.warn("[Studio 3D] Failed to restore cached layout:", e);
    }

    setTimeout(() => {
        try {
            const saved = localStorage.getItem('aurasync_fixtures');
            if (saved) {
                const parsed = JSON.parse(saved);
                if (parsed && Array.isArray(parsed) && parsed.length > 0) {
                    fixtures = parsed;
                    renderFixtures();
                    if (studioVisualizer) {
                        studioVisualizer.clearFixtures();
                        fixtures.forEach(f => studioVisualizer.addFixture(f));
                    }
                    console.log(`[Fixtures] Restored ${fixtures.length} active instances from localStorage.`);
                }
            }
        } catch (e) { console.warn('[Fixtures] Could not restore instances:', e); }
    }, 100);

    // Waveform canvas setup + dedicated 60fps draw loop
    const waveCanvas = document.getElementById('auto-waveform-canvas');
    if (waveCanvas) {
        canvas = waveCanvas;
        ctx = canvas.getContext('2d');
        window.waveHistory = [];
        window.beatHistory = [];
        startWaveformLoop();
    }

    // Spotify Setup
    const spotBtn = document.getElementById('spotify-connect-btn');
    if (spotBtn) {
        spotBtn.onclick = async () => {
            const cidEl = document.getElementById('spotify-client-id');
            const secEl = document.getElementById('spotify-client-secret');
            if (!cidEl || !secEl || !cidEl.value || !secEl.value) {
                return alert("Inserisci Client ID e Secret di Spotify API");
            }

            const cid = cidEl.value;
            const sec = secEl.value;
            spotBtn.innerText = "Redirecting...";

            try {
                const res = await fetch('/spotify/auth', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ client_id: cid, client_secret: sec })
                });
                const data = await res.json();
                if (data.status === 'success' && data.auth_url) {
                    window.location.href = data.auth_url;
                } else {
                    alert(data.message || "Impossibile recuperare URL di auth");
                    spotBtn.innerText = "Connect Spotify";
                }
            } catch (e) {
                console.error("Spotify Auth Error:", e);
                spotBtn.innerText = "Connect Spotify";
            }
        };
    }

    const sPause = document.getElementById('spotify-pause');
    const sPlay = document.getElementById('spotify-play');
    const sNext = document.getElementById('spotify-next');

    // No longer using switchTab for multi-page structure
    // window.switchTab('tab-auto');
}

// Spotify Playback Controls
const spotifyControl = (action, value = null) => {
    let payload = { action: action };
    const track = window.currentSpotifyTrack;

    if (action === 'toggle') {
        payload.action = (track && track.is_playing) ? 'pause' : 'play';
    } else if (action === 'seek') {
        if (track && track.duration_ms) {
            payload.position_ms = Math.floor((parseInt(value, 10) / 1000) * track.duration_ms);
            // Optimistic update
            track.progress_ms = payload.position_ms;
            track._lastUpdate = Date.now();
        }
    } else if (action === 'shuffle') {
        payload.state = !(track && track.shuffle_state);
    } else if (action === 'repeat') {
        const states = ['off', 'context', 'track'];
        let currentIdx = track ? states.indexOf(track.repeat_state) : 0;
        payload.state = states[(currentIdx + 1) % 3];
    }

    fetch('/spotify/control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
};

// Exit Safety Popup - Removed as it was too intrusive for this environment
// window.onbeforeunload = function (e) {
//     if (isDirty) { ... }
// };

// ═══════════════════════════════════════════════════════════════════
// UI & AUDIO CANVAS SETUP
// ═══════════════════════════════════════════════════════════════════

let selectedFixtureId = null;
function resizeCanvas() {
    if (canvas) {
        const w = canvas.parentElement.clientWidth || 800;
        const h = canvas.parentElement.clientHeight || 120;
        if (canvas.width !== w || canvas.height !== h) {
            canvas.width = w;
            canvas.height = h;
        }
    }
}
window.resizeCanvas = resizeCanvas;
async function loadAudioDevices() {
    const res = await fetch('/api/audio/devices');
    const devices = await res.json();
    const select = document.getElementById('audio-input-select');
    select.innerHTML = devices.map(d => `<option value="${d.id}">${d.name} (${d.channels} ch)</option>`).join('');

    // Auto-select BlackHole if available (user's virtual audio from Spotify)
    const blackholeIdx = devices.findIndex(d => d.name.toLowerCase().includes('blackhole'));
    if (blackholeIdx >= 0) {
        select.selectedIndex = blackholeIdx;
        const bhDevice = devices[blackholeIdx];
        await fetch(`/api/audio/device/${bhDevice.id}`, { method: 'POST' });
        console.log(`[Audio] Auto-selected BlackHole: index=${bhDevice.id}`);
    }

    // Wire up the change event
    select.onchange = async () => {
        const index = select.value;
        await fetch(`/api/audio/device/${index}`, { method: 'POST' });
        console.log(`Switched audio device to index ${index}`);
    };

    // Wire up latency offset
    const latencySlider = document.getElementById('latency-offset');
    const latencyVal = document.getElementById('latency-val');
    if (latencySlider && latencyVal) {
        latencySlider.oninput = () => {
            const val = parseInt(latencySlider.value);
            latencyVal.innerText = `${val}ms`;
            fetch('/api/audio/latency', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ delay_ms: Math.max(0, val) })
            });
        };
    }

    // Wire up DMX Output Mode
    const dmxSelect = document.getElementById('dmx-output-select');
    if (dmxSelect) {
        dmxSelect.onchange = () => {
            const mode = dmxSelect.value;
            fetch('/api/dmx/mode', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ mode: mode })
            });
            console.log(`Switched DMX Output Mode to: ${mode}`);
        };
    }

    // Wire up BPM Sync Mode
    const bpmSyncSelect = document.getElementById('bpm-sync-select');
    if (bpmSyncSelect) {
        bpmSyncSelect.onchange = () => {
            const mode = bpmSyncSelect.value;
            fetch('/api/bpm/sync_mode', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ mode: mode })
            });
            console.log(`Switched BPM Sync Mode to: ${mode}`);
        };
    }
}

// Spotify Update Loop for smooth progress
let spotifyProgressInterval = setInterval(() => {
    const track = window.currentSpotifyTrack;
    if (track && track.is_playing && track.duration_ms > 0 && track._lastUpdate) {
        // Interpolate progress locally
        const delta = Date.now() - track._lastUpdate;
        const currentMs = Math.min(track.progress_ms + delta, track.duration_ms);

        const pBar = document.getElementById('spotify-progress');
        const tCur = document.getElementById('spotify-time-current');

        if (pBar && document.activeElement !== pBar) {
            pBar.value = (currentMs / track.duration_ms) * 1000;
        }

        const fmt = (ms) => {
            const totalSec = Math.floor(ms / 1000);
            const m = Math.floor(totalSec / 60);
            const s = (totalSec % 60).toString().padStart(2, '0');
            return `${m}:${s}`;
        };
        if (tCur) tCur.innerText = fmt(currentMs);
    }
}, 100);

// 1. Navigation & UI
window.switchTab = function (tabId) {
    if (!tabId) return;
    const cleanId = tabId.replace('tab-', '');
    const tabBtn = document.getElementById(`tab-${cleanId}`);
    if (!tabBtn) return;

    document.querySelectorAll('.tab-btn').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.mode-container').forEach(c => c.classList.remove('active'));

    tabBtn.classList.add('active');
    const target = document.getElementById(`${cleanId}-workspace`);
    if (target) target.classList.add('active');

    // Toggle 3D Designer HUD visibility: Only in Live Auto
    const designerHud = document.querySelector('.visualizer-designer-hud');
    if (designerHud) {
        designerHud.style.display = (cleanId === 'auto') ? 'flex' : 'none';
    }

    // Resize waveform canvas whenever Auto Mode becomes visible
    if (cleanId === 'auto') {
        setTimeout(window.resizeCanvas || (() => { }), 50);
    }

    // Trigger resize observer for 3D Visualizer (Global)
    if (typeof studioVisualizer !== 'undefined' && studioVisualizer.renderer) {
        setTimeout(() => {
            const vizContainer = document.getElementById('visualizer-container');
            if (vizContainer) {
                const w = vizContainer.clientWidth;
                const h = vizContainer.clientHeight;
                studioVisualizer.renderer.setSize(w, h);
                studioVisualizer.camera.aspect = w / h;
                studioVisualizer.camera.updateProjectionMatrix();
            }
        }, 150);
    }
};

function setupTabs() {
    const tabs = document.querySelectorAll('.tab-btn');
    tabs.forEach(tab => {
        tab.onclick = () => window.switchTab(tab.id);
    });
}

// 1. Loading Management
function showLoading(msg = "Caricamento in corso...") {
    const overlay = document.getElementById('loading-overlay');
    const msgEl = document.getElementById('loading-msg');
    if (overlay) {
        msgEl.innerText = msg;
        overlay.classList.remove('hidden');
    }
}

function hideLoading() {
    const overlay = document.getElementById('loading-overlay');
    if (overlay) overlay.classList.add('hidden');
}

// 2. API Communications
async function loadConfig() {
    try {
        const res = await fetch('/api/config');
        config = await res.json();
    } catch (e) { console.error("Config log error:", e); }
}

async function browseFile() {
    try {
        const res = await fetch('/api/browse');
        const data = await res.json();
        if (data.status === 'success') {
            const wpInput = document.getElementById('workspace-path');
            if (wpInput) wpInput.value = data.path;
            await loadWorkspace(data.path);
        }
    } catch (e) { console.error("Browse failed:", e); }
}

async function browseFixture() {
    try {
        const res = await fetch('/api/browse/fixture');
        const data = await res.json();
        if (data.status === 'success') {
            // Legacy single-file support (fallback if needed)
            console.log("Single fixture selected:", data.path);
        }
    } catch (e) { console.error("Browse fixture failed:", e); }
}

async function browseFixtureFolder() {
    try {
        const res = await fetch('/api/browse/folder');
        const data = await res.json();
        if (data.status === 'success') {
            showLoading(`Caricamento fixture da: ${data.path}...`);
            await loadFixtureFolder(data.path);
            hideLoading();
        }
    } catch (e) {
        hideLoading();
        alert("Errore durante la selezione della cartella");
    }
}

async function loadFixtureFolder(folderPath) {
    try {
        const res = await fetch('/api/fixture/load-folder', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: folderPath })
        });
        const data = await res.json();
        if (data.status === 'success') {
            renderFixtureLibrary(data.fixtures, `Cartella .qxf — ${data.count} fixture caricate`);
            if (data.errors.length > 0) {
                console.warn("Fixture non caricate:", data.errors);
            }
        } else {
            alert("Errore: " + data.message);
        }
    } catch (e) {
        alert("Errore di rete durante il caricamento fixture");
    }
}

async function extractFixtures() {
    const wpInput = document.getElementById('workspace-path');
    const qxwPath = wpInput ? wpInput.value : null;
    showLoading("Estrazione fixture dal progetto QLC+...");
    try {
        const res = await fetch('/api/fixture/load-qxw', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: qxwPath || null })
        });
        const data = await res.json();
        hideLoading();
        if (data.status === 'success') {
            renderFixtureLibrary(data.fixtures, `Progetto: ${data.source} — ${data.count} fixture`);
        } else {
            alert("Errore: " + data.message + "\n\nAssicurati di aver caricato prima un progetto QLC+ (.qxw).");
        }
    } catch (e) {
        hideLoading();
        alert("Errore di rete durante l'estrazione fixture");
    }
}

function renderFixtureLibrary(fixtures, title) {
    fixtureLibrary = fixtures;
    isDirty = true;

    const panel = document.getElementById('fixture-library-panel');
    const titleEl = document.getElementById('fixture-lib-title');
    const listEl = document.getElementById('fixture-library-list');

    if (panel) panel.style.display = 'block';
    if (titleEl) titleEl.textContent = title;

    if (listEl) {
        listEl.innerHTML = fixtures.map((f, i) => {
            const name = f.name || f.model || 'Fixture ' + (i + 1);
            const manufacturer = f.manufacturer || '';
            const channels = f.channels || (f.channels && Object.keys(f.channels).length) || '?';
            const universe = f.universe !== undefined ? `U${f.universe}` : '';
            const address = f.address !== undefined ? `ch.${f.address}` : '';
            const modes = f.modes ? Object.keys(f.modes).join(', ') : (f.mode || '');

            return `
        <div style="background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; padding: 10px;">
            <div style="font-weight: 600; font-size: 0.8rem; color: var(--accent-color, #00d2ff); margin-bottom: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${name}</div>
            <div style="font-size: 0.7rem; color: #888;">${manufacturer}</div>
            <div style="display: flex; gap: 6px; margin-top: 6px; flex-wrap: wrap;">
                <span style="background: rgba(0,210,255,0.15); padding: 2px 6px; border-radius: 4px; font-size: 0.65rem;">${channels} ch</span>
                ${universe ? `<span style="background: rgba(255,255,255,0.08); padding: 2px 6px; border-radius: 4px; font-size: 0.65rem;">${universe}</span>` : ''}
                ${address ? `<span style="background: rgba(255,255,255,0.08); padding: 2px 6px; border-radius: 4px; font-size: 0.65rem;">${address}</span>` : ''}
            </div>
            ${modes ? `<div style="font-size: 0.65rem; color: #666; margin-top: 4px;">${modes}</div>` : ''}
        </div>`;
        }).join('');

        // Auto-save to server for persistence across reloads
        fetch('/api/fixture/library/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fixtures })
        }).then(r => r.json()).then(d => {
            if (d.status === 'success') console.log(`[Fixtures] Saved ${d.count} fixtures to server.`);
        }).catch(e => console.warn('[Fixtures] Save failed:', e));
    }
}

function clearFixtureLibrary() {
    fixtureLibrary = [];
    const panel = document.getElementById('fixture-library-panel');
    const list = document.getElementById('fixture-library-list');
    if (panel) panel.style.display = 'none';
    if (list) list.innerHTML = '';
    isDirty = true;
}

async function loadFixture() {
    // Legacy single-file load (kept for compatibility)
    const path = document.getElementById('fixture-path') ? document.getElementById('fixture-path').value : '';
    if (!path) return alert("Scegli prima un file .qxf");
    showLoading("Analisi fixture QLC+...");
    try {
        const res = await fetch('/api/fixture/load', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path })
        });
        const data = await res.json();
        if (data.status === 'success') {
            renderFixtureLibrary([data.fixture], `Fixture: ${data.fixture.model}`);
        } else {
            alert("Errore: " + data.message);
        }
    } catch (e) {
        alert("Errore di rete");
    }
    hideLoading();
}


async function saveProject() {
    const name = document.getElementById('project-name').value || "unnamed";
    showLoading(`Salvataggio ${name}...`);
    try {
        const payload = {
            name: name,
            ui_state: {
                fixtureSettings: typeof fixtureSettings !== 'undefined' ? fixtureSettings : {},
                fixturesLayout: fixtures
            }
        };
        const res = await fetch('/api/project/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (data.status === 'success') {
            notify(`Progetto salvato: ${data.file}`, 'success');
            isDirty = false;
        } else {
            notify(`Errore salvataggio: ${data.message}`, 'error');
        }
    } catch (e) { notify('Errore salvataggio progetto', 'error'); }
    hideLoading();
}

async function loadProject() {
    const name = document.getElementById('project-name').value;
    if (!name) return alert("Inserisci il nome del progetto da caricare.");
    showLoading(`Caricamento sessione ${name}...`);
    try {
        const res = await fetch('/api/project/load', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: name + ".aurasync" })
        });
        const data = await res.json();
        if (data.status === 'success') {
            fixtures = data.state.workspace_path ? fixtures : []; // Handle empty
            if (data.state.ui_state) {
                if (data.state.ui_state.fixtureSettings) {
                    fixtureSettings = data.state.ui_state.fixtureSettings;
                    localStorage.setItem('qlc_fixture_settings', JSON.stringify(fixtureSettings));
                }
                if (data.state.ui_state.fixturesLayout) {
                    localStorage.setItem('aurasync_fixtures', JSON.stringify(data.state.ui_state.fixturesLayout));
                }
            }
            await restoreEnvironment(); // Refresh all
            notify('Sessione ripristinata!', 'success');
        } else {
            notify('Progetto non trovato!', 'warning');
        }
    } catch (e) { notify('Errore caricamento progetto', 'error'); }
    hideLoading();
}

async function restoreEnvironment() {
    showLoading("Ripristino configurazione...");
    try {
        const res = await fetch('/api/env/status');
        const data = await res.json();

        config = data.config;
        fixtures = (data.workspace && data.workspace.fixtures) ? data.workspace.fixtures : [];

        if (data.workspace && data.workspace.file) {
            const filename = data.workspace.file.split('/').pop();
            const projectLink = document.getElementById('project-link');
            if (projectLink) {
                projectLink.innerText = filename;
                projectLink.href = "#";
            }
            const pathInput = document.getElementById('workspace-path');
            if (pathInput) pathInput.value = data.workspace.file;
        }

        // IMPORTANT: Sync full fixture data to localStorage for Live Studio window
        localStorage.setItem('aurasync_fixtures', JSON.stringify(fixtures));

        if (typeof renderFixtures === 'function') renderFixtures();

        if (typeof studioVisualizer !== 'undefined' && studioVisualizer) {
            studioVisualizer.clearFixtures();
            fixtures.forEach(f => studioVisualizer.addFixture(f));
        }

        if (typeof renderLFOs === 'function') renderLFOs();
        if (typeof renderSettings === 'function') renderSettings();

        if (config.last_tab) {
            switchTab(config.last_tab);
        }
    } catch (e) {
        console.error("Restoration failed:", e);
    }
    hideLoading();
}

async function exportToQLC() {
    try {
        window.location.href = '/api/workspace/export/qxw';
    } catch (e) {
        alert("Errore durante l'esportazione verso QLC+.");
    }
}

async function loadWorkspace(qxwPath = null) {
    const wpInput = document.getElementById('workspace-path');
    const path = qxwPath || (wpInput ? wpInput.value : null);

    if (!path) {
        if (wpInput) alert("Inserisci un percorso valido!");
        return;
    }
    if (!path.toLowerCase().endsWith('.qxw')) {
        return alert("Il percorso deve puntare a un file .qxw di QLC+.\n\nPer importare le fixture usa i pulsanti 'Da progetto QLC+' o 'Sfoglia cartella .qxf'.");
    }

    showLoading("Analisi Progetto QLC+...");

    try {
        const res = await fetch('/api/workspace/load', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path })
        });

        const data = await res.json();

        // Artificial delay so the loading screen is readable
        await new Promise(r => setTimeout(r, 800));

        hideLoading();

        if (data.status === 'success') {
            fixtures = data.fixtures;
            renderFixtures();

            // Populate QLC+ functions/effects panel
            if (data.functions && data.functions.length > 0) {
                qlcFunctions = data.functions;
                renderFunctions();
            }

            // Populate 3D Scene
            if (studioVisualizer) {
                studioVisualizer.clearFixtures();
                fixtures.forEach(f => studioVisualizer.addFixture(f));
            }

            // Persist to localStorage for Live Studio sync
            saveFixturesToLocal();

            const fnCount = data.functions ? data.functions.length : 0;
            notify(`Workspace caricato: ${fixtures.length} fixture — ${fnCount} funzioni QLC+`, 'success');
        } else {
            notify('Errore caricamento: ' + data.message, 'error');
        }
    } catch (e) {
        hideLoading();
        console.error('loadWorkspace Exception:', e);
        notify('Errore JS: ' + (e.message || e), 'error', 8000);
    }
}

// 2.5 Persistance
function saveFixturesToLocal() {
    if (fixtures && fixtures.length > 0) {
        localStorage.setItem('aurasync_fixtures', JSON.stringify(fixtures));
        console.log(`[Storage] Saved ${fixtures.length} fixtures. Sample:`, fixtures[0]?.name, "Details:", !!fixtures[0]?.channel_details);
    }
}

// 3. Rendering
let qlcFunctions = []; // Parsed QLC+ functions/effects

function renderFixtures() {
    const container = document.getElementById('fixture-list');
    if (!container) return; // Guard against missing element
    if (fixtures.length === 0) {
        container.innerHTML = '<p class="empty-msg">Nessuna fixture trovata.</p>';
        return;
    }

    container.innerHTML = fixtures.map(f => {
        const chCount = typeof f.channels === 'number' ? f.channels
            : Array.isArray(f.channels) ? f.channels.length
                : (f.channels && typeof f.channels === 'object' ? Object.keys(f.channels).length : 1);
        return `
        <div class="fixture-item card" onclick="selectFixture('${f.id}')" style="cursor:pointer;">
            <div style="display:flex; justify-content:space-between; align-items:center;">
                <h3 style="margin:0; font-size:0.85rem;">${f.name}</h3>
                <span style="font-size:0.65rem; background:rgba(0,210,255,0.15); padding:2px 6px; border-radius:4px;">${chCount}ch</span>
            </div>
            <p style="margin:4px 0; font-size:0.7rem; color:#888;">U${f.universe ?? 0} · ch${f.address ?? '?'} · ${f.mode || f.model || ''}</p>
        </div>`;
    }).join('');
}

// Virtual Console state
const fnControlType = {};  // {fnId: 'button'|'flash'|'fader'}
const fnActiveState = {};  // {fnId: true|false}
const fnFaderValue = {};   // {fnId: 0-100}

// Section color palette (cycles through on new path)
const SECTION_COLORS = [
    '#c0392b', '#8e44ad', '#2980b9', '#16a085', '#d35400', '#27ae60', '#2c3e50', '#c0392b'
];

function switchManualTab(tab) {
    const dmxScreen = document.getElementById('manual-screen-dmx');
    const fxScreen = document.getElementById('manual-screen-fx');
    const dmxBtn = document.getElementById('manual-tab-dmx');
    const fxBtn = document.getElementById('manual-tab-fx');

    if (dmxScreen) dmxScreen.style.display = tab === 'dmx' ? 'block' : 'none';
    if (fxScreen) fxScreen.style.display = tab === 'fx' ? 'block' : 'none';

    const activeStyle = 'border:1px solid rgba(0,210,255,0.5); background:rgba(0,210,255,0.18); color:#00d2ff;';
    const inactiveStyle = 'border:1px solid rgba(255,255,255,0.1); background:rgba(255,255,255,0.05); color:#666;';

    if (dmxBtn) dmxBtn.style.cssText = dmxBtn.style.cssText.replace(/border:.*?;.*?color:[^;]+;/g, '') + (tab === 'dmx' ? activeStyle : inactiveStyle);
    if (fxBtn) fxBtn.style.cssText = fxBtn.style.cssText.replace(/border:.*?;.*?color:[^;]+;/g, '') + (tab === 'fx' ? activeStyle : inactiveStyle);
}

function renderFunctions() {
    const container = document.getElementById('qlc-functions-list');
    if (!container) return;
    if (!qlcFunctions || qlcFunctions.length === 0) {
        container.innerHTML = '<p class="empty-msg" style="grid-column:1/-1; font-size:0.8rem;">Carica un progetto .qxw per vedere gli effetti.</p>';
        return;
    }

    // Apply filter
    const filterEl = document.getElementById('fn-filter');
    const filter = filterEl ? filterEl.value : '';
    const fns = filter ? qlcFunctions.filter(f => f.type === filter) : qlcFunctions;

    // Group by Path (or 'Generali' if empty)
    const groups = {};
    fns.forEach(fn => {
        const group = fn.path || fn.type || 'Generali';
        if (!groups[group]) groups[group] = [];
        groups[group].push(fn);
    });

    let colorIdx = 0;
    let html = '<div style="width:100%;">';

    for (const [groupName, functions] of Object.entries(groups)) {
        const color = SECTION_COLORS[colorIdx++ % SECTION_COLORS.length];
        html += `
        <div style="margin-bottom: 18px; break-inside: avoid;">
            <div style="background:${color}; padding: 6px 12px; border-radius: 6px 6px 0 0; display:flex; align-items:center; justify-content:space-between;">
                <span style="font-weight:700; font-size:0.8rem; letter-spacing:1px; color:#fff;">${groupName.toUpperCase()}</span>
                <div style="display:flex; gap:4px;">
                    <button onclick="allGroupOff('${groupName}')" style="background:rgba(0,0,0,0.3); border:none; color:rgba(255,255,255,0.7); padding:2px 7px; border-radius:4px; cursor:pointer; font-size:0.65rem;">■ STOP</button>
                </div>
            </div>
            <div style="background:rgba(0,0,0,0.25); border:1px solid ${color}44; border-top:none; border-radius:0 0 6px 6px; padding:10px; display:flex; flex-wrap:wrap; gap:8px;">
        `;

        functions.forEach(fn => {
            const ctrlType = fnControlType[fn.id] || 'button';
            const isActive = fnActiveState[fn.id] || false;
            const fval = fnFaderValue[fn.id] || 0;
            const shortName = fn.name.length > 22 ? fn.name.substring(0, 20) + '…' : fn.name;

            if (ctrlType === 'fader') {
                html += `
                <div class="vc-fader-wrap" oncontextmenu="vcContextMenu(event,'${fn.id}','${escHtml(fn.name)}')" title="${fn.name}">
                    <div style="font-size:0.62rem; color:#aaa; text-align:center; margin-bottom:4px; max-width:70px; word-break:break-word; line-height:1.2;">${shortName}</div>
                    <div style="display:flex; flex-direction:column; align-items:center; gap:4px;">
                        <span style="font-size:0.7rem; color:#fff; font-weight:600;">${fval}</span>
                        <input type="range" min="0" max="100" value="${fval}" orient="vertical"
                            style="writing-mode:vertical-lr; direction:rtl; height:80px; width:20px; accent-color:${color};"
                            oninput="vcFaderChange('${fn.id}', this.value)"
                            onchange="vcFaderChange('${fn.id}', this.value)">
                    </div>
                    <div style="font-size:0.55rem; color:#555; text-align:center; margin-top:2px;">DMX</div>
                </div>`;
            } else if (ctrlType === 'flash') {
                html += `
                <button class="vc-btn vc-flash" style="background:${isActive ? color : 'rgba(0,0,0,0.4)'}; border:2px solid ${color}; color:#fff;"
                    onmousedown="vcFlashOn('${fn.id}')"
                    onmouseup="vcFlashOff('${fn.id}')"
                    onmouseleave="vcFlashOff('${fn.id}')"
                    ontouchstart="vcFlashOn('${fn.id}')"
                    ontouchend="vcFlashOff('${fn.id}')"
                    oncontextmenu="vcContextMenu(event,'${fn.id}','${escHtml(fn.name)}')"
                    title="FLASH – ${fn.name}">${shortName}<div style="font-size:0.5rem; color:rgba(255,255,255,0.5); margin-top:2px;">FLASH</div></button>`;
            } else {
                // Default: toggle button
                html += `
                <button class="vc-btn" style="background:${isActive ? color : 'rgba(0,0,0,0.4)'}; border:2px solid ${isActive ? color : 'rgba(255,255,255,0.12)'}; color:${isActive ? '#fff' : '#bbb'};"
                    onclick="vcToggle('${fn.id}')"
                    oncontextmenu="vcContextMenu(event,'${fn.id}','${escHtml(fn.name)}')"
                    id="vc-btn-${fn.id}"
                    title="${fn.name}">${shortName}</button>`;
            }
        });

        html += `</div></div>`;
    }

    html += '</div>';
    container.innerHTML = html;
    container.style.display = 'block';  // override grid for this full-width layout
}

function escHtml(s) { return (s || '').replace(/'/g, '&apos;').replace(/"/g, '&quot;'); }

function vcToggle(id) {
    fnActiveState[id] = !fnActiveState[id];
    sendFnCommand(id, fnActiveState[id] ? 'on' : 'off');
    renderFunctions();
}

function vcFlashOn(id) { fnActiveState[id] = true; sendFnCommand(id, 'on'); }
function vcFlashOff(id) { fnActiveState[id] = false; sendFnCommand(id, 'off'); }

function vcFaderChange(id, val) {
    fnFaderValue[id] = parseInt(val);
    // Update just the value display without full re-render
    const wrap = document.querySelector(`[oncontextmenu*="'${id}'"] span`);
    if (wrap) wrap.innerText = val;
    sendFnCommand(id, 'value', parseInt(val));
}

function allGroupOff(groupName) {
    qlcFunctions.filter(f => (f.path || f.type || 'Generali') === groupName).forEach(f => {
        fnActiveState[f.id] = false;
        sendFnCommand(f.id, 'off');
    });
    renderFunctions();
}

async function sendFnCommand(id, action, value) {
    try {
        await fetch('/api/qlc/function', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id, action, value })
        });
    } catch (e) { console.warn('VC command failed:', e); }
}

// Context menu to change control type
function vcContextMenu(event, id, name) {
    event.preventDefault();
    // Remove existing menu
    const existing = document.getElementById('vc-ctx-menu');
    if (existing) existing.remove();

    const types = [
        { key: 'button', label: '🔘 Pulsante Toggle' },
        { key: 'flash', label: '⚡ Flash (premi e tieni)' },
        { key: 'fader', label: '🎚 Fader 0–100' },
    ];
    const menu = document.createElement('div');
    menu.id = 'vc-ctx-menu';
    menu.style.cssText = `position:fixed; left:${event.clientX}px; top:${event.clientY}px; z-index:9999;
        background:#1a1a2e; border:1px solid rgba(255,255,255,0.15); border-radius:8px;
        padding:6px; min-width:180px; box-shadow:0 8px 32px rgba(0,0,0,0.6);`;

    menu.innerHTML = `<div style="font-size:0.7rem; color:#888; padding:4px 8px; border-bottom:1px solid rgba(255,255,255,0.1); margin-bottom:4px;">${name}</div>` +
        types.map(t => `
        <div onclick="vcSetType('${id}','${t.key}')" style="padding:7px 12px; font-size:0.75rem; cursor:pointer; border-radius:5px;
            background:${(fnControlType[id] || 'button') === t.key ? 'rgba(0,210,255,0.15)' : 'transparent'};
            color:${(fnControlType[id] || 'button') === t.key ? '#00d2ff' : '#ccc'};">
            ${t.label}
        </div>`).join('');

    document.body.appendChild(menu);
    setTimeout(() => document.addEventListener('click', () => menu.remove(), { once: true }), 10);
}

function vcSetType(id, type) {
    fnControlType[id] = type;
    document.getElementById('vc-ctx-menu')?.remove();
    renderFunctions();
}

async function triggerQlcFunction(id) {
    sendFnCommand(id, 'on');
}

const getGroupIcon = (group) => {
    if (!group) return '⚪';
    const g = group.toLowerCase();
    if (g.includes('intensity')) return '💡';
    if (g.includes('colour')) return '🎨';
    if (g.includes('pan')) return '↔️';
    if (g.includes('tilt')) return '↕️';
    if (g.includes('shutter') || g.includes('strobe')) return '⚡';
    if (g.includes('speed')) return '⏱️';
    if (g.includes('gobo')) return '🌀';
    if (g.includes('prism')) return '💎';
    if (g.includes('effect')) return '✨';
    if (g.includes('maintenance') || g.includes('control')) return '🛠️';
    if (g.includes('beam')) return '🔦';
    return '⚪';
};

function selectFixture(id) {
    selectedFixtureId = id;
    const fixture = fixtures.find(f => f.id == id);
    if (!fixture) return;
    const container = document.getElementById('active-controls');

    let chCount = 1;
    if (typeof fixture.channels === 'number') chCount = fixture.channels;
    else if (Array.isArray(fixture.channels)) chCount = fixture.channels.length;
    else if (fixture.channels && typeof fixture.channels === 'object' && Object.keys(fixture.channels).length > 0) chCount = Object.keys(fixture.channels).length;
    else if (fixture.channels) chCount = parseInt(fixture.channels);

    const startAddress = parseInt(fixture.address) || 1;
    let slidersHTML = '';

    for (let i = 0; i < chCount; i++) {
        const dmxChannel = startAddress + i;
        let label = `Ch ${i + 1}`;
        let icon = '⚪';

        if (fixture.channel_details && fixture.channel_details[i]) {
            const detail = fixture.channel_details[i];
            if (typeof detail === 'object' && detail.name !== undefined) {
                label = detail.name;
                icon = getGroupIcon(detail.group);
            } else if (typeof detail === 'string') {
                label = detail;
            }
        } else if (Array.isArray(fixture.channels) && fixture.channels[i]) {
            label = fixture.channels[i];
        } else if (fixture.channels && typeof fixture.channels === 'object' && Object.keys(fixture.channels)[i]) {
            label = Object.keys(fixture.channels)[i];
        }

        if (label.length > 18) label = label.substring(0, 16) + '..';

        slidersHTML += `
            <div class="fader-container">
                <div style="font-size: 1.1rem; text-align: center; margin-bottom: 2px; height: 20px;">${icon}</div>
                <label style="font-size: 0.55rem; color: #fff; margin-bottom: 5px; text-align: center; height: 30px; display: flex; align-items: center; justify-content: center; word-break: break-word; line-height:1.1;">${label}</label>
                <input type="range" min="0" max="255" value="0" class="pro-slider" style="writing-mode: vertical-lr; direction: rtl; height: 120px; width: 24px;"
                    oninput="updateDMX(${fixture.universe || 0}, ${dmxChannel}, this.value)">
                <span style="font-size: 0.55rem; margin-top: 5px; color: #555;">DMX ${dmxChannel}</span>
            </div>`;
    }

    container.innerHTML = `
        <div class="control-group">
            <h3 style="margin-bottom: 12px; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 8px; color: var(--primary-color); font-size:0.9rem;">
                ${fixture.name} <span style="font-size:0.7em; color:#aaa; font-weight:normal;">(${chCount} canali · ${fixture.mode || ''})</span>
            </h3>
            <div class="fader-list" style="display:flex; gap:6px; flex-wrap: wrap; overflow-x: auto;">
                ${slidersHTML}
            </div>
        </div>`;
}

async function updateDMX(universe, channel, value) {
    // Update 3D Visualizer
    if (studioVisualizer && selectedFixtureId !== null) {
        studioVisualizer.updateFixture(selectedFixtureId, value);
    }

    // Record to Timeline
    if (typeof timeline !== 'undefined') {
        timeline.addEvent('dmx', { universe, channel, value });
    }

    await fetch('/api/dmx/set', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ universe, channel: parseInt(channel), value: parseInt(value) })
    });
}

/**
 * Standalone 60fps waveform draw loop.
 * Runs independently of WebSocket — always redraws from waveHistory.
 * Canvas resize no longer causes blank frames.
 */
function startWaveformLoop() {
    function drawFrame() {
        if (!canvas || !ctx) { requestAnimationFrame(drawFrame); return; }

        // Keep canvas pixel dimensions in sync with CSS layout
        const parentW = canvas.parentElement ? canvas.parentElement.clientWidth : 0;
        const parentH = canvas.parentElement ? canvas.parentElement.clientHeight : 0;
        // Force fallback if hidden
        const W = parentW > 0 ? parentW : window.innerWidth * 0.8;
        const H = parentH > 0 ? parentH : 120;

        if (canvas.width !== W) canvas.width = W;
        if (canvas.height !== H) canvas.height = H;

        const centerY = H / 2;
        const hist = window.waveHistory || [];
        const beats = window.beatHistory || [];

        // Force background wipe
        ctx.fillStyle = '#111';
        ctx.fillRect(0, 0, W, H);

        // ── Background grid ──────────────────────────────────────────────
        ctx.strokeStyle = 'rgba(0, 210, 255, 0.08)';
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 6]);
        for (let y = H * 0.25; y < H; y += H * 0.25) {
            ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
        }
        ctx.setLineDash([]);

        // ── Center baseline ───────────────────────────────────────────────
        ctx.strokeStyle = 'rgba(0, 210, 255, 0.35)';
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(0, centerY); ctx.lineTo(W, centerY); ctx.stroke();

        // ── History Line (right to left scrolling) ────────────────────────
        ctx.beginPath();
        for (let i = 0; i < hist.length; i++) {
            const pt = hist[i];
            const x = W - (hist.length - i);
            if (x < 0) continue;

            // Raw amplitude → screen height (Reduced multiplier to fit within canvas bounds)
            const ampH = Math.max(2, pt.val * H * 2.5);

            if (i === 0) {
                ctx.moveTo(x, centerY - ampH);
            } else {
                ctx.lineTo(x, centerY - ampH);
            }
        }

        // Draw the bottom symmetric half
        for (let i = hist.length - 1; i >= 0; i--) {
            const pt = hist[i];
            const x = W - (hist.length - i);
            if (x < 0) continue;

            const ampH = Math.max(2, pt.val * H * 2.5);
            ctx.lineTo(x, centerY + ampH);
        }

        ctx.closePath();

        // Use color based on latest frequency
        ctx.fillStyle = 'rgba(0, 255, 136, 0.1)';
        ctx.strokeStyle = 'rgba(0, 255, 136, 1)'; // Bright Neon Green to stand out
        ctx.lineWidth = 2.0;

        if (hist.length > 0) {
            const last = hist[hist.length - 1];
            const r = Math.round(Math.min(255, last.high * 255 + 50));
            const g = Math.round(Math.min(255, last.mid * 255 + 100));
            const b = Math.round(Math.min(255, last.low * 255 + 100));
            ctx.fillStyle = `rgba(${r},${g},${b},0.3)`;
            ctx.strokeStyle = `rgba(${r},${g},${b},1)`;
        }

        ctx.fill();
        ctx.stroke();

        // Beat flash (white vertical line)
        for (let i = 0; i < hist.length; i++) {
            const x = W - (hist.length - i);
            if (x < 0 || !beats[i]) continue;
            ctx.fillStyle = 'rgba(255,255,255,0.75)';
            ctx.fillRect(x, 0, 2, H);
        }

        // ── Playhead (right edge) ─────────────────────────────────────────
        ctx.fillStyle = '#ff0055';
        ctx.fillRect(W - 2, 0, 2, H);

        if (hist.length === 0) {
            ctx.fillStyle = 'white';
            ctx.font = '16px sans-serif';
            ctx.fillText('IN ATTESA DI AUDIO...', W / 2 - 80, centerY);
        }

        requestAnimationFrame(drawFrame);
    }
    requestAnimationFrame(drawFrame);
}

// 4. Existing Analysis Logic
function setupWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${window.location.host}/ws`);

    const status = document.getElementById('status');

    ws.onopen = () => {
        if (status) {
            status.innerText = "Connected";
            status.classList.add('connected');
        }
    };

    ws.onclose = () => {
        if (status) {
            status.innerText = "Disconnected";
            status.classList.remove('connected');
        }
        setTimeout(setupWebSocket, 2000);
    };

    ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.type === 'analysis') {
            updateVisualizer(data);

            if (data.ai_metrics) {
                updateDesignerDashboard(data.ai_metrics.energy, data.bpm, data.is_beat, data.ai_metrics);
            }

            // Sync Deep Sync Status (Spotify & Pro DJ Link)
            updateSyncStatus(data.spotify, data.prodj);

            // Sync BPM UI
            const bpmVal = document.getElementById('bpm-val');
            if (bpmVal) bpmVal.innerText = Math.round(data.bpm);

        } else { // Use a switch for other message types
            switch (data.type) {
                case 'auto_lights_sync':
                    autoLightsActive = data.enabled;
                    const alBtn = document.getElementById('auto-lights-btn');
                    if (alBtn) {
                        alBtn.classList.toggle('active', autoLightsActive);
                        alBtn.innerText = `AUTO LIGHTS: ${autoLightsActive ? 'ON' : 'OFF'}`;
                    }
                    break;

                case 'dmx_update':
                    if (studioVisualizer && data.universes) {
                        studioVisualizer.heartbeat();
                        const fixList = (typeof fixtures !== 'undefined') ? fixtures : [];
                        fixList.forEach(fix => {
                            // SAFE KEY: JSON keys are strings, fix.universe might be a number
                            const uniData = data.universes[fix.universe] || data.universes[String(fix.universe)];
                            if (uniData) {
                                studioVisualizer.updateFixture(fix.id, fix.address, uniData, data.is_delta, fix.universe);
                            }
                        });
                    }
                    break;
                case 'audio_status': // Original audio_status was an else if, now a case
                    if (data.color) {
                        // Color Sync for Main Studio
                        if (typeof studioVisualizer !== 'undefined') {
                            studioVisualizer.setBeamColor(data.color);
                        }
                    }
                    break;
            }
        }
    };
}

const toggleAutoLights = () => {
    autoLightsActive = !autoLightsActive;
    const btn = document.getElementById('auto-lights-btn');
    if (btn) {
        btn.classList.toggle('active', autoLightsActive);
        btn.innerText = `AUTO LIGHTS: ${autoLightsActive ? 'ON' : 'OFF'}`;
    }

    // Sync with backend engine
    fetch('/api/auto_lights/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: autoLightsActive })
    }).catch(e => console.error("[Sync] Failed to sync auto_lights state:", e));

    if (autoLightsActive) {
        console.log('[AI] Auto Lights Engine Enabled');
        if (typeof notify === 'function') notify('Auto Lights: ON', 'success', 2000);
    } else {
        console.log('[AI] Auto Lights Engine Disabled (Strobes/Flashes Off)');
        if (typeof notify === 'function') notify('Auto Lights: OFF', 'warning', 2000);
    }
};

const updateDesignerDashboard = (energy, bpm, isBeat, metrics = {}) => {
    const designer = window.AuraDesigner;
    if (!designer || !document.getElementById('ai-designer-dashboard')) return;

    // Update designer's internal state for stats
    designer.energyLevel = energy;
    designer.bpm = bpm;
    designer.pushHistory(energy, isBeat);

    const stats = designer.getStats();

    // Section display
    const secEl = document.getElementById('ai-section-val');
    if (secEl) {
        const displaySection = metrics.section || stats.vibe || stats.section || "VERSE";
        if (secEl.innerText !== displaySection) {
            secEl.innerText = displaySection;
            secEl.style.color = (displaySection === "DROP") ? "#ff00ff" : "#00d2ff";
            addTickerLog(`Musical Section: <span class="pal-mark">${displaySection}</span>`, "sec");
        }
    }

    // Palette & BPM
    const palEl = document.getElementById('ai-palette-name');
    if (palEl) {
        const pName = (metrics.mood || stats.palette || "IDLE").toUpperCase();
        if (palEl.innerText !== pName) {
            palEl.innerText = pName;
            addTickerLog(`Palette switched to <span class="pal-mark">${pName}</span>`, "pal");
        }
    }

    const bpmEl = document.getElementById('ai-bpm-val');
    if (bpmEl) bpmEl.innerText = Math.round(bpm || 120);

    // BPM Unity & Symmetry
    const unityEl = document.getElementById('ai-unity-val');
    if (unityEl) unityEl.innerText = `${metrics.unity || 85}%`;
    const symEl = document.getElementById('ai-symmetry-val');
    if (symEl) symEl.innerText = (metrics.symmetry || "MIRROR").toUpperCase();

    // VU Meters
    const setMeter = (id, val) => {
        const el = document.getElementById(id);
        if (el) el.style.width = `${Math.min(100, Math.max(0, val * 100))}%`;
    };

    setMeter('meter-energy', metrics.energy || energy);
    setMeter('meter-wash', metrics.wash || 0);
    setMeter('meter-beam', metrics.beam || 0);

    // Palette preview dots (Sync with actual colors)
    if (metrics.palette) {
        const pDots = [document.getElementById('pal-p'), document.getElementById('pal-s'), document.getElementById('pal-a')];
        metrics.palette.forEach((c, i) => {
            if (pDots[i]) pDots[i].style.background = `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
        });
    }

    // Beat Pulse
    const pulse = document.getElementById('ai-beat-pulse');
    if (pulse && isBeat) {
        pulse.style.transition = 'none';
        pulse.style.width = '100%';
        setTimeout(() => {
            pulse.style.transition = 'width 0.4s ease-out';
            pulse.style.width = '0%';
        }, 50);
        addTickerLog(`<span class="beat-mark">BEAT</span> detected [E:${Math.round(energy * 100)}%]`, "beat");
    }
};

const updateSyncStatus = (spotify, prodj) => {
    // Spotify Update
    const spotEl = document.getElementById('sync-spotify');
    const spotStat = document.getElementById('sync-spotify-status');
    if (spotEl && spotStat) {
        if (spotify && spotify.connected) {
            spotEl.style.opacity = "1";
            const track = spotify.track || {};
            if (track.is_playing) {
                spotStat.innerText = `SPOTIFY: ANALYSIS ACTIVE (${track.current_section_index || 0})`;
                spotStat.style.color = "#00ff88";
            } else {
                spotStat.innerText = "SPOTIFY: CONNECTED (IDLE)";
                spotStat.style.color = "#888";
            }
        } else {
            spotEl.style.opacity = "0.3";
            spotStat.innerText = "Spotify Offline";
            spotStat.style.color = "#fff";
        }
    }

    // Pro DJ Link Update
    const djEl = document.getElementById('sync-prodj');
    const djStat = document.getElementById('sync-prodj-status');
    if (djEl && djStat) {
        if (prodj && prodj.connected) {
            djEl.style.opacity = "1";
            if (prodj.playing) {
                djStat.innerText = `PRO DJ: PLAYER ${prodj.master_player} (B:${prodj.current_beat})`;
                djStat.style.color = "#00ff88";
            } else {
                djStat.innerText = "PRO DJ: CONNECTED (READY)";
                djStat.style.color = "#888";
            }
        } else {
            djEl.style.opacity = "0.3";
            djStat.innerText = "Pro DJ Link Offline";
            djStat.style.color = "#fff";
        }
    }
};

const addTickerLog = (msg, type) => {
    const ticker = document.getElementById('ticker-content');
    if (!ticker) return;

    const span = document.createElement('span');
    span.innerHTML = `[${new Date().toLocaleTimeString().split(' ')[0]}] ${msg}`;
    ticker.prepend(span);

    // Limit log entries
    while (ticker.childNodes.length > 8) {
        ticker.removeChild(ticker.lastChild);
    }
};

const handleAILighting = (isBeat, bpm, energy, bands, stems) => {
    if (!autoLightsActive || !fixtures || fixtures.length === 0 || !window.AuraDesigner) return;

    const designer = window.AuraDesigner;
    const s = stems || { drums: 0, bass: 0, vocals: 0, other: 0, flux: 0 };
    const eSafe = (isNaN(energy) || energy === undefined) ? 0 : energy;

    // 1. Scene & Section Management
    if (bands && bands.section) {
        designer.setSection(bands.section);
    } else {
        // Dynamic Vibe based on Energy if no explicit section is provided
        designer.updateVibeByEnergy(eSafe);
    }

    if (!window._aiBeatCount) window._aiBeatCount = 0;
    if (isBeat) {
        window._aiBeatCount++;
        // Change palette every 32 beats or on major energy peak
        if (window._aiBeatCount % 32 === 0 || (eSafe > 0.9 && Math.random() > 0.8)) {
            const palettes = designer.getPaletteNames();
            const nextIdx = (palettes.indexOf(designer.currentPaletteName) + 1) % palettes.length;
            designer.setPalette(palettes[nextIdx]);
            addTickerLog(`Designer: Switch to <b>${designer.currentPaletteName}</b>`, "pal");
        }
    }

    // 2. Intensity Envelopes (Section & Stem-Aware)
    const vibe = designer.vibe;
    const isDrop = vibe === "DROP" || vibe === "CLIMAX";
    const isBreakdown = designer.currentSection === "BREAKDOWN";

    // Wash Intensity: Driven by Bass resonance and general energy
    const washBase = isBreakdown ? 0.2 : (isDrop ? 0.6 : 0.4);
    const b = s.bass || 0;
    designer.washIntensity = Math.max(washBase, (b * 0.6) + (eSafe * 0.4));

    // Beam Intensity: Driven by Drums and Beat hits
    if (isBeat || (s.drums || 0) > 0.85) {
        designer.beamIntensity = 1.0;
    } else {
        designer.beamIntensity = Math.max(0, designer.beamIntensity - (isDrop ? 0.05 : 0.1));
    }

    // FX triggers (Strobe/Sparks) on high flux or climax beats
    designer.fxIntensity = ((s.flux || 0) > 0.8 || (isDrop && isBeat && Math.random() > 0.7)) ? 1.0 : 0;

    // Movement: Speed up during energetic sections
    const moveSpeed = isDrop ? 0.05 : (isBreakdown ? 0.012 : 0.025);
    autoMovementPhase += moveSpeed * (bpm / 120);

    // Update Dashboard UI
    updateDesignerDashboard(energy, bpm, isBeat);

    const updates = {};
    const primaryRGB = designer.hexToRgb(designer.palette.primary);
    const secondaryRGB = designer.hexToRgb(designer.palette.secondary);
    const accentRGB = designer.hexToRgb(designer.palette.accent);

    // 3. Wash Global Pulse & Breathe Logic
    if (!window._washEnergy) window._washEnergy = 0.5;

    // VIBE Parsing
    const currentVibe = designer.vibe; // "INTRO", "BUILDUP", "DROP", "CLIMAX"
    const isAmbient = (currentVibe === "INTRO");
    // Dynamic Wash Target based on Vibe
    let washTarget = 0.5;
    if (vibe === "INTRO") washTarget = 0.6;
    if (vibe === "BUILDUP") washTarget = 0.8;
    if (isDrop) washTarget = 0.9;

    // "Breathing" LFO for Intro/Buildup
    const washLFO = (vibe === "INTRO" || vibe === "BUILDUP") ? 0.2 * Math.sin(Date.now() / 1500) : 0;

    if (isBeat && (vibe === "DROP" || vibe === "CLIMAX" || vibe === "BUILDUP")) {
        window._washEnergy = 1.0;
        window._beatWindow = Date.now();
    } else {
        const decaySpeed = (vibe === "INTRO") ? 0.002 : ((window._washEnergy > washTarget + 0.2) ? 0.03 : 0.008);
        const baseline = (washTarget + washLFO);
        window._washEnergy = Math.max(baseline, window._washEnergy - decaySpeed);
    }

    const isBeatWindow = (window._beatWindow && (Date.now() - window._beatWindow < 120));

    // Group updates by universe
    const universeUpdates = {};

    fixtures.forEach((fix, i) => {
        const id = parseInt(fix.id);
        const addr = parseInt(fix.address);
        const universe = parseInt(fix.universe || 0);
        const zone = designer.getFixtureZone(fix);

        if (!universeUpdates[universe]) universeUpdates[universe] = {};
        const updates = universeUpdates[universe];

        const getCh = (kMap) => {
            return fix.channel_details.findIndex(c => {
                const cn = (c.name || "").toLowerCase();
                return kMap.some(k => cn.includes(k));
            });
        };

        const redIdx = getCh(['red', 'rosso']);
        const greenIdx = getCh(['green', 'verde']);
        const blueIdx = getCh(['blue', 'blu']);
        const dimIdx = getCh(['dim', 'int', 'level', 'master']);
        const panIdx = getCh(['pan']);
        const tiltIdx = getCh(['tilt']);
        const strIdx = getCh(['strobe', 'shutter', 'strobo']);
        const sparkIdx = getCh(['spark', 'fontana', 'shoot', 'height']);
        const goboIdx = getCh(['gobo', 'ruota gobo']);

        // A. Smooth Color & Intensity
        const targetColor = designer.getFixtureColor(id, zone, isBeatWindow);
        let targetIntensity = 0;

        if (vibe === "DROP" || vibe === "CLIMAX") {
            targetIntensity = (isBeatWindow || energy > 0.8) ? 255 : 200;
        } else if (vibe === "BUILDUP") {
            targetIntensity = 100 + (designer.smoothedEnergy * 155);
        } else if (vibe === "IDLE") {
            targetIntensity = 40; // Soft ambient glow for IDLE
        } else {
            if ([0, 2, 4, 6, 8, 10, 11].includes(id)) targetIntensity = 140;
            else targetIntensity = (designer.smoothedEnergy > 0.2) ? 80 : 40;
        }

        // Apply Smoothing to RGB Dimmer
        const sR = designer.updateBuffer(id, 'r', targetColor.r);
        const sG = designer.updateBuffer(id, 'g', targetColor.g);
        const sB = designer.updateBuffer(id, 'b', targetColor.b);
        const sI = designer.updateBuffer(id, 'dim', targetIntensity);

        if (dimIdx !== -1) {
            if (redIdx !== -1) updates[addr + redIdx] = Math.floor(sR);
            if (greenIdx !== -1) updates[addr + greenIdx] = Math.floor(sG);
            if (blueIdx !== -1) updates[addr + blueIdx] = Math.floor(sB);
            updates[addr + dimIdx] = Math.floor(sI);
        } else if (redIdx !== -1) {
            const scale = sI / 255;
            updates[addr + redIdx] = Math.floor(sR * scale);
            updates[addr + greenIdx] = Math.floor(sG * scale);
            updates[addr + blueIdx] = Math.floor(sB * scale);
        }

        // B. Smooth Movement
        if (panIdx !== -1 || tiltIdx !== -1) {
            const move = designer.getMovementPhasing(id, fixtures.length, i);
            const targetPan = 128 + 120 * move.pan;
            let tiltBase = (vibe === "INTRO") ? 180 : 128;
            const targetTilt = tiltBase + 60 * move.tilt;

            const sPan = designer.updateBuffer(id, 'pan', targetPan);
            const sTilt = designer.updateBuffer(id, 'tilt', targetTilt);

            if (panIdx !== -1) updates[addr + panIdx] = Math.floor(sPan);
            if (tiltIdx !== -1) updates[addr + tiltIdx] = Math.floor(sTilt);
        }

        // C. Strobe & FX (These remain snappy by design, or smoothed if preferred)
        if (strIdx !== -1) {
            const strobeVal = (isBeatWindow && vibe === "DROP") || (vibe === "CLIMAX" && Math.random() > 0.8) ? 255 : 0;
            updates[addr + strIdx] = strobeVal;
        }

        if (sparkIdx !== -1) {
            const shoot = (vibe === "CLIMAX") || (vibe === "DROP" && stems.drums > 0.9);
            updates[addr + sparkIdx] = shoot ? 255 : 0;
        }
    });

    // Send updates for each universe
    for (const u in universeUpdates) {
        if (Object.keys(universeUpdates[u]).length > 0) {
            bulkSetDmx(parseInt(u), universeUpdates[u]);
        }
    }
};

window._lastBulkTime = 0;
const bulkSetDmx = (universe, channels) => {
    if (!window._lastBulkTimes) window._lastBulkTimes = {};
    const now = Date.now();
    if (window._lastBulkTimes[universe] && now - window._lastBulkTimes[universe] < 40) return;
    window._lastBulkTimes[universe] = now;

    if (typeof ws !== 'undefined' && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            type: 'dmx_bulk',
            universe: universe,
            channels: channels
        }));
    } else {
        fetch('/api/dmx/bulk', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ universe, channels })
        }).catch(() => { });
    }
};

function updateVisualizer(data) {
    if (!data) return;
    const bands = data.bands || {};
    const bpm = data.bpm || 0;
    const is_beat = !!data.is_beat;
    const waveform = data.waveform;

    // Set global flags for 3D visualizer reactivity
    let totalEnergy = 0;
    let count = 0;
    for (let b in bands) {
        if (bands[b]) {
            totalEnergy += bands[b].rel_energy || 0;
            count++;
        }
    }
    window._latestAudioEnergy = count > 0 ? totalEnergy / count : 0;
    window._latestBeatTriggered = is_beat;

    // Update BPM display
    // Update BPM display
    const bpmEl = document.getElementById('bpm-val');
    if (!bpmEl) return;

    if (bpm > 0) {
        bpmEl.innerText = bpm;
        bpmEl.style.color = '';
    } else {
        if (!bpmEl._warmupInterval) {
            let dots = 0;
            bpmEl.innerText = '···';
            bpmEl.style.color = 'rgba(255,255,255,0.35)';
            bpmEl._warmupInterval = setInterval(() => {
                if (document.getElementById('bpm-val').innerText.match(/^\d/)) {
                    clearInterval(bpmEl._warmupInterval);
                    bpmEl._warmupInterval = null;
                } else {
                    dots = (dots + 1) % 4;
                    bpmEl.innerText = '·'.repeat(dots + 1);
                }
            }, 400);
        }
    }
    const indicator = document.getElementById('header-beat-indicator');
    if (indicator && is_beat) {
        indicator.classList.add('active');
        setTimeout(() => indicator.classList.remove('active'), 100);

        // Record to Timeline
        if (window.timeline && typeof timeline !== 'undefined') {
            timeline.addEvent('beat', { bpm: bpm });
        }
    }

    // AI AUTO LIGHTS ENGINE
    const finalEnergy = (data.ai_metrics && data.ai_metrics.energy !== undefined) ? data.ai_metrics.energy : window._latestAudioEnergy;
    handleAILighting(is_beat, bpm, finalEnergy, bands, data.stems);

    // Only accumulate data — drawing happens in startWaveformLoop RAF
    if (waveform) {
        if (!window.waveHistory) window.waveHistory = [];
        if (!window.beatHistory) window.beatHistory = [];

        let sum = 0;
        for (let i = 0; i < waveform.length; i++) sum += Math.abs(waveform[i]);
        // Float32 audio is already localized roughly between 0.0 - 1.0 (after AGC)
        const val = waveform.length > 0 ? (sum / waveform.length) : 0;

        window.waveHistory.push({
            val: val,
            low: bands && bands.low ? bands.low.rel_energy : 0,
            mid: bands && bands.mid ? bands.mid.rel_energy : 0,
            high: bands && bands.high ? bands.high.rel_energy : 0,
            beat_phase: data.beat_phase || 0,
            bpm: bpm
        });
        window.beatHistory.push(is_beat);

        // Update meters visually using AI Stems (Module 10.1)
        if (data.stems) {
            const s = data.stems;

            const updateMeter = (id, val, trigThreshold) => {
                const card = document.getElementById(id);
                if (!card) return;
                const bar = card.querySelector('.meter-bar');
                if (bar) bar.style.width = Math.min(100, val * 100) + '%';

                if (val > trigThreshold) {
                    card.classList.add('triggered');
                    setTimeout(() => card.classList.remove('triggered'), 100);
                }
            };

            updateMeter('meter-low', s.drums || 0, 0.8);
            updateMeter('meter-mid', s.vocals || 0, 0.7);
            updateMeter('meter-high', (s.other || 0) * 0.7 + (s.flux || 0) * 0.3, 0.75);
        }
        else if (bands) {
            // Fallback to raw bands if stems missing
            const setBar = (id, val) => {
                const bar = document.querySelector(`#${id} .meter-bar`);
                if (bar) bar.style.width = Math.min(100, val * 100) + '%';
            };
            if (bands.low) setBar('meter-low', bands.low.rel_energy);
            if (bands.mid) setBar('meter-mid', bands.mid.rel_energy);
            if (bands.high) setBar('meter-high', bands.high.rel_energy);
        }

        // Keep history length to max canvas width
        const maxPts = Math.max(canvas ? canvas.width : 800, 800);
        while (window.waveHistory.length > maxPts) { window.waveHistory.shift(); window.beatHistory.shift(); }
    }

    // AI Color Harmony Update
    if (data.mood && data.palette) {
        const moodEl = document.getElementById('ai-mood-text');
        if (moodEl) moodEl.innerText = data.mood;

        const sectionEl = document.getElementById('ai-section-text');
        if (sectionEl && data.section) {
            sectionEl.innerText = data.section;
            // Visual feedback based on section
            if (data.section === 'DROP') {
                sectionEl.style.color = '#00ff88';
                sectionEl.style.borderColor = 'rgba(0,255,136,0.5)';
                sectionEl.style.background = 'rgba(0,255,136,0.1)';
            } else if (data.section === 'BREAKDOWN') {
                sectionEl.style.color = '#a0a0a0';
                sectionEl.style.borderColor = 'rgba(160,160,160,0.5)';
                sectionEl.style.background = 'rgba(160,160,160,0.1)';
            } else {
                sectionEl.style.color = '#ff0055';
                sectionEl.style.borderColor = 'rgba(255,0,85,0.5)';
                sectionEl.style.background = 'rgba(255,0,85,0.1)';
            }
        }

        const p = data.palette;
        if (p && p.length >= 3) {
            const c1 = document.getElementById('color-swatch-1');
            const c2 = document.getElementById('color-swatch-2');
            const c3 = document.getElementById('color-swatch-3');
            if (c1) c1.style.background = `rgb(${p[0][0]}, ${p[0][1]}, ${p[0][2]})`;
            if (c2) c2.style.background = `rgb(${p[1][0]}, ${p[1][1]}, ${p[1][2]})`;
            if (c3) c3.style.background = `rgb(${p[2][0]}, ${p[2][1]}, ${p[2][2]})`;
        }
    }

    // Spotify Update
    if (data.spotify && data.spotify.connected) {
        const setupSt = document.getElementById('spotify-status');
        if (setupSt) {
            setupSt.innerText = "Connesso";
            setupSt.className = "status-indicator connected";
        }

        const nowPlaying = document.getElementById('spotify-now-playing');
        if (nowPlaying) nowPlaying.style.display = 'block';

        const track = data.spotify.track;
        if (track) {
            // Prevent 40Hz WebSocket from resetting our smooth interpolator
            const oldTrack = window.currentSpotifyTrack;
            if (oldTrack && oldTrack.name === track.name && oldTrack.progress_ms === track.progress_ms && oldTrack.is_playing === track.is_playing) {
                track._lastUpdate = oldTrack._lastUpdate;
            } else {
                track._lastUpdate = Date.now();
            }

            window.currentSpotifyTrack = track; // save for controls

            const tName = document.getElementById('spotify-track-name');
            const tArtist = document.getElementById('spotify-artist');
            const tCover = document.getElementById('spotify-cover');

            if (tName) tName.innerText = track.name;
            if (tArtist) tArtist.innerText = track.artist;
            if (tCover && track.cover_url) tCover.src = track.cover_url;

            // Apply Spotify dominant color to the first swatch if available
            if (track.dominant_color) {
                const c1 = document.getElementById('color-swatch-1');
                if (c1) c1.style.background = `rgb(${track.dominant_color[0]}, ${track.dominant_color[1]}, ${track.dominant_color[2]})`;

                // Highlight track name with dominant color for visual flair
                if (tName) tName.style.color = `rgb(${track.dominant_color[0]}, ${track.dominant_color[1]}, ${track.dominant_color[2]})`;
            }

            // Progress Bar & Time
            const pBar = document.getElementById('spotify-progress');
            const tCur = document.getElementById('spotify-time-current');
            const tTot = document.getElementById('spotify-time-total');

            if (pBar && track.duration_ms > 0) {
                const fmt = (ms) => {
                    const totalSec = Math.floor(ms / 1000);
                    const m = Math.floor(totalSec / 60);
                    const s = (totalSec % 60).toString().padStart(2, '0');
                    return `${m}:${s}`;
                };
                if (tTot) tTot.innerText = fmt(track.duration_ms);
            }

            // Play/Pause Button
            const btnPlayPause = document.getElementById('spotify-play-pause');
            if (btnPlayPause) {
                btnPlayPause.innerText = track.is_playing ? '⏸' : '▶';
                btnPlayPause.style.fontSize = track.is_playing ? '1.2rem' : '1.4rem';
                btnPlayPause.style.paddingLeft = track.is_playing ? '0' : '4px'; // Optical alignment for play button
            }

            // Shuffle
            const btnShuffle = document.getElementById('spotify-shuffle');
            if (btnShuffle) {
                btnShuffle.style.color = track.shuffle_state ? '#1db954' : '#888';
            }

            // Repeat
            const btnRepeat = document.getElementById('spotify-repeat');
            if (btnRepeat) {
                if (track.repeat_state === 'track') {
                    btnRepeat.style.color = '#1db954';
                    btnRepeat.innerText = '🔂';
                } else if (track.repeat_state === 'context') {
                    btnRepeat.style.color = '#1db954';
                    btnRepeat.innerText = '🔁';
                } else {
                    btnRepeat.style.color = '#888';
                    btnRepeat.innerText = '🔁';
                }
            }
        }
    }

    // Update Meters
    for (const [name, bandData] of Object.entries(bands)) {
        const meter = document.getElementById(`meter-${name}`);
        if (!meter) continue;

        const bar = meter.querySelector('.meter-bar');

        // Use normalized rel_energy for smoother visualization (0.0 to 1.0)
        let height = (bandData.rel_energy || 0) * 100;
        bar.style.height = `${height}%`;

        if (bandData.triggered) meter.parentElement.classList.add('triggered');
        else meter.parentElement.classList.remove('triggered');
    }
}

function renderSettings() {
    const container = document.getElementById('band-settings');
    if (container) {
        container.innerHTML = '';
        for (const [name, data] of Object.entries(config.bands || {})) {
            const div = document.createElement('div');
            div.className = 'band-config';
            div.innerHTML = `
                <h3>${name.toUpperCase()}</h3>
                <div class="input-group">
                    <label>OSC Path</label>
                    <input type="text" data-band="${name}" data-key="osc_path" value="${data.osc_path}">
                </div>
                <div class="input-group">
                    <label>Multiplicatore Soglia</label>
                    <input type="number" step="0.1" data-band="${name}" data-key="threshold_multiplier" value="${data.threshold_multiplier}">
                </div>
            `;
            container.appendChild(div);
        }
    }

    // Sync DMX Output Select
    const dmxSelect = document.getElementById('dmx-output-select');
    if (dmxSelect && config.dmx_settings) {
        dmxSelect.value = config.dmx_settings.output_mode || 'artnet';
    }

    // Sync BPM Sync Select
    const bpmSelect = document.getElementById('bpm-sync-select');
    if (bpmSelect) {
        bpmSelect.value = config.bpm_sync_mode || 'internal';
    }

    // Sync Latency Offset
    const latencySlider = document.getElementById('latency-offset');
    const latencyVal = document.getElementById('latency-val');
    if (latencySlider && latencyVal && config.dmx_settings) {
        const lValue = config.dmx_settings.latency_ms || 0;
        latencySlider.value = lValue;
        latencyVal.innerText = `${lValue}ms`;
    }
}

async function saveConfig() {
    const inputs = document.querySelectorAll('input[data-band]');
    inputs.forEach(input => {
        const band = input.dataset.band;
        const key = input.dataset.key;
        let val = input.value;
        if (input.type === 'number') val = parseFloat(val);
        config.bands[band][key] = val;
    });

    const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config)
    });
    if (res.ok) alert("Regole salvate!");
}

// 5. Generative LFO Management
async function addNewLFO() {
    const lfo_id = "LFO-" + Date.now().toString().slice(-4);
    const data = {
        id: lfo_id,
        shape: "sine",
        frequency: 1.0,
        amplitude: 1.0,
        offset: 0.0,
        universe: 0,
        channel: 1
    };

    await fetch('/api/generative/lfo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
    });
    isDirty = true;
    renderLFOs();
}

async function renderLFOs() {
    const res = await fetch('/api/generative/status');
    const state = await res.json();
    const container = document.getElementById('lfo-list');
    if (!container) return; // Not on a page with an LFO list

    container.innerHTML = Object.entries(state).map(([id, data]) => `
        <div class="lfo-card glass" data-id="${id}">
            <button class="delete-btn" onclick="deleteLFO('${id}')">×</button>
            <h3>${id}</h3>
            <div class="lfo-controls-row">
                <div class="input-group">
                    <label>Shape</label>
                    <select onchange="updateLFO('${id}', {shape: this.value})" class="pro-input">
                        <option value="sine" ${data.shape === 'sine' ? 'selected' : ''}>Sine</option>
                        <option value="saw" ${data.shape === 'saw' ? 'selected' : ''}>Saw</option>
                        <option value="triangle" ${data.shape === 'triangle' ? 'selected' : ''}>Triangle</option>
                        <option value="square" ${data.shape === 'square' ? 'selected' : ''}>Square</option>
                        <option value="random" ${data.shape === 'random' ? 'selected' : ''}>Random</option>
                    </select>
                </div>
                <div class="input-group">
                    <label>Freq (Hz)</label>
                    <input type="number" step="0.1" value="${data.frequency || 1.0}" 
                        onchange="updateLFO('${id}', {frequency: parseFloat(this.value)})" class="pro-input">
                </div>
            </div>
            <div class="lfo-controls-row">
                 <div class="input-group">
                    <label>Universe</label>
                    <input type="number" value="${data.target ? data.target[0] : 1}" 
                        onchange="updateLFO('${id}', {universe: parseInt(this.value)})" class="pro-input">
                </div>
                <div class="input-group">
                    <label>Channel</label>
                    <input type="number" value="${data.target ? data.target[1] : 1}" 
                        onchange="updateLFO('${id}', {channel: parseInt(this.value)})" class="pro-input">
                </div>
            </div>
        </div>
    `).join('');
}

async function updateLFO(id, newData) {
    const res = await fetch('/generative/status');
    const state = await res.json();
    const current = state[id];

    const payload = {
        id: id,
        shape: newData.shape || current.shape,
        frequency: newData.frequency !== undefined ? newData.frequency : current.frequency,
        amplitude: newData.amplitude !== undefined ? newData.amplitude : current.amplitude,
        offset: newData.offset !== undefined ? newData.offset : current.offset,
        universe: newData.universe !== undefined ? newData.universe : current.target[0],
        channel: newData.channel !== undefined ? newData.channel : current.target[1]
    };

    await fetch('/api/generative/lfo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    isDirty = true;
}

async function deleteLFO(id) {
    await fetch(`/api/generative/lfo/${id}`, { method: 'DELETE' });
    renderLFOs();
}

window.onload = () => {
    init();
    restoreEnvironment();
};

// ==========================================
// Phase 6: Venue Builder & Cloud Logic
// ==========================================
function setupVenueBuilder() {
    const uploadZone = document.getElementById('upload-zone');
    const fileInput = document.getElementById('venue-image-input');
    const loader = document.getElementById('ai-analysis-loader');
    const exportBtn = document.getElementById('export-qxw-btn');

    if (uploadZone && fileInput) {
        uploadZone.onclick = () => fileInput.click();

        fileInput.onchange = async (e) => {
            if (e.target.files.length > 0) {
                // Simulate file upload and analysis
                uploadZone.style.display = 'none';
                loader.style.display = 'block';

                try {
                    const res = await fetch('/api/venue/analyze', { method: 'POST' });
                    const data = await res.json();

                    loader.style.display = 'none';
                    uploadZone.style.display = 'block';

                    if (data.status === 'success') {
                        document.getElementById('upload-status').innerText = "✅ " + data.message;
                        uploadZone.style.borderColor = "#00ff88";

                        // Update application state
                        fixtures = data.fixtures;
                        renderFixtures();

                        // Update 3D Visualizer
                        if (studioVisualizer) {
                            studioVisualizer.clearFixtures();
                            fixtures.forEach(f => studioVisualizer.addFixture(f));
                        }
                    }
                } catch (err) {
                    console.error("AI Analysis failed:", err);
                    loader.style.display = 'none';
                    uploadZone.style.display = 'block';
                    document.getElementById('upload-status').innerText = "❌ Errore Analisi";
                }
            }
        };
    }

    if (exportBtn) {
        exportBtn.onclick = async () => {
            const res = await fetch('/workspace/export', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ fixtures })
            });
            const data = await res.json();
            if (data.status === 'success') {
                // Trigger download
                const blob = new Blob([data.xml], { type: 'text/xml' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = 'AuraSync_AI_Venue.qxw';
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
            } else {
                alert("Export failed");
            }
        };
    }

    loadCloudPresets();
}

async function loadCloudPresets() {
    try {
        const res = await fetch('/api/cloud/presets');
        const data = await res.json();
        const container = document.getElementById('presets-container');
        if (!container || !data.presets) return;

        container.innerHTML = '';
        data.presets.forEach(p => {
            const el = document.createElement('div');
            el.className = 'preset-card';
            el.style.cssText = 'background: rgba(255,255,255,0.05); padding: 1rem; border-radius: 8px; border: 1px solid rgba(255,255,255,0.1); margin-bottom: 10px;';
            el.innerHTML = `
                <h3 style="color: #fff; margin-bottom: 0.5rem;">${p.name}</h3>
                <p style="color: #aaa; font-size: 0.9rem;">by ${p.author}</p>
                <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 1rem;">
                    <span style="color: #00d2ff; font-size: 0.8rem;">↓ ${p.downloads}</span>
                    <button class="secondary-btn" style="padding: 5px 10px; font-size: 0.8rem;">Download</button>
                </div>
            `;
            container.appendChild(el);
        });
    } catch (e) { console.error("Error loading presets:", e); }
}

// ════════════════════════════════════════════════════════════════════════════════
// VIRTUAL CONSOLE & FIXTURE MANAGER LOGIC
// ════════════════════════════════════════════════════════════════════════════════

let fixtureSettings = {}; // { id: { enabled: true } }

// Overlay Manager
function openFixtureManager() {
    const list = document.getElementById('fixture-manager-list');
    const overlay = document.getElementById('fixture-manager-overlay');
    if (!list || !overlay) return;

    if (!fixtures || fixtures.length === 0) {
        list.innerHTML = '<p class="empty-msg">Nessuna fixture caricata.</p>';
    } else {
        list.innerHTML = fixtures.map(f => {
            const isEnabled = fixtureSettings[f.id]?.enabled !== false;
            return `
                <div style="display:flex; align-items:center; justify-content:space-between; padding:10px 0; border-bottom:1px solid rgba(255,255,255,0.05);">
                    <div>
                        <div style="color:#fff; font-size:0.85rem; font-weight:600;">${f.name}</div>
                        <div style="color:#888; font-size:0.7rem;">Univ ${f.universe ?? 0} | DMX ${f.address ?? '?'} | Ch: ${f.channels || (f.channel_details ? f.channel_details.length : 0)}</div>
                    </div>
                    <label style="position:relative; display:inline-block; width:44px; height:24px;">
                        <input type="checkbox" id="fix-en-${f.id}" ${isEnabled ? 'checked' : ''} style="opacity:0; width:0; height:0;" onchange="updateFixtureSetting(${f.id}, this.checked)">
                        <span style="position:absolute; cursor:pointer; top:0; left:0; right:0; bottom:0; background-color:${isEnabled ? '#2ecc71' : 'rgba(255,255,255,0.1)'}; transition:.4s; border-radius:34px;">
                            <span style="position:absolute; content:''; height:18px; width:18px; left:3px; bottom:3px; background-color:white; transition:.4s; border-radius:50%; transform:${isEnabled ? 'translateX(20px)' : 'translateX(0)'};"></span>
                        </span>
                    </label>
                </div>
            `;
        }).join('');
    }
    overlay.style.display = 'block';
}

function closeFixtureManager(e) {
    const overlay = document.getElementById('fixture-manager-overlay');
    if (!overlay) return;
    if (e && e.target.id !== 'fixture-manager-overlay') return;
    overlay.style.display = 'none';
    renderFixtures(); // Re-render to reflect changes
}

function updateFixtureSetting(id, enabled) {
    if (!fixtureSettings[id]) fixtureSettings[id] = {};
    fixtureSettings[id].enabled = enabled;

    // Update the UI switch visually right away
    const span = document.querySelector(`#fix-en-${id} + span`);
    const ball = span.querySelector('span');
    span.style.backgroundColor = enabled ? '#2ecc71' : 'rgba(255,255,255,0.1)';
    ball.style.transform = enabled ? 'translateX(20px)' : 'translateX(0)';
}

function toggleAllFixtures(enable) {
    fixtures.forEach(f => {
        updateFixtureSetting(f.id, enable);
        const cb = document.getElementById(`fix-en-${f.id}`);
        if (cb) cb.checked = enable;
    });
}

function saveFixtureLayout() {
    localStorage.setItem('qlc_fixture_settings', JSON.stringify(fixtureSettings));
    closeFixtureManager();
}

function loadFixtureLayout() {
    try {
        const saved = localStorage.getItem('qlc_fixture_settings');
        if (saved) fixtureSettings = JSON.parse(saved);
    } catch (e) { }
}

// Override renderFixtures to handle enabled/disabled state and intensity strip
window.renderFixtures = function () {
    const listContainer = document.getElementById('fixture-list');
    const stripContainer = document.getElementById('vc-intensity-strip');

    const enabledFixtures = (fixtures || []).filter(f => f && fixtureSettings[f.id]?.enabled !== false);

    if (enabledFixtures.length === 0) {
        let msg = '<p class="empty-msg">Nessuna fixture visibile.</p>';
        if (listContainer) listContainer.innerHTML = msg;
        if (stripContainer) stripContainer.innerHTML = msg;
        return;
    }

    // 1. Selector List
    if (listContainer) {
        listContainer.innerHTML = enabledFixtures.map(f => {
            const fname = f.name || `Fixture ${f.id}`;
            const chCount = f.channels || (f.channel_details ? f.channel_details.length : 0);
            return `
            <div class="fixture-item card" onclick="selectFixture('${f.id}')" style="padding:10px; margin-bottom:8px; cursor:pointer; background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08); border-radius:6px;">
                <h3 style="margin:0 0 4px 0; font-size:0.8rem; color:#fff;">${fname}</h3>
                <span style="font-size:0.65rem; color:#888;">Univ ${f.universe ?? 0} | Addr ${f.address ?? '?'} | Ch: ${chCount}</span>
            </div>
            `;
        }).join('');
    }

    // 2. Intensity Strip Faders
    if (stripContainer) {
        stripContainer.innerHTML = enabledFixtures.map(f => {
            // Find Dimmer/Intensity channel
            let dimChIdx = 0; // fallback
            if (f.channels) {
                if (Array.isArray(f.channels)) {
                    const idx = f.channels.findIndex(c => c && typeof c === 'string' && (c.toLowerCase().includes('dimmer') || c.toLowerCase().includes('intensity')));
                    if (idx !== -1) dimChIdx = idx;
                } else if (typeof f.channels === 'object') {
                    for (const key in f.channels) {
                        const c = f.channels[key];
                        if (c && typeof c === 'string' && (c.toLowerCase().includes('dimmer') || c.toLowerCase().includes('intensity'))) {
                            dimChIdx = parseInt(key);
                            break;
                        }
                    }
                }
            }
            const dmxAddr = parseInt(f.address) + dimChIdx;

            let shortName = f.name || `Fix ${f.id}`;
            if (shortName.length > 12) shortName = shortName.substring(0, 10) + '..';

            return `
                <div class="vc-fader-wrap" style="width:70px; background:rgba(0,0,0,0.5);">
                    <div style="font-size:0.65rem; color:#fff; margin-bottom:10px; text-align:center; height:24px; display:flex; align-items:flex-end; justify-content:center;">${shortName}</div>
                    <input type="range" min="0" max="255" value="0" class="pro-slider" style="writing-mode: vertical-lr; direction: rtl; height: 130px; width: 28px;"
                        oninput="updateDMX(${f.universe}, ${dmxAddr}, this.value)">
                    <div style="font-size:0.6rem; color:#888; margin-top:8px;">DMX ${dmxAddr}</div>
                </div>
            `;
        }).join('');
    }
};

// Hook into loadWorkspace to load settings
const originalLoadWorkspace = window.loadWorkspace;
window.loadWorkspace = async function () {
    loadFixtureLayout();
    await originalLoadWorkspace();
};

// Master Controls
function vcMasterOn() {
    const sliders = document.querySelectorAll('#vc-intensity-strip input[type="range"]');
    sliders.forEach(s => { s.value = 255; s.dispatchEvent(new Event('input')); });
}

function vcMasterOff() {
    const sliders = document.querySelectorAll('#vc-intensity-strip input[type="range"]');
    sliders.forEach(s => { s.value = 0; s.dispatchEvent(new Event('input')); });
}

async function vcBlackout() {
    vcMasterOff();
    // also stop all QLC functions
    try {
        await fetch(`${API_BASE}/qlc/blackout`, { method: 'POST' });
        // clear local state
        for (const id in activeFunctions) activeFunctions[id] = false;
        renderFunctions(); // refresh UI buttons
    } catch (e) { console.error("Blackout error", e); }
}

async function vcReset() {
    if (confirm("Sei sicuro di voler ricaricare completamente il bridge e resettare tutte le luci?")) {
        try {
            await fetch(`${API_BASE}/qlc/reset`, { method: 'POST' });
            alert("Reset inviato.");
            location.reload();
        } catch (e) { console.error(e); }
    }
}

// Load layout on boot
loadFixtureLayout();


// Removed Venue Builder logics

// Live Pop-out Window
function openLiveStudio() {
    // Save current fixtures state to ensure Live Studio gets them instantly
    if (fixtures && fixtures.length > 0) {
        localStorage.setItem('aurasync_fixtures', JSON.stringify(fixtures));
    }

    const w = 900, h = 600;
    const left = (screen.width - w) / 2;
    const top = (screen.height - h) / 2;

    window.open(
        'live_studio.html',
        'LiveStudio',
        `width=${w},height=${h},top=${top},left=${left},resizable=yes,scrollbars=no,status=no,toolbar=no,menubar=no,location=no`
    );
}

// ════════════════════════════════════════════════════════════════════════════════
// 3D DESIGN MODE HUD LOGIC
// ════════════════════════════════════════════════════════════════════════════════
let designModeActive = false;

window.toggleDesignMode = function () {
    designModeActive = !designModeActive;
    const btn = document.getElementById('toggle-design-btn');
    const controls = document.getElementById('design-controls');

    if (btn) {
        btn.innerText = `🎨 DESIGN MODE: ${designModeActive ? 'ON' : 'OFF'}`;
        btn.classList.toggle('active', designModeActive);
        btn.style.background = designModeActive ? 'linear-gradient(135deg, #00ff88, #1db954)' : 'linear-gradient(135deg, #00d2ff, #0066cc)';
    }

    if (controls) {
        controls.style.display = designModeActive ? 'block' : 'none';
        if (designModeActive) controls.classList.add('animate-slide-in');
    }

    // Invert orbit vs transform
    if (studioVisualizer) {
        studioVisualizer._orbitEnabled = !designModeActive;
        if (!designModeActive && studioVisualizer.transformControl) {
            studioVisualizer.transformControl.detach();
        }
    }
};

window.setTransformMode = function (mode) {
    if (studioVisualizer && studioVisualizer.transformControl) {
        studioVisualizer.transformControl.setMode(mode);
        // Visual feedback
        document.querySelectorAll('.mini-btn-pro').forEach(btn => {
            btn.classList.remove('active');
            if (btn.innerText.toLowerCase().includes(mode.substring(0, 3))) btn.classList.add('active');
        });
    }
};

window.saveFixtureLayout = function () {
    if (fixtures && fixtures.length > 0) {
        localStorage.setItem('aurasync_fixtures', JSON.stringify(fixtures));
        // Also sync to the new key I'm using in some places
        localStorage.setItem('aurasync_fixtures', JSON.stringify(fixtures));

        const saveBtn = document.querySelector('button[onclick="saveFixtureLayout()"]');
        if (saveBtn) {
            const oldText = saveBtn.innerText;
            saveBtn.innerText = "SAVED! ✅";
            setTimeout(() => saveBtn.innerText = oldText, 2000);
        }
        console.log("[Studio 3D] Layout saved to LocalStorage");
    }
};

// Ensure global functions are accessible
window.openLiveStudio = openLiveStudio;
window.openFixtureManager = openFixtureManager;

// Initialize app robustly
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
