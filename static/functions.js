/**
 * AuraSync Pro - Visual Function Editor V3.0
 * Professional 3-column workflow for creating Scenes, Chasers, and EFX.
 */

window.AuraFunctions = {
    fixtures: [],
    functions: { scenes: {}, chasers: {}, efx: {} },
    selectedFunction: null,
    editorData: {}, // Temporary data for the currently edited function
    isDirty: false,

    // ─── Init ────────────────────────────────────────────────────────
    async init() {
        console.log('[Functions] V3.0 initializing...');
        await this.loadData();
        this.renderFunctionList();

        // Handle URL params if editing specific function from another page
        constParams = new URLSearchParams(window.location.search);
        const fId = constParams.get('id');
        const fType = constParams.get('type');
        if (fId && fType) this.selectFunction(fId, fType);
    },

    async loadData() {
        try {
            const [fixRes, fnRes] = await Promise.all([
                fetch('/api/workspace/fixtures'),
                fetch('/api/functions')
            ]);
            if (fixRes.ok) this.fixtures = await fixRes.json();
            if (fnRes.ok) this.functions = await fnRes.json();
            console.log('[Functions] Data loaded:', Object.keys(this.functions.scenes || {}).length, 'scenes');
        } catch (e) {
            console.error('[Functions] Load error:', e);
        }
    },

    // ─── List Rendering ──────────────────────────────────────────────
    renderFunctionList() {
        const list = document.getElementById('function-list');
        if (!list) return;
        list.innerHTML = '';

        const renderGroup = (title, items, type) => {
            const keys = Object.keys(items);
            if (keys.length === 0 && type !== 'scene') return; // Don't show empty groups except scene (as starting point)

            const divider = document.createElement('div');
            divider.className = 'scene-divider';
            divider.innerText = title;
            list.appendChild(divider);

            if (keys.length === 0) {
                const empty = document.createElement('div');
                empty.style = 'color:#444; font-size:0.7rem; padding:10px; font-style:italic;';
                empty.innerText = 'Crea la prima funzione';
                list.appendChild(empty);
                return;
            }

            keys.sort((a, b) => {
                const nameA = (items[a].name || items[a].Name || '').toLowerCase();
                const nameB = (items[b].name || items[b].Name || '').toLowerCase();
                return nameA.localeCompare(nameB);
            }).forEach(id => {
                const f = items[id];
                const card = document.createElement('div');
                card.className = 'function-card';
                if (this.selectedFunction && this.selectedFunction.id === id) card.classList.add('active');

                const name = f.name || f.Name || id;
                const path = f.path || f.Path || '';

                card.innerHTML = `
                    <div style="display:flex; flex-direction:column; gap:2px; flex:1; overflow:hidden;">
                        <span style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${name}</span>
                        ${path ? `<span style="font-size:0.6rem; color:#555;">${path}</span>` : ''}
                    </div>
                    <span class="type-tag" style="background:${this.getTypeColor(type)}22; color:${this.getTypeColor(type)}">${type}</span>
                `;
                card.onclick = () => this.selectFunction(id, type);
                list.appendChild(card);
            });
        };

        renderGroup('SCENE', this.functions.scenes || {}, 'scene');
        renderGroup('CHASERS/SEQUENCES', this.functions.chasers || {}, 'chaser');
        renderGroup('MOVIMENTI EFX', this.functions.efx || {}, 'efx');
    },

    getTypeColor(type) {
        switch (type) {
            case 'scene': return '#00d2ff';
            case 'chaser': return '#00ff88';
            case 'efx': return '#ffaa00';
            default: return '#888';
        }
    },

    // ─── Selection Logic ─────────────────────────────────────────────
    async selectFunction(id, type) {
        // Find function data
        const group = type === 'scene' ? this.functions.scenes :
            type === 'chaser' ? this.functions.chasers :
                this.functions.efx;

        const original = group[id];
        if (!original) return;

        this.selectedFunction = { id, type, ...original };
        this.editorData = JSON.parse(JSON.stringify(original)); // Deep copy for editing
        this.isDirty = false;

        this.renderFunctionList();
        this.renderEditor();
        this.renderInspector();

        // Show save bar
        const saveBar = document.getElementById('fn-save-bar');
        if (saveBar) saveBar.style.display = 'flex';
    },

    createNew(type) {
        const id = 'f' + Date.now();
        const names = { scene: 'Nuova Scena', chaser: 'Nuovo Chaser', efx: 'Nuovo EFX' };

        const newFn = {
            id,
            name: names[type],
            type: type,
            data: {},    // For scenes
            steps: [],   // For chasers
            fixtures: [], // For EFX
            pattern: 'circle',
            speed: 1.0, width: 50, height: 50
        };

        // Add to local state
        const bucket = type === 'scene' ? 'scenes' : type === 'chaser' ? 'chasers' : 'efx';
        this.functions[bucket][id] = newFn;

        this.selectFunction(id, type);
        if (typeof notify === 'function') notify(`${type} creato`, 'success', 2000);
    },

    // ─── Editor Rendering ─────────────────────────────────────────────
    renderEditor() {
        const container = document.getElementById('function-editor-content');
        if (!container) return;
        container.innerHTML = '';

        if (this.selectedFunction.type === 'scene') {
            this.renderSceneEditor(container);
        } else if (this.selectedFunction.type === 'chaser') {
            this.renderChaserEditor(container);
        } else if (this.selectedFunction.type === 'efx') {
            this.renderEFXEditor(container);
        }
    },

    // ─── SCENE EDITOR ────────────────────────────────────────────────
    renderSceneEditor(container) {
        container.innerHTML = `
            <div style="display:flex; flex-direction:column; gap:20px;">
                <div style="display:flex; justify-content:space-between; align-items:center;">
                    <h3 style="margin:0; font-size:0.9rem; color:#fff;">Fixture Grid</h3>
                    <div style="font-size:0.7rem; color:#555;">Seleziona fixture per regolare i parametri</div>
                </div>
                
                <div class="fixture-mask-grid">
                    ${this.fixtures.map(f => {
            const hasValues = Object.keys(this.editorData.data || {}).some(k => k.startsWith(`${f.universe}_`));
            return `
                        <div class="fixture-mask-card ${hasValues ? 'active' : ''}" id="mask-${f.id}" onclick="AuraFunctions.editFixtureChannels('${f.id}')">
                            <div class="name">${f.name}</div>
                            <div class="info">U${f.universe} • Addr ${f.address}</div>
                        </div>
                        `;
        }).join('')}
                </div>
                
                <div id="channel-editor-area" style="min-height:200px; border-top:1px solid rgba(255,255,255,0.05); padding-top:20px;">
                    <div class="editor-placeholder" style="height:auto; padding:40px 0;">
                        <span style="font-size:1.5rem;">💡</span>
                        <p>Seleziona una fixture per aprire i canali</p>
                    </div>
                </div>
            </div>
        `;
    },

    editFixtureChannels(id) {
        const fix = this.fixtures.find(f => f.id === id);
        if (!fix) return;

        // Visual feedback
        document.querySelectorAll('.fixture-mask-card').forEach(c => c.classList.remove('selected-editor'));
        document.getElementById(`mask-${id}`).classList.add('selected-editor');

        const area = document.getElementById('channel-editor-area');
        if (!area) return;

        area.innerHTML = `
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:15px;">
                <h4 style="margin:0; font-size:0.8rem; color:var(--accent-color); text-transform:uppercase;">${fix.name}</h4>
                <button onclick="AuraFunctions.clearFixtureInScene('${fix.id}')" style="background:none; border:none; color:#ff4455; font-size:0.65rem; cursor:pointer;">Reset Fixture</button>
            </div>
            <div class="channel-grid" style="display:grid; grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); gap:10px;">
                ${(fix.channel_details || []).map((ch, idx) => {
            const chNum = parseInt(fix.address) + idx;
            const key = `${fix.universe}_${chNum}`;
            const val = this.editorData.data?.[fix.universe]?.[chNum] ?? this.editorData.data?.[key] ?? 0;

            return `
                    <div class="channel-slider-box" style="background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.06); padding:10px; border-radius:8px;">
                        <div style="display:flex; justify-content:space-between; margin-bottom:5px;">
                            <label style="font-size:0.65rem; color:#888;">${ch.name}</label>
                            <span id="ch-val-${key}" style="font-size:0.65rem; color:var(--accent-color); font-weight:800;">${val}</span>
                        </div>
                        <input type="range" class="pro-slider" min="0" max="255" value="${val}" 
                               style="width:100%; height:4px;"
                               oninput="AuraFunctions.updateSceneChannel(${fix.universe}, ${chNum}, this.value)">
                    </div>
                    `;
        }).join('')}
            </div>
        `;
    },

    updateSceneChannel(uni, ch, val) {
        if (!this.editorData.data) this.editorData.data = {};
        if (!this.editorData.data[uni]) this.editorData.data[uni] = {};

        this.editorData.data[uni][ch] = parseInt(val);
        this.isDirty = true;

        const key = `${uni}_${ch}`;
        const display = document.getElementById(`ch-val-${key}`);
        if (display) display.innerText = val;

        // Live Preview
        fetch('/api/dmx/set', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ universe: uni, channel: ch, value: parseInt(val) })
        });
    },

    clearFixtureInScene(id) {
        const fix = this.fixtures.find(f => f.id === id);
        if (!fix) return;
        if (this.editorData.data && this.editorData.data[fix.universe]) {
            (fix.channel_details || []).forEach((_, idx) => {
                const chNum = fix.address + idx;
                delete this.editorData.data[fix.universe][chNum];
            });
            this.editFixtureChannels(id);
            document.getElementById(`mask-${id}`).classList.remove('active');
        }
    },

    // ─── CHASER EDITOR ───────────────────────────────────────────────
    renderChaserEditor(container) {
        container.innerHTML = `
            <div style="display:flex; flex-direction:column; gap:20px;">
                <div style="display:flex; justify-content:space-between; align-items:center;">
                    <h3 style="margin:0; font-size:0.9rem; color:#fff;">Sequenza Step</h3>
                    <button class="vc-mode-btn" onclick="AuraFunctions.addChaserStep()" style="width:auto; padding:5px 12px; font-size:0.7rem;">+ Aggiungi Scena</button>
                </div>

                <div style="background:rgba(0,0,0,0.2); border-radius:12px; border:1px solid rgba(255,255,255,0.06); overflow:hidden;">
                    <table class="chaser-step-table">
                        <thead>
                            <tr>
                                <th width="40">#</th>
                                <th>Scena</th>
                                <th width="100">Hold (ms)</th>
                                <th width="100">Fade (ms)</th>
                                <th width="60"></th>
                            </tr>
                        </thead>
                        <tbody id="chaser-steps-body">
                            ${(this.editorData.steps || []).map((step, idx) => `
                                <tr class="chaser-step-row">
                                    <td>${idx + 1}</td>
                                    <td>
                                        <select class="insp-select" style="padding:4px; font-size:0.75rem;" onchange="AuraFunctions.updateStep(${idx}, 'scene_id', this.value)">
                                            ${Object.entries(this.functions.scenes).map(([sid, sc]) => `
                                                <option value="${sid}" ${String(step.scene_id) === sid ? 'selected' : ''}>${sc.name || sid}</option>
                                            `).join('')}
                                        </select>
                                    </td>
                                    <td><input type="number" class="step-input-small" value="${step.hold || 1000}" onchange="AuraFunctions.updateStep(${idx}, 'hold', this.value)"></td>
                                    <td><input type="number" class="step-input-small" value="${step.fade || 0}" onchange="AuraFunctions.updateStep(${idx}, 'fade', this.value)"></td>
                                    <td><button onclick="AuraFunctions.removeStep(${idx})" style="background:none; border:none; color:#ff4455; cursor:pointer;">✕</button></td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>
                    ${(!this.editorData.steps || this.editorData.steps.length === 0) ? `
                        <div style="padding:40px; text-align:center; color:#444; font-size:0.75rem; font-style:italic;">
                            Nessun passo. Aggiungi scene per creare una sequenza.
                        </div>
                    ` : ''}
                </div>
                
                <div style="display:flex; gap:10px; margin-top:10px;">
                    <button class="vc-mode-btn live-active" style="width:auto;" onclick="AuraFunctions.previewChaser()">▶ Test Sequenza</button>
                    <button class="vc-mode-btn" style="width:auto; color:#ff4455;" onclick="AuraFunctions.stopChaser()">⏹ Stop</button>
                </div>
            </div>
        `;
    },

    addChaserStep() {
        if (!this.editorData.steps) this.editorData.steps = [];
        const firstSceneId = Object.keys(this.functions.scenes)[0];
        if (!firstSceneId) return notify('Devi creare prima almeno una scena', 'error');

        this.editorData.steps.push({
            scene_id: firstSceneId,
            hold: 1000,
            fade: 0
        });
        this.isDirty = true;
        this.renderEditor();
    },

    updateStep(idx, field, val) {
        const step = this.editorData.steps[idx];
        if (step) {
            step[field] = (field === 'scene_id') ? val : parseInt(val);
            this.isDirty = true;
        }
    },

    removeStep(idx) {
        this.editorData.steps.splice(idx, 1);
        this.isDirty = true;
        this.renderEditor();
    },

    previewChaser() {
        if (!this.selectedFunction.id) return;
        this.saveCurrent(true); // Silent save before preview
        fetch(`/api/functions/run/chaser/${this.selectedFunction.id}`, { method: 'POST' });
    },

    stopChaser() {
        if (!this.selectedFunction.id) return;
        fetch(`/api/functions/stop/${this.selectedFunction.id}`, { method: 'POST' });
    },

    // ─── EFX EDITOR ──────────────────────────────────────────────────
    renderEFXEditor(container) {
        container.innerHTML = `
            <div style="display:flex; flex-direction:column; gap:20px;">
                <h3 style="margin:0; font-size:0.9rem; color:#fff;">Generatore Pattern EFX</h3>
                
                <div class="efx-pattern-preview">
                    <canvas id="efx-preview-canvas" class="efx-pattern-canvas"></canvas>
                    <div style="position:absolute; bottom:10px; right:10px; font-size:0.65rem; color:var(--accent-color); font-weight:800; background:rgba(0,0,0,0.5); padding:2px 8px; border-radius:10px; border:1px solid var(--accent-color);">LIVE PREVIEW</div>
                </div>

                <div class="efx-params-grid">
                    <div class="insp-group">
                        <div class="insp-label">Pattern</div>
                        <select class="insp-select" onchange="AuraFunctions.updateEFX('pattern', this.value)">
                            <option value="circle" ${this.editorData.pattern === 'circle' ? 'selected' : ''}>Cerchio</option>
                            <option value="eight" ${this.editorData.pattern === 'eight' ? 'selected' : ''}>Otto (Infinity)</option>
                            <option value="sine" ${this.editorData.pattern === 'sine' ? 'selected' : ''}>Ondata Pan</option>
                            <option value="pulse" ${this.editorData.pattern === 'pulse' ? 'selected' : ''}>Pulsazione</option>
                        </select>
                    </div>
                    <div class="insp-group">
                        <div class="insp-label">Velocità</div>
                        <input type="range" min="0.1" max="5.0" step="0.1" value="${this.editorData.speed || 1.0}" oninput="AuraFunctions.updateEFX('speed', this.value)">
                    </div>
                </div>

                <div style="display:flex; flex-direction:column; gap:10px; border-top:1px solid rgba(255,255,255,0.05); padding-top:15px;">
                    <div class="insp-label">Fixture Incluse</div>
                    <div class="fixture-mask-grid">
                        ${this.fixtures.map(f => `
                            <div class="fixture-mask-card ${this.editorData.fixtures?.includes(f.id) ? 'active' : ''}" onclick="AuraFunctions.toggleFixtureInEFX('${f.id}')">
                                <div class="name">${f.name}</div>
                                <div class="info">U${f.universe}</div>
                            </div>
                        `).join('')}
                    </div>
                </div>
            </div>
        `;
        this.initEFXPreview();
    },

    updateEFX(field, val) {
        this.editorData[field] = (field === 'pattern') ? val : parseFloat(val);
        this.isDirty = true;
    },

    toggleFixtureInEFX(id) {
        if (!this.editorData.fixtures) this.editorData.fixtures = [];
        const idx = this.editorData.fixtures.indexOf(id);
        if (idx > -1) this.editorData.fixtures.splice(idx, 1);
        else this.editorData.fixtures.push(id);

        this.isDirty = true;
        this.renderEditor();
    },

    initEFXPreview() {
        const canvas = document.getElementById('efx-preview-canvas');
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        let t = 0;

        const draw = () => {
            if (!document.getElementById('efx-preview-canvas')) return;

            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.strokeStyle = 'rgba(0, 210, 255, 0.2)';
            ctx.setLineDash([5, 5]);
            ctx.strokeRect(20, 20, canvas.width - 40, canvas.height - 40);
            ctx.setLineDash([]);

            const pattern = this.editorData.pattern;
            const speed = this.editorData.speed || 1.0;
            const w = (canvas.width - 80) / 2;
            const h = (canvas.height - 80) / 2;
            const cx = canvas.width / 2;
            const cy = canvas.height / 2;

            ctx.fillStyle = 'var(--accent-color)';
            ctx.shadowBlur = 10;
            ctx.shadowColor = 'var(--accent-color)';

            // Draw current point
            let x = cx, y = cy;
            if (pattern === 'circle') {
                x = cx + Math.cos(t) * w;
                y = cy + Math.sin(t) * h;
            } else if (pattern === 'eight') {
                x = cx + Math.sin(t) * w;
                y = cy + Math.sin(2 * t) * h;
            } else if (pattern === 'sine') {
                x = cx + Math.sin(t) * w;
                y = cy;
            }

            ctx.beginPath();
            ctx.arc(x, y, 6, 0, Math.PI * 2);
            ctx.fill();

            t += 0.05 * speed;
            requestAnimationFrame(draw);
        };
        requestAnimationFrame(draw);
    },

    // ─── INSPECTOR ──────────────────────────────────────────────────
    renderInspector() {
        const body = document.getElementById('fn-inspector');
        if (!body) return;

        body.innerHTML = `
            <div class="insp-group">
                <div class="insp-label">Nome Funzione</div>
                <input type="text" id="insp-fn-name" class="insp-input" value="${this.editorData.name || ''}" oninput="AuraFunctions.onMetaChange()">
            </div>
            <div class="insp-group">
                <div class="insp-label">Percorso / Gruppo</div>
                <input type="text" id="insp-fn-path" class="insp-input" value="${this.editorData.path || ''}" oninput="AuraFunctions.onMetaChange()" placeholder="es. COLORI">
            </div>
            <div class="insp-group">
                <div class="insp-label">ID QLC+</div>
                <div style="font-size:0.7rem; color:#444; font-family:monospace; background:rgba(255,255,255,0.03); padding:8px; border-radius:6px;">${this.selectedFunction.id}</div>
            </div>
            ${this.selectedFunction.type === 'scene' ? `
                <div class="insp-group">
                    <div class="insp-label">Info Canali</div>
                    <div style="font-size:0.65rem; color:#666;">Canali mappati: ${Object.keys(this.editorData.data || {}).length}</div>
                </div>
            ` : ''}
        `;
    },

    onMetaChange() {
        this.editorData.name = document.getElementById('insp-fn-name').value;
        this.editorData.path = document.getElementById('insp-fn-path').value;
        this.isDirty = true;
    },

    // ─── PERSISTENCE ─────────────────────────────────────────────────
    async saveCurrent(isSilent = false) {
        if (!this.selectedFunction) return;

        const f = this.editorData;
        const endpoint = f.type === 'scene' ? '/api/functions/scene' : '/api/functions/save'; // Generic for others if available

        try {
            const res = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(f)
            });

            if (res.ok) {
                this.isDirty = false;
                if (!isSilent) {
                    notify('Funzione salvata', 'success', 2000);
                    await this.loadData();
                    this.renderFunctionList();
                }
            } else {
                if (!isSilent) notify('Errore durante il salvataggio', 'error');
            }
        } catch (e) {
            console.error(e);
            if (!isSilent) notify('Errore di rete', 'error');
        }
    },

    async deleteCurrent() {
        if (!this.selectedFunction) return;
        if (!confirm(`Vuoi davvero eliminare ${this.editorData.name}?`)) return;

        try {
            const res = await fetch(`/api/functions/delete/${this.selectedFunction.id}`, { method: 'DELETE' });
            if (res.ok) {
                notify('Funzione eliminata', 'success', 2000);
                this.selectedFunction = null;
                await this.loadData();
                this.renderFunctionList();
                this.renderEditor();
                this.renderInspector();
                document.getElementById('fn-save-bar').style.display = 'none';
            }
        } catch (e) {
            notify('Errore eliminazione', 'error');
        }
    }
};

document.addEventListener('DOMContentLoaded', () => window.AuraFunctions.init());
