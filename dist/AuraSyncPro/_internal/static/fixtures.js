/**
 * AuraSync Pro - Fixture Manager Logic
 * Handles DMX Patching, Library Browsing, and Fixture Properties.
 */

let activeUniverse = 0;
let selectedFixture = null;
let fixtureLibrary = [];
let activeFixtures = [];

async function initFixtureManager() {
    showLoading("Inizializzazione Patch Bay...");

    // 1. Initial Render of Grid
    renderPatchGrid();

    // 2. Load Data from Backend
    await loadLibrary();
    await loadActiveFixtures();

    // 3. Setup Events
    setupEventListeners();

    hideLoading();
    console.log("[Fixtures] Fixture Manager Initialized");
}

function renderPatchGrid() {
    const grid = document.getElementById('patch-bay-container');
    grid.innerHTML = '';

    for (let i = 1; i <= 512; i++) {
        const cell = document.createElement('div');
        cell.className = 'dmx-cell';
        cell.id = `dmx-${i}`;
        cell.innerText = i;
        cell.dataset.ch = i;

        cell.onclick = () => selectAddress(i);
        grid.appendChild(cell);
    }
}

async function loadLibrary() {
    try {
        const res = await fetch('/api/fixture/library');
        const data = await res.json();
        if (data.status === 'success') {
            fixtureLibrary = data.fixtures;
            renderLibraryList();
        }
    } catch (e) { console.warn("[Library] Load failed", e); }
}

async function loadActiveFixtures() {
    try {
        const res = await fetch('/api/env/status');
        const data = await res.json();
        activeFixtures = data.workspace.fixtures || [];
        renderActiveFixtures();
        updatePatchOccupancy();
    } catch (e) { console.warn("[Workspace] Load failed", e); }
}

function renderLibraryList() {
    const list = document.getElementById('library-list');
    const search = document.getElementById('library-search').value.toLowerCase();

    const filtered = fixtureLibrary.filter(f =>
        (f.name || f.model || '').toLowerCase().includes(search) ||
        (f.manufacturer || '').toLowerCase().includes(search)
    );

    if (filtered.length === 0) {
        list.innerHTML = '<div class="empty-msg">Nessuna fixture trovata</div>';
        return;
    }

    list.innerHTML = filtered.map(f => `
        <div class="library-item" onclick="addFixtureToWorkspace('${f._file || f.model}')">
            <div style="font-weight:600; font-size:0.8rem;">${f.model}</div>
            <div style="font-size:0.7rem; color:#888;">${f.manufacturer} · ${f.channel_count || '?'}ch</div>
        </div>
    `).join('');
}

function renderActiveFixtures() {
    const list = document.getElementById('active-fixtures-list');
    if (activeFixtures.length === 0) {
        list.innerHTML = '<div class="empty-msg">Nessuna fixture patchata</div>';
        return;
    }

    list.innerHTML = '<h3>Fixtures Patchate</h3>' + activeFixtures.map(f => `
        <div class="fixture-card ${selectedFixture && selectedFixture.id === f.id ? 'active' : ''}" 
             onclick="selectFixtureInstance('${f.id}')"
             draggable="true" 
             ondragstart="onDragFixture(event, '${f.id}')">
            <div style="display:flex; justify-content:space-between;">
                <span style="font-weight:600; font-size:0.85rem;">${f.name}</span>
                <span style="font-size:0.7rem; color:var(--accent-color);">U${f.universe} : ${f.address}</span>
            </div>
            <div style="font-size:0.7rem; color:#888; margin-top:4px;">
                ${f.model} · ${f.channel_details ? f.channel_details.length : '?'} canali
            </div>
        </div>
    `).join('');
}

function updatePatchOccupancy() {
    // Clear all
    document.querySelectorAll('.dmx-cell').forEach(c => {
        c.classList.remove('used');
        c.title = '';
    });

    // Mark used
    activeFixtures.filter(f => parseInt(f.universe) === activeUniverse).forEach(f => {
        const start = parseInt(f.address);
        const count = f.channel_details ? f.channel_details.length : 1;

        for (let i = 0; i < count; i++) {
            const cell = document.getElementById(`dmx-${start + i}`);
            if (cell) {
                cell.classList.add('used');
                cell.title = `${f.name} (${f.model})`;
                if (i === 0) cell.innerText = '●';
                else cell.innerText = '';
            }
        }
    });
}

function selectFixtureInstance(id) {
    selectedFixture = activeFixtures.find(f => f.id === id);
    renderActiveFixtures();

    // Setup Inspector
    const inspector = document.getElementById('fixture-inspector');
    const msg = document.getElementById('no-selection-msg');

    if (selectedFixture) {
        inspector.classList.remove('hidden');
        msg.classList.add('hidden');

        document.getElementById('inspect-name').value = selectedFixture.name;
        document.getElementById('inspect-universe').value = selectedFixture.universe;
        document.getElementById('inspect-address').value = selectedFixture.address;

        const pos = selectedFixture.position || { x: 0, y: 0, z: 0 };
        document.getElementById('inspect-x').value = pos.x;
        document.getElementById('inspect-y').value = pos.y;
        document.getElementById('inspect-z').value = pos.z;
    }
}

async function addFixtureToWorkspace(qxfFile) {
    showLoading(`Aggiunta fixture...`);
    try {
        const res = await fetch('/api/workspace/patch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                qxf: qxfFile,
                universe: activeUniverse,
                // Find first free address
                auto_address: true
            })
        });
        const data = await res.json();
        if (data.status === 'success') {
            await loadActiveFixtures();
        } else {
            alert("Errore patching: " + data.message);
        }
    } catch (e) { console.error(e); }
    hideLoading();
}

async function updateFixtureProperties() {
    if (!selectedFixture) return;

    const payload = {
        id: selectedFixture.id,
        name: document.getElementById('inspect-name').value,
        universe: parseInt(document.getElementById('inspect-universe').value),
        address: parseInt(document.getElementById('inspect-address').value),
        position: {
            x: parseFloat(document.getElementById('inspect-x').value),
            y: parseFloat(document.getElementById('inspect-y').value),
            z: parseFloat(document.getElementById('inspect-z').value)
        }
    };

    showLoading("Aggiornamento fixture...");
    try {
        const res = await fetch('/api/workspace/update-fixture', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        if ((await res.json()).status === 'success') {
            await loadActiveFixtures();
        }
    } catch (e) { console.error(e); }
    hideLoading();
}

async function deleteFixture() {
    if (!selectedFixture || !confirm(`Eliminare ${selectedFixture.name}?`)) return;

    showLoading("Rimozione fixture...");
    try {
        const res = await fetch('/api/workspace/remove-fixture', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: selectedFixture.id })
        });
        if ((await res.json()).status === 'success') {
            selectedFixture = null;
            await loadActiveFixtures();
            document.getElementById('fixture-inspector').classList.add('hidden');
            document.getElementById('no-selection-msg').classList.remove('hidden');
        }
    } catch (e) { console.error(e); }
    hideLoading();
}

function setupEventListeners() {
    // Universe Selection
    document.querySelectorAll('.universe-btn').forEach(btn => {
        btn.onclick = () => {
            document.querySelectorAll('.universe-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            activeUniverse = parseInt(btn.dataset.uni);
            updatePatchOccupancy();
        };
    });

    // Search
    document.getElementById('library-search').oninput = renderLibraryList;

    // Inspector Actions
    document.getElementById('update-fixture-btn').onclick = updateFixtureProperties;
    document.getElementById('delete-fixture-btn').onclick = deleteFixture;

    // AI Stage Builder
    document.getElementById('stage-photo-upload').onchange = (e) => {
        const file = e.target.files[0];
        if (file) {
            const reader = new FileReader();
            reader.onload = (ev) => {
                document.getElementById('stage-preview-img').src = ev.target.result;
                document.getElementById('stage-preview-img').style.display = 'block';
                document.getElementById('stage-preview-placeholder').style.display = 'none';
            };
            reader.readAsDataURL(file);
        }
    };
    document.getElementById('run-ai-builder-btn').onclick = runAIStageBuilder;
}

async function runAIStageBuilder() {
    const imgSrc = document.getElementById('stage-preview-img').src;
    if (!imgSrc || imgSrc.endsWith('fixtures.html')) {
        alert("Carica prima una foto del palco!");
        return;
    }

    if (activeFixtures.length === 0) {
        alert("Nessuna fixture patchata! Patcha prima le fixture per posizionarle.");
        return;
    }

    showLoading("Analisi AI 3D in corso (Gemini)...");

    const payload = {
        image: imgSrc,
        fixtures: activeFixtures.map(f => ({
            id: f.id,
            name: f.name,
            model: f.model
        }))
    };

    try {
        const res = await fetch('/api/venue/analyze/gemini', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await res.json();

        if (data.status === 'success') {
            const positions = data.positions; // Array of {id, position: {x,y,z}}

            // Applica massivamente le nuove posizioni a tutte le fixtures
            for (const item of positions) {
                const fix = activeFixtures.find(f => f.id === item.id);
                if (fix) {
                    await fetch('/api/workspace/update-fixture', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            id: fix.id,
                            position: item.position
                        })
                    });
                }
            }

            alert(data.mock ? "Modalità MOCK (API Key mancante). Posizioni simulate." : "Analisi 3D completata e posizioni applicate!");
            await loadActiveFixtures();

            // Seleziona la prima fixture per aggiornare l'inspector
            if (activeFixtures.length > 0) {
                selectFixtureInstance(activeFixtures[0].id);
            }
        } else {
            alert("Errore AI: " + data.message);
        }
    } catch (e) {
        console.error(e);
        alert("Errore di connessione al motore AI.");
    }
    hideLoading();
}

// Start when DOM loaded
document.addEventListener('DOMContentLoaded', initFixtureManager);
