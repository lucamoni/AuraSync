class AuraVisualizer3D {
    constructor(containerId) {
        this.containerId = containerId;
        this.container = document.getElementById(containerId);
        this.initialized = false;
        this.fixtures = {};
        this._universeState = {}; // PERSISTENT DMX MIRROR: { u_id: Uint8Array(512) }
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
        this._setupDiagnosticCube();

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
        const isSpark = n.includes('fontana') || n.includes('spark');

        // Moving head detection takes priority over generic LED/Par
        const isHead = n.includes('head') || n.includes('moving') || n.includes('beam') || n.includes('wash') || n.includes('spot');
        const isPar = (n.includes('par') || n.includes('led')) && !isBar && !isHead;

        const isMovingHead = isHead && !isBar && !isSpark;

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

        // Store reference for intensity matches
        fixtureData.coreMat = coreMat;
        fixtureData.beamMat = beamMat;
        fixtureData.spotMat = spotMat;

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
        const channelDetails = fixtureData.channel_details || fixtureData.channel_details || [];
        const basePosition = group.position.clone();

        // Initialize state variables to avoid undefined in _animate
        const intensity = 0;
        const strobeValue = 0;
        const beamColor = new THREE.Color(0xffffff);

        // CHANNEL CACHING (Performance & Debugging)
        const findIdx = (keywords) => {
            const keys = Array.isArray(keywords) ? keywords : [keywords];
            let kIdx = channelDetails.findIndex(c => {
                const cn = (c.name || '').toLowerCase();
                return keys.some(k => cn.includes(k)) && !cn.includes('fine') && !cn.includes('16 bit');
            });
            if (kIdx === -1) {
                kIdx = channelDetails.findIndex(c => {
                    const cn = (c.name || '').toLowerCase();
                    return keys.some(k => cn.includes(k));
                });
            }
            return kIdx;
        };

        const dimmerIdx = findIdx(['dim', 'intensity', 'intensità', 'intensita', 'level', 'dimmer']);
        const panIdx = findIdx(['pan', 'brandeggio']);
        const tiltIdx = findIdx(['tilt', 'alzo']);
        const rIdx = findIdx(['red', 'rosso', 'r']);
        const gIdx = findIdx(['green', 'verde', 'g']);
        const bIdx = findIdx(['blue', 'blu', 'b']);
        const strobeIdx = findIdx(['strobe', 'shutter', 'strobo', 'otturatore', 'flash']);
        const wIdx = findIdx(['white', 'bianco', 'w']);
        const colorIdx = findIdx(['color', 'ruota colori', 'colore']);

        this.fixtures[id] = {
            group, body, head, headMat, beam, beamMat, spot, spotMat, coreMat,
            isMovingHead, isSpark, channelDetails, basePosition,
            intensity, strobeValue, beamColor,
            panIdx, tiltIdx, dimmerIdx, rIdx, gIdx, bIdx, strobeIdx, wIdx, colorIdx,
            id: id,
            universe: fixtureData.universe || 0,
            updateCount: 0,
            lastUniData: null
        };

        // Performance: Counter for received updates
        this.fixtures[id].updateCount = 0;
        this.fixtures[id].lastUpdateVal = 0;
    }

    setFixturePosition(id, pos, rot) {
        if (!this.fixtures[id]) return;
        const f = this.fixtures[id];

        if (pos) {
            f.group.position.set(pos.x, pos.y, pos.z);
            f.basePosition.copy(f.group.position);
        }
        if (rot) {
            f.group.rotation.set(rot.x, rot.y, rot.z);
        }
    }

    heartbeat() {
        this._lastDmxTime = Date.now();
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

    updateFixture(id, startAddr, channelsData, isDelta = true, universeId = 0) {
        try {
            if (!this.fixtures[id]) return;
            const f = this.fixtures[id];

            // 1. Maintain Universe Mirror for sparse updates (Deltas)
            const u = universeId || f.universe || 0;
            if (!this._universeState[u]) this._universeState[u] = new Uint8Array(512);

            if (Array.isArray(channelsData)) {
                // Full buffer update
                for (let i = 0; i < Math.min(512, channelsData.length); i++) {
                    this._universeState[u][i] = channelsData[i];
                }
            } else {
                // Sparse delta update { "channel_idx": value }
                for (const c_idx in channelsData) {
                    const idx = parseInt(c_idx);
                    if (idx >= 0 && idx < 512) {
                        this._universeState[u][idx] = channelsData[c_idx];
                    }
                }
            }

            f.updateCount++;
            f.lastUniData = this._universeState[u];
            this._lastDmxTime = Date.now();

            // DEBUG: Log if we are in delta mode and see a relevant change
            if (!Array.isArray(channelsData) && this.statsOverlay) {
                const addr = parseInt(startAddr);
                const relevantChannels = [f.dimmerIdx, f.panIdx, f.tiltIdx, f.rIdx, f.gIdx, f.bIdx];
                for (const c_idx in channelsData) {
                    const idx = parseInt(c_idx);
                    const relIdx = idx - (addr - 1);
                    if (relevantChannels.includes(relIdx)) {
                        if (f.updateCount % 10 === 0) {
                            console.log(`[3D] Fixture ${id} Delta Hit: Ch ${idx} (Rel ${relIdx}) = ${channelsData[c_idx]}`);
                        }
                    }
                }
            }

            const addr = parseInt(startAddr);

            // 2. Get value from PERSISTENT mirror
            const getVal = (idx) => {
                if (idx === -1 || idx === null) return null;
                const target = (addr - 1) + idx;
                return (target >= 0 && target < 512) ? this._universeState[u][target] : null;
            };

            // DYNAMIC CHANNEL RECOVERY: If any crucial index is -1, try re-calculating (in case details loaded late)
            const findIdx = (keywords) => {
                const keys = Array.isArray(keywords) ? keywords : [keywords];
                const list = f.channelDetails || [];
                let kIdx = list.findIndex(c => {
                    const cn = (c.name || '').toLowerCase();
                    return keys.some(k => cn.includes(k)) && !cn.includes('fine') && !cn.includes('16 bit') && !cn.includes('fino');
                });
                return kIdx;
            };

            if (f.dimmerIdx === -1) f.dimmerIdx = findIdx(['dim', 'intensity', 'intensità', 'intensita', 'level', 'dimmer', 'shutter']);
            if (f.panIdx === -1) f.panIdx = findIdx(['pan', 'brandeggio', 'orizzontale']);
            if (f.tiltIdx === -1) f.tiltIdx = findIdx(['tilt', 'alzo', 'verticale']);
            if (f.rIdx === -1) f.rIdx = findIdx(['red', 'rosso', 'r', 'red macro']);
            if (f.gIdx === -1) f.gIdx = findIdx(['green', 'verde', 'g', 'green macro']);
            if (f.bIdx === -1) f.bIdx = findIdx(['blue', 'blu', 'b', 'blue macro']);
            if (f.strobeIdx === -1) f.strobeIdx = findIdx(['strobe', 'shutter', 'strobo', 'otturatore', 'flash']);
            if (f.wIdx === -1) f.wIdx = findIdx(['white', 'bianco', 'w', 'white macro']);

            let dimNum = getVal(f.dimmerIdx);
            let rNum = getVal(f.rIdx);
            let gNum = getVal(f.gIdx);
            let bNum = getVal(f.bIdx);
            let strobeNum = getVal(f.strobeIdx);
            let panNum = getVal(f.panIdx);
            let tiltNum = getVal(f.tiltIdx);
            let wNum = getVal(f.wIdx);

            // TEST MODE OVERRIDE
            if (this._testMode) {
                dimNum = 255; rNum = 255; gNum = 255; bNum = 255; wNum = 255;
                const slowTime = Date.now() * 0.001;
                panNum = 127 + Math.sin(slowTime + (parseInt(id) * 0.5)) * 127;
                tiltNum = 127 + Math.cos(slowTime + (parseInt(id) * 0.5)) * 127;
            }

            // Intensity calculation
            let intensity = 1.0;
            if (dimNum !== null) {
                intensity = dimNum / 255;
            } else if (rNum !== null || gNum !== null || bNum !== null) {
                intensity = Math.max(rNum || 0, gNum || 0, bNum || 0, wNum || 0) / 255;
            }

            f.intensity = intensity;
            f.strobeValue = strobeNum || 0;

            // Color processing
            if (rNum !== null || gNum !== null || bNum !== null || wNum !== null) {
                const r = (rNum || 0) / 255;
                const g = (gNum || 0) / 255;
                const b = (bNum || 0) / 255;
                const w = (wNum || 0) / 255;
                f.beamColor.setRGB(Math.min(1, r + w), Math.min(1, g + w), Math.min(1, b + w));
            } else {
                const colorWheelNum = getVal(f.colorIdx);
                if (colorWheelNum !== null) {
                    const colors = [0xffffff, 0xff0000, 0xffaa00, 0xffff00, 0x00ff00, 0x00ffff, 0x0000ff, 0xff00ff, 0xffcccc, 0x8800ff];
                    const cIdx = Math.floor((colorWheelNum / 256) * colors.length);
                    f.beamColor.set(colors[cIdx % colors.length]);
                }
            }

            if (f.beamMat && f.beamMat.color) f.beamMat.color.copy(f.beamColor);
            if (f.coreMat && f.coreMat.color) f.coreMat.color.copy(f.beamColor);
            if (f.spotMat && f.spotMat.color) f.spotMat.color.copy(f.beamColor);
            if (f.headMat) {
                if (f.headMat.emissive && f.headMat.type !== 'MeshBasicMaterial') f.headMat.emissive.copy(f.beamColor);
                if (f.headMat.color) f.headMat.color.copy(f.beamColor);
            }

            this._updateVisualState(f);

            // AUTO-DETECTION UPGRADE: If we have indices, we MOVE. 
            // Periodically log to confirm parameters
            if (f.updateCount % 400 === 1) {
                console.log(`[3D] Fixture ${id} Live Update | P:${panNum} T:${tiltNum} Dim:${dimNum}`);
                if (f.isMovingHead === false && (panNum !== null || tiltNum !== null)) {
                    console.warn(`[3D] Fixture ${id} promoted to Moving Head based on live data.`);
                    f.isMovingHead = true;
                    f.body.rotation.x = Math.PI; // Correct orientation for moving heads
                }
            }

            // Movement (Pan / Tilt) - Apply if we have the objects and the data
            if (f.group && f.body) {
                if (panNum !== null) f.group.rotation.y = ((panNum / 255) - 0.5) * (Math.PI * 3);
                if (tiltNum !== null) f.body.rotation.x = ((tiltNum / 255) - 0.5) * (Math.PI * 1.5) + Math.PI;
            }

            if (f.updateCount % 200 === 1) {
                // Keep some logging for user confirmation
                console.log(`[3D] Fixture ${id} Active: D=${dimNum}, P=${panNum}, T=${tiltNum} | Map: P:${f.panIdx} T:${f.tiltIdx}`);
            }
        } catch (err) {
            console.error("[3D Visualizer] updateFixture Error:", err);
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
            // Only set IDLE if we don't have a recent heartbeat
            if (!this._lastDmxTime || Date.now() - this._lastDmxTime > 2000) {
                this.statsOverlay.innerHTML = 'ENGINE: IDLE (No Data)';
            }
            this.container.appendChild(this.statsOverlay);
        }
        this._lastDmxTime = 0;
        this._debugMode = false;

        // Listener for Test Mode
        window.addEventListener('keydown', (e) => {
            if (e.key.toLowerCase() === 't') {
                this._testMode = !this._testMode;
                console.log("[3D Visualizer] Test Mode:", this._testMode ? "ENABLED (Force movement)" : "DISABLED");
            }
        });
    }

    _animate() {
        requestAnimationFrame(() => this._animate());
        try {
            const now = Date.now();
            if (!this._lastFrameTime) this._lastFrameTime = now;
            const delta = now - this._lastFrameTime;
            this._lastFrameTime = now;
            this._fps = Math.round(1000 / delta);

            // Update Diagnostic Cube
            if (this._diagCube) {
                this._diagCube.rotation.x += 0.02;
                this._diagCube.rotation.y += 0.03;
            }

            // Engine Status timeout
            if (this.statsOverlay) {
                const totalPackets = Object.values(this.fixtures).reduce((sum, f) => sum + (f.updateCount || 0), 0);
                const isIdle = (now - this._lastDmxTime > 2000);
                const statusText = this._testMode ? 'TEST MODE' : (isIdle ? 'IDLE' : 'LIVE');
                const timeStr = new Date().toLocaleTimeString();

                if (this.isCustomOverlay) {
                    const span = this.statsOverlay.querySelector('span');
                    let dmxTrace = "";

                    // Show trace for the first few fixtures to detect signal presence
                    const firstFixes = Object.values(this.fixtures).slice(0, 3);
                    firstFixes.forEach((f, idx) => {
                        if (f.lastUniData) {
                            const vals = Array.from(f.lastUniData.slice(0, 8)).join('|');
                            dmxTrace += `<br/><span style="font-size:10px;color:#888">UNIV ${f.universe} FIX ${f.id}: ${vals}</span>`;
                        }
                    });

                    if (span) span.innerHTML = `ENGINE: ${statusText} | FPS: ${this._fps} | PKTS: ${totalPackets} [${timeStr}]${dmxTrace}`;
                    this.statsOverlay.style.borderColor = (isIdle && !this._testMode) ? 'rgba(255, 255, 255, 0.1)' : (this._testMode ? '#ff0055' : '#00ff88');
                    this.statsOverlay.style.color = (isIdle && !this._testMode) ? '#555' : (this._testMode ? '#ff0055' : '#00ff88');
                } else {
                    this.statsOverlay.innerHTML = `ENGINE: ${statusText} | FPS: ${this._fps} | PKTS: ${totalPackets} [${timeStr}]`;
                }
            }

            // Update visual state for all fixtures
            for (const id in this.fixtures) {
                const f = this.fixtures[id];

                if (this._testMode) {
                    const slowTime = now * 0.001;
                    if (f.isMovingHead) {
                        f.group.rotation.y = Math.sin(slowTime + (parseInt(id) * 0.5)) * Math.PI;
                        f.body.rotation.x = Math.cos(slowTime + (parseInt(id) * 0.5)) * 0.5 + Math.PI;
                    }
                    f.intensity = 1.0;
                    f.beamColor.set(0xffffff);
                }

                this._updateVisualState(f);
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
        } catch (err) {
            // Log only once every 5 seconds to avoid flooding
            if (!this._lastErrTime || Date.now() - this._lastErrTime > 5000) {
                console.error("[3D Visualizer] Animation Error:", err);
                this._lastErrTime = Date.now();
            }
        }
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

    _setupDiagnosticCube() {
        if (!this.scene) return;
        const geo = new THREE.BoxGeometry(0.3, 0.3, 0.3);
        const mat = new THREE.MeshBasicMaterial({ color: 0x00ff88, wireframe: true });
        this._diagCube = new THREE.Mesh(geo, mat);
        this._diagCube.position.set(-3, 6, 0);
        this.scene.add(this._diagCube);
    }
}
