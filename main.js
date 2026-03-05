// =============================================================
//  MAIN.JS — Scene setup, car select, HUD, settings, game loop
//
//  Depends on: physics.js, cars.js, track.js  (loaded first)
//  Uses BabylonJS + HavokPhysics
// =============================================================

// ── Input — delegated to InputManager (input.js) ────────────
// inputManager is a singleton on window, registered in input.js.
// Call inputManager.update() each frame before reading .state.

// ── Status helpers ───────────────────────────────────────────
const setStatus = s => { const e = document.getElementById('load-status'); if (e) e.textContent = s; };
const setBar    = p => { const e = document.getElementById('load-bar');    if (e) e.style.width  = p + '%'; };

// ── Main async init ──────────────────────────────────────────
(async function () {
  if (!window.BABYLON) { setStatus('ERROR: BABYLON NOT LOADED'); return; }
  const B = BABYLON;

  setStatus('LOADING HAVOK WASM...'); setBar(15);

  let HK = null;
  try {
    if (typeof window.HavokPhysics !== 'function')
      throw new Error('HavokPhysics not on window');
    HK = await window.HavokPhysics();
    setStatus('HAVOK READY'); setBar(40);
  } catch (err) {
    setStatus('HAVOK UNAVAILABLE — MANUAL MODE'); setBar(40);
    console.warn('Havok init failed:', err);
  }

  // ── Engine + scene ───────────────────────────────────────
  const canvas = document.getElementById('c');
  const engine = new B.Engine(canvas, true, { adaptToDeviceRatio: true });
  const scene  = new B.Scene(engine);
  scene.clearColor = new B.Color4(0.50, 0.75, 0.96, 1);

  if (HK) {
    scene.enablePhysics(new B.Vector3(0, -9.81, 0), new B.HavokPlugin(true, HK));
    setStatus('PHYSICS ENGINE ONLINE'); setBar(55);
  } else {
    try {
      scene.enablePhysics(new B.Vector3(0, -9.81, 0), new B.OimoJSPlugin());
      setStatus('OIMO PHYSICS FALLBACK'); setBar(55);
    } catch (e) {
      setStatus('NO PHYSICS — MANUAL MODE'); setBar(55);
    }
  }

  // ── Lighting ─────────────────────────────────────────────
  const sun = new B.DirectionalLight('sun', new B.Vector3(-0.5, -1, -0.3), scene);
  sun.intensity = 1.7;
  sun.diffuse   = new B.Color3(1, 0.95, 0.85);
  const amb = new B.HemisphericLight('amb', new B.Vector3(0, 1, 0), scene);
  amb.intensity   = 0.5;
  amb.diffuse     = new B.Color3(0.75, 0.88, 1);
  amb.groundColor = new B.Color3(0.3, 0.5, 0.2);

  setStatus('READY TO RACE...'); setBar(65);

  // track is populated when the player confirms map selection
  let track = null;

  // ── Sky sphere ───────────────────────────────────────────
  const SKY_COL = new B.Color3(0.52, 0.76, 1.0);
  scene.clearColor = new B.Color4(SKY_COL.r, SKY_COL.g, SKY_COL.b, 1);
  const sky = B.MeshBuilder.CreateSphere('sky',
    { diameter: 1100, sideOrientation: B.Mesh.BACKSIDE, segments: 8 }, scene);
  const sm = new B.StandardMaterial('sky', scene);
  sm.emissiveColor   = SKY_COL;
  sm.disableLighting = true;
  sm.backFaceCulling = false;
  sky.isPickable     = false;
  sky.material       = sm;

  setStatus('SPAWNING CAR...'); setBar(78);

  // ── Car materials — one set per profile color ────────────
  function makeCarMats(profile) {
    const [r, g, b] = profile.color3;
    // Use a unique suffix so materials from a previous car don't collide.
    // The old  `new StandardMaterial(name, scene) || getMaterialByName(name)`
    // pattern was broken — the constructor always returns a truthy object,
    // so getMaterialByName() never ran and duplicate materials accumulated.
    const uid = profile.id + '_' + Date.now();

    const mBody = new B.StandardMaterial('body_' + uid, scene);
    mBody.diffuseColor = new B.Color3(r, g, b);
    mBody.specularPower = 80;

    const mBlue = new B.StandardMaterial('blue_' + uid, scene);
    mBlue.diffuseColor = new B.Color3(0.04, 0.38, 1);

    const mTire = new B.StandardMaterial('tire_' + uid, scene);
    mTire.diffuseColor = new B.Color3(0.1, 0.1, 0.1);

    const mRim = new B.StandardMaterial('rim_' + uid, scene);
    mRim.diffuseColor = new B.Color3(0.9, 0.85, 0.08);
    mRim.specularPower = 128;

    return { mBody, mBlue, mTire, mRim };
  }

  // ── Build chassis mesh ────────────────────────────────────
  function buildChassisMesh(profile, mats) {
    const chassis = B.MeshBuilder.CreateBox('chassis',
      { width: 1.85, height: 0.36, depth: 4.0 }, scene);
    chassis.position         = track.startPos.clone();
    chassis.rotationQuaternion = track.startRot.clone();
    chassis.material = mats.mBody;

    const mk = (n, w, h, d, mat, px, py, pz) => {
      const m = B.MeshBuilder.CreateBox(n, { width: w, height: h, depth: d }, scene);
      m.parent   = chassis;
      m.position.set(px, py, pz);
      m.material = mat;
      return m;
    };
    mk('nose', 1.3, 0.22, 1.0, mats.mBody,  0, -0.02, 2.45);
    mk('cock', 0.92, 0.42, 1.3, mats.mBlue, 0,  0.36, 0.10);
    mk('wuL',  0.09, 0.50, 0.07, mats.mBody, -0.60, 0.40, -1.72);
    mk('wuR',  0.09, 0.50, 0.07, mats.mBody,  0.60, 0.40, -1.72);
    mk('wing', 1.62, 0.08, 0.42, mats.mBlue,  0,  0.60, -1.72);

    return chassis;
  }

  // ── Wheel anchor definitions ──────────────────────────────
  const wDefs = [
    { x: -1.02, y: -0.08, z:  1.32, front: true,  left: true  },
    { x:  1.02, y: -0.08, z:  1.32, front: true,  left: false },
    { x: -1.02, y: -0.08, z: -1.42, front: false, left: true  },
    { x:  1.02, y: -0.08, z: -1.42, front: false, left: false },
  ];

  function buildWheelMeshes(chassis, mTire, mRim) {
    return wDefs.map((w, i) => {
      const t = B.MeshBuilder.CreateCylinder('wt' + i,
        { diameter: 0.56, height: 0.30, tessellation: 18 }, scene);
      t.parent   = chassis;
      t.position.set(w.x, w.y, w.z);
      t.rotation.z = Math.PI / 2;
      t.material   = mTire;
      const r = B.MeshBuilder.CreateCylinder('wr' + i,
        { diameter: 0.34, height: 0.31, tessellation: 12 }, scene);
      r.parent   = t;
      r.material = mRim;
      return t;
    });
  }

  // ── State holders (set after car select) ─────────────────
  let physBody     = null;
  let physAgg      = null;   // keep reference so we can dispose it on respawn
  let vehicle      = null;
  let wheelMeshes  = [];
  let chassisMesh  = null;
  let carMats      = null;   // current car's materials — dispose on respawn
  const hasPhysics = scene.getPhysicsEngine() !== null;

  // ── Spawn / respawn ───────────────────────────────────────
  function doRespawn() {
    if (!physBody || !track) return;
    // Invalidate current lap — keep best times intact
    lapStart  = -1;
    allCpHit  = false;
    nextCpIdx = 0;
    refreshCpHighlight();
    physBody.disablePreStep = false;
    physBody.setLinearVelocity(B.Vector3.Zero());
    physBody.setAngularVelocity(B.Vector3.Zero());
    chassisMesh.position.copyFrom(track.startPos);
    chassisMesh.rotationQuaternion.copyFrom(track.startRot);
    if (vehicle) {
      vehicle.gear        = 0;
      vehicle.rpm         = 800;
      vehicle.steerAngle  = 0;
      vehicle._reversing  = false;
      vehicle._prevVel    = B.Vector3.Zero();
    }
    let ticks = 0;
    const obs = scene.onAfterPhysicsObservable.add(() => {
      if (++ticks >= 2) {
        physBody.disablePreStep = true;
        scene.onAfterPhysicsObservable.remove(obs);
      }
    });
  }

  // ── Spawn car with chosen profile ────────────────────────
  function spawnCar(profileId) {
    // Dispose previous car — physics aggregate first, then meshes, then materials
    if (physAgg) {
      physAgg.dispose();
      physAgg  = null;
      physBody = null;
    }
    if (chassisMesh) {
      chassisMesh.getChildMeshes().forEach(m => m.dispose());
      chassisMesh.dispose();
      chassisMesh = null;
    }
    if (carMats) {
      Object.values(carMats).forEach(m => m && m.dispose && m.dispose());
      carMats = null;
    }

    const profile = CAR_PROFILES[profileId];
    carMats       = makeCarMats(profile);
    chassisMesh   = buildChassisMesh(profile, carMats);
    wheelMeshes   = buildWheelMeshes(chassisMesh, carMats.mTire, carMats.mRim);

    if (hasPhysics) {
      vehicle = new RaycastVehicle(scene, chassisMesh, null);
      loadCarProfile(vehicle, profileId);

      const agg = new B.PhysicsAggregate(chassisMesh, B.PhysicsShapeType.BOX,
        { mass: vehicle.MASS, restitution: 0.18, friction: 0.4 }, scene);
      agg.body.setAngularDamping(0.30);
      agg.body.setLinearDamping(0.04);
      physAgg       = agg;
      physBody      = agg.body;
      vehicle.body  = physBody;
      wDefs.forEach(w =>
        vehicle.addWheel(new B.Vector3(w.x, w.y, w.z), w.front, w.left));
    }

    // Update HUD car name
    const nameEl = document.getElementById('car-name');
    if (nameEl) {
      nameEl.textContent = profile.name;
      nameEl.style.color = profile.colorHex;
    }
    const dtEl = document.getElementById('car-dt');
    if (dtEl) dtEl.textContent = profile.subtitle;

    // Sync settings panel sliders to new car values
    syncSettingsPanel();
    doRespawn();
  }

  // ── Camera ───────────────────────────────────────────────
  const camera = new B.FreeCamera('cam', new B.Vector3(0, 5, -12), scene);
  camera.minZ  = 0.1;
  camera.maxZ  = 1200;
  camera.fov   = 50 * Math.PI / 180;
  let camPos        = camera.position.clone();
  let camTgt        = B.Vector3.Zero();
  let camDriftAngle = 0;
  let camDistBase   = 5.5;
  let camHeightBase = 1.8;

  // ── HUD element references ────────────────────────────────
  const hudSpeed  = document.getElementById('spd-val');
  const hudRpm    = document.getElementById('rpm-bar');
  const hudGear   = document.getElementById('gear');
  const hudTime   = document.getElementById('lap-time');
  const driftEl   = document.getElementById('drift');
  const airEl     = document.getElementById('air');
  const attessaBar    = document.getElementById('attessa-bar');
  const attessaWrap   = document.getElementById('attessa-wrap');
  const loadEls   = ['t-fl','t-fr','t-rl','t-rr'].map(id => document.getElementById(id));
  const slipEls   = ['sf-fl','sf-fr','sf-rl','sf-rr'].map(id => document.getElementById(id));
  const PEAK_SLIP = 0.25;

  // ── Lap & checkpoint system ───────────────────────────────
  let lap          = 1;
  let lapStart     = -1;        // -1 = timer not yet started
  let nextCpIdx    = 0;
  let allCpHit     = false;     // true once all intermediate CPs have been hit this lap
  let cpCooldown   = false;
  let bestLap      = Infinity;
  let lastLap      = Infinity;
  let lapHistory   = [];
  let best3Consec  = Infinity;

  const fmtTime = ms => {
    if (!isFinite(ms)) return '--:--.---';
    const s = Math.floor(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2,'0')}.${String(Math.floor(ms % 1000)).padStart(3,'0')}`;
  };

  function flashBest(label, timeStr) {
    const el = document.getElementById('best-flash');
    if (!el) return;
    el.textContent = `${label}  ${timeStr}`;
    el.style.opacity = '1';
    el.style.transform = 'translateY(0)';
    clearTimeout(el._flashTimer);
    el._flashTimer = setTimeout(() => {
      el.style.opacity = '0';
      el.style.transform = 'translateY(-8px)';
    }, 3000);
  }

  function updateBestHUD() {
    const llEl  = document.getElementById('last-lap-val');
    const blEl  = document.getElementById('best-lap-val');
    const b3El  = document.getElementById('best-3-val');
    if (llEl) llEl.textContent = isFinite(lastLap)     ? fmtTime(lastLap)     : '--:--.---';
    if (blEl) blEl.textContent = isFinite(bestLap)     ? fmtTime(bestLap)     : '--:--.---';
    if (b3El) b3El.textContent = isFinite(best3Consec) ? fmtTime(best3Consec) : '--:--.---';
  }

  function onLapComplete(lapMs) {
    lastLap = lapMs;
    lapHistory.push(lapMs);
    lap++;
    let newBest = false;
    if (lapMs < bestLap) {
      bestLap = lapMs;
      newBest = true;
      flashBest('BEST LAP', fmtTime(bestLap));
    }
    if (lapHistory.length >= 3) {
      const last3 = lapHistory.slice(-3).reduce((a, b) => a + b, 0);
      if (last3 < best3Consec) {
        best3Consec = last3;
        if (!newBest) flashBest('BEST 3 LAPS', fmtTime(best3Consec));
      }
    }
    updateBestHUD();
  }

  function refreshCpHighlight() {
    if (!track || !track.checkpoints.length) return;
    track.checkpoints.forEach((cp, i) => {
      if (!cp.mesh.material) return;
      if (i === 0) {
        cp.mesh.material = (i === nextCpIdx)
          ? track._sfMatActive : track._sfMatInactive;
      } else {
        cp.mesh.material = (i === nextCpIdx)
          ? track._cpMatActive : track._cpMatInactive;
      }
    });
  }

  // ── Manual fallback state ─────────────────────────────────
  let manVel = B.Vector3.Zero(), manHead = -Math.PI / 2, manSteer = 0;

  // ── Render loop ───────────────────────────────────────────
  let lastT = performance.now();

  scene.onBeforeRenderObservable.add(() => {
    const now = performance.now();
    const dt  = Math.min((now - lastT) / 1000, 0.05);
    lastT = now;

    if (!chassisMesh) return;

    let state = {
      speedKmh: 0, rpm: 800, gear: 1,
      drifting: false, inAir: false,
      suspTravel: [0.5, 0.5, 0.5, 0.5],
      attessaSplit: 0, drivetrain: 'FR',
    };

    if (vehicle && hasPhysics) {
      if (!window.inputManager) { console.error('[Main] inputManager NOT FOUND on window!'); }
      if (window.inputManager) inputManager.update();
      state = vehicle.update(window.inputManager ? inputManager.state : { throttle:false, brake:false, left:false, right:false, handbrake:false, reset:false, steerAxis:0 }, dt);
      vehicle.updateWheelMeshes(wheelMeshes);
      if (vehicle._needsReset) { vehicle._needsReset = false; doRespawn(); }
    } else if (chassisMesh) {
      // ── Manual fallback ───────────────────────────────
      const fwd   = new B.Vector3(Math.sin(manHead), 0, Math.cos(manHead));
      const right = new B.Vector3(Math.cos(manHead), 0, -Math.sin(manHead));
      let vF = B.Vector3.Dot(manVel, fwd);
      let vL = B.Vector3.Dot(manVel, right);
      const sf = Math.max(0.3, 1 - Math.abs(vF) / 28);
      const ts = inputManager.state.left ? -0.44 * sf : inputManager.state.right ? 0.44 * sf : 0;
      manSteer += (inputManager.state.left || inputManager.state.right)
        ? (ts - manSteer) * 3.2 * dt
        : -manSteer * Math.min(1, 4.8 * dt);
      manSteer = Math.max(-0.44, Math.min(0.44, manSteer));
      let eng = 0;
      if (inputManager.state.throttle) eng = 7200 / 700;
      if (inputManager.state.brake)    eng -= 15000 / 700 * Math.sign(vF || 1);
      const latF = -vL * (inputManager.state.handbrake ? 2 : 22) * 0.72;
      if (Math.abs(vF) > 0.4) {
        let t = (vF * Math.tan(manSteer)) / 2.95;
        if (inputManager.state.handbrake) t *= 1.7;
        manHead += t * dt;
      }
      vF += (eng - 0.55 * vF * Math.abs(vF) / 700) * dt;
      vL += latF * dt;
      if (inputManager.state.handbrake) vL *= Math.pow(0.04, dt);
      vF = Math.max(-20, Math.min(56, vF));
      manVel = fwd.scale(vF).add(right.scale(vL));
      chassisMesh.position.addInPlace(manVel.scale(dt));
      chassisMesh.position.y = track ? track.startPos.y - 0.9 : 0;
      chassisMesh.rotation.y = manHead;
      state.speedKmh = Math.abs(vF) * 3.6;
      if (inputManager.state.reset) {
        manVel = B.Vector3.Zero();
        if (track) chassisMesh.position.copyFrom(track.startPos);
        chassisMesh.rotation.y = -Math.PI / 2;
        manHead = -Math.PI / 2;
      }
    }

    // ── Chase camera with drift lean ─────────────────────
    const cp   = chassisMesh.absolutePosition;
    const rotQ = chassisMesh.absoluteRotationQuaternion
                 || B.Quaternion.RotationYawPitchRoll(
                      chassisMesh.rotation ? chassisMesh.rotation.y : 0, 0, 0);
    const fwdCam = B.Vector3.TransformNormal(
      B.Vector3.Forward(), rotQ.toRotationMatrix(new B.Matrix())).normalize();

    // Drift lean: camera lags behind car heading when sliding
    const avgSlip = vehicle
      ? (Math.abs(vehicle.slipAngles[2] || 0) + Math.abs(vehicle.slipAngles[3] || 0)) / 2
      : 0;
    camDriftAngle += (avgSlip * Math.sign(vehicle ? vehicle.steerAngle : 0) * 0.6
                      - camDriftAngle) * Math.min(1, 4 * dt);

    const speedFactor = Math.min(1, (state.speedKmh || 0) / 180);
    const camDist     = camDistBase + speedFactor * 1.5;
    const camHeight   = camHeightBase + speedFactor * 0.4;

    // Rotate camera offset by drift angle
    const driftRot = B.Quaternion.RotationAxis(B.Vector3.Up(), camDriftAngle);
    const driftMat = driftRot.toRotationMatrix(new B.Matrix());
    const camOffset = B.Vector3.TransformNormal(
      fwdCam.scale(-camDist), driftMat);

    const desired = new B.Vector3(
      cp.x + camOffset.x,
      cp.y + camHeight,
      cp.z + camOffset.z
    );
    camPos = B.Vector3.Lerp(camPos, desired, 0.12);
    camTgt = B.Vector3.Lerp(camTgt,
      new B.Vector3(cp.x + fwdCam.x * 6, cp.y + 0.5, cp.z + fwdCam.z * 6), 0.14);
    camera.position.copyFrom(camPos);
    camera.setTarget(camTgt);

    // ── Checkpoint & lap detection ────────────────────────
    if (track && track.checkpoints.length > 0 && chassisMesh) {
      const cps    = track.checkpoints;
      const carP   = chassisMesh.absolutePosition;

      const sfCp   = cps[0];
      const sfDist = B.Vector3.Distance(carP, sfCp.mesh.position);
      const sfR    = sfCp.mesh._triggerRadius || 8;

      // ── S/F line — always checked regardless of nextCpIdx ──
      if (sfDist < sfR && !cpCooldown) {
        cpCooldown = true;
        setTimeout(() => { cpCooldown = false; }, 800);

        if (lapStart === -1) {
          // Very first crossing — start clock, advance to CP1
          lapStart  = now;
          nextCpIdx = cps.length > 1 ? 1 : 0;
          allCpHit  = cps.length === 1;
          refreshCpHighlight();

        } else if (!allCpHit) {
          // Crossed S/F without completing all checkpoints — reset timer only
          lapStart  = now;
          nextCpIdx = cps.length > 1 ? 1 : 0;
          allCpHit  = false;
          refreshCpHighlight();

        } else {
          // Valid lap
          const lapMs = now - lapStart;
          lapStart    = now;
          allCpHit    = false;
          nextCpIdx   = cps.length > 1 ? 1 : 0;
          onLapComplete(lapMs);
          refreshCpHighlight();
        }

      // ── Intermediate checkpoints — only when it's the next required one ──
      } else if (nextCpIdx > 0 && !cpCooldown) {
        const nextCp = cps[nextCpIdx];
        const dist   = B.Vector3.Distance(carP, nextCp.mesh.position);
        const trigR  = nextCp.mesh._triggerRadius || 8;

        if (dist < trigR) {
          cpCooldown = true;
          setTimeout(() => { cpCooldown = false; }, 600);

          nextCpIdx++;
          if (nextCpIdx >= cps.length) {
            nextCpIdx = 0;
            allCpHit  = true;
          }
          refreshCpHighlight();
        }
      }

    } else if (track && track.checkpoint && !track.checkpoints.length) {
      // ── Oval fallback — single trigger ───────────────────
      const dist = B.Vector3.Distance(chassisMesh.absolutePosition, track.checkpoint.position);
      if (dist < 9 && !cpCooldown) {
        cpCooldown = true;
        setTimeout(() => { cpCooldown = false; }, 1200);
        if (lapStart !== -1) onLapComplete(now - lapStart);
        lapStart = now;
      }
    }

    // ── HUD updates ──────────────────────────────────────
    if (hudSpeed) hudSpeed.textContent = Math.round(state.speedKmh * 0.621371);
    if (hudRpm)   hudRpm.style.width   = (state.rpm / 8500 * 100) + '%';
    if (hudGear)  hudGear.textContent  = state.reversing ? 'R' : state.gear;
    if (hudTime)  hudTime.textContent  = `${lap} · ${lapStart === -1 ? '0:00.000' : fmtTime(now - lapStart)}`;
    const c3El = document.getElementById('curr-3-val');
    if (c3El) {
      if (lapStart === -1) {
        c3El.textContent = '--:--.---';
      } else {
        const prev  = lapHistory.slice(-2);
        const sum   = prev.reduce((a, b) => a + b, 0) + (now - lapStart);
        const count = prev.length + 1;
        c3El.textContent = fmtTime(sum) + (count < 3 ? ` (${count}/3)` : '');
      }
    }
    if (driftEl)  driftEl.style.opacity = state.drifting ? '1' : '0';
    if (airEl)    airEl.style.opacity   = state.inAir    ? '1' : '0';

    // ATTESSA bar — only show for Bruiser, and hide when force-locked
    if (attessaWrap) {
      const locked = vehicle && vehicle.attessaForceLock;
      attessaWrap.style.display = (state.drivetrain === 'AWD' && !locked) ? 'block' : 'none';
      if (attessaBar)
        attessaBar.style.width = Math.round(state.attessaSplit * 100) + '%';
    }

    // Telemetry panel
    if (state.wheelLoads)
      state.wheelLoads.forEach((l, i) => { if (loadEls[i]) loadEls[i].textContent = Math.round(l) + ' N'; });
    if (state.slipAngles)
      state.slipAngles.forEach((a, i) => {
        const el = slipEls[i]; if (!el) return;
        const pct = Math.min(100, Math.abs(a) / PEAK_SLIP * 100);
        el.style.width = pct + '%';
        el.classList.toggle('over', Math.abs(a) > PEAK_SLIP * 0.75);
      });
  });

  engine.runRenderLoop(() => scene.render());
  window.addEventListener('resize', () => engine.resize());

  // ── Settings panel ────────────────────────────────────────
  const panel = document.getElementById('settings-panel');
  document.getElementById('settings-btn')
    .addEventListener('click', () => panel.classList.toggle('open'));
  document.getElementById('sp-close')
    .addEventListener('click', () => panel.classList.remove('open'));

  // ── Tooltip data ──────────────────────────────────────────
  const TIPS = {
    'mass':         { name: 'TOTAL MASS', desc: 'How heavy the car feels. Lower mass = snappier acceleration and rotation, easier to throw into corners. Too light and it gets twitchy over bumps and loses stability mid-slide.', def: 'KATANA 780 kg · BRUISER 1380 kg · SPEC R 1050 kg' },
    'bias':         { name: 'FRONT BIAS %', desc: 'Where the car\'s weight sits. Lower % shifts mass rearward — car rotates more freely, lifts the front under braking, and oversteers earlier. Higher % gives more front grip and stability but kills rotation.', def: 'KATANA 43% · BRUISER 51% · SPEC R 40%' },
    'pac-b':        { name: 'STIFFNESS (B)', desc: 'How sharply the tire reaches its grip peak. High B = narrow slip window, snaps to grip fast then breaks away suddenly. Low B = progressive, forgiving build-up. Affects how telegraphed the limit feels.', def: 'All cars: 8' },
    'pac-c':        { name: 'SHAPE (C)', desc: 'Controls the overall shape of the grip curve. Higher values make the peak rounder and the falloff more gradual. Lower values sharpen the transition from grip to slip — more on/off feel at the limit.', def: 'All cars: 1.6' },
    'pac-d':        { name: 'PEAK GRIP (D)', desc: 'The maximum lateral force multiplier. This is the single biggest grip dial. Raise it for more overall cornering force — raises the floor of all tire behaviour. Lower it to make the car slide more easily.', def: 'All cars: 2.0' },
    'pac-e':        { name: 'CURVATURE (E)', desc: 'Shapes the plateau around the peak. Values above 1 widen it — the tire stays near peak grip across a broader slip range, more forgiving. Below 1 narrows the plateau — smaller margin before the car snaps loose.', def: 'All cars: 0.75' },
    'spring':       { name: 'SPRING RATE', desc: 'Suspension stiffness. Stiffer = sharper weight transfer response, better at high speed, harsher over bumps. Softer = more body roll, weight transfers slowly which can help initiation but hurts stability mid-corner.', def: 'KATANA 38 000 · BRUISER 40 000 · SPEC R 30 000' },
    'damper':       { name: 'DAMPER', desc: 'Controls how fast the suspension compresses and rebounds. Too low and the car bounces — weight sloshes around unpredictably. Too high and the chassis feels rigid, tires skip over imperfections.', def: 'KATANA 4200 · BRUISER 4200 · SPEC R 2400' },
    'eng':          { name: 'ENGINE FORCE', desc: 'Raw drive force at the wheel. Higher = harder acceleration and more power oversteer on exit. Too much and you spin the driven wheels constantly. Scales with drivetrain split so FR and FF feel it differently.', def: 'KATANA 5000 · BRUISER 13 500 · SPEC R 6200' },
    'brkf':         { name: 'BRAKE FORCE', desc: 'Deceleration force applied to all four wheels under normal braking. Higher = shorter stopping distances, more weight pitch forward under braking which can rotate the car. Pair with brake bias for balance.', def: 'KATANA 10 000 · BRUISER 14 000 · SPEC R 9000' },
    'finaldrive':   { name: 'FINAL DRIVE', desc: 'Multiplies all gear ratios. Higher = more torque multiplication, stronger acceleration, lower top speed. Lower = longer gearing, less aggressive pull out of corners but higher terminal velocity.', def: 'KATANA 3.9 · BRUISER 3.5 · SPEC R 4.1' },
    'fgrip':        { name: 'TIRE COMPOUND FRONT', desc: 'Front axle grip multiplier. Lower = front washes out first (understeer), car ploughs in corners. Higher = strong front bite, easier turn-in, can cause snap oversteer if rear compound is much lower.', def: 'All cars: 1.0' },
    'rgrip':        { name: 'TIRE COMPOUND REAR', desc: 'Rear axle grip multiplier. The main drift dial. Lower values make the rear break away earlier and slide more freely. Higher values plant the rear — harder to initiate but more stable mid-drift.', def: 'KATANA 0.5 · BRUISER 1.0 · SPEC R 0.42' },
    'angdamp':      { name: 'ANGULAR DAMPING', desc: 'Rotational drag on the chassis. Higher = spins slow down faster, car self-corrects quicker, easier to catch slides. Lower = rotation persists longer, more committed spins, harder to countersteer out of.', def: 'Tunable — not per-car default' },
    'lindamp':      { name: 'LINEAR DAMPING', desc: 'Global velocity drag — a light speed bleed applied constantly. Very small values. Mainly used to stop the car rolling forever on flat surfaces. Raising it too much makes everything feel like driving through mud.', def: 'Tunable — not per-car default' },
    'sret':         { name: 'STEER RETURN', desc: 'How fast the wheel self-centres. High = steering snaps back quickly, helps catch slides automatically. Low = wheel stays wherever you leave it, more manual control required, better for held drifts.', def: 'KATANA 2.6 · BRUISER 3.8 · SPEC R 2.4' },
    'sspd':         { name: 'STEER INPUT SPD', desc: 'How fast the wheel responds to input. High = instant, twitchy steering — small inputs cause big reactions. Low = slow rack, you have to anticipate corners well ahead. Also affects how controllable countersteer is.', def: 'KATANA 3.2 · BRUISER 2.6 · SPEC R 2.8' },
    'smax':         { name: 'STEER MAX (rad)', desc: 'Full lock steering angle in radians. More lock = tighter minimum turning radius and more aggressive rotation on entry. Too much and the car swings violently. Less lock = stable at speed, harder to tighten lines.', def: 'KATANA 0.48 · BRUISER 0.38 · SPEC R 0.52' },
    'dthresh':      { name: 'SLIP ANGLE THRESHOLD', desc: 'The minimum slip angle before the drift overlay triggers. Does not affect physics — only the visual/audio drift detection. Lower = drift state triggers on very mild slides. Higher = only full committed slides count.', def: 'KATANA 0.10 · BRUISER 0.25 · SPEC R 0.10' },
    'latscale':     { name: 'WEIGHT TRANSFER SCALE', desc: 'How aggressively lateral load shifts between wheels during cornering. Higher = inner wheels unload faster, outer wheels load up harder — exaggerates grip differential across an axle. Affects mid-corner balance significantly.', def: 'KATANA 0.45 · BRUISER 0.40 · SPEC R 0.58' },
    'cgheight':     { name: 'CG HEIGHT', desc: 'Centre of gravity height. Higher CG = more dramatic weight transfer in all directions, stronger body roll effect, easier to destabilise. Lower CG = flatter, more planted feel, harder to rotate.', def: 'KATANA 0.55 m · BRUISER 0.45 m · SPEC R 0.52 m' },
    'hbforce':      { name: 'HANDBRAKE FORCE', desc: 'How hard the rear wheels lock when you pull the handbrake. More force = rear locks faster and more completely, sharper rotation on entry. Too much and the car pivots violently and is hard to control.', def: 'KATANA 22 000 · BRUISER 12 000 · SPEC R 20 000' },
    'hbmuk':        { name: 'LOCKED WHEEL μk', desc: 'Kinetic friction of a fully locked wheel. Lower = locked wheels slide more freely — rear drifts further, harder to stop spinning. Higher = locked wheels scrub speed quickly, shorter sharper rotation.', def: 'KATANA 0.92 · BRUISER 0.82 · SPEC R 0.95' },
    'avcap':        { name: 'MAX YAW RATE', desc: 'Caps how fast the chassis can rotate. Lower = spins are slower and more manageable, easier to catch. Higher = very fast rotation, realistic snap oversteer, hard to countersteer in time. Main stability dial.', def: 'All cars: 10 (uncapped in profiles)' },
    'drag':         { name: 'DRAG COEFF', desc: 'Aerodynamic resistance. Higher drag = lower top speed, car decelerates faster when you lift. Lower drag = longer straights, but the car keeps momentum through corners which can hurt braking zones.', def: 'KATANA 0.40 · BRUISER 0.55 · SPEC R 0.44' },
    'df':           { name: 'DOWNFORCE COEFF', desc: 'Aerodynamic downforce generated at speed. Adds virtual weight to all four tires above the onset speed. Raises the grip ceiling at high speed — makes fast corners feel planted. No effect at low speed.', def: 'KATANA 0.18 · BRUISER 0.48 · SPEC R 0.18' },
    'dfmin':        { name: 'DF ONSET KMH', desc: 'Speed at which downforce starts ramping in. Below this speed downforce is zero. Above it, grip increases with speed. Set high to keep low-speed handling raw and only stabilise at circuit speeds.', def: 'KATANA 50 · BRUISER 70 · SPEC R 50' },
    'attessa-max':  { name: 'MAX FRONT SPLIT', desc: 'The ceiling on how much torque ATTESSA can send to the front axle when rear slip is detected. 50% = equal split at max engagement. Lower keeps the car more rear-biased even under AWD correction.', def: 'BRUISER 50%' },
    'attessa-thr':  { name: 'ATTESSA SLIP THRESHOLD', desc: 'How much rear slip is required before torque transfer begins. Lower = AWD kicks in earlier, more traction, harder to drift. Higher = car stays RWD longer, slides more freely before ATTESSA intervenes.', def: 'BRUISER 0.05' },
    'attessa-resp': { name: 'ATTESSA RESPONSE SPEED', desc: 'How fast torque transfers to the front axle once slip is detected. High = instant AWD correction, very stable. Low = slow ramp, the rear slides noticeably before being caught — more drama, less safety net.', def: 'BRUISER 0.12' },
  };

  // ── Tooltip hover wiring ──────────────────────────────────
  const ttEl    = document.getElementById('sp-tooltip');
  const ttName  = document.getElementById('sp-tt-name');
  const ttDesc  = document.getElementById('sp-tt-desc');
  const ttDef   = document.getElementById('sp-tt-def');

  document.querySelectorAll('.sp-label[data-tip]').forEach(el => {
    el.addEventListener('mouseenter', e => {
      const tip = TIPS[el.dataset.tip];
      if (!tip || !ttEl) return;
      ttName.textContent = tip.name;
      ttDesc.textContent = tip.desc;
      ttDef.textContent  = 'DEFAULT · ' + tip.def;
      ttEl.classList.add('vis');
      _positionTip(e);
    });
    el.addEventListener('mousemove', _positionTip);
    el.addEventListener('mouseleave', () => ttEl && ttEl.classList.remove('vis'));
  });

  function _positionTip(e) {
    if (!ttEl) return;
    const gap = 14;
    const tw = ttEl.offsetWidth;
    const th = ttEl.offsetHeight;
    let x = e.clientX + gap;
    let y = e.clientY + gap;
    if (x + tw > window.innerWidth  - 8) x = e.clientX - tw - gap;
    if (y + th > window.innerHeight - 8) y = e.clientY - th - gap;
    ttEl.style.left = x + 'px';
    ttEl.style.top  = y + 'px';
  }



  function bind(id, valId, cb, fmt) {
    const sl = document.getElementById(id);
    const vl = document.getElementById(valId);
    if (!sl || !vl) return;
    sl.addEventListener('input', () => {
      const v = parseFloat(sl.value);
      vl.textContent = fmt ? fmt(v) : String(v);
      cb(v);
    });
  }

  // Original params
  bind('s-mass',   'v-mass',   v => { if (vehicle) vehicle.MASS = v; if (physBody) physBody.setMassProperties({ mass: v, inertia: new BABYLON.Vector3(1,1,1) }); }, v => Math.round(v) + ' kg');
  bind('s-bias',   'v-bias',   v => { if (vehicle) vehicle.FRONT_BIAS = v / 100; }, v => v.toFixed(0));
  bind('s-B',      'v-B',      v => { if (vehicle) vehicle.PAC_B = v; }, v => v.toFixed(1));
  bind('s-C',      'v-C',      v => { if (vehicle) vehicle.PAC_C = v; }, v => v.toFixed(2));
  bind('s-D',      'v-D',      v => { if (vehicle) vehicle.PAC_D = v; }, v => v.toFixed(2));
  bind('s-E',      'v-E',      v => { if (vehicle) vehicle.PAC_E = v; }, v => v.toFixed(2));
  bind('s-spring', 'v-spring', v => { if (vehicle) vehicle.SPRING_K = v; }, v => Math.round(v));
  bind('s-damper', 'v-damper', v => { if (vehicle) vehicle.DAMPER_C = v; }, v => Math.round(v));
  bind('s-eng',    'v-eng',    v => { if (vehicle) vehicle.ENG_F = v; }, v => Math.round(v));
  bind('s-brkf',   'v-brkf',  v => { if (vehicle) vehicle.BRK_F = v; }, v => Math.round(v));
  bind('s-finaldrive', 'v-finaldrive', v => { if (vehicle) vehicle.finalDrive = v; }, v => v.toFixed(2));
  bind('s-fgrip',  'v-fgrip',  v => { if (vehicle) vehicle.TIRE_COMPOUND_FRONT = v; }, v => v.toFixed(2));
  bind('s-rgrip',  'v-rgrip',  v => { if (vehicle) vehicle.TIRE_COMPOUND_REAR = v; }, v => v.toFixed(2));
  // Dynamics
  bind('s-angdamp', 'v-angdamp', v => { if (physBody) physBody.setAngularDamping(v); }, v => v.toFixed(2));
  bind('s-lindamp', 'v-lindamp', v => { if (physBody) physBody.setLinearDamping(v);  }, v => v.toFixed(3));
  bind('s-sret',    'v-sret',    v => { if (vehicle) vehicle.STEER_RET = v; }, v => v.toFixed(1));
  bind('s-sspd',    'v-sspd',    v => { if (vehicle) vehicle.STEER_SPD = v; }, v => v.toFixed(1));
  bind('s-smax',    'v-smax',    v => { if (vehicle) vehicle.STEER_MAX = v; }, v => v.toFixed(2));
  bind('s-dthresh', 'v-dthresh', v => { if (vehicle) vehicle.SLIP_ANGLE_THRESHOLD = v; }, v => v.toFixed(2));
  bind('s-latscale','v-latscale',v => { if (vehicle) vehicle.WEIGHT_TRANSFER_SCALE = v; }, v => v.toFixed(2));
  bind('s-cgheight','v-cgheight',v => { if (vehicle) vehicle.CG_HEIGHT = v; }, v => v.toFixed(2));
  bind('s-hbforce', 'v-hbforce', v => { if (vehicle) vehicle.HBRK_F = v; }, v => Math.round(v));
  bind('s-hbmuk',   'v-hbmuk',   v => { if (vehicle) vehicle.HANDBRAKE_MU_K = v; }, v => v.toFixed(2));
  bind('s-avcap',   'v-avcap',   v => { if (vehicle) vehicle.MAX_YAW_RATE = v; }, v => v.toFixed(1));
  bind('s-brakebias','v-brakebias', v => { if (vehicle) vehicle.BRAKE_BIAS = v; }, v => Math.round(v * 100) + '%');
  bind('s-antiroll', 'v-antiroll',  v => { if (vehicle) vehicle.ANTI_ROLL  = v; }, v => v.toFixed(2));
  bind('s-drag',    'v-drag',    v => { if (vehicle) vehicle.AERO_DRAG = v; }, v => v.toFixed(2));
  bind('s-df',      'v-df',      v => { if (vehicle) vehicle.DOWNFORCE_COEFF = v; }, v => v.toFixed(2));
  bind('s-dfmin',   'v-dfmin',   v => { if (vehicle) vehicle.DOWNFORCE_MIN_KMH = v; }, v => Math.round(v));
  // Camera
  bind('s-fov',      'v-fov',      v => { camera.fov = v * Math.PI / 180; }, v => Math.round(v) + '°');
  bind('s-camdist',  'v-camdist',  v => { camDistBase   = v; }, v => v.toFixed(1));
  bind('s-camheight','v-camheight',v => { camHeightBase = v; }, v => v.toFixed(1));
  // ATTESSA
  bind('s-attessa-max',  'v-attessa-max',  v => { if (vehicle) vehicle.ATTESSA_MAX_FRONT = v; }, v => Math.round(v * 100) + '%');
  bind('s-attessa-thr',  'v-attessa-thr',  v => { if (vehicle) vehicle.ATTESSA_SLIP_THRESHOLD = v; }, v => v.toFixed(2));
  bind('s-attessa-resp', 'v-attessa-resp', v => { if (vehicle) vehicle.ATTESSA_RESPONSE = v; }, v => v.toFixed(2));
  // Force full AWD toggle
  const attessaLockEl = document.getElementById('s-attessa-lock');
  const attessaSlidersEl = document.getElementById('attessa-sliders');
  if (attessaLockEl) {
    attessaLockEl.addEventListener('change', () => {
      if (!vehicle) return;
      vehicle.attessaForceLock = attessaLockEl.checked;
      if (attessaSlidersEl) attessaSlidersEl.style.opacity = attessaLockEl.checked ? '0.35' : '1';
    });
  }

  // Sync all sliders to current vehicle state
  function syncSettingsPanel() {
    if (!vehicle) return;
    const setSlider = (id, valId, val, fmt) => {
      const sl = document.getElementById(id);
      const vl = document.getElementById(valId);
      if (sl) sl.value = val;
      if (vl) vl.textContent = fmt ? fmt(val) : String(val);
    };
    setSlider('s-mass',    'v-mass',    vehicle.MASS,             v => Math.round(v) + ' kg');
    setSlider('s-bias',    'v-bias',    vehicle.FRONT_BIAS * 100, v => Math.round(v));
    setSlider('s-B',       'v-B',       vehicle.PAC_B,            v => v.toFixed(1));
    setSlider('s-C',       'v-C',       vehicle.PAC_C,            v => v.toFixed(2));
    setSlider('s-D',       'v-D',       vehicle.PAC_D,            v => v.toFixed(2));
    setSlider('s-E',       'v-E',       vehicle.PAC_E,            v => v.toFixed(2));
    setSlider('s-spring',  'v-spring',  vehicle.SPRING_K,         v => Math.round(v));
    setSlider('s-damper',  'v-damper',  vehicle.DAMPER_C,         v => Math.round(v));
    setSlider('s-eng',     'v-eng',     vehicle.ENG_F,            v => Math.round(v));
    setSlider('s-brkf',    'v-brkf',    vehicle.BRK_F,            v => Math.round(v));
    setSlider('s-finaldrive','v-finaldrive', vehicle.finalDrive ?? 3.9, v => v.toFixed(2));
    setSlider('s-fgrip',   'v-fgrip',   vehicle.TIRE_COMPOUND_FRONT,      v => v.toFixed(2));
    setSlider('s-rgrip',   'v-rgrip',   vehicle.TIRE_COMPOUND_REAR,       v => v.toFixed(2));
    // Reset force AWD toggle on car change
    const lockEl = document.getElementById('s-attessa-lock');
    if (lockEl) { lockEl.checked = false; }
    if (vehicle) vehicle.attessaForceLock = false;
    const slidersEl = document.getElementById('attessa-sliders');
    if (slidersEl) slidersEl.style.opacity = '1';
    setSlider('s-sret',    'v-sret',    vehicle.STEER_RET,                v => v.toFixed(1));
    setSlider('s-sspd',    'v-sspd',    vehicle.STEER_SPD,                v => v.toFixed(1));
    setSlider('s-smax',    'v-smax',    vehicle.STEER_MAX,                v => v.toFixed(2));
    setSlider('s-dthresh', 'v-dthresh', vehicle.SLIP_ANGLE_THRESHOLD,     v => v.toFixed(2));
    setSlider('s-latscale','v-latscale',vehicle.WEIGHT_TRANSFER_SCALE,    v => v.toFixed(2));
    setSlider('s-cgheight','v-cgheight',vehicle.CG_HEIGHT,                v => v.toFixed(2));
    setSlider('s-hbforce', 'v-hbforce', vehicle.HBRK_F,                   v => Math.round(v));
    setSlider('s-hbmuk',   'v-hbmuk',   vehicle.HANDBRAKE_MU_K,           v => v.toFixed(2));
    setSlider('s-avcap',    'v-avcap',    vehicle.MAX_YAW_RATE,             v => v.toFixed(1));
    setSlider('s-brakebias','v-brakebias',vehicle.BRAKE_BIAS ?? 0.60,       v => Math.round(v * 100) + '%');
    setSlider('s-antiroll', 'v-antiroll', vehicle.ANTI_ROLL  ?? 1.0,        v => v.toFixed(2));
    setSlider('s-drag',    'v-drag',    vehicle.AERO_DRAG,                v => v.toFixed(2));
    setSlider('s-df',      'v-df',      vehicle.DOWNFORCE_COEFF,          v => v.toFixed(2));
    setSlider('s-dfmin',   'v-dfmin',   vehicle.DOWNFORCE_MIN_KMH,        v => Math.round(v));
    // Show/hide ATTESSA section
    const attessaSection = document.getElementById('attessa-section');
    if (attessaSection)
      attessaSection.style.display = vehicle.drivetrain === 'AWD' ? 'block' : 'none';
  }

  // ── Copy params button ────────────────────────────────────
  document.getElementById('copy-params-btn').addEventListener('click', () => {
    if (!vehicle) return;
    const p = {
      car: vehicle.currentProfileId,
      // Mass & distribution
      MASS:         vehicle.MASS,
      FRONT_BIAS:   vehicle.FRONT_BIAS,
      CG_HEIGHT:    vehicle.CG_HEIGHT,
      // Pacejka
      PAC_B: vehicle.PAC_B,
      PAC_C: vehicle.PAC_C,
      PAC_D: vehicle.PAC_D,
      PAC_E: vehicle.PAC_E,
      // Suspension
      SPRING_K:  vehicle.SPRING_K,
      DAMPER_C:  vehicle.DAMPER_C,
      // Engine / brakes
      ENG_F:  vehicle.ENG_F,
      BRK_F:  vehicle.BRK_F,
      HBRK_F: vehicle.HBRK_F,
      // Steering
      STEER_MAX: vehicle.STEER_MAX,
      STEER_SPD: vehicle.STEER_SPD,
      STEER_RET: vehicle.STEER_RET,
      // Tire compound
      TIRE_COMPOUND_FRONT: vehicle.TIRE_COMPOUND_FRONT,
      TIRE_COMPOUND_REAR:  vehicle.TIRE_COMPOUND_REAR,
      HANDBRAKE_MU_K:      vehicle.HANDBRAKE_MU_K,
      // Aero
      AERO_DRAG:             vehicle.AERO_DRAG,
      DOWNFORCE_COEFF:       vehicle.DOWNFORCE_COEFF,
      DOWNFORCE_MIN_KMH:     vehicle.DOWNFORCE_MIN_KMH,
      WEIGHT_TRANSFER_SCALE: vehicle.WEIGHT_TRANSFER_SCALE,
      // Slip / yaw
      SLIP_ANGLE_THRESHOLD: vehicle.SLIP_ANGLE_THRESHOLD,
      MAX_YAW_RATE:         vehicle.MAX_YAW_RATE,
    };
    // Add ATTESSA params if AWD
    if (vehicle.drivetrain === 'AWD') {
      p.ATTESSA_MAX_FRONT      = vehicle.ATTESSA_MAX_FRONT;
      p.ATTESSA_SLIP_THRESHOLD = vehicle.ATTESSA_SLIP_THRESHOLD;
      p.ATTESSA_RESPONSE       = vehicle.ATTESSA_RESPONSE;
    }
    const text = JSON.stringify(p, null, 2);
    navigator.clipboard.writeText(text).then(() => {
      const confirm = document.getElementById('copy-confirm');
      confirm.style.opacity = '1';
      setTimeout(() => confirm.style.opacity = '0', 2000);
    });
  });


  // ── Controls modal ────────────────────────────────────────
  const controlsModal = document.getElementById('controls-modal');
  const gpStatusEl    = document.getElementById('gp-status');
  const kbBindingsEl  = document.getElementById('kb-bindings');
  const gpBindingsEl  = document.getElementById('gp-bindings');
  const dzSlider      = document.getElementById('dz-slider');
  const dzVal         = document.getElementById('dz-val');

  const ACTION_LABELS = {
    throttle: 'THROTTLE', brake: 'BRAKE',
    left: 'STEER LEFT', right: 'STEER RIGHT',
    handbrake: 'HANDBRAKE', reset: 'RESET / RESPAWN',
  };
  const GP_ACTION_LABELS = {
    steer: 'STEER (AXIS)', throttle: 'THROTTLE',
    brake: 'BRAKE', handbrake: 'HANDBRAKE', reset: 'RESET',
  };

  function openControlsModal() {
    renderKbBindings();
    renderGpBindings();
    updateGpStatus();
    dzSlider.value  = inputManager.deadzone;
    dzVal.textContent = inputManager.deadzone.toFixed(2);
    controlsModal.classList.add('open');
  }

  function closeControlsModal() {
    inputManager.cancelRebind();
    controlsModal.classList.remove('open');
    // Clear any waiting state from rows
    document.querySelectorAll('.bind-row.waiting, .bind-key.waiting')
      .forEach(el => el.classList.remove('waiting'));
  }

  document.getElementById('controls-btn').addEventListener('click', openControlsModal);
  document.getElementById('ctrl-close').addEventListener('click', closeControlsModal);
  document.getElementById('ctrl-done-btn').addEventListener('click', closeControlsModal);
  controlsModal.addEventListener('click', e => { if (e.target === controlsModal) closeControlsModal(); });

  // ESC cancels active rebind or closes modal
  window.addEventListener('keydown', e => {
    if (e.code === 'Escape') {
      if (inputManager._rebinding) {
        inputManager.cancelRebind();
        document.querySelectorAll('.bind-row.waiting, .bind-key.waiting')
          .forEach(el => el.classList.remove('waiting'));
      } else if (controlsModal.classList.contains('open')) {
        closeControlsModal();
      }
    }
  });

  // ── Render keyboard binding rows ──────────────────────────
  function renderKbBindings() {
    kbBindingsEl.innerHTML = '';
    Object.entries(ACTION_LABELS).forEach(([action, label]) => {
      const codes = inputManager.keyBindings[action] || [];
      const row   = document.createElement('div');
      row.className   = 'bind-row';
      row.dataset.action = action;

      const actionSpan = document.createElement('span');
      actionSpan.className   = 'bind-action';
      actionSpan.textContent = label;
      row.appendChild(actionSpan);

      const keysDiv = document.createElement('div');
      keysDiv.className = 'bind-keys';

      // Primary binding (clickable to rebind)
      const primary = document.createElement('span');
      primary.className   = 'bind-key';
      primary.textContent = InputManager.codeLabel(codes[0] || '—');
      primary.title       = 'Click to rebind';
      primary.addEventListener('click', () => startKbRebind(action, primary, row));
      keysDiv.appendChild(primary);

      // Secondary binding (read-only display)
      if (codes[1]) {
        const sep = document.createElement('span');
        sep.className   = 'bind-sep';
        sep.textContent = '/';
        keysDiv.appendChild(sep);

        const secondary = document.createElement('span');
        secondary.className   = 'bind-key';
        secondary.textContent = InputManager.codeLabel(codes[1]);
        secondary.style.opacity = '0.45';
        secondary.style.cursor  = 'default';
        secondary.title = 'Default fallback — rebind primary to change';
        keysDiv.appendChild(secondary);
      }

      row.appendChild(keysDiv);
      kbBindingsEl.appendChild(row);
    });
  }

  function startKbRebind(action, keyEl, row) {
    // Clear any previous waiting state
    document.querySelectorAll('.bind-row.waiting, .bind-key.waiting')
      .forEach(el => el.classList.remove('waiting'));

    keyEl.textContent = '...';
    keyEl.classList.add('waiting');
    row.classList.add('waiting');

    inputManager.startRebind(action, 'key', (newCode) => {
      keyEl.textContent = InputManager.codeLabel(newCode);
      keyEl.classList.remove('waiting');
      row.classList.remove('waiting');
    });
  }

  // ── Render gamepad binding rows ───────────────────────────
  function renderGpBindings() {
    gpBindingsEl.innerHTML = '';
    Object.entries(GP_ACTION_LABELS).forEach(([action, label]) => {
      const bind = inputManager.gamepadBindings[action];
      if (!bind) return;

      const row = document.createElement('div');
      row.className      = 'bind-row';
      row.dataset.action = action;

      const actionSpan = document.createElement('span');
      actionSpan.className   = 'bind-action';
      actionSpan.textContent = label;
      row.appendChild(actionSpan);

      const keysDiv = document.createElement('div');
      keysDiv.className = 'bind-keys';

      const btn = document.createElement('span');
      btn.className = 'bind-key';

      if (action === 'steer') {
        btn.textContent = 'L.STICK X';
        btn.style.opacity = '0.45';
        btn.style.cursor  = 'default';
        btn.title = 'Axis — not rebindable via this menu';
      } else {
        btn.textContent = InputManager.buttonLabel(bind.index);
        btn.title = 'Click to rebind';
        btn.addEventListener('click', () => startGpRebind(action, btn, row));
      }

      keysDiv.appendChild(btn);
      row.appendChild(keysDiv);
      gpBindingsEl.appendChild(row);
    });
  }

  function startGpRebind(action, btnEl, row) {
    document.querySelectorAll('.bind-row.waiting, .bind-key.waiting')
      .forEach(el => el.classList.remove('waiting'));

    btnEl.textContent = 'PRESS BTN';
    btnEl.classList.add('waiting');
    row.classList.add('waiting');

    inputManager.startRebind(action, 'gamepad', (newIndex) => {
      btnEl.textContent = InputManager.buttonLabel(newIndex);
      btnEl.classList.remove('waiting');
      row.classList.remove('waiting');
      renderGpBindings(); // re-render to reflect new binding
    });
  }

  // ── Gamepad status ────────────────────────────────────────
  function updateGpStatus() {
    const name = inputManager.connectedGamepadName;
    if (name) {
      gpStatusEl.className   = 'connected';
      // Trim overly long browser gamepad IDs
      gpStatusEl.textContent = '● ' + (name.length > 48 ? name.slice(0, 48) + '…' : name);
    } else {
      gpStatusEl.className   = 'disconnected';
      gpStatusEl.textContent = 'NO CONTROLLER DETECTED';
    }
  }

  window.addEventListener('inputmanager:gamepad', e => {
    updateGpStatus();
    if (e.detail.status === 'connected') renderGpBindings();
  });

  // ── Reset to defaults ─────────────────────────────────────
  document.getElementById('ctrl-reset-btn').addEventListener('click', () => {
    inputManager.resetToDefaults();
    dzSlider.value    = inputManager.deadzone;
    dzVal.textContent = inputManager.deadzone.toFixed(2);
    renderKbBindings();
    renderGpBindings();
  });

  // ── Deadzone slider ───────────────────────────────────────
  dzSlider.addEventListener('input', () => {
    const v = parseFloat(dzSlider.value);
    inputManager.deadzone = v;
    dzVal.textContent     = v.toFixed(2);
    inputManager._saveBindings();
  });

  // ── Car select screen ─────────────────────────────────────
  // Generate car cards from CAR_PROFILES so stat bars are always
  // in sync with the physics values — previously they were hardcoded
  // in HTML and would silently drift out of sync if profiles changed.
  const CAR_DESCS = {
    katana: 'Twitchy and fast to rotate. Snap oversteer on entry, unforgiving if you ignore the countersteer window. High risk, high reward.',
    bruiser: 'Heavy, planted, powerful. ATTESSA torque transfer fights your drift. Commit hard to break it loose — when it slides it stays stable.',
    specr: "Shouldn't drift. Does. Throttle pushes to understeer — use the handbrake and weight transfer. Scandinavian flick is your entry. Rewarding to master.",
  };
  const carGrid = document.querySelector('.car-grid');
  if (carGrid) {
    carGrid.innerHTML = '';
    Object.values(CAR_PROFILES).forEach(p => {
      const card = document.createElement('div');
      card.className = 'car-card';
      card.dataset.car = p.id;
      card.style.setProperty('--car-color', p.colorHex);
      const statRows = Object.entries(p.stats).map(([k, v]) =>
        `<div class="stat-row">
           <span class="stat-name">${k}</span>
           <div class="stat-track">
             <div class="stat-fill" style="width:${v}%;background:${p.colorHex}"></div>
           </div>
         </div>`
      ).join('');
      card.innerHTML =
        `<div class="car-name" style="color:${p.colorHex}">${p.name}</div>
         <div class="car-sub">${p.subtitle}</div>
         <div class="car-dt-badge" style="color:${p.colorHex}">${p.drivetrain} · ${p.subtitle}</div>
         <div class="car-desc">${CAR_DESCS[p.id] || ''}</div>
         ${statRows}`;
      carGrid.appendChild(card);
    });
  }

  let chosenCar = 'katana';

  document.querySelectorAll('.car-card').forEach(card => {
    card.addEventListener('click', () => {
      document.querySelectorAll('.car-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      chosenCar = card.dataset.car;
    });
  });

  // Car → Map transition
  document.getElementById('start-btn').addEventListener('click', () => {
    const carSelectEl = document.getElementById('car-select');
    if (carSelectEl) {
      carSelectEl.style.opacity = '0';
      setTimeout(() => {
        carSelectEl.style.display = 'none';
        // Show map select
        const mapSelectEl = document.getElementById('map-select');
        if (mapSelectEl) {
          mapSelectEl.style.display = 'flex';
          requestAnimationFrame(() => mapSelectEl.style.opacity = '1');
        }
      }, 400);
    }
  });

  // Pre-select first car card
  const firstCard = document.querySelector('.car-card');
  if (firstCard) { firstCard.classList.add('selected'); chosenCar = firstCard.dataset.car; }

  // ── Map select screen ──────────────────────────────────────
  let chosenMap      = 'figure8';
  let customTrackURL = null;
  let wantChicanes   = false;

  // ── Import track button ─────────────────────────────────
  // ── Import track modal ──────────────────────────────────
  const importTrackBtn   = document.getElementById('import-track-btn');
  const importTrackName  = document.getElementById('import-track-name');
  const glbModal         = document.getElementById('glb-modal');
  const glbClose         = document.getElementById('glb-close');
  const glbDrop          = document.getElementById('glb-drop');
  const glbDropName      = document.getElementById('glb-drop-name');
  const glbBrowseBtn     = document.getElementById('glb-browse-btn');
  const importTrackInput = document.getElementById('import-track-input');

  function openGlbModal() {
    if (glbModal) glbModal.classList.add('open');
  }
  function closeGlbModal() {
    if (glbModal) glbModal.classList.remove('open');
  }
  function applyTrackFile(file) {
    if (!file || !file.name.toLowerCase().endsWith('.glb')) return;
    if (customTrackURL) URL.revokeObjectURL(customTrackURL);
    customTrackURL = URL.createObjectURL(file);
    chosenMap = 'custom';
    document.querySelectorAll('.map-card').forEach(c => c.classList.remove('selected'));
    importTrackBtn.classList.add('loaded');
    importTrackName.textContent  = file.name.toUpperCase();
    if (glbDropName) glbDropName.textContent = file.name.toUpperCase();
    closeGlbModal();
  }

  if (importTrackBtn) importTrackBtn.addEventListener('click', openGlbModal);
  if (glbClose)       glbClose.addEventListener('click', closeGlbModal);
  if (glbModal)       glbModal.addEventListener('click', e => { if (e.target === glbModal) closeGlbModal(); });

  if (glbBrowseBtn)   glbBrowseBtn.addEventListener('click', e => { e.stopPropagation(); importTrackInput && importTrackInput.click(); });
  if (glbDrop) {
    glbDrop.addEventListener('click', () => importTrackInput && importTrackInput.click());
    glbDrop.addEventListener('dragover',  e => { e.preventDefault(); glbDrop.classList.add('dragover'); });
    glbDrop.addEventListener('dragleave', () => glbDrop.classList.remove('dragover'));
    glbDrop.addEventListener('drop', e => {
      e.preventDefault();
      glbDrop.classList.remove('dragover');
      const file = e.dataTransfer.files[0];
      applyTrackFile(file);
    });
  }
  if (importTrackInput) {
    importTrackInput.addEventListener('change', () => applyTrackFile(importTrackInput.files[0]));
  }

  document.querySelectorAll('.map-card').forEach(card => {
    card.addEventListener('click', () => {
      document.querySelectorAll('.map-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      chosenMap = card.dataset.map;
    });
  });

  // Pre-select first map card
  const firstMapCard = document.querySelector('.map-card');
  if (firstMapCard) { firstMapCard.classList.add('selected'); chosenMap = firstMapCard.dataset.map; }

  // Chicane toggle
  const chicaneToggle = document.getElementById('chicane-toggle');
  if (chicaneToggle) chicaneToggle.addEventListener('change', () => {
    wantChicanes = chicaneToggle.checked;
  });

  document.getElementById('map-start-btn').addEventListener('click', async () => {
    const mapSelectEl = document.getElementById('map-select');
    if (mapSelectEl) {
      mapSelectEl.style.opacity = '0';
      setTimeout(() => mapSelectEl.style.display = 'none', 400);
    }

    setStatus('LOADING TRACK...'); setBar(80);

    // Build the track, then spawn car once physics are ready.
    track = await buildTrack(scene, chosenMap, customTrackURL, (resolvedTrack) => {
      track = resolvedTrack;
      if (wantChicanes) buildChicanes(scene, chosenMap);
      spawnCar(chosenCar);
      // Give the vehicle the surface grip map so wheels know what they're on
      if (vehicle && track.surfaces) vehicle.trackSurfaces = track.surfaces;
      nextCpIdx = 0;
      allCpHit  = false;
      lapHistory = [];
      lap = 1;
      lapStart = -1;
      refreshCpHighlight();
      updateBestHUD();
      setStatus('READY'); setBar(100);
    });
  });

  // ── Finish loading — hide splash and show car select ─────
  setStatus('SELECT YOUR CAR'); setBar(100);
  setTimeout(() => {
    const el = document.getElementById('loading');
    if (el) { el.style.opacity = '0'; setTimeout(() => el.style.display = 'none', 700); }
  }, 400);

})();