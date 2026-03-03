/**
 * AuraSync Professional Console & Function Manager logic
 */

window.AuraConsole = {
    functions: {
        scenes: {},
        chasers: {},
        efx: {}
    },
    activeFunctions: new Set(),
    deskFaders: {}, // channel -> value

    async init() {
        console.log("[Console] Initializing AuraSync Professional...");
        await this.loadFunctions();
        await this.loadGroups();
        this.renderSimpleDesk();
        this.setupEventListeners();
    },

    async loadFunctions() {
        try {
            const res = await fetch('/api/functions');
            this.functions = await res.json();
            this.renderFunctionManager();
            this.renderVirtualConsole();
        } catch (e) {
            console.error("[Console] Failed to load functions:", e);
        }
    },

    async loadGroups() {
        try {
            const res = await fetch('/api/groups');
            this.groups = await res.json();
            this.renderRGBMatrixControls();
        } catch (e) {
            console.error("[Console] Failed to load groups:", e);
        }
    },

    setupEventListeners() {
        window.addEventListener('workspace-loaded', () => {
            this.loadFunctions();
            this.loadGroups();
        });
    },

    // --- FUNCTION MANAGER UI ---
    renderFunctionManager() {
        const container = document.getElementById('function-list');
        if (!container) return;

        container.innerHTML = '<h3>Scene & Sequenze</h3>';

        Object.entries(this.functions.scenes || {}).forEach(([id, scene]) => {
            container.appendChild(this.createFunctionCard(id, scene.name, 'scene'));
        });

        Object.entries(this.functions.chasers || {}).forEach(([id, chaser]) => {
            container.appendChild(this.createFunctionCard(id, chaser.name, 'chaser'));
        });

        Object.entries(this.functions.efx || {}).forEach(([id, efx]) => {
            container.appendChild(this.createFunctionCard(id, efx.name, 'efx'));
        });
    },

    createFunctionCard(id, name, type) {
        const div = document.createElement('div');
        div.className = 'function-card';
        div.draggable = true;
        div.innerHTML = `<span>${name}</span><span class="type-tag">${type}</span>`;
        div.onclick = () => this.toggleFunction(type, id, div);

        div.ondragstart = (e) => {
            e.dataTransfer.setData("application/aurasync-function", JSON.stringify({ id, name, type }));
            e.dataTransfer.effectAllowed = "copy";
        };
        return div;
    },

    async toggleFunction(type, id, element) {
        const isRunning = this.activeFunctions.has(id);
        if (isRunning) {
            await fetch(`/api/functions/stop/${id}`, { method: 'POST' });
            this.activeFunctions.delete(id);
            element.classList.remove('active');
        } else {
            await fetch(`/api/functions/run/${type}/${id}`, { method: 'POST' });
            if (type !== 'scene') {
                this.activeFunctions.add(id);
                element.classList.add('active');
            }
        }
    },

    async createSceneFromDump() {
        const name = prompt("Nome della Scena (Snapshot):", "Dump " + new Date().toLocaleTimeString());
        if (!name) return;

        const res = await fetch('/api/dmx/dump', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name })
        });
        const data = await res.json();
        if (data.status === 'success') {
            await this.loadFunctions();
        }
    },

    // --- SIMPLE DESK UI ---
    renderSimpleDesk() {
        const grid = document.getElementById('desk-fader-grid');
        if (!grid) return;

        grid.innerHTML = '';
        // Render first 64 channels for performance, user can paginate later (logic simplified)
        for (let i = 1; i <= 64; i++) {
            const item = document.createElement('div');
            item.className = 'desk-fader-item';
            item.innerHTML = `
                <span class="ch-num">${i}</span>
                <span class="ch-val" id="desk-val-${i}">0</span>
                <input type="range" class="desk-slider" min="0" max="255" value="0" orient="vertical" id="desk-fader-${i}">
            `;

            const slider = item.querySelector('input');
            const valDisplay = item.querySelector('.ch-val');

            slider.oninput = () => {
                const val = parseInt(slider.value);
                valDisplay.innerText = val;
                this.setManualChannel(i, val);
            };

            grid.appendChild(item);
        }
    },

    async setManualChannel(ch, val) {
        await fetch('/api/dmx/manual', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                universe: 0,
                channels: { [ch]: val }
            })
        });
    },

    async resetAllDeskFaders() {
        document.querySelectorAll('.desk-slider').forEach(s => {
            s.value = 0;
            const id = s.id.replace('desk-fader-', '');
            const valDisplay = document.getElementById(`desk-val-${id}`);
            if (valDisplay) valDisplay.innerText = '0';
        });
        // Logic to clear manual overrides in backend could be added via a new endpoint or just wait 5s
    },

    // --- RGB MATRIX UI ---
    renderRGBMatrixControls() {
        const container = document.getElementById('function-list'); // For now, append to list
        if (!container || !this.groups || this.groups.length === 0) return;

        const section = document.createElement('div');
        section.innerHTML = '<h3 style="margin-top:20px;">RGB Matrix Grids</h3>';

        this.groups.forEach(group => {
            const div = document.createElement('div');
            div.className = 'function-card';
            div.innerHTML = `<span>Grid: ${group.name}</span><button class="mini-btn">START</button>`;

            const btn = div.querySelector('button');
            let isRunning = false;

            btn.onclick = async (e) => {
                e.stopPropagation();
                isRunning = !isRunning;
                if (isRunning) {
                    await fetch('/api/matrix/start', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ group_id: group.id, pattern: "plasma" })
                    });
                    btn.innerText = "STOP";
                    btn.style.background = "var(--primary-color)";
                } else {
                    await fetch(`/api/matrix/stop/${group.id}`, { method: 'POST' });
                    btn.innerText = "START";
                    btn.style.background = "";
                }
            };
            section.appendChild(div);
        });
        container.appendChild(section);
    },

    // --- VIRTUAL CONSOLE UI ---
    renderVirtualConsole() {
        const container = document.getElementById('virtual-console-grid');
        if (!container) return;
        container.innerHTML = '';

        Object.entries(this.functions.scenes || {}).forEach(([id, scene]) => {
            container.appendChild(this.createConsoleButton(id, scene.name, 'scene'));
        });
    },

    createConsoleButton(id, label, type, groupId = null) {
        const div = document.createElement('div');
        div.className = 'vc-button';
        if (groupId) div.dataset.group = groupId;
        div.dataset.id = id;
        div.innerHTML = `<div class="led-indicator"></div><div class="vc-icon">🎬</div><div class="vc-label">${label}</div>`;

        div.onclick = () => {
            if (div.dataset.group) {
                document.querySelectorAll(`.vc-button[data-group="${div.dataset.group}"]`).forEach(b => {
                    if (b !== div && b.classList.contains('on')) {
                        b.classList.remove('on');
                        fetch(`/api/functions/stop/${b.dataset.id}`, { method: 'POST' });
                    }
                });
            }
            const isOn = div.classList.toggle('on');
            if (isOn) fetch(`/api/functions/run/${type}/ ${id}`, { method: 'POST' });
            else fetch(`/api/functions/stop/${id}`, { method: 'POST' });
        };
        return div;
    }
};
