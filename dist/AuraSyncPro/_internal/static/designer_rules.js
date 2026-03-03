const LIGHTING_PALETTES = {
    "Cyberpunk": { primary: "#ff00ff", secondary: "#00ffff", accent: "#ffff00", bg: "#220044" },
    "Ocean": { primary: "#0044ff", secondary: "#00ccff", accent: "#ffffff", bg: "#001133" },
    "Sunset": { primary: "#ff4400", secondary: "#ffaa00", accent: "#ff0066", bg: "#331100" },
    "Royal": { primary: "#8800ff", secondary: "#ff00ff", accent: "#ffffff", bg: "#110022" },
    "Monochrome": { primary: "#ffffff", secondary: "#00d2ff", accent: "#444444", bg: "#000000" },
    "Neon": { primary: "#00ff88", secondary: "#00d2ff", accent: "#ffffff", bg: "#001100" },

    // Phase 20: Pro Choreography Palettes
    "ProIntro": { primary: "#0044ff", secondary: "#ffffff", accent: "#001133", bg: "#000511" }, // Cold Blue/White
    "ProBuildup": { primary: "#ffbf00", secondary: "#ffffff", accent: "#ff4400", bg: "#110a00" }, // Amber -> Cold White
    "ProDrop": { primary: "#ff0000", secondary: "#0022ff", accent: "#ffffff", bg: "#110000" }  // Saturated Red, Electric Blue, White
};

const ZONES = {
    WASH: "wash",
    BEAM: "beam",
    FX: "fx"
};

class LightingDesigner {
    constructor() {
        this.currentPaletteName = "Cyberpunk";
        this.palette = LIGHTING_PALETTES[this.currentPaletteName];
        this.energyLevel = 0;

        // Choreography Settings
        this.unity = 0.8;             // 0.0 (chaos) to 1.0 (total rig unity)
        this.symmetryMode = "Mirror"; // Mirror, Linear

        // Intensity Envelopes
        this.washIntensity = 0.5;
        this.beamIntensity = 0;
        this.fxIntensity = 0;

        // Pattern State
        this.currentSection = "VERSE";
        this.movementPattern = "Wave";
        this.washPattern = "Alternate";
        this.vibe = "INTRO"; // Default PRO vibe

        this.history = [];
        this.maxHistory = 200;
    }

    setSection(section) {
        if (!section) return;
        const s = section.toUpperCase();
        if (this.currentSection !== s) {
            this.currentSection = s;

            // Phase 20: PRO VIBE States (Intro, Buildup, Drop, Climax)
            if (s.includes("DROP")) {
                this.vibe = "DROP";
                this.unity = 1.0;
                this.movementPattern = "Fan"; // Fan out on drops
                this.washPattern = "Snap";    // Instant color changes
                this.currentPaletteName = "ProDrop";
            } else if (s.includes("BUILDUP") || s.includes("PRECHORUS") || s.includes("BUILD")) {
                this.vibe = "BUILDUP";
                this.unity = 0.8;
                this.movementPattern = "Cross"; // Fast crossing beams
                this.washPattern = "Chase";     // Lateral sweep
                this.currentPaletteName = "ProBuildup";
            } else if (s.includes("CLIMAX") || s.includes("OUTRO")) {
                this.vibe = "CLIMAX";
                this.unity = 0.0; // Chaos
                this.movementPattern = "Ballyhoo"; // Frenetic randomized
                this.washPattern = "Strobe";
                this.currentPaletteName = "ProDrop";
            } else {
                // INTRO / VERSE / BREAKDOWN
                this.vibe = "INTRO";
                this.unity = 0.9; // Cohesive, calm
                this.movementPattern = "Circular"; // Slow circular breathing
                this.washPattern = "Breathe";      // Fading
                this.currentPaletteName = "ProIntro";
            }

            // Apply palette immediately
            if (LIGHTING_PALETTES[this.currentPaletteName]) {
                this.palette = LIGHTING_PALETTES[this.currentPaletteName];
            }
        }
    }

    /**
     * Incastro Logic: Returns true/false for geometric patterns
     * Used to create 1-3-5 vs 2-4-6 patterns (Incastri)
     */
    getIncastro(index, type = "AB") {
        if (type === "AB") return index % 2 === 0;
        if (type === "ABC") return index % 3 === 0;
        return true;
    }

    /**
     * Grouping logic: identifies if a fixture is Inner, Outer, Left, or Right
     */
    getSpatialGroup(index, total) {
        const center = (total - 1) / 2;
        const isLeft = index < center;
        const distFromCenter = Math.abs(index - center) / (total / 2);

        return {
            side: isLeft ? "Left" : "Right",
            position: distFromCenter < 0.5 ? "Inner" : "Outer",
            dist: distFromCenter
        };
    }

    getMovementPhasing(index, total) {
        const p = this.movementPattern;
        const spatial = this.getSpatialGroup(index, total);

        if (this.symmetryMode === "Mirror") {
            // Mirror movement (Left specchia Right)
            const multiplier = spatial.side === "Left" ? -1 : 1;
            const offset = spatial.dist * 1.2;

            if (p === "Fan") return { pan: multiplier, tilt: 1, offset: offset };
            if (p === "Parallel") return { pan: multiplier, tilt: 1, offset: 0 };
            return { pan: multiplier, tilt: 1, offset: offset };
        }

        // Linear mode (existing logic)
        if (p === "Wave") return { pan: 1, tilt: 1, offset: index * 0.4 };
        if (p === "Fan") {
            const center = (total - 1) / 2;
            const dist = index - center;
            return { pan: dist * 0.4, tilt: 1, offset: Math.abs(dist) * 0.2 };
        }
        return { pan: 1, tilt: 1, offset: index * 0.5 };
    }

    pushHistory(energy, isBeat) {
        this.history.push({
            time: Date.now(),
            energy: energy || 0,
            isBeat: !!isBeat,
            palette: this.currentPaletteName
        });
        if (this.history.length > this.maxHistory) this.history.shift();
    }

    getStats() {
        return {
            palette: this.currentPaletteName,
            colors: this.palette,
            energy: this.energyLevel,
            section: this.currentSection,
            vibe: this.vibe,
            unity: this.unity,
            symmetry: this.symmetryMode,
            patterns: { movement: this.movementPattern, wash: this.washPattern },
            intensities: { wash: this.washIntensity, beam: this.beamIntensity, fx: this.fxIntensity }
        };
    }

    setPalette(name) {
        if (LIGHTING_PALETTES[name]) {
            this.currentPaletteName = name;
            this.palette = LIGHTING_PALETTES[name];
        }
    }

    getPaletteNames() { return Object.keys(LIGHTING_PALETTES); }

    getFixtureZone(fix) {
        const n = (fix.name + " " + (fix.model || "")).toLowerCase();
        if (n.includes('fontana') || n.includes('spark') || n.includes('strobo') || n.includes('strobe')) return ZONES.FX;
        if (n.includes('par') || n.includes('wash') || n.includes('led') || n.includes('bar') || n.includes('strip')) return ZONES.WASH;
        return ZONES.BEAM;
    }

    /**
     * Color Math Utilities
     */
    rgbToHsl(r, g, b) {
        r /= 255, g /= 255, b /= 255;
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        let h, s, l = (max + min) / 2;

        if (max == min) {
            h = s = 0; // achromatic
        } else {
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
        if (s == 0) {
            r = g = b = l;
        } else {
            const hue2rgb = (p, q, t) => {
                if (t < 0) t += 1;
                if (t > 1) t -= 1;
                if (t < 1 / 6) return p + (q - p) * 6 * t;
                if (t < 1 / 2) return q;
                if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
                return p;
            };
            const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
            const p = 2 * l - q;
            r = hue2rgb(p, q, h + 1 / 3);
            g = hue2rgb(p, q, h);
            b = hue2rgb(p, q, h - 1 / 3);
        }
        return { r: Math.round(r * 255), g: Math.round(g * 255), b: Math.round(b * 255) };
    }

    hexToRgb(hex) {
        const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
        return result ? {
            r: parseInt(result[1], 16),
            g: parseInt(result[2], 16),
            b: parseInt(result[3], 16)
        } : { r: 255, g: 255, b: 255 };
    }
}

window.AuraDesigner = new LightingDesigner();
