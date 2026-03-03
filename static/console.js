/**
 * AuraSync Pro - Virtual Console Engine V3.0
 * Full redesign: Inspector-based editing, no prompt() calls.
 * 3-column layout: Library | Workspace | Inspector
 */

window.AuraConsole = {
    isDesignMode: false,
    widgets: [],
    functions: { scenes: {}, chasers: {}, efx: {} },
    fixtures: [],
    selectedWidget: null,

    // ─── Init ────────────────────────────────────────────────────────
    async init() {
        if (!document.getElementById('virtual-console-grid')) return; // Guard: not on console page
        console.log('[Console] Engine V3.0 init');
        this.loadLayout();
        await this.loadData();
        this.renderVirtualConsole();
        this.renderSceneList();
    },

    async loadData() {
        try {
            const [fnRes, fixRes] = await Promise.all([
                fetch('/api/functions'),
                fetch('/api/workspace/fixtures')
            ]);
            if (fnRes.ok) this.functions = await fnRes.json();
            if (fixRes.ok) this.fixtures = await fixRes.json();
            console.log('[Console] Scenes:', Object.keys(this.functions.scenes || {}).length);
        } catch (e) {
            console.warn('[Console] Data load error:', e);
        }
    },

    // ─── Layout Persistence ─────────────────────────────────────────
    loadLayout() {
        try {
            const s = localStorage.getItem('aurasync_console_v3');
            if (s) this.widgets = JSON.parse(s);
        } catch (e) { }
    },

    saveLayout() {
        localStorage.setItem('aurasync_console_v3', JSON.stringify(this.widgets));
        if (typeof notify === 'function') notify('Layout salvato', 'success', 2000);
    },

    clearLayout() {
        this.widgets = [];
        this.selectedWidget = null;
        this.saveLayout();
        this.renderVirtualConsole();
        this.showInspector(null);
    },

    // ─── Mode ────────────────────────────────────────────────────────
    setMode(isDesign) {
        this.isDesignMode = isDesign;
        const ws = document.getElementById('vc-workspace-panel');
        const dBtn = document.getElementById('vc-design-btn');
        const lBtn = document.getElementById('vc-live-btn');

        if (isDesign) {
            ws?.classList.add('design-mode');
            dBtn?.classList.add('design-active');
            dBtn?.classList.remove('live-active');
            lBtn?.classList.remove('live-active');
        } else {
            ws?.classList.remove('design-mode');
            dBtn?.classList.remove('design-active');
            lBtn?.classList.add('live-active');
            this.selectedWidget = null;
            this.showInspector(null);
        }

        const grid = document.getElementById('virtual-console-grid');
        if (grid) {
            grid.ondragover = isDesign ? (e) => e.preventDefault() : null;
            grid.ondrop = isDesign ? (e) => this.handleDrop(e) : null;
        }

        this.renderVirtualConsole();
    },

    // ─── Drag & Drop ─────────────────────────────────────────────────
    onDragStart(e, type) {
        e.dataTransfer.setData('widget-type', type);
    },

    handleDrop(e) {
        e.preventDefault();
        const type = e.dataTransfer.getData('widget-type');
        const grid = document.getElementById('virtual-console-grid');
        if (!grid) return;
        const rect = grid.getBoundingClientRect();
        const snapX = Math.round((e.clientX - rect.left) / 40) * 40;
        const snapY = Math.round((e.clientY - rect.top) / 40) * 40;

        const defaults = {
            button: { w: 120, h: 120, label: 'Bottone' },
            slider: { w: 80, h: 280, label: 'Slider' },
            frame: { w: 400, h: 280, label: 'Solo Frame' },
            'cue-list': { w: 240, h: 280, label: 'Cue List' },
            label: { w: 200, h: 60, label: 'Etichetta' }
        };

        const d = defaults[type] || defaults.button;

        const w = {
            id: 'w' + Date.now(),
            type,
            x: snapX, y: snapY,
            w: d.w, h: d.h,
            label: d.label,
            funcId: null,
            parentId: null,
            mode: 'toggle',
            active: false,
            level: 0,
            channel: 1,
            universe: 0,
            steps: [],
            currentStep: 0
        };

        this.widgets.push(w);
        this.renderVirtualConsole();
        this.saveLayout();

        // Auto-select for editing
        if (this.isDesignMode) this.selectWidget(w.id);
    },

    // ─── Render ──────────────────────────────────────────────────────
    renderVirtualConsole() {
        const grid = document.getElementById('virtual-console-grid');
        if (!grid) return;
        grid.innerHTML = '';

        const hint = document.getElementById('vc-empty-hint');
        if (this.widgets.length === 0) {
            if (hint) { hint.style.display = 'flex'; grid.appendChild(hint); }
        } else {
            if (hint) hint.style.display = 'none';
        }

        // Render frames first (background)
        this.widgets.filter(w => w.type === 'frame').forEach(w => grid.appendChild(this.buildEl(w)));
        this.widgets.filter(w => w.type !== 'frame').forEach(w => grid.appendChild(this.buildEl(w)));
    },

    buildEl(w) {
        const div = document.createElement('div');
        div.className = `vc-widget ${w.type}${this.selectedWidget?.id === w.id ? ' selected-widget' : ''}`;
        div.id = w.id;
        div.style.cssText = `left:${w.x}px; top:${w.y}px; width:${w.w}px; height:${w.h}px;`;

        if (w.type === 'frame') {
            div.innerHTML = `<span class="vc-frame-title">${w.label}</span>`;
            div.onclick = () => { if (this.isDesignMode) this.selectWidget(w.id); };

        } else if (w.type === 'slider') {
            div.innerHTML = `
                <div class="vc-fader-inner">
                    <span class="vc-label">${w.label}</span>
                    <input type="range" min="0" max="255" value="${w.level || 0}"
                           style="writing-mode:vertical-lr; direction:rtl; flex:1; width:24px; margin:8px 0;">
                    <span class="fader-val">${w.level || 0}</span>
                </div>`;
            const range = div.querySelector('input');
            const valEl = div.querySelector('.fader-val');
            range.oninput = () => {
                w.level = parseInt(range.value);
                valEl.innerText = w.level;
                fetch('/api/dmx/set', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        universe: w.universe !== undefined ? w.universe : 0,
                        channel: w.channel || 1,
                        value: w.level,
                        is_manual: true
                    })
                });
            };
            div.onclick = () => { if (this.isDesignMode) this.selectWidget(w.id); };

        } else if (w.type === 'cue-list') {
            div.innerHTML = `
                <div class="vc-cuelist">
                    <div class="cuelist-header">${w.label}</div>
                    <div class="cuelist-steps">
                        ${w.steps && w.steps.length ? w.steps.map((s, i) =>
                `<div class="cue-step-row ${w.currentStep === i ? 'active' : ''}" onclick="AuraConsole.goToStep('${w.id}',${i})">
                                <span>${i + 1}</span><span>${s.name || s.id || '—'}</span>
                            </div>`
            ).join('') : '<div style="padding:12px;color:#444;text-align:center;font-size:0.73rem;">Nessun step — configura nell\'inspector</div>'}
                    </div>
                    <div class="cuelist-controls">
                        <button onclick="AuraConsole.stepCue('${w.id}',-1)">⏮</button>
                        <button onclick="AuraConsole.stopCue('${w.id}')">⏹</button>
                        <button onclick="AuraConsole.stepCue('${w.id}',1)">⏭</button>
                    </div>
                </div>`;
            div.querySelector('.cuelist-header').onclick = () => { if (this.isDesignMode) this.selectWidget(w.id); };

        } else if (w.type === 'label') {
            div.innerHTML = `<div class="vc-text-label">${w.label}</div>`;
            div.onclick = () => { if (this.isDesignMode) this.selectWidget(w.id); };

        } else {
            // Button
            div.innerHTML = `
                <div class="vc-btn-inner ${w.active ? 'active' : ''}">
                    <div class="led"></div>
                    <span class="vc-label">${w.label}</span>
                </div>`;
            const inner = div.querySelector('.vc-btn-inner');

            div.onclick = () => {
                if (this.isDesignMode) {
                    this.selectWidget(w.id);
                } else if (w.mode === 'toggle') {
                    if (w.active) this.stopFunction(w, inner);
                    else this.startFunction(w, inner);
                }
            };
            div.onmousedown = () => { if (!this.isDesignMode && w.mode === 'flash') this.startFunction(w, inner); };
            div.onmouseup = () => { if (!this.isDesignMode && w.mode === 'flash') this.stopFunction(w, inner); };
        }

        // Resize handle (always present, visible only in design mode via CSS)
        const handle = document.createElement('div');
        handle.className = 'resize-handle';
        div.appendChild(handle);

        // Dragging in design mode
        if (this.isDesignMode) this.makeDraggable(div, w, handle);

        return div;
    },

    // ─── Widget Inspector ────────────────────────────────────────────
    selectWidget(id) {
        this.selectedWidget = this.widgets.find(w => w.id === id) || null;
        this.renderVirtualConsole(); // Re-render to show selection highlight
        this.showInspector(this.selectedWidget);
    },

    showInspector(w) {
        const form = document.getElementById('insp-form');
        const noSel = document.getElementById('insp-no-sel');

        if (!w) {
            form && (form.style.display = 'none');
            noSel && (noSel.style.display = 'flex');
            return;
        }

        form && (form.style.display = 'block');
        noSel && (noSel.style.display = 'none');

        // Populate common fields
        const label = document.getElementById('insp-label');
        if (label) label.value = w.label || '';

        // Show/hide sections based on type
        const btnSec = document.getElementById('insp-btn-section');
        const slSec = document.getElementById('insp-slider-section');
        const frmSec = document.getElementById('insp-frame-section');

        btnSec && (btnSec.style.display = (w.type === 'button' || w.type === 'cue-list') ? 'block' : 'none');
        slSec && (slSec.style.display = w.type === 'slider' ? 'block' : 'none');
        frmSec && (frmSec.style.display = w.type === 'frame' ? 'block' : 'none');

        if (w.type === 'button') {
            const modeEl = document.getElementById('insp-mode');
            if (modeEl) modeEl.value = w.mode || 'toggle';
            this.populateScenePicker(w.funcId);
            const funcId = document.getElementById('insp-func-id');
            if (funcId) funcId.value = w.funcId || '';
        }

        if (w.type === 'slider') {
            const ch = document.getElementById('insp-ch');
            const uni = document.getElementById('insp-uni');
            if (ch) ch.value = w.channel || 1;
            if (uni) uni.value = w.universe !== undefined ? w.universe + 1 : 1;
        }
    },

    populateScenePicker(selectedId) {
        const picker = document.getElementById('insp-scene-picker');
        if (!picker) return;

        const scenes = this.functions?.scenes || {};
        const chasers = this.functions?.chasers || {};
        const efx = this.functions?.efx || {};

        let html = '';

        const renderCategory = (title, data) => {
            const entries = Object.entries(data);
            if (entries.length === 0) return '';
            let res = `<div class="scene-divider" style="margin-top:6px;">${title}</div>`;
            res += entries.map(([id, sc]) => {
                const name = sc.name || sc.Name || id;
                return `<div class="insp-scene-opt ${String(selectedId) === String(id) ? 'selected' : ''}"
                             onclick="AuraConsole.pickScene('${id}')">${name}</div>`;
            }).join('');
            return res;
        };

        html += renderCategory('Scene', scenes);
        html += renderCategory('Chaser', chasers);
        html += renderCategory('EFX', efx);

        if (!html) {
            picker.innerHTML = '<div class="insp-scene-opt" style="color:#666; font-style:italic;">Nessuna funzione disponibile. Carica un workspace (.qxw) in Setup.</div>';
            return;
        }

        picker.innerHTML = html;

        // Auto-scroll to selected
        const sel = picker.querySelector('.selected');
        if (sel) sel.scrollIntoView({ block: 'nearest' });
    },

    pickScene(id) {
        // Update the manual input field too
        const funcId = document.getElementById('insp-func-id');
        if (funcId) funcId.value = id;
        this.populateScenePicker(id);
    },

    applyInspector() {
        const w = this.selectedWidget;
        if (!w) return;

        const label = document.getElementById('insp-label');
        if (label) w.label = label.value;

        if (w.type === 'button') {
            const mode = document.getElementById('insp-mode');
            const funcId = document.getElementById('insp-func-id');
            if (mode) w.mode = mode.value;
            if (funcId && funcId.value) w.funcId = funcId.value;
        }

        if (w.type === 'slider') {
            const ch = document.getElementById('insp-ch');
            const uni = document.getElementById('insp-uni');
            if (ch) w.channel = parseInt(ch.value) || 1;
            if (uni) w.universe = Math.max(0, (parseInt(uni.value) || 1) - 1);
        }

        if (w.type === 'cue-list') {
            const funcId = document.getElementById('insp-func-id');
            if (funcId && funcId.value) {
                w.funcId = funcId.value;
                const chaser = this.functions?.chasers?.[funcId.value];
                if (chaser) w.steps = chaser.steps || [];
            }
        }

        this.saveLayout();
        this.renderVirtualConsole();
        if (typeof notify === 'function') notify('Widget aggiornato', 'success', 2000);
    },

    deleteWidget() {
        const w = this.selectedWidget;
        if (!w) return;
        this.widgets = this.widgets.filter(x => x.id !== w.id && x.parentId !== w.id);
        this.selectedWidget = null;
        this.showInspector(null);
        this.saveLayout();
        this.renderVirtualConsole();
        if (typeof notify === 'function') notify('Widget eliminato', 'warning', 2000);
    },

    // ─── Scene List (left panel) ────────────────────────────────────
    renderSceneList() {
        const list = document.getElementById('vc-scene-list');
        if (!list) return;
        const scenes = this.functions?.scenes || {};
        const chasers = this.functions?.chasers || {};
        const entries = [...Object.entries(scenes), ...Object.entries(chasers)];

        if (entries.length === 0) {
            list.innerHTML = '<div style="color:#444; font-size:0.73rem; padding:10px; text-align:center;">Carica workspace in Setup</div>';
            return;
        }

        list.innerHTML = '';

        if (Object.keys(scenes).length) {
            const lbl = document.createElement('div');
            lbl.className = 'scene-divider';
            lbl.innerText = 'Scene';
            list.appendChild(lbl);
            Object.entries(scenes).forEach(([id, sc]) => {
                const el = document.createElement('div');
                el.className = 'scene-badge';
                el.innerText = sc.name || id;
                el.onclick = () => this.quickLaunchScene(id, el);
                list.appendChild(el);
            });
        }

        if (Object.keys(chasers).length) {
            const lbl = document.createElement('div');
            lbl.className = 'scene-divider';
            lbl.innerText = 'Chasers';
            list.appendChild(lbl);
            Object.entries(chasers).forEach(([id, ch]) => {
                const el = document.createElement('div');
                el.className = 'scene-badge';
                el.innerText = ch.name || id;
                el.onclick = () => this.quickLaunchScene(id, el);
                list.appendChild(el);
            });
        }
    },

    quickLaunchScene(id, el) {
        // Toggle active state
        const isActive = el.classList.contains('active-scene');
        document.querySelectorAll('.scene-badge.active-scene').forEach(e => e.classList.remove('active-scene'));
        if (!isActive) {
            el.classList.add('active-scene');
            fetch(`/api/functions/run/scene/${id}`, { method: 'POST' });
            if (typeof notify === 'function') notify('Scena avviata', 'success', 1500);
        } else {
            fetch(`/api/functions/stop/${id}`, { method: 'POST' });
        }
    },

    // ─── Function Control ────────────────────────────────────────────
    async startFunction(w, el) {
        if (!w.funcId) {
            if (typeof notify === 'function') notify('Nessuna funzione assegnata — configura in Design Mode', 'warning', 3000);
            return;
        }
        // Solo Frame: deactivate siblings
        if (w.parentId) {
            this.widgets
                .filter(s => s.parentId === w.parentId && s.id !== w.id && s.active)
                .forEach(s => {
                    s.active = false;
                    const sEl = document.getElementById(s.id)?.querySelector('.vc-btn-inner');
                    sEl?.classList.remove('active');
                    fetch(`/api/functions/stop/${s.funcId}`, { method: 'POST' });
                });
        }
        w.active = true;
        el?.classList.add('active');
        fetch(`/api/functions/run/scene/${w.funcId}`, { method: 'POST' });
    },

    async stopFunction(w, el) {
        if (!w.funcId) return;
        w.active = false;
        el?.classList.remove('active');
        fetch(`/api/functions/stop/${w.funcId}`, { method: 'POST' });
    },

    // ─── Cue List Control ────────────────────────────────────────────
    stepCue(wid, dir) {
        const w = this.widgets.find(x => x.id === wid);
        if (!w || !w.steps || w.steps.length === 0) return;
        w.currentStep = (w.currentStep + dir + w.steps.length) % w.steps.length;
        const step = w.steps[w.currentStep];
        fetch(`/api/functions/run/scene/${step.id || step}`, { method: 'POST' });
        this.renderVirtualConsole();
    },

    goToStep(wid, idx) {
        const w = this.widgets.find(x => x.id === wid);
        if (!w || !w.steps) return;
        w.currentStep = idx;
        const step = w.steps[idx];
        if (!this.isDesignMode) fetch(`/api/functions/run/scene/${step.id || step}`, { method: 'POST' });
        this.renderVirtualConsole();
    },

    stopCue(wid) {
        const w = this.widgets.find(x => x.id === wid);
        if (!w || !w.funcId) return;
        fetch(`/api/functions/stop/${w.funcId}`, { method: 'POST' });
    },

    // ─── Drag & Resize ───────────────────────────────────────────────
    makeDraggable(el, w, handle) {
        let moving = false, resizing = false, sx = 0, sy = 0, sw = 0, sh = 0;

        el.onmousedown = (e) => {
            if (!this.isDesignMode) return;
            e.stopPropagation();
            if (e.target === handle || handle.contains(e.target)) {
                resizing = true;
                sx = e.clientX; sy = e.clientY;
                sw = el.offsetWidth; sh = el.offsetHeight;
            } else {
                moving = true;
                sx = e.clientX - el.offsetLeft;
                sy = e.clientY - el.offsetTop;
            }
            el.style.zIndex = 1000;
            document.body.style.userSelect = 'none';
        };

        const onMove = (e) => {
            if (moving) {
                const x = Math.round((e.clientX - sx) / 40) * 40;
                const y = Math.round((e.clientY - sy) / 40) * 40;
                el.style.left = x + 'px';
                el.style.top = y + 'px';
                w.x = x; w.y = y;
                // Auto parent detection
                const frames = this.widgets.filter(f => f.type === 'frame' && f.id !== w.id);
                const parent = frames.find(f => x >= f.x && x < f.x + f.w && y >= f.y && y < f.y + f.h);
                w.parentId = parent ? parent.id : null;
            } else if (resizing) {
                const nw = Math.max(Math.round((sw + e.clientX - sx) / 40) * 40, 40);
                const nh = Math.max(Math.round((sh + e.clientY - sy) / 40) * 40, 40);
                el.style.width = nw + 'px';
                el.style.height = nh + 'px';
                w.w = nw; w.h = nh;
            }
        };

        const onUp = () => {
            moving = false; resizing = false;
            el.style.zIndex = '';
            document.body.style.userSelect = '';
            this.saveLayout();
        };

        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    }
};

document.addEventListener('DOMContentLoaded', () => window.AuraConsole.init());
