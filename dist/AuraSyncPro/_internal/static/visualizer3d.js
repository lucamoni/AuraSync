class AuraVisualizer3D {
    constructor(containerId) {
        this.containerId = containerId;
        this.container = document.getElementById(containerId);
        this.initialized = false;
        this.fixtures = {};
        this._pendingFixtures = [];
        this._pendingClear = false;
        this._softTexture = this._generateSoftTexture();

        // Lazy-init: only setup Three.js when the container is actually visible
        this._initWhenVisible();
    }

    _initWhenVisible() {
        if (!this.container) return;
        const obs = new ResizeObserver((entries) => {
            for (const entry of entries) {
                const w = entry.contentRect.width;
                const h = entry.contentRect.height;
                if (w > 10 && h > 10 && !this.initialized) {
                    this._setup(w, h);
                    obs.disconnect();
                }
            }
        });
        obs.observe(this.container);
    }

    _setup(w, h) {
        if (this.initialized) return;
        this.initialized = true;

        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x000000);

        this.camera = new THREE.PerspectiveCamera(60, w / h, 0.1, 1000);
        this.camera.position.set(0, 8, 15);
        this.camera.lookAt(0, 2, 0);

        this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        this.renderer.setSize(w, h);
        this.renderer.shadowMap.enabled = true;
        this.container.appendChild(this.renderer.domElement);

        this._setupStats();
        this._setupScene();
        this._setupOrbitControls();

        // Setup TransformControls
        this.transformControl = new THREE.TransformControls(this.camera, this.renderer.domElement);
        this.transformControl.addEventListener('dragging-changed', (event) => {
            this._orbitEnabled = !event.value;
        });
        this.transformControl.addEventListener('change', () => {
            if (this._selectedFixtureId && this.transformControl.object) {
                const pos = this.transformControl.object.position;
                const rot = this.transformControl.object.rotation;
                if (typeof fixtures !== 'undefined') {
                    const f = fixtures.find(fx => fx.id === this._selectedFixtureId);
                    if (f) {
                        f.position = { x: pos.x, y: pos.y, z: pos.z };
                        f.rotation = { x: rot.x, y: rot.y, z: rot.z };
                        localStorage.setItem('aurasync_fixtures', JSON.stringify(fixtures));
                        if (typeof isDirty !== 'undefined') isDirty = true;

                        // Update basePosition so jitter doesn't snap back to old pos
                        if (this.fixtures[this._selectedFixtureId]) {
                            this.fixtures[this._selectedFixtureId].basePosition.copy(pos);
                        }
                    }
                }
            }
        });
        this.scene.add(this.transformControl);

        // Raycaster for fixture selection
        this.raycaster = new THREE.Raycaster();
        this.mouse = new THREE.Vector2();

        this.renderer.domElement.addEventListener('click', (e) => {
            if (!this._orbitEnabled && this.transformControl.dragging) return; // ignore clicks while dragging

            const rect = this.renderer.domElement.getBoundingClientRect();
            this.mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
            this.mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

            this.raycaster.setFromCamera(this.mouse, this.camera);

            const interactables = Object.values(this.fixtures).map(f => f.group);
            const intersects = this.raycaster.intersectObjects(interactables, true);

            if (intersects.length > 0) {
                let obj = intersects[0].object;
                while (obj && !obj.userData?.fixtureId && obj.parent) { obj = obj.parent; }

                if (obj && obj.userData?.fixtureId) {
                    this._selectedFixtureId = obj.userData.fixtureId;
                    this.transformControl.attach(obj);
                }
            } else {
                this.transformControl.detach();
                this._selectedFixtureId = null;
            }
        });

        // Key bindings for Translate/Rotate
        window.addEventListener('keydown', (e) => {
            if (e.key.toLowerCase() === 't') this.transformControl.setMode('translate');
            if (e.key.toLowerCase() === 'r') this.transformControl.setMode('rotate');
        });

        // Apply pending operations
        if (this._pendingClear) { this._clearScene(); this._pendingClear = false; }
        this._pendingFixtures.forEach(f => this._addFixtureToScene(f));
        this._pendingFixtures = [];

        this._animate();

        window.addEventListener('resize', () => {
            const cw = this.container.clientWidth;
            const ch = this.container.clientHeight;
            if (cw > 10 && ch > 10) {
                this.camera.aspect = cw / ch;
                this.camera.updateProjectionMatrix();
                this.renderer.setSize(cw, ch);
            }
        });
    }

    setBackgroundImage(dataUrl) {
        if (!dataUrl) return;
        new THREE.TextureLoader().load(dataUrl, (texture) => {
            // Keep proportion based on container bounds
            this.scene.background = texture;

            // Adjust materials slightly so they pop against a real photo
            const floorMat = this.scene.children.find(c => c.type === 'Mesh' && c.geometry.type === 'PlaneGeometry')?.material;
            if (floorMat) {
                floorMat.opacity = 0.5;
                floorMat.transparent = true;
            }
        });
    }

    _setupScene() {
        // Floor grid
        const grid = new THREE.GridHelper(30, 30, 0x1a2530, 0x050a10);
        this.scene.add(grid);

        // Stage Floor
        const stageGeo = new THREE.BoxGeometry(40, 0.5, 20); // Larger stage
        const stageMat = new THREE.MeshStandardMaterial({ color: 0x020305, roughness: 0.9, metalness: 0.1 });
        const stage = new THREE.Mesh(stageGeo, stageMat);
        stage.position.y = -0.25;
        stage.receiveShadow = true;
        this.scene.add(stage);

        // Back Wall (to catch beams)
        const wallGeo = new THREE.PlaneGeometry(20, 10);
        const wallMat = new THREE.MeshStandardMaterial({ color: 0x05070a, roughness: 0.9 });
        const backWall = new THREE.Mesh(wallGeo, wallMat);
        backWall.position.set(0, 4.5, -5);
        backWall.receiveShadow = true;
        this.scene.add(backWall);

        // Side Walls (Wings)
        const sideWallGeo = new THREE.PlaneGeometry(10, 10);
        const leftWall = new THREE.Mesh(sideWallGeo, wallMat);
        leftWall.rotation.y = Math.PI / 2;
        leftWall.position.set(-10, 4.5, 0);
        this.scene.add(leftWall);

        const rightWall = new THREE.Mesh(sideWallGeo, wallMat);
        rightWall.rotation.y = -Math.PI / 2;
        rightWall.position.set(10, 4.5, 0);
        this.scene.add(rightWall);

        // Ambient light
        this.scene.add(new THREE.AmbientLight(0x111620, 0.4));

        // Truss bar
        const trussGeo = new THREE.BoxGeometry(20, 0.15, 0.15);
        const trussMat = new THREE.MeshLambertMaterial({ color: 0x555555 });
        const truss = new THREE.Mesh(trussGeo, trussMat);
        truss.position.set(0, 5, 0);
        this.scene.add(truss);
    }

    _setupOrbitControls() {
        this._orbitEnabled = true;

        let isDragging = false;
        let prevMouse = { x: 0, y: 0 };
        let spherical = { theta: 0, phi: Math.PI / 4, radius: 16 };

        const domEl = this.renderer.domElement;
        domEl.addEventListener('mousedown', e => { isDragging = true; prevMouse = { x: e.clientX, y: e.clientY }; });
        domEl.addEventListener('mouseup', () => isDragging = false);
        domEl.addEventListener('mouseleave', () => isDragging = false);
        domEl.addEventListener('mousemove', e => {
            if (!isDragging || !this._orbitEnabled) return;
            const dx = (e.clientX - prevMouse.x) * 0.01;
            const dy = (e.clientY - prevMouse.y) * 0.01;
            spherical.theta -= dx;
            spherical.phi = Math.max(0.1, Math.min(Math.PI / 2 - 0.05, spherical.phi - dy));
            prevMouse = { x: e.clientX, y: e.clientY };
        });
        domEl.addEventListener('wheel', e => {
            if (!this._orbitEnabled) return;
            spherical.radius = Math.max(5, Math.min(40, spherical.radius + e.deltaY * 0.05));
            e.preventDefault();
        }, { passive: false });

        this._spherical = spherical;
    }

    addFixture(fixtureData) {
        if (!this.initialized) { this._pendingFixtures.push(fixtureData); return; }
        this._addFixtureToScene(fixtureData);
    }

    _addFixtureToScene(fixtureData) {
        const { id, name, model } = fixtureData;
        const n = (name + " " + (model || "")).toLowerCase();
        const isBar = n.includes('bar') || n.includes('batten') || n.includes('strip');
        const isPar = n.includes('par') || n.includes('led') && !isBar;
        const isSpark = n.includes('fontana') || n.includes('spark');
        const isMovingHead = !isBar && !isPar && !isSpark;

        const idx = Object.keys(this.fixtures).length;
        const spread = 2.0;
        const cols = 7;
        const col = idx % cols;
        const row = Math.floor(idx / cols);

        // Group container that handles the overall position
        const group = new THREE.Group();
        group.userData = { fixtureId: id };

        if (fixtureData.position) {
            group.position.set(fixtureData.position.x, fixtureData.position.y, fixtureData.position.z);
        } else {
            const startX = (col - Math.floor(cols / 2)) * spread;
            const startZ = row * spread - 1;
            group.position.set(startX, 0, startZ);
        }

        if (fixtureData.rotation) {
            group.rotation.set(fixtureData.rotation.x, fixtureData.rotation.y, fixtureData.rotation.z);
        }

        const body = new THREE.Group();
        let head;
        let headMat;
        let beamGeo;
        let spotGeo = new THREE.CircleGeometry(0.5, 24);

        if (isBar) {
            // LED Bar
            const baseGeo = new THREE.BoxGeometry(2.0, 0.2, 0.4);
            const baseMat = new THREE.MeshLambertMaterial({ color: 0x222222 });
            const base = new THREE.Mesh(baseGeo, baseMat);
            body.add(base);

            const headGeo = new THREE.BoxGeometry(1.8, 0.1, 0.3);
            headMat = new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 0.2, roughness: 0.8 });
            head = new THREE.Mesh(headGeo, headMat);
            head.position.y = -0.15;
            body.add(head);

            beamGeo = new THREE.BoxGeometry(1.8, 3, 0.8);
            beamGeo.translate(0, -1.5, 0); // anchor at top
            spotGeo = new THREE.PlaneGeometry(2.0, 1.0);

        } else if (isPar) {
            // LED PAR
            const baseGeo = new THREE.CylinderGeometry(0.3, 0.3, 0.4, 16);
            const baseMat = new THREE.MeshLambertMaterial({ color: 0x111111 });
            const base = new THREE.Mesh(baseGeo, baseMat);
            base.rotation.x = Math.PI / 2;
            body.add(base);

            const headGeo = new THREE.CircleGeometry(0.25, 16);
            headMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
            head = new THREE.Mesh(headGeo, headMat);
            head.position.z = 0.21;
            body.add(head);

            body.rotation.x = Math.PI / 2; // Point down

            beamGeo = new THREE.CylinderGeometry(0.2, 1.2, 4, 16, 1, true);
            beamGeo.translate(0, -2, 0);

        } else if (isSpark) {
            // Cold Spark Machine (Fontana Fredda)
            const baseGeo = new THREE.BoxGeometry(0.5, 0.4, 0.5);
            const baseMat = new THREE.MeshLambertMaterial({ color: 0x333333 });
            const base = new THREE.Mesh(baseGeo, baseMat);
            body.add(base);

            headMat = new THREE.MeshBasicMaterial({ color: 0x444444 });
            head = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.1), headMat);
            head.position.y = 0.21;
            body.add(head);

            // The "Beam" for sparks is a vertical thin cone/cylinder
            beamGeo = new THREE.CylinderGeometry(0.05, 0.4, 4, 12, 1, true);
            beamGeo.translate(0, 2, 0); // anchor at bottom, shoots UP
            spotGeo = new THREE.CircleGeometry(0.1, 8); // Tiny spot for sparks
        } else {
            // Moving Head (Default)
            const baseGeo = new THREE.BoxGeometry(0.4, 0.15, 0.4);
            const baseMat = new THREE.MeshLambertMaterial({ color: 0x333333 });
            const base = new THREE.Mesh(baseGeo, baseMat);
            body.add(base);

            const headGeo = new THREE.SphereGeometry(0.18, 16, 12);
            headMat = new THREE.MeshStandardMaterial({ color: 0x222222, metalness: 0.8, roughness: 0.2 });
            head = new THREE.Mesh(headGeo, headMat);
            head.position.y = -0.2;
            body.add(head);

            body.rotation.x = Math.PI; // hanging down

            // Volumetric Cone for moving head (starts thin, spreads wide, much longer)
            beamGeo = new THREE.CylinderGeometry(0.05, 1.8, 12, 24, 1, true);
            beamGeo.translate(0, -6.1, 0); // anchor at top precisely at lens
        }

        body.position.set(0, 5, 0); // Suspended up
        group.add(body);

        // Beam (Volumetric Additive Haze)
        const beamMat = new THREE.MeshBasicMaterial({
            color: 0xffffff, transparent: true, opacity: 0,
            side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
            depthWrite: false, map: this._softTexture
        });
        const beam = new THREE.Mesh(beamGeo, beamMat);

        // Inner Core Beam (High intensity center)
        const coreMat = new THREE.MeshBasicMaterial({
            color: 0xffffff, transparent: true, opacity: 0,
            side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
            depthWrite: false, map: this._softTexture
        });
        const coreGeo = beamGeo.clone();
        coreGeo.scale(0.3, 1, 0.3); // Thinner core
        const coreBeam = new THREE.Mesh(coreGeo, coreMat);
        beam.add(coreBeam);

        // Spot (Glow on floor/walls)
        const spotMat = new THREE.MeshBasicMaterial({
            color: 0xffffff, transparent: true, opacity: 0,
            blending: THREE.AdditiveBlending, depthWrite: false,
            map: this._softTexture
        });
        const spot = new THREE.Mesh(spotGeo, spotMat);

        // Store reference to core for intensity updates
        fixtureData.coreMat = coreMat;

        if (isBar || isPar) {
            beam.position.set(0, -0.2, 0); // Relative to body
            spot.rotation.x = -Math.PI / 2;
            spot.position.set(0, 0.01, 0);
            body.add(beam);
            group.add(spot);
        } else if (isSpark) {
            beam.position.set(0, 0.2, 0);
            beam.rotation.x = 0; // shoots up
            spot.visible = false; // No floor spot for sparks
            body.add(beam);
            group.add(spot);
        } else {
            beam.position.set(0, 0, 0); // Relative to body
            spot.rotation.x = -Math.PI / 2;
            spot.position.set(0, 0.01, 0);
            body.add(beam); // Attach to tilting body instead of group
            group.add(spot);
        }


        // Label (sprite)
        const label = document.createElement('canvas');
        label.width = 256; label.height = 64;
        const ctx = label.getContext('2d');
        ctx.fillStyle = 'rgba(0,0,0,0)';
        ctx.fillRect(0, 0, 256, 64);
        ctx.fillStyle = 'rgba(0,210,255,0.8)';
        ctx.font = '22px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(fixtureData.name || `F${id}`, 128, 40);
        const texture = new THREE.CanvasTexture(label);
        const labelMat = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false });
        const sprite = new THREE.Sprite(labelMat);
        sprite.position.y = 0.5;
        group.add(sprite);

        this.scene.add(group);
        const channelDetails = fixtureData.channel_details || [];
        const basePosition = group.position.clone();

        // Initialize state variables to avoid undefined in _animate
        const intensity = 0;
        const strobeValue = 0;
        const beamColor = new THREE.Color(0xffffff);

        this.fixtures[id] = {
            group, body, head, headMat, beam, beamMat, spot, spotMat,
            isMovingHead, isSpark, channelDetails, basePosition,
            intensity, strobeValue, beamColor
        };
    }

    clearFixtures() {
        if (!this.initialized) { this._pendingClear = true; this._pendingFixtures = []; return; }
        this._clearScene();
    }

    _clearScene() {
        if (this.transformControl) this.transformControl.detach();
        this._selectedFixtureId = null;

        for (const id in this.fixtures) {
            this.scene.remove(this.fixtures[id].group);
        }
        this.fixtures = {};
    }

    updateFixture(id, startAddr, channelsData) {
        if (!this.fixtures[id]) return;
        const f = this.fixtures[id];

        const addr = parseInt(startAddr);
        // Find channels dynamically with multi-language and "coarse-first" priority
        const getV = (keywords) => {
            if (!Array.isArray(keywords)) keywords = [keywords];

            // 1. Try to find a non-fine channel first
            let idx = f.channelDetails.findIndex(c => {
                const n = c.name.toLowerCase();
                return keywords.some(k => n.includes(k)) && !n.includes('fine') && !n.includes('16 bit');
            });

            // 2. Fallback to any channel if no non-fine one found
            if (idx === -1) {
                idx = f.channelDetails.findIndex(c => {
                    const n = c.name.toLowerCase();
                    return keywords.some(k => n.includes(k));
                });
            }

            if (idx === -1) return null;
            // Use .toString() as JSON keys from Python are strings
            const val = channelsData[(addr + idx).toString()];
            return (val !== undefined) ? val : null;
        };

        const dimNum = getV(['dim', 'intensity', 'intensità', 'intensita', 'level', 'dimmer']);
        const rNum = getV(['red', 'rosso', 'r']);
        const gNum = getV(['green', 'verde', 'g']);
        const bNum = getV(['blue', 'blu', 'b']);
        const wNum = getV(['white', 'bianco', 'w']);
        const strobeNum = getV(['strobe', 'shutter', 'strobo', 'otturatore', 'flash']);
        const panNum = getV(['pan', 'brandeggio']);
        const tiltNum = getV(['tilt', 'alzo']);
        const colorWheelNum = getV(['color', 'ruota colori', 'colore']);


        // Intensity calculation
        let intensity = 1.0;
        if (dimNum !== null) intensity = dimNum / 255;
        else if (rNum !== null || gNum !== null || bNum !== null) intensity = Math.max(rNum || 0, gNum || 0, bNum || 0) / 255;

        f.intensity = intensity;
        f.strobeValue = strobeNum || 0;

        // Color (with RGBW support)
        if (rNum !== null || gNum !== null || bNum !== null || wNum !== null) {
            const r = (rNum || 0) / 255;
            const g = (gNum || 0) / 255;
            const b = (bNum || 0) / 255;
            const w = (wNum || 0) / 255;

            // Mix white into RGB
            const color = new THREE.Color(
                Math.min(1.0, r + w),
                Math.min(1.0, g + w),
                Math.min(1.0, b + w)
            );

            f.beamColor = color;
        } else if (colorWheelNum !== null) {
            // Basic fallback for Color Wheel fixtures (8-bit)
            const colors = [0xffffff, 0xff0000, 0xffaa00, 0xffff00, 0x00ff00, 0x00ffff, 0x0000ff, 0xff00ff, 0xffcccc, 0x8800ff];
            const idx = Math.floor((colorWheelNum / 256) * colors.length);
            f.beamColor = new THREE.Color(colors[idx % colors.length]);
        } else {
            f.beamColor = new THREE.Color(0xffffff); // Default to white
        }

        if (f.beamMat && f.beamMat.color) f.beamMat.color.copy(f.beamColor);
        if (f.coreMat && f.coreMat.color) f.coreMat.color.copy(f.beamColor);
        if (f.spotMat && f.spotMat.color) f.spotMat.color.copy(f.beamColor);
        if (f.headMat) {
            if (f.headMat.emissive && f.headMat.type !== 'MeshBasicMaterial') {
                f.headMat.emissive.copy(f.beamColor);
            }
            if (f.headMat.color) f.headMat.color.copy(f.beamColor);
        }

        // Apply base DMX update (strobe logic runs in _animate)
        this._updateVisualState(f);

        // Update Stats
        this._lastDmxTime = Date.now();
        if (this.statsOverlay) {
            if (this.isCustomOverlay) {
                const span = this.statsOverlay.querySelector('span');
                if (span) span.innerText = 'ENGINE: LIVE';
                this.statsOverlay.style.borderColor = '#00ff88';
                this.statsOverlay.style.color = '#00ff88';
                const dot = this.statsOverlay.querySelector('.dot');
                if (dot) dot.style.background = '#00ff88';
            } else {
                this.statsOverlay.innerHTML = `ENGINE: LIVE <span style="color:#aaa">(Addr ${addr})</span>`;
                this.statsOverlay.style.color = '#00ff00';
            }
        }

        // Movement (Pan / Tilt)
        if (f.isMovingHead) {
            if (panNum !== null) f.group.rotation.y = ((panNum / 255) - 0.5) * (Math.PI * 3);
            if (tiltNum !== null) f.body.rotation.x = ((tiltNum / 255) - 0.5) * (Math.PI * 1.5) + Math.PI;
        }
    }

    _updateVisualState(f) {
        let finalIntensity = f.intensity;

        // Simple Strobe Simulation
        if (f.strobeValue > 15) {
            const freq = (f.strobeValue / 255) * 20;
            const phase = (Date.now() * 0.001) * freq * Math.PI * 2;
            if (Math.sin(phase) < 0) finalIntensity = 0;
        }

        if (f.isSpark) {
            // Specialized Spark Animation
            const flicker = 0.7 + 0.3 * Math.random();
            const sparkColor = new THREE.Color(0xffaa44); // Warm sparks
            if (f.beamMat) {
                f.beamMat.color.copy(sparkColor);
                f.beamMat.opacity = (finalIntensity > 0.05) ? finalIntensity * flicker * 0.9 : 0;
                // Scale Y based on intensity to simulate "height"
                f.beam.scale.y = 0.2 + 0.8 * finalIntensity;
            }
            if (f.headMat) f.headMat.color.copy(sparkColor);
            return;
        }

        // Additive Haze "Shimmer" effect
        const shimmer = 0.9 + 0.1 * Math.sin(Date.now() * 0.005);

        // FLUENT VOLUMETRIC OPACITY
        // The outer beam is soft and wide, the inner core is sharp and bright
        if (f.beamMat) f.beamMat.opacity = Math.max(0, Math.min(0.6, (finalIntensity || 0) * 1.5 * shimmer));
        if (f.coreMat) f.coreMat.opacity = Math.max(0, Math.min(1.0, (finalIntensity || 0) * 3.0 * shimmer));
        if (f.spotMat) f.spotMat.opacity = Math.max(0, Math.min(1, (finalIntensity || 0) * 2.5));

        if (f.headMat && f.headMat.type === 'MeshStandardMaterial') {
            f.headMat.emissiveIntensity = (finalIntensity || 0) * 15.0; // Glowing lens
        }
    }

    _generateSoftTexture() {
        // High resolution fluid radial gradient for smooth volumetric haze
        const canvas = document.createElement('canvas');
        canvas.width = 256; canvas.height = 256;
        const ctx = canvas.getContext('2d');
        const grad = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
        grad.addColorStop(0, 'rgba(255,255,255,1.0)');     // Hot center
        grad.addColorStop(0.2, 'rgba(255,255,255,0.8)');   // Corona
        grad.addColorStop(0.5, 'rgba(255,255,255,0.3)');   // Soft fade
        grad.addColorStop(0.8, 'rgba(255,255,255,0.05)');  // Outer haze
        grad.addColorStop(1, 'rgba(255,255,255,0)');       // Perfect edge fade
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, 256, 256);
        const tex = new THREE.CanvasTexture(canvas);
        return tex;
    }

    _setupStats() {
        const existing = document.getElementById('status-overlay');
        if (existing) {
            this.statsOverlay = existing;
            this.isCustomOverlay = true;
        } else {
            this.statsOverlay = document.createElement('div');
            this.statsOverlay.style.position = 'absolute';
            this.statsOverlay.style.top = '10px';
            this.statsOverlay.style.left = '10px';
            this.statsOverlay.style.padding = '8px 12px';
            this.statsOverlay.style.background = 'rgba(0,0,0,0.6)';
            this.statsOverlay.style.color = '#ff3300';
            this.statsOverlay.style.fontFamily = 'monospace';
            this.statsOverlay.style.fontSize = '12px';
            this.statsOverlay.style.borderRadius = '6px';
            this.statsOverlay.style.pointerEvents = 'none';
            this.statsOverlay.style.zIndex = '100';
            this.statsOverlay.innerHTML = 'ENGINE: IDLE (No Data)';
            this.container.appendChild(this.statsOverlay);
        }
        this._lastDmxTime = 0;
    }

    _animate() {
        requestAnimationFrame(() => this._animate());

        // Engine Status timeout
        if (this.statsOverlay && Date.now() - this._lastDmxTime > 2000) {
            if (this.isCustomOverlay) {
                const span = this.statsOverlay.querySelector('span');
                if (span) span.innerText = 'ENGINE: IDLE (No Data)';
                this.statsOverlay.style.borderColor = 'rgba(255, 255, 255, 0.1)';
                this.statsOverlay.style.color = '#555';
                const dot = this.statsOverlay.querySelector('.dot');
                if (dot) dot.style.background = '#555';
            } else {
                this.statsOverlay.innerHTML = 'ENGINE: IDLE (No Data)';
                this.statsOverlay.style.color = '#555';
            }
        }

        // Update visual state for all fixtures (strobe, color interpolation, etc.)
        for (const id in this.fixtures) {
            this._updateVisualState(this.fixtures[id]);
        }

        if (this._spherical) {
            const { theta, phi, radius } = this._spherical;
            this.camera.position.set(
                radius * Math.sin(theta) * Math.sin(phi),
                radius * Math.cos(phi),
                radius * Math.cos(theta) * Math.sin(phi)
            );
            this.camera.lookAt(0, 2, 0);
        }
        this.renderer.render(this.scene, this.camera);
    }

    setBeamColor(colorHex) {
        const color = new THREE.Color(colorHex);
        for (const id in this.fixtures) {
            const f = this.fixtures[id];
            if (f.beamMat) f.beamMat.color.copy(color);
            if (f.spotMat) f.spotMat.color.copy(color);
            if (f.headMat) {
                if (f.headMat.emissive && f.headMat.type !== 'MeshBasicMaterial') {
                    f.headMat.emissive.copy(color);
                }
                f.headMat.color.copy(color);
            }
        }
    }
}
