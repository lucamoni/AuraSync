const LIGHTING_PALETTES = {
    "Cyberpunk": { primary: "#ff00ff", secondary: "#00ffff", accent: "#ffff00", bg: "#220044" },
    "Ocean": { primary: "#0044ff", secondary: "#00ccff", accent: "#ffffff", bg: "#001133" },
    "Sunset": { primary: "#ff4400", secondary: "#ffaa00", accent: "#ff0066", bg: "#331100" },
    "Royal": { primary: "#8800ff", secondary: "#ff00ff", accent: "#ffffff", bg: "#110022" },
    "Monochrome": { primary: "#ffffff", secondary: "#00d2ff", accent: "#444444", bg: "#000000" },
    "Neon": { primary: "#00ff88", secondary: "#00d2ff", accent: "#ffffff", bg: "#001100" },
    "Inferno": { primary: "#ff2200", secondary: "#ffaa00", accent: "#ffffff", bg: "#110500" },
    "Arctic": { primary: "#00ccff", secondary: "#ffffff", accent: "#0022ff", bg: "#000511" },
    "Techno": { primary: "#00ff00", secondary: "#333333", accent: "#ffffff", bg: "#000000" },
    "DeepForest": { primary: "#00ff44", secondary: "#77ff00", accent: "#ffaa00", bg: "#001100" },
    "CandyShop": { primary: "#ff0000", secondary: "#00ff00", accent: "#0000ff", bg: "#111111" }
};

/** 
 * 50 LOGICAL SOLUTIONS MAPPING
 * Fixture Groups:
 * Heads: 0, 2, 4, 6 | PARs: 1, 3, 5 | Mini: 7, 12 | P36: 8-11 | Sparks: 13, 14
 */
const PROGRAM_LIBRARY = {
    // 1-10: MOVEMENTS (Heads 0,2,4,6)
    "VShape": { type: "move", pattern: "VShape", target: [0, 2, 4, 6], vibe: "INTRO" },
    "DNAHelix": { type: "move", pattern: "DNAHelix", target: [0, 2, 4, 6], vibe: "DROP" },
    "Tornado": { type: "move", pattern: "Tornado", target: [0, 2, 4, 6], vibe: "DROP" },
    "SkySearcher": { type: "move", pattern: "Eight", target: [0, 2, 4, 6], vibe: "CLIMAX" },
    "ParallelSweep": { type: "move", pattern: "Line", target: [0, 2, 4, 6], vibe: "BUILDUP" },

    // 11-20: COLORS (PARs 1,3,5 & P36 8-11)
    "ColdWarm": { type: "color", palette: "Arctic", target: [1, 3, 5, 8, 9, 10, 11] },
    "SunsetGradient": { type: "color", palette: "Sunset", target: [1, 3, 5] },
    "PoliceChase": { type: "fx", pattern: "Police", target: [0, 2, 4, 6, 1, 3, 5] },
    "GoldenHour": { type: "color", palette: "Sunset", accent: "#ffffff", target: [1, 3, 5, 8, 9, 10, 11] },

    // 21-30: DYNAMICS & STROBE
    "BPMSyncStrobo": { type: "fx", pattern: "Strobe", target: "all", vibe: "DROP" },
    "Glitch": { type: "fx", pattern: "Glitch", target: "all", vibe: "CLIMAX" },
    "PulseDimmer": { type: "fx", pattern: "Breathe", target: "all" },

    // 31-40: STRUCTURE & SPARKS
    "FountainBlast": { type: "spark", pattern: "Blast", target: [13, 14], trigger: "beat" },
    "TowerUplight": { type: "move", pattern: "FixedUp", target: [7, 12] },
    "GrandFinale": { type: "fx", pattern: "Full", target: "all", vibe: "CLIMAX" }
};

const ZONES = { WASH: "wash", BEAM: "beam", FX: "fx" };

class LightingDesigner {
    constructor() {
        this.currentPaletteName = "Cyberpunk";
        this.palette = LIGHTING_PALETTES[this.currentPaletteName];
        this.energyLevel = 0;
        this.smoothedEnergy = 0;
        this.unity = 0.8;
        this.symmetryMode = "Mirror";
        this.washIntensity = 0.5;
        this.beamIntensity = 0;
        this.fxIntensity = 0;
        this.currentSection = "VERSE";
        this.vibe = "INTRO";
        this.prevVibe = "INTRO";
        this.vibeCooldown = 0; // Prevent rapid vibe flickers

        this.sm = 0.15; // Smoothing Factor (0.05 - 0.3)
        this.dmxBuffer = {}; // { fixId: { ch: currentVal } }

        this.history = [];
        this.maxHistory = 200;
        this.currentProgram = "VShape";
        this.activeSparkTrigger = false;
    }

    /** Smoothing Utility */
    smoothValue(current, target, factor = this.sm) {
        if (current === undefined) return target;
        return current + (target - current) * factor;
    }

    updateBuffer(id, channel, target) {
        if (!this.dmxBuffer[id]) this.dmxBuffer[id] = {};
        const current = this.dmxBuffer[id][channel] ?? target;
        const result = this.smoothValue(current, target);
        this.dmxBuffer[id][channel] = result;
        return result;
    }

    setSection(section) {
        if (!section) return;
        const s = section.toUpperCase();
        if (this.currentSection !== s) {
            this.currentSection = s;
            this._applyVibeRules(s);
            this._pickRandomProgramByVibe(this.vibe);
        }
    }

    _applyVibeRules(s) {
        if (s.includes("DROP") || s.includes("CHORUS")) {
            this.vibe = "DROP";
            this.unity = 1.0;
            this.movementPattern = "Tornado";
        } else if (s.includes("BUILDUP") || s.includes("PRECHORUS")) {
            this.vibe = "BUILDUP";
            this.unity = 0.8;
            this.movementPattern = "Cross";
        } else if (s.includes("CLIMAX")) {
            this.vibe = "CLIMAX";
            this.unity = 0.0;
            this.movementPattern = "Ballyhoo";
        } else if (s.includes("IDLE")) {
            this.vibe = "IDLE";
            this.unity = 1.0;
            this.movementPattern = "FixedDown";
        } else {
            this.vibe = "INTRO";
            this.unity = 0.5;
            this.movementPattern = "VShape";
        }
    }

    _pickRandomProgramByVibe(vibe) {
        const eligible = Object.keys(PROGRAM_LIBRARY).filter(k =>
            !PROGRAM_LIBRARY[k].vibe || PROGRAM_LIBRARY[k].vibe === vibe
        );
        if (eligible.length > 0) {
            this.currentProgram = eligible[Math.floor(Math.random() * eligible.length)];
            console.log(`[AI Designer] Loaded Program: ${this.currentProgram}`);
        }
    }

    updateVibeByEnergy(energy) {
        if (energy === undefined) return;
        this.energyLevel = energy;
        this.smoothedEnergy = this.smoothValue(this.smoothedEnergy, energy, 0.05); // Slow smoothing for energy

        // Decrement vibe cooldown
        if (this.vibeCooldown > 0) this.vibeCooldown--;

        const oldVibe = this.vibe;
        const e = this.smoothedEnergy;
        const c = this.currentSection;

        // Vibe Logic with Instance Wakeup
        if (energy < 0.05 && e < 0.05) {
            this.vibe = "IDLE";
        } else {
            // Wake Up Bypass: If in IDLE and music starts, ignore cooldown for instant reaction
            if (this.vibe === "IDLE" && energy > 0.08) {
                this.vibe = "INTRO";
                this.vibeCooldown = 0;
            }

            if (this.vibeCooldown === 0) {
                if (e > 0.90) this.vibe = "DROP";
                else if (e > 0.70) this.vibe = "BUILDUP";
                else if (e < 0.35) this.vibe = "INTRO";
            }
        }

        if (this.vibe !== oldVibe) {
            const energyLog = isNaN(e) ? "0.00" : e.toFixed(2);
            console.log(`[AI Designer] Vibe Switch: ${oldVibe} -> ${this.vibe} (E: ${energyLog})`);
            this.vibeCooldown = 60; // Wait ~2 seconds before next switch (at 30Hz)
            this._applyVibeRules(this.vibe);
            this._pickRandomProgramByVibe(this.vibe);
        }
    }

    getIncastro(index, type = "AB") {
        if (type === "AB") return index % 2 === 0;
        if (type === "ABC") return index % 3 === 0;
        return true;
    }

    getSpatialGroup(index, total) {
        const center = (total - 1) / 2;
        const isLeft = index < center;
        const distFromCenter = Math.abs(index - center) / (total / 2);
        return { side: isLeft ? "Left" : "Right", position: distFromCenter < 0.5 ? "Inner" : "Outer", dist: distFromCenter };
    }

    // Using fixture ID for ID-locked patterns
    getMovementPhasing(id, totalCount, indexInList) {
        const t = Date.now() / 1000;
        const p = this.movementPattern;

        const phase = (indexInList / totalCount) * Math.PI * 2;

        // Logical IDs for Teste Mobili: 0, 2, 4, 6
        if (p === "VShape") {
            // IDs 0,2 are Left-ish, 4,6 are Right-ish in a standard row
            const side = (id === 0 || id === 2) ? -1 : 1;
            return { pan: side * 0.4, tilt: 0.6 };
        }
        if (p === "DNAHelix") {
            const shift = (id === 0 || id === 4) ? 0 : Math.PI / 2;
            return { pan: Math.sin(t + shift), tilt: Math.cos(t + shift) * 0.4 };
        }
        if (p === "Tornado") {
            const radius = 0.5 + 0.5 * Math.sin(t * 0.5);
            return { pan: Math.sin(t * 3 + phase) * radius, tilt: Math.cos(t * 3 + phase) * radius };
        }
        if (p === "Ballyhoo") {
            return { pan: Math.sin(t * 4 + id) + Math.cos(t * 3), tilt: Math.cos(t * 5 + id) };
        }
        if (p === "FixedDown") return { pan: 0, tilt: -0.2 }; // Standard pointing 'forward/down'
        if (p === "FixedUp") return { pan: 0, tilt: 1.0 };

        return { pan: Math.sin(t * 0.5 + phase) * 0.5, tilt: 0.8 };
    }

    getFixtureColor(id, zone, isBeat) {
        const pal = this.palette;
        const prog = PROGRAM_LIBRARY[this.currentProgram];

        // Idle State: Deep Blue Atmospheric
        if (this.vibe === "IDLE") {
            return this.hexToRgb("#000044"); // Deep Ocean Blue (Standard Static Color)
        }

        // Specific Program Rules (e.g., Police Chase)
        if (prog && prog.pattern === "Police") {
            const side = (id % 2 === 0);
            return this.hexToRgb(side ? "#ff0000" : "#0000ff");
        }

        // Default Palette Logic
        if (zone === "wash") {
            const useAlt = id % 3 === 0;
            return this.hexToRgb(useAlt ? pal.secondary : pal.primary);
        }
        if (isBeat && (this.vibe === "DROP" || this.vibe === "CLIMAX")) {
            return this.hexToRgb(pal.accent);
        }
        return this.hexToRgb(pal.primary);
    }

    pushHistory(energy, isBeat) {
        this.history.push({ time: Date.now(), energy: energy || 0, isBeat: !!isBeat, prog: this.currentProgram });
        if (this.history.length > 200) this.history.shift();
    }

    getStats() {
        return {
            program: this.currentProgram, palette: this.currentPaletteName, energy: this.energyLevel,
            section: this.currentSection, vibe: this.vibe, unity: this.unity
        };
    }

    getFixtureZone(fix) {
        if (!fix) return ZONES.BEAM;
        const n = ((fix.name || "") + " " + (fix.model || "")).toLowerCase();
        if (n.includes('fontana') || n.includes('spark') || n.includes('strobo') || n.includes('strobe')) return ZONES.FX;
        if (n.includes('par') || n.includes('wash') || n.includes('led') || n.includes('bar') || n.includes('strip')) return ZONES.WASH;
        return ZONES.BEAM;
    }

    getPaletteNames() {
        return Object.keys(LIGHTING_PALETTES);
    }

    setPalette(name) {
        if (LIGHTING_PALETTES[name]) {
            this.currentPaletteName = name;
            this.palette = LIGHTING_PALETTES[name];
        }
    }

    hexToRgb(hex) {
        const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
        return result ? { r: parseInt(result[1], 16), g: parseInt(result[2], 16), b: parseInt(result[3], 16) } : { r: 255, g: 255, b: 255 };
    }

    rgbToHsl(r, g, b) {
        r /= 255, g /= 255, b /= 255;
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        let h, s, l = (max + min) / 2;
        if (max == min) h = s = 0;
        else {
            const d = max - min;
            s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
            switch (max) {
                case r: h = (g - b) / d + (g < b ? 6 : 0); break;
                case g: h = (b - r) / d + 2; break;
                case b: h = (r - g) / d + 4; break;
            }
            h /= 6;
        }
        return { h, s, l };
    }

    hslToRgb(h, s, l) {
        let r, g, b;
        const hue2rgb = (p, q, t) => { if (t < 0) t += 1; if (t > 1) t -= 1; if (t < 1 / 6) return p + (q - p) * 6 * t; if (t < 1 / 2) return q; if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6; return p; };
        const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
        const p = 2 * l - q;
        r = hue2rgb(p, q, h + 1 / 3); g = hue2rgb(p, q, h); b = hue2rgb(p, q, h - 1 / 3);
        return { r: Math.round(r * 255), g: Math.round(g * 255), b: Math.round(b * 255) };
    }
}

window.AuraDesigner = new LightingDesigner();
