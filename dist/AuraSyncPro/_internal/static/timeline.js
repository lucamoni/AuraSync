/**
 * AuraSync Professional Show Manager (Multitrack Timeline)
 */

class AuraTimeline {
    constructor() {
        this.isPlaying = false;
        this.isRecording = false;
        this.startTime = 0;
        this.currentTime = 0;
        this.events = []; // {time, duration, type, id, name, trackId}
        this.timer = null;
        this.pixelsPerSecond = 50;
        this.lastProcessedTime = 0;

        this.setupEventListeners();
        this.initWaveform();
    }

    setupEventListeners() {
        const btnPlay = document.getElementById('btn-play');
        const btnRecord = document.getElementById('btn-record');
        const btnStop = document.getElementById('btn-stop');
        const zoomSlider = document.getElementById('timeline-zoom-slider');

        if (btnPlay) btnPlay.onclick = () => this.togglePlay();
        if (btnRecord) btnRecord.onclick = () => this.toggleRecord();
        if (btnStop) btnStop.onclick = () => this.stop();

        if (zoomSlider) {
            zoomSlider.oninput = () => {
                this.pixelsPerSecond = parseInt(zoomSlider.value);
                this.refreshUI();
            };
        }

        // Handle dropping functions from Sidebar
        const timelineArea = document.querySelector('.timeline-tracks-container');
        if (timelineArea) {
            timelineArea.ondragover = (e) => e.preventDefault();
            timelineArea.ondrop = (e) => this.handleDrop(e);
        }
    }

    togglePlay() {
        if (this.isPlaying) this.pause();
        else this.play();
    }

    play() {
        this.isPlaying = true;
        this.startTime = Date.now() - this.currentTime;
        const btn = document.getElementById('btn-play');
        if (btn) btn.innerText = '⏸';
        this.startTick();
    }

    pause() {
        this.isPlaying = false;
        const btn = document.getElementById('btn-play');
        if (btn) btn.innerText = '▶';
        cancelAnimationFrame(this.timer);
    }

    stop() {
        this.pause();
        this.currentTime = 0;
        this.lastProcessedTime = 0;
        this.refreshUI();
    }

    startTick() {
        const tick = () => {
            if (!this.isPlaying) return;
            this.currentTime = Date.now() - this.startTime;

            // Trigger events
            const triggeredEvents = this.events.filter(e =>
                e.time > this.lastProcessedTime && e.time <= this.currentTime
            );

            triggeredEvents.forEach(e => this.triggerEvent(e));

            this.lastProcessedTime = this.currentTime;
            this.updatePlayhead();
            this.updateTimeDisplay();
            this.timer = requestAnimationFrame(tick);
        };
        this.timer = requestAnimationFrame(tick);
    }

    triggerEvent(event) {
        console.log("[Timeline] Triggering:", event.name);
        fetch(`/api/functions/run/${event.type}/${event.id}`, { method: 'POST' });

        // Auto-stop after duration if it's a chaser or efx
        if (event.type !== 'scene' && event.duration) {
            setTimeout(() => {
                fetch(`/api/functions/stop/${event.id}`, { method: 'POST' });
            }, event.duration);
        }
    }

    handleDrop(e) {
        e.preventDefault();
        // This assumes we implement dragstart in console.js
        const data = e.dataTransfer.getData("application/aurasync-function");
        if (!data) return;

        const func = JSON.parse(data);
        const rect = e.currentTarget.getBoundingClientRect();
        const x = e.clientX - rect.left + e.currentTarget.scrollLeft - 150; // Offset for track-info

        const time = (x / this.pixelsPerSecond) * 1000;
        this.addEvent(func.type, func.id, func.name, Math.max(0, time));
    }

    addEvent(type, id, name, time) {
        const event = {
            time: time,
            duration: 2000, // 2s default
            type: type,
            id: id,
            name: name,
            trackId: 'track-manual' // Default track
        };
        this.events.push(event);
        this.renderEvent(event);
    }

    updatePlayhead() {
        const playheads = document.querySelectorAll('.playhead');
        const offset = (this.currentTime / 1000) * this.pixelsPerSecond;
        playheads.forEach(ph => ph.style.transform = `translateX(${offset}px)`);
    }

    updateTimeDisplay() {
        const el = document.getElementById('time-display');
        if (!el) return;
        const sec = (this.currentTime / 1000);
        const mins = Math.floor(sec / 60);
        const remain = (sec % 60).toFixed(2);
        el.innerText = `${mins.toString().padStart(2, '0')}:${remain.padStart(5, '0')}`;
    }

    refreshUI() {
        // Redraw all events
        document.querySelectorAll('.event-block').forEach(b => b.remove());
        this.events.forEach(e => this.renderEvent(e));
        this.updatePlayhead();
    }

    renderEvent(event) {
        const container = document.querySelector(`#${event.trackId} .track-content`);
        if (!container) return;

        const block = document.createElement('div');
        block.className = `event-block ${event.type}`;
        block.innerText = event.name;
        block.style.left = (event.time / 1000) * this.pixelsPerSecond + 'px';
        block.style.width = (event.duration / 1000) * this.pixelsPerSecond + 'px';

        // Drag & Resize logic (simplified for expansion)
        block.onmousedown = (e) => this.handleBlockInteraction(e, block, event);

        container.appendChild(block);
    }

    handleBlockInteraction(e, block, event) {
        const isResize = e.offsetX > (block.offsetWidth - 10);
        const startX = e.clientX;
        const startLeft = parseInt(block.style.left);
        const startWidth = parseInt(block.style.width);

        const onMove = (me) => {
            const dx = me.clientX - startX;
            if (isResize) {
                const newW = Math.max(10, startWidth + dx);
                block.style.width = newW + 'px';
                event.duration = (newW / this.pixelsPerSecond) * 1000;
            } else {
                const newL = Math.max(0, startLeft + dx);
                block.style.left = newL + 'px';
                event.time = (newL / this.pixelsPerSecond) * 1000;
            }
        };

        const onUp = () => {
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
        };

        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
        e.stopPropagation();
    }

    initWaveform() {
        const canvas = document.getElementById('waveform-canvas');
        if (!canvas) return;
        const ctx = canvas.getContext('2d');

        // Mock waveform for now
        ctx.fillStyle = '#00d2ff';
        for (let i = 0; i < canvas.width; i += 4) {
            const h = Math.random() * 40;
            ctx.fillRect(i, 40 - h / 2, 2, h);
        }
    }
}

// Initialize when ready
document.addEventListener('DOMContentLoaded', () => {
    window.auraTimeline = new AuraTimeline();
});
