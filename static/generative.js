let fixtures = [];
let selectedFixtureId = null;
let bezierPoints = [
    { x: 100, y: 300 }, // P0
    { x: 200, y: 100 }, // CP1
    { x: 400, y: 100 }, // CP2
    { x: 500, y: 300 }  // P1
];
let draggedPointIdx = -1;

const canvas = document.getElementById('bezier-editor');
const ctx = canvas.getContext('2d');

async function init() {
    await loadFixtures();
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);

    canvas.addEventListener('mousedown', onMouseDown);
    canvas.addEventListener('mousemove', onMouseMove);
    canvas.addEventListener('mouseup', onMouseUp);

    requestAnimationFrame(renderLoop);
}

async function loadFixtures() {
    try {
        const r = await fetch('/api/workspace/fixtures');
        const data = await r.json();
        fixtures = data || [];

        const select = document.getElementById('gen-fixture-select');
        select.innerHTML = '<option value="">Seleziona Fixture...</option>';
        fixtures.forEach(f => {
            const opt = document.createElement('option');
            opt.value = f.id;
            opt.innerText = `${f.name} (Uni ${f.universe}, Addr ${f.address})`;
            select.appendChild(opt);
        });

        select.onchange = (e) => {
            selectedFixtureId = e.target.value;
        };
    } catch (e) {
        console.error("Failed to load fixtures", e);
    }
}

function resizeCanvas() {
    const container = canvas.parentElement;
    canvas.width = container.clientWidth;
    canvas.height = container.clientHeight;
}

function onMouseDown(e) {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    draggedPointIdx = bezierPoints.findIndex(p => {
        const dx = p.x - mx;
        const dy = p.y - my;
        return Math.sqrt(dx * dx + dy * dy) < 15;
    });
}

function onMouseMove(e) {
    if (draggedPointIdx === -1) return;
    const rect = canvas.getBoundingClientRect();
    bezierPoints[draggedPointIdx].x = e.clientX - rect.left;
    bezierPoints[draggedPointIdx].y = e.clientY - rect.top;
}

function onMouseUp() {
    draggedPointIdx = -1;
}

function renderLoop() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Draw grid
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1;
    for (let x = 0; x < canvas.width; x += 50) {
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height); ctx.stroke();
    }
    for (let y = 0; y < canvas.height; y += 50) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvas.width, y); ctx.stroke();
    }

    // Draw lines between points
    ctx.setLineDash([5, 5]);
    ctx.strokeStyle = 'rgba(0, 210, 255, 0.3)';
    ctx.beginPath();
    ctx.moveTo(bezierPoints[0].x, bezierPoints[0].y);
    ctx.lineTo(bezierPoints[1].x, bezierPoints[1].y);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(bezierPoints[2].x, bezierPoints[2].y);
    ctx.lineTo(bezierPoints[3].x, bezierPoints[3].y);
    ctx.stroke();
    ctx.setLineDash([]);

    // Draw Bezier Curve
    ctx.strokeStyle = '#00d2ff';
    ctx.lineWidth = 4;
    ctx.shadowBlur = 15;
    ctx.shadowColor = 'rgba(0, 210, 255, 0.5)';
    ctx.beginPath();
    ctx.moveTo(bezierPoints[0].x, bezierPoints[0].y);
    ctx.bezierCurveTo(
        bezierPoints[1].x, bezierPoints[1].y,
        bezierPoints[2].x, bezierPoints[2].y,
        bezierPoints[3].x, bezierPoints[3].y
    );
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Draw points
    bezierPoints.forEach((p, i) => {
        ctx.fillStyle = i === 0 || i === 3 ? '#00d2ff' : '#ff00ff';
        ctx.beginPath();
        ctx.arc(p.x, p.y, 8, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'white';
        ctx.lineWidth = 2;
        ctx.stroke();
    });

    requestAnimationFrame(renderLoop);
}

async function applyBezierPath() {
    if (!selectedFixtureId) {
        alert("Seleziona una fixture prima!");
        return;
    }

    const fix = fixtures.find(f => f.id == selectedFixtureId);
    if (!fix) return;

    // Extract pan/tilt channels
    const pan_ch = fix.channel_details.findIndex(c => c.name.toLowerCase().includes('pan')) + 1;
    const tilt_ch = fix.channel_details.findIndex(c => c.name.toLowerCase().includes('tilt')) + 1;

    if (pan_ch === 0 || tilt_ch === 0) {
        alert("Questa fixture non sembra avere canali Pan/Tilt!");
        return;
    }

    // Map canvas coords to stage coords (roughly -10 to 10)
    const points = bezierPoints.map(p => {
        const sx = (p.x / canvas.width - 0.5) * 20;
        const sy = (p.y / canvas.height - 0.5) * 20;
        return [sx, sy, 5]; // Constant height
    });

    const payload = {
        id: `bezier_${selectedFixtureId}`,
        universe: parseInt(fix.universe),
        pan_channel: parseInt(fix.address) + pan_ch - 1,
        tilt_channel: parseInt(fix.address) + tilt_ch - 1,
        points: points,
        duration: 4.0,
        fix_pos: [0, 0, 10], // Default top hang
        loop: true
    };

    const r = await fetch('/api/generative/add_bezier_path', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    const result = await r.json();
    if (result.status === 'success') {
        notify("Percorso applicato!");
    }
}

function notify(msg) {
    console.log("NOTIFY:", msg);
}

init();
