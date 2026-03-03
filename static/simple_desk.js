/**
 * AuraSync Pro - Simple Desk V1.0
 * Provides manual control for all 512 DMX channels.
 */

window.SimpleDesk = {
    init() {
        console.log("[Simple Desk] Initializing...");
        this.currentUniverse = 0;
        this.currentPage = 1;
        this.channelsPerPage = 32;
        this.createPagination();
        this.renderFaders();
    },

    createPagination() {
        const controls = document.querySelector('.desk-controls');
        if (!controls || document.querySelector('.desk-pagination')) return;

        const pagination = document.createElement('div');
        pagination.className = 'desk-pagination';
        pagination.style.display = 'flex';
        pagination.style.gap = '10px';
        pagination.style.alignItems = 'center';
        pagination.innerHTML = `
            <button onclick="window.SimpleDesk.prevPage()" class="secondary-btn">&laquo; Prev</button>
            <span id="desk-page-label" style="font-family: 'JetBrains Mono', monospace; min-width: 80px; text-align: center;">Page 1</span>
            <button onclick="window.SimpleDesk.nextPage()" class="secondary-btn">Next &raquo;</button>
        `;
        controls.insertBefore(pagination, controls.children[1]); // Insert before reset
    },

    switchUniverse() {
        const select = document.getElementById('desk-universe-select');
        if (select) {
            this.currentUniverse = parseInt(select.value) - 1;
            this.currentPage = 1;
            this.renderFaders();
        }
    },

    prevPage() {
        if (this.currentPage > 1) {
            this.currentPage--;
            this.renderFaders();
        }
    },

    nextPage() {
        const maxPage = Math.ceil(512 / this.channelsPerPage);
        if (this.currentPage < maxPage) {
            this.currentPage++;
            this.renderFaders();
        }
    },

    renderFaders() {
        const grid = document.getElementById('desk-fader-grid');
        const pageLabel = document.getElementById('desk-page-label');
        if (!grid) return;

        grid.innerHTML = '';
        if (pageLabel) {
            pageLabel.innerText = `Page ${this.currentPage}`;
        }

        const startCh = (this.currentPage - 1) * this.channelsPerPage + 1;
        const endCh = Math.min(startCh + this.channelsPerPage - 1, 512);

        for (let i = startCh; i <= endCh; i++) {
            const faderWrap = document.createElement('div');
            faderWrap.className = 'desk-fader-item';
            faderWrap.innerHTML = `
                <div class="fader-track" style="height: 150px; display: flex; align-items: center; padding: 10px 0;">
                    <input type="range" min="0" max="255" value="0" 
                           orient="vertical" class="fader-input" id="fader-${i}"
                           style="writing-mode: vertical-lr; direction: rtl; appearance: slider-vertical; width: 8px; height: 100%; border-radius: 4px; accent-color: var(--accent-color);">
                </div>
                <div class="ch-num">${i}</div>
                <div class="ch-val" id="fader-val-${i}">0</div>
            `;

            const input = faderWrap.querySelector('input');
            const valLabel = faderWrap.querySelector('.ch-val');

            input.oninput = () => {
                const val = parseInt(input.value);
                valLabel.innerText = val;
                this.sendDMX(i, val);
            };

            grid.appendChild(faderWrap);
        }
    },

    async sendDMX(channel, value) {
        try {
            await fetch('/api/dmx/set', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    universe: this.currentUniverse || 0,
                    channel: channel,
                    value: value,
                    is_manual: true
                })
            });
        } catch (e) {
            console.error("[Simple Desk] DMX Send Error:", e);
        }
    },

    async resetAll() {
        if (!confirm("Reset all manual faders to 0?")) return;
        for (let i = 1; i <= 512; i++) {
            const input = document.getElementById(`fader-${i}`);
            const valLabel = document.getElementById(`fader-val-${i}`);
            if (input) {
                input.value = 0;
                valLabel.innerText = 0;
            }
        }

        // Release the entire universe from Manual Control
        await fetch('/api/dmx/release', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                universe: this.currentUniverse || 0,
                channel: "all"
            })
        });
    }
};

document.addEventListener('DOMContentLoaded', () => window.SimpleDesk.init());
