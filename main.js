// =============================================================
//  MAIN.JS — Scene setup, car select, HUD, settings, game loop
//
//  Depends on: physics.js, cars.js, track.js  (loaded first)
//  Uses BabylonJS + HavokPhysics
//
//  OPTIMISATIONS IN THIS FILE
//  ─────────────────────────────────────────────────────────────
//  1. CAMERA — all Matrix/Vector3 objects used in the chase
//     camera are pre-allocated once and mutated in-place.
//     No new B.Matrix() / new B.Vector3() inside the render loop.
//
//  2. DOM QUERIES — every getElementById ref that was being
//     called inside the render loop is cached to a const at
//     startup. Zero DOM queries during gameplay.
//
//  3. FRAMERATE-INDEPENDENT LERP — camera smoothing uses
//     1-(1-base)^(dt*60) so blend rate is identical at any fps.
//
//  4. buildTargetList — called after track loads so raycasts
//     use the fast O(1) boolean filter (see physics.js).
// =============================================================

const setStatus = s => { const e = document.getElementById('load-status'); if (e) e.textContent = s; };
const setBar    = p => { const e = document.getElementById('load-bar');    if (e) e.style.width  = p + '%'; };

(async function () {
  if (!window.BABYLON) { setStatus('ERROR: BABYLON NOT LOADED'); return; }
  const B = BABYLON;

  setStatus('LOADING HAVOK WASM...'); setBar(15);

  let HK = null;
  try {
    if (typeof window.HavokPhysics !== 'function') throw new Error('HavokPhysics not on window');
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

  let track = null;

  // ── Sky sphere ───────────────────────────────────────────
  const SKY_COL = new B.Color3(0.52, 0.76, 1.0);
  scene.clearColor = new B.Color4(SKY_COL.r, SKY_COL.g, SKY_COL.b, 1);
  const sky = B.MeshBuilder.CreateSphere('sky',
    { diameter: 1100, sideOrientation: B.Mesh.BACKSIDE, segments: 8 }, scene);
  const sm = new B.StandardMaterial('sky', scene);
  sm.emissiveColor = SKY_COL; sm.disableLighting = true; sm.backFaceCulling = false;
  sky.isPickable = false; sky.material = sm;
  // Sky is never a raycast target
  sky._wheelTarget = false;

  setStatus('SPAWNING CAR...'); setBar(78);

  // ── Car materials ─────────────────────────────────────────
  function makeCarMats(profile) {
    const [r, g, b] = profile.color3;
    const uid = profile.id + '_' + Date.now();
    const mBody = new B.StandardMaterial('body_' + uid, scene);
    mBody.diffuseColor = new B.Color3(r, g, b); mBody.specularPower = 80;
    const mBlue = new B.StandardMaterial('blue_' + uid, scene);
    mBlue.diffuseColor = new B.Color3(0.04, 0.38, 1);
    const mTire = new B.StandardMaterial('tire_' + uid, scene);
    mTire.diffuseColor = new B.Color3(0.1, 0.1, 0.1);
    const mRim = new B.StandardMaterial('rim_' + uid, scene);
    mRim.diffuseColor = new B.Color3(0.9, 0.85, 0.08); mRim.specularPower = 128;
    return { mBody, mBlue, mTire, mRim };
  }

  // ── Build chassis mesh ────────────────────────────────────
  function buildChassisMesh(profile, mats) {
    const chassis = B.MeshBuilder.CreateBox('chassis',
      { width: 1.85, height: 0.36, depth: 4.0 }, scene);
    chassis.position           = track.startPos.clone();
    chassis.rotationQuaternion = track.startRot.clone();
    chassis.material           = mats.mBody;
    // Tag chassis parts as non-raycast targets immediately
    chassis._wheelTarget = false;
    const mk = (n, w, h, d, mat, px, py, pz) => {
      const m = B.MeshBuilder.CreateBox(n, { width: w, height: h, depth: d }, scene);
      m.parent = chassis; m.position.set(px, py, pz); m.material = mat;
      m._wheelTarget = false;
      return m;
    };
    mk('nose', 1.3,  0.22, 1.0,  mats.mBody, 0,     -0.02,  2.45);
    mk('cock', 0.92, 0.42, 1.3,  mats.mBlue, 0,      0.36,  0.10);
    mk('wuL',  0.09, 0.50, 0.07, mats.mBody, -0.60,  0.40, -1.72);
    mk('wuR',  0.09, 0.50, 0.07, mats.mBody,  0.60,  0.40, -1.72);
    mk('wing', 1.62, 0.08, 0.42, mats.mBlue, 0,      0.60, -1.72);
    return chassis;
  }

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
      t.parent = chassis; t.position.set(w.x, w.y, w.z);
      t.rotation.z = Math.PI / 2; t.material = mTire;
      t._wheelTarget = false;
      const r = B.MeshBuilder.CreateCylinder('wr' + i,
        { diameter: 0.34, height: 0.31, tessellation: 12 }, scene);
      r.parent = t; r.material = mRim;
      r._wheelTarget = false;
      return t;
    });
  }

  let physBody    = null;
  let physAgg     = null;
  let vehicle     = null;
  let wheelMeshes = [];
  let chassisMesh = null;
  let carMats     = null;
  const hasPhysics = scene.getPhysicsEngine() !== null;

  // ── Respawn ───────────────────────────────────────────────
  function doRespawn() {
    if (!physBody || !track) return;
    lapStart  = -1; allCpHit = false; nextCpIdx = 0;
    refreshCpHighlight();
    physBody.disablePreStep = false;
    physBody.setLinearVelocity(B.Vector3.Zero());
    physBody.setAngularVelocity(B.Vector3.Zero());
    chassisMesh.position.copyFrom(track.startPos);
    chassisMesh.rotationQuaternion.copyFrom(track.startRot);
    if (vehicle) {
      vehicle.gear = 0; vehicle.rpm = 800;
      vehicle.steerAngle = 0; vehicle._reversing = false;
    }
    let ticks = 0;
    const obs = scene.onAfterPhysicsObservable.add(() => {
      if (++ticks >= 2) {
        physBody.disablePreStep = true;
        scene.onAfterPhysicsObservable.remove(obs);
      }
    });
  }

  // ── Spawn car ─────────────────────────────────────────────
  function spawnCar(profileId) {
    if (physAgg)     { physAgg.dispose(); physAgg = null; physBody = null; }
    if (chassisMesh) { chassisMesh.getChildMeshes().forEach(m => m.dispose()); chassisMesh.dispose(); chassisMesh = null; }
    if (carMats)     { Object.values(carMats).forEach(m => m?.dispose?.()); carMats = null; }

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
      physAgg = agg; physBody = agg.body; vehicle.body = physBody;
      wDefs.forEach(w => vehicle.addWheel(new B.Vector3(w.x, w.y, w.z), w.front, w.left));
    }

    const nameEl = document.getElementById('car-name');
    if (nameEl) { nameEl.textContent = profile.name; nameEl.style.color = profile.colorHex; }
    const dtEl = document.getElementById('car-dt');
    if (dtEl) dtEl.textContent = profile.subtitle;
    syncSettingsPanel();
    doRespawn();
  }

  // ── Camera ───────────────────────────────────────────────
  const camera = new B.FreeCamera('cam', new B.Vector3(0, 5, -12), scene);
  camera.minZ = 0.1; camera.maxZ = 1200;
  camera.fov  = 50 * Math.PI / 180;

  let camPos        = camera.position.clone();
  let camTgt        = B.Vector3.Zero();
  let camDriftAngle = 0;
  let camDistBase   = 5.5;
  let camHeightBase = 1.8;

  // Pre-allocated camera scratch — no new calls in render loop
  const _camRotM   = new B.Matrix();
  const _camFwdV   = new B.Vector3();
  const _camOffV   = new B.Vector3();
  const _camDesV   = new B.Vector3();
  const _camTgtV   = new B.Vector3();
  const _driftQ    = new B.Quaternion();
  const _driftM    = new B.Matrix();

  // Pre-allocated scratch for manual fallback and checkpoint math
  const _manFwdV   = new B.Vector3();
  const _manRightV = new B.Vector3();
  const _cpDeltaV  = new B.Vector3();

  // ── HUD element refs — all cached at startup ──────────────
  const hudSpeed      = document.getElementById('spd-val');
  const hudRpm        = document.getElementById('rpm-bar');
  const hudGear       = document.getElementById('gear');
  const hudTime       = document.getElementById('lap-time');
  const driftEl       = document.getElementById('drift');
  const airEl         = document.getElementById('air');
  const attessaBar    = document.getElementById('attessa-bar');
  const attessaWrap   = document.getElementById('attessa-wrap');
  const curr3El       = document.getElementById('curr-3-val');   // was queried live each frame
  const loadEls       = ['t-fl','t-fr','t-rl','t-rr'].map(id => document.getElementById(id));
  const slipEls       = ['sf-fl','sf-fr','sf-rl','sf-rr'].map(id => document.getElementById(id));
  const PEAK_SLIP     = 0.25;

  // ── Lap & checkpoint system ───────────────────────────────
  let lap = 1, lapStart = -1, nextCpIdx = 0, allCpHit = false;
  let cpCooldown = false, bestLap = Infinity, lastLap = Infinity;
  let lapHistory = [], best3Consec = Infinity;

  const fmtTime = ms => {
    if (!isFinite(ms)) return '--:--.---';
    const s = Math.floor(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2,'0')}.${String(Math.floor(ms % 1000)).padStart(3,'0')}`;
  };

  function flashBest(label, timeStr) {
    const el = document.getElementById('best-flash');
    if (!el) return;
    el.textContent = `${label}  ${timeStr}`;
    el.style.opacity = '1'; el.style.transform = 'translateY(0)';
    clearTimeout(el._flashTimer);
    el._flashTimer = setTimeout(() => {
      el.style.opacity = '0'; el.style.transform = 'translateY(-8px)';
    }, 3000);
  }

  function updateBestHUD() {
    const llEl = document.getElementById('last-lap-val');
    const blEl = document.getElementById('best-lap-val');
    const b3El = document.getElementById('best-3-val');
    if (llEl) llEl.textContent = isFinite(lastLap)     ? fmtTime(lastLap)     : '--:--.---';
    if (blEl) blEl.textContent = isFinite(bestLap)     ? fmtTime(bestLap)     : '--:--.---';
    if (b3El) b3El.textContent = isFinite(best3Consec) ? fmtTime(best3Consec) : '--:--.---';
  }

  function onLapComplete(lapMs) {
    lastLap = lapMs; lapHistory.push(lapMs); lap++;
    let newBest = false;
    if (lapMs < bestLap) { bestLap = lapMs; newBest = true; flashBest('BEST LAP', fmtTime(bestLap)); }
    if (lapHistory.length >= 3) {
      const n = lapHistory.length;
      const last3 = lapHistory[n-1] + lapHistory[n-2] + lapHistory[n-3];
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
      cp.mesh.material = i === 0
        ? (i === nextCpIdx ? track._sfMatActive : track._sfMatInactive)
        : (i === nextCpIdx ? track._cpMatActive : track._cpMatInactive);
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
      if (window.inputManager) inputManager.update();
      state = vehicle.update(
        window.inputManager ? inputManager.state
          : { throttle:false, brake:false, left:false, right:false, handbrake:false, reset:false, steerAxis:0 },
        dt
      );
      vehicle.updateWheelMeshes(wheelMeshes);
      if (vehicle._needsReset) { vehicle._needsReset = false; doRespawn(); }
    } else if (chassisMesh) {
      // Manual fallback — uses pre-allocated scratch, no new allocs
      _manFwdV.set(Math.sin(manHead), 0, Math.cos(manHead));
      _manRightV.set(Math.cos(manHead), 0, -Math.sin(manHead));
      let vF = B.Vector3.Dot(manVel, _manFwdV);
      let vL = B.Vector3.Dot(manVel, _manRightV);
      const sf = Math.max(0.3, 1 - Math.abs(vF) / 28);
      const ts = inputManager.state.left ? -0.44 * sf : inputManager.state.right ? 0.44 * sf : 0;
      manSteer += (inputManager.state.left || inputManager.state.right)
        ? (ts - manSteer) * 3.2 * dt : -manSteer * Math.min(1, 4.8 * dt);
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
      _manFwdV.scaleToRef(vF, manVel);
      _manRightV.scaleToRef(vL, _manRightV);  // reuse _manRightV as temp
      manVel.addInPlace(_manRightV);
      manVel.scaleToRef(dt, _manFwdV);  // reuse _manFwdV as temp delta
      chassisMesh.position.addInPlace(_manFwdV);
      chassisMesh.position.y = track ? track.startPos.y - 0.9 : 0;
      chassisMesh.rotation.y = manHead;
      state.speedKmh = Math.abs(vF) * 3.6;
      if (inputManager.state.reset) {
        manVel = B.Vector3.Zero();
        if (track) chassisMesh.position.copyFrom(track.startPos);
        chassisMesh.rotation.y = -Math.PI / 2; manHead = -Math.PI / 2;
      }
    }

    // ── Chase camera — all scratch pre-allocated, zero new ─
    const cp   = chassisMesh.absolutePosition;
    const rotQ = chassisMesh.absoluteRotationQuaternion
                 || B.Quaternion.RotationYawPitchRoll(chassisMesh.rotation?.y ?? 0, 0, 0);

    // Forward vector from quaternion — reuse _camRotM
    rotQ.toRotationMatrix(_camRotM);
    B.Vector3.TransformNormalToRef(B.Vector3.Forward(), _camRotM, _camFwdV);
    _camFwdV.normalizeToRef(_camFwdV);

    const avgSlip = vehicle
      ? (Math.abs(vehicle.slipAngles[2] || 0) + Math.abs(vehicle.slipAngles[3] || 0)) * 0.5 : 0;

    // Framerate-independent lerp: 1-(1-base)^(dt*60)
    const driftAlpha  = 1.0 - Math.pow(0.88, dt * 60);
    const camPosAlpha = 1.0 - Math.pow(0.88, dt * 60);
    const camTgtAlpha = 1.0 - Math.pow(0.86, dt * 60);

    camDriftAngle += (avgSlip * Math.sign(vehicle ? vehicle.steerAngle : 0) * 0.6
                      - camDriftAngle) * driftAlpha;

    const speedFactor = Math.min(1, (state.speedKmh || 0) / 180);
    const camDist     = camDistBase  + speedFactor * 1.5;
    const camHeight   = camHeightBase + speedFactor * 0.4;

    // Drift rotation — reuse _driftQ and _driftM
    B.Quaternion.RotationAxisToRef(B.Vector3.Up(), camDriftAngle, _driftQ);
    _driftQ.toRotationMatrix(_driftM);
    _camFwdV.scaleToRef(-camDist, _camOffV);
    B.Vector3.TransformNormalToRef(_camOffV, _driftM, _camOffV);

    _camDesV.set(cp.x + _camOffV.x, cp.y + camHeight, cp.z + _camOffV.z);
    _camTgtV.set(cp.x + _camFwdV.x * 6, cp.y + 0.5, cp.z + _camFwdV.z * 6);

    // Lerp in-place
    camPos.x += (_camDesV.x - camPos.x) * camPosAlpha;
    camPos.y += (_camDesV.y - camPos.y) * camPosAlpha;
    camPos.z += (_camDesV.z - camPos.z) * camPosAlpha;
    camTgt.x += (_camTgtV.x - camTgt.x) * camTgtAlpha;
    camTgt.y += (_camTgtV.y - camTgt.y) * camTgtAlpha;
    camTgt.z += (_camTgtV.z - camTgt.z) * camTgtAlpha;

    camera.position.copyFrom(camPos);
    camera.setTarget(camTgt);

    // ── Checkpoint & lap detection ────────────────────────
    if (track && track.checkpoints.length > 0) {
      const cps  = track.checkpoints;
      const carP = chassisMesh.absolutePosition;
      const sfCp = cps[0];
      const sfR  = sfCp.mesh._triggerRadius || 8;

      // Squared distance — avoids sqrt and internal Vector3 alloc
      sfCp.mesh.position.subtractToRef(carP, _cpDeltaV);
      const sfDist2 = _cpDeltaV.lengthSquared();

      if (sfDist2 < sfR * sfR && !cpCooldown) {
        cpCooldown = true;
        setTimeout(() => { cpCooldown = false; }, 800);
        if (lapStart === -1) {
          lapStart = now; nextCpIdx = cps.length > 1 ? 1 : 0;
          allCpHit = cps.length === 1; refreshCpHighlight();
        } else if (!allCpHit) {
          lapStart = now; nextCpIdx = cps.length > 1 ? 1 : 0;
          allCpHit = false; refreshCpHighlight();
        } else {
          const lapMs = now - lapStart; lapStart = now;
          allCpHit = false; nextCpIdx = cps.length > 1 ? 1 : 0;
          onLapComplete(lapMs); refreshCpHighlight();
        }
      } else if (nextCpIdx > 0 && !cpCooldown) {
        const nextCp = cps[nextCpIdx];
        const trigR  = nextCp.mesh._triggerRadius || 8;
        nextCp.mesh.position.subtractToRef(carP, _cpDeltaV);
        if (_cpDeltaV.lengthSquared() < trigR * trigR) {
          cpCooldown = true;
          setTimeout(() => { cpCooldown = false; }, 600);
          if (++nextCpIdx >= cps.length) { nextCpIdx = 0; allCpHit = true; }
          refreshCpHighlight();
        }
      }
    } else if (track && track.checkpoint && !track.checkpoints.length) {
      track.checkpoint.position.subtractToRef(chassisMesh.absolutePosition, _cpDeltaV);
      if (_cpDeltaV.lengthSquared() < 81 && !cpCooldown) {  // 81 = 9*9
        cpCooldown = true;
        setTimeout(() => { cpCooldown = false; }, 1200);
        if (lapStart !== -1) onLapComplete(now - lapStart);
        lapStart = now;
      }
    }

    // ── HUD updates ───────────────────────────────────────
    if (hudSpeed) hudSpeed.textContent = Math.round(state.speedKmh * 0.621371);
    if (hudRpm)   hudRpm.style.width   = (state.rpm / 8500 * 100) + '%';
    if (hudGear)  hudGear.textContent  = state.reversing ? 'R' : state.gear;
    if (hudTime)  hudTime.textContent  = `${lap} · ${lapStart === -1 ? '0:00.000' : fmtTime(now - lapStart)}`;

    if (curr3El) {
      if (lapStart === -1) {
        curr3El.textContent = '--:--.---';
      } else {
        // Direct index math — no slice/reduce, no array allocation
        const hn    = lapHistory.length;
        const prev2 = hn >= 2 ? lapHistory[hn-1] + lapHistory[hn-2]
                    : hn === 1 ? lapHistory[0] : 0;
        const count = Math.min(hn + 1, 3);
        const sum   = prev2 + (now - lapStart);
        curr3El.textContent = fmtTime(sum) + (count < 3 ? ` (${count}/3)` : '');
      }
    }

    if (driftEl) driftEl.style.opacity = state.drifting ? '1' : '0';
    if (airEl)   airEl.style.opacity   = state.inAir    ? '1' : '0';

    if (attessaWrap) {
      const locked = vehicle && vehicle.attessaForceLock;
      attessaWrap.style.display = (state.drivetrain === 'AWD' && !locked) ? 'block' : 'none';
      if (attessaBar) attessaBar.style.width = Math.round(state.attessaSplit * 100) + '%';
    }

    // Telemetry — direct index loop, no iterator allocation
    if (state.wheelLoads) {
      for (let i = 0; i < 4; i++) {
        if (loadEls[i]) loadEls[i].textContent = Math.round(state.wheelLoads[i]) + ' N';
      }
    }
    if (state.slipAngles) {
      for (let i = 0; i < 4; i++) {
        const el = slipEls[i]; if (!el) continue;
        const pct = Math.min(100, Math.abs(state.slipAngles[i]) / PEAK_SLIP * 100);
        el.style.width = pct + '%';
        el.classList.toggle('over', Math.abs(state.slipAngles[i]) > PEAK_SLIP * 0.75);
      }
    }
  });

  engine.runRenderLoop(() => scene.render());
  window.addEventListener('resize', () => engine.resize());

  // ── Settings panel ────────────────────────────────────────
  const panel = document.getElementById('settings-panel');
  document.getElementById('settings-btn').addEventListener('click', () => panel.classList.toggle('open'));
  document.getElementById('sp-close').addEventListener('click', () => panel.classList.remove('open'));

  // ── Tooltip data ──────────────────────────────────────────
  const TIPS = {
    'mass':         { name: 'TOTAL MASS', desc: 'How heavy the car feels. Lower mass = snappier acceleration and rotation, easier to throw into corners. Too light and it gets twitchy over bumps and loses stability mid-slide.', def: 'KATANA 780 kg · BRUISER 1380 kg · SPEC R 1050 kg' },
    'bias':         { name: 'FRONT BIAS %', desc: 'Where the car\'s weight sits. Lower % shifts mass rearward — car rotates more freely, lifts the front under braking, and oversteers earlier. Higher % gives more front grip and stability but kills rotation.', def: 'KATANA 43% · BRUISER 51% · SPEC R 40%' },
    'pac-b':        { name: 'STIFFNESS (B)', desc: 'How sharply the tire reaches its grip peak. High B = narrow slip window, snaps to grip fast then breaks away suddenly. Low B = progressive, forgiving build-up.', def: 'All cars: 8' },
    'pac-c':        { name: 'SHAPE (C)', desc: 'Controls the overall shape of the grip curve. Higher values make the peak rounder and the falloff more gradual.', def: 'All cars: 1.6' },
    'pac-d':        { name: 'PEAK GRIP (D)', desc: 'The maximum lateral force multiplier. The single biggest grip dial.', def: 'All cars: 2.0' },
    'pac-e':        { name: 'CURVATURE (E)', desc: 'Shapes the plateau around the peak. Values above 1 widen it.', def: 'All cars: 0.75' },
    'spring':       { name: 'SPRING RATE', desc: 'Suspension stiffness. Stiffer = sharper weight transfer, better at high speed.', def: 'KATANA 38 000 · BRUISER 40 000 · SPEC R 30 000' },
    'damper':       { name: 'DAMPER', desc: 'Controls how fast the suspension compresses and rebounds.', def: 'KATANA 4200 · BRUISER 4200 · SPEC R 2400' },
    'eng':          { name: 'ENGINE FORCE', desc: 'Raw drive force at the wheel.', def: 'KATANA 5000 · BRUISER 13 500 · SPEC R 6200' },
    'brkf':         { name: 'BRAKE FORCE', desc: 'Deceleration force under normal braking.', def: 'KATANA 10 000 · BRUISER 14 000 · SPEC R 9000' },
    'finaldrive':   { name: 'FINAL DRIVE', desc: 'Multiplies all gear ratios. Higher = more torque, lower top speed.', def: 'KATANA 3.9 · BRUISER 3.5 · SPEC R 4.1' },
    'fgrip':        { name: 'TIRE COMPOUND FRONT', desc: 'Front axle grip multiplier.', def: 'All cars: 1.0' },
    'rgrip':        { name: 'TIRE COMPOUND REAR', desc: 'Rear axle grip multiplier. The main drift dial.', def: 'KATANA 0.5 · BRUISER 1.0 · SPEC R 0.42' },
    'angdamp':      { name: 'ANGULAR DAMPING', desc: 'Rotational drag on the chassis.', def: 'Tunable — not per-car default' },
    'lindamp':      { name: 'LINEAR DAMPING', desc: 'Global velocity drag.', def: 'Tunable — not per-car default' },
    'sret':         { name: 'STEER RETURN', desc: 'How fast the wheel self-centres.', def: 'KATANA 2.6 · BRUISER 3.8 · SPEC R 2.4' },
    'sspd':         { name: 'STEER INPUT SPD', desc: 'How fast the wheel responds to input.', def: 'KATANA 3.2 · BRUISER 2.6 · SPEC R 2.8' },
    'smax':         { name: 'STEER MAX (rad)', desc: 'Full lock steering angle in radians.', def: 'KATANA 0.48 · BRUISER 0.38 · SPEC R 0.52' },
    'dthresh':      { name: 'SLIP ANGLE THRESHOLD', desc: 'Minimum slip angle before drift overlay triggers.', def: 'KATANA 0.10 · BRUISER 0.25 · SPEC R 0.10' },
    'latscale':     { name: 'WEIGHT TRANSFER SCALE', desc: 'How aggressively lateral load shifts between wheels.', def: 'KATANA 0.45 · BRUISER 0.40 · SPEC R 0.58' },
    'cgheight':     { name: 'CG HEIGHT', desc: 'Centre of gravity height.', def: 'KATANA 0.55 m · BRUISER 0.45 m · SPEC R 0.52 m' },
    'hbforce':      { name: 'HANDBRAKE FORCE', desc: 'How hard the rear wheels lock on handbrake.', def: 'KATANA 22 000 · BRUISER 12 000 · SPEC R 20 000' },
    'hbmuk':        { name: 'LOCKED WHEEL μk', desc: 'Kinetic friction of a fully locked wheel.', def: 'KATANA 0.92 · BRUISER 0.82 · SPEC R 0.95' },
    'avcap':        { name: 'MAX YAW RATE', desc: 'Caps how fast the chassis can rotate.', def: 'All cars: 10' },
    'drag':         { name: 'DRAG COEFF', desc: 'Aerodynamic resistance.', def: 'KATANA 0.40 · BRUISER 0.55 · SPEC R 0.44' },
    'df':           { name: 'DOWNFORCE COEFF', desc: 'Aerodynamic downforce generated at speed.', def: 'KATANA 0.18 · BRUISER 0.48 · SPEC R 0.18' },
    'dfmin':        { name: 'DF ONSET KMH', desc: 'Speed at which downforce starts ramping in.', def: 'KATANA 50 · BRUISER 70 · SPEC R 50' },
    'attessa-max':  { name: 'MAX FRONT SPLIT', desc: 'Ceiling on torque ATTESSA sends to the front axle.', def: 'BRUISER 50%' },
    'attessa-thr':  { name: 'ATTESSA SLIP THRESHOLD', desc: 'Rear slip required before torque transfer begins.', def: 'BRUISER 0.05' },
    'attessa-resp': { name: 'ATTESSA RESPONSE SPEED', desc: 'How fast torque transfers to the front axle.', def: 'BRUISER 0.12' },
  };

  const ttEl   = document.getElementById('sp-tooltip');
  const ttName = document.getElementById('sp-tt-name');
  const ttDesc = document.getElementById('sp-tt-desc');
  const ttDef  = document.getElementById('sp-tt-def');

  document.querySelectorAll('.sp-label[data-tip]').forEach(el => {
    el.addEventListener('mouseenter', e => {
      const tip = TIPS[el.dataset.tip]; if (!tip || !ttEl) return;
      ttName.textContent = tip.name; ttDesc.textContent = tip.desc;
      ttDef.textContent  = 'DEFAULT · ' + tip.def;
      ttEl.classList.add('vis'); _positionTip(e);
    });
    el.addEventListener('mousemove', _positionTip);
    el.addEventListener('mouseleave', () => ttEl && ttEl.classList.remove('vis'));
  });

  function _positionTip(e) {
    if (!ttEl) return;
    const gap = 14, tw = ttEl.offsetWidth, th = ttEl.offsetHeight;
    let x = e.clientX + gap, y = e.clientY + gap;
    if (x + tw > window.innerWidth  - 8) x = e.clientX - tw - gap;
    if (y + th > window.innerHeight - 8) y = e.clientY - th - gap;
    ttEl.style.left = x + 'px'; ttEl.style.top = y + 'px';
  }

  function bind(id, valId, cb, fmt) {
    const sl = document.getElementById(id), vl = document.getElementById(valId);
    if (!sl || !vl) return;
    sl.addEventListener('input', () => {
      const v = parseFloat(sl.value);
      vl.textContent = fmt ? fmt(v) : String(v);
      cb(v);
    });
  }

  bind('s-mass',      'v-mass',      v => { if (vehicle) vehicle.MASS = v; if (physBody) physBody.setMassProperties({ mass: v, inertia: new BABYLON.Vector3(1,1,1) }); }, v => Math.round(v) + ' kg');
  bind('s-bias',      'v-bias',      v => { if (vehicle) vehicle.FRONT_BIAS = v / 100; }, v => v.toFixed(0));
  bind('s-B',         'v-B',         v => { if (vehicle) vehicle.PAC_B = v; }, v => v.toFixed(1));
  bind('s-C',         'v-C',         v => { if (vehicle) vehicle.PAC_C = v; }, v => v.toFixed(2));
  bind('s-D',         'v-D',         v => { if (vehicle) vehicle.PAC_D = v; }, v => v.toFixed(2));
  bind('s-E',         'v-E',         v => { if (vehicle) vehicle.PAC_E = v; }, v => v.toFixed(2));
  bind('s-spring',    'v-spring',    v => { if (vehicle) vehicle.SPRING_K = v; }, v => Math.round(v));
  bind('s-damper',    'v-damper',    v => { if (vehicle) vehicle.DAMPER_C = v; }, v => Math.round(v));
  bind('s-eng',       'v-eng',       v => { if (vehicle) vehicle.ENG_F = v; }, v => Math.round(v));
  bind('s-brkf',      'v-brkf',      v => { if (vehicle) vehicle.BRK_F = v; }, v => Math.round(v));
  bind('s-finaldrive','v-finaldrive',v => { if (vehicle) vehicle.finalDrive = v; }, v => v.toFixed(2));
  bind('s-fgrip',     'v-fgrip',     v => { if (vehicle) vehicle.TIRE_COMPOUND_FRONT = v; }, v => v.toFixed(2));
  bind('s-rgrip',     'v-rgrip',     v => { if (vehicle) vehicle.TIRE_COMPOUND_REAR  = v; }, v => v.toFixed(2));
  bind('s-angdamp',   'v-angdamp',   v => { if (physBody) physBody.setAngularDamping(v); }, v => v.toFixed(2));
  bind('s-lindamp',   'v-lindamp',   v => { if (physBody) physBody.setLinearDamping(v);  }, v => v.toFixed(3));
  bind('s-sret',      'v-sret',      v => { if (vehicle) vehicle.STEER_RET = v; }, v => v.toFixed(1));
  bind('s-sspd',      'v-sspd',      v => { if (vehicle) vehicle.STEER_SPD = v; }, v => v.toFixed(1));
  bind('s-smax',      'v-smax',      v => { if (vehicle) vehicle.STEER_MAX = v; }, v => v.toFixed(2));
  bind('s-dthresh',   'v-dthresh',   v => { if (vehicle) vehicle.SLIP_ANGLE_THRESHOLD = v; }, v => v.toFixed(2));
  bind('s-latscale',  'v-latscale',  v => { if (vehicle) vehicle.WEIGHT_TRANSFER_SCALE = v; }, v => v.toFixed(2));
  bind('s-cgheight',  'v-cgheight',  v => { if (vehicle) vehicle.CG_HEIGHT = v; }, v => v.toFixed(2));
  bind('s-hbforce',   'v-hbforce',   v => { if (vehicle) vehicle.HBRK_F = v; }, v => Math.round(v));
  bind('s-hbmuk',     'v-hbmuk',     v => { if (vehicle) vehicle.HANDBRAKE_MU_K = v; }, v => v.toFixed(2));
  bind('s-avcap',     'v-avcap',     v => { if (vehicle) vehicle.MAX_YAW_RATE = v; }, v => v.toFixed(1));
  bind('s-brakebias', 'v-brakebias', v => { if (vehicle) vehicle.BRAKE_BIAS = v; }, v => Math.round(v * 100) + '%');
  bind('s-antiroll',  'v-antiroll',  v => { if (vehicle) vehicle.ANTI_ROLL  = v; }, v => v.toFixed(2));
  bind('s-drag',      'v-drag',      v => { if (vehicle) vehicle.AERO_DRAG = v; }, v => v.toFixed(2));
  bind('s-df',        'v-df',        v => { if (vehicle) vehicle.DOWNFORCE_COEFF = v; }, v => v.toFixed(2));
  bind('s-dfmin',     'v-dfmin',     v => { if (vehicle) vehicle.DOWNFORCE_MIN_KMH = v; }, v => Math.round(v));
  bind('s-fov',       'v-fov',       v => { camera.fov = v * Math.PI / 180; }, v => Math.round(v) + '°');
  bind('s-camdist',   'v-camdist',   v => { camDistBase   = v; }, v => v.toFixed(1));
  bind('s-camheight', 'v-camheight', v => { camHeightBase = v; }, v => v.toFixed(1));
  bind('s-attessa-max',  'v-attessa-max',  v => { if (vehicle) vehicle.ATTESSA_MAX_FRONT = v; }, v => Math.round(v * 100) + '%');
  bind('s-attessa-thr',  'v-attessa-thr',  v => { if (vehicle) vehicle.ATTESSA_SLIP_THRESHOLD = v; }, v => v.toFixed(2));
  bind('s-attessa-resp', 'v-attessa-resp', v => { if (vehicle) vehicle.ATTESSA_RESPONSE = v; }, v => v.toFixed(2));

  const attessaLockEl    = document.getElementById('s-attessa-lock');
  const attessaSlidersEl = document.getElementById('attessa-sliders');
  if (attessaLockEl) {
    attessaLockEl.addEventListener('change', () => {
      if (!vehicle) return;
      vehicle.attessaForceLock = attessaLockEl.checked;
      if (attessaSlidersEl) attessaSlidersEl.style.opacity = attessaLockEl.checked ? '0.35' : '1';
    });
  }

  function syncSettingsPanel() {
    if (!vehicle) return;
    const setSlider = (id, valId, val, fmt) => {
      const sl = document.getElementById(id), vl = document.getElementById(valId);
      if (sl) sl.value = val;
      if (vl) vl.textContent = fmt ? fmt(val) : String(val);
    };
    setSlider('s-mass',       'v-mass',       vehicle.MASS,             v => Math.round(v) + ' kg');
    setSlider('s-bias',       'v-bias',       vehicle.FRONT_BIAS * 100, v => Math.round(v));
    setSlider('s-B',          'v-B',          vehicle.PAC_B,            v => v.toFixed(1));
    setSlider('s-C',          'v-C',          vehicle.PAC_C,            v => v.toFixed(2));
    setSlider('s-D',          'v-D',          vehicle.PAC_D,            v => v.toFixed(2));
    setSlider('s-E',          'v-E',          vehicle.PAC_E,            v => v.toFixed(2));
    setSlider('s-spring',     'v-spring',     vehicle.SPRING_K,         v => Math.round(v));
    setSlider('s-damper',     'v-damper',     vehicle.DAMPER_C,         v => Math.round(v));
    setSlider('s-eng',        'v-eng',        vehicle.ENG_F,            v => Math.round(v));
    setSlider('s-brkf',       'v-brkf',       vehicle.BRK_F,            v => Math.round(v));
    setSlider('s-finaldrive', 'v-finaldrive', vehicle.finalDrive ?? 3.9, v => v.toFixed(2));
    setSlider('s-fgrip',      'v-fgrip',      vehicle.TIRE_COMPOUND_FRONT, v => v.toFixed(2));
    setSlider('s-rgrip',      'v-rgrip',      vehicle.TIRE_COMPOUND_REAR,  v => v.toFixed(2));
    const lockEl = document.getElementById('s-attessa-lock');
    if (lockEl) lockEl.checked = false;
    if (vehicle) vehicle.attessaForceLock = false;
    const slidersEl = document.getElementById('attessa-sliders');
    if (slidersEl) slidersEl.style.opacity = '1';
    setSlider('s-sret',       'v-sret',       vehicle.STEER_RET,                v => v.toFixed(1));
    setSlider('s-sspd',       'v-sspd',       vehicle.STEER_SPD,                v => v.toFixed(1));
    setSlider('s-smax',       'v-smax',       vehicle.STEER_MAX,                v => v.toFixed(2));
    setSlider('s-dthresh',    'v-dthresh',    vehicle.SLIP_ANGLE_THRESHOLD,     v => v.toFixed(2));
    setSlider('s-latscale',   'v-latscale',   vehicle.WEIGHT_TRANSFER_SCALE,    v => v.toFixed(2));
    setSlider('s-cgheight',   'v-cgheight',   vehicle.CG_HEIGHT,                v => v.toFixed(2));
    setSlider('s-hbforce',    'v-hbforce',    vehicle.HBRK_F,                   v => Math.round(v));
    setSlider('s-hbmuk',      'v-hbmuk',      vehicle.HANDBRAKE_MU_K,           v => v.toFixed(2));
    setSlider('s-avcap',      'v-avcap',      vehicle.MAX_YAW_RATE,             v => v.toFixed(1));
    setSlider('s-brakebias',  'v-brakebias',  vehicle.BRAKE_BIAS ?? 0.60,       v => Math.round(v * 100) + '%');
    setSlider('s-antiroll',   'v-antiroll',   vehicle.ANTI_ROLL  ?? 1.0,        v => v.toFixed(2));
    setSlider('s-drag',       'v-drag',       vehicle.AERO_DRAG,                v => v.toFixed(2));
    setSlider('s-df',         'v-df',         vehicle.DOWNFORCE_COEFF,          v => v.toFixed(2));
    setSlider('s-dfmin',      'v-dfmin',      vehicle.DOWNFORCE_MIN_KMH,        v => Math.round(v));
    const attessaSection = document.getElementById('attessa-section');
    if (attessaSection) attessaSection.style.display = vehicle.drivetrain === 'AWD' ? 'block' : 'none';
  }

  document.getElementById('copy-params-btn').addEventListener('click', () => {
    if (!vehicle) return;
    const p = {
      car: vehicle.currentProfileId, MASS: vehicle.MASS, FRONT_BIAS: vehicle.FRONT_BIAS,
      CG_HEIGHT: vehicle.CG_HEIGHT, PAC_B: vehicle.PAC_B, PAC_C: vehicle.PAC_C,
      PAC_D: vehicle.PAC_D, PAC_E: vehicle.PAC_E, SPRING_K: vehicle.SPRING_K,
      DAMPER_C: vehicle.DAMPER_C, ENG_F: vehicle.ENG_F, BRK_F: vehicle.BRK_F,
      HBRK_F: vehicle.HBRK_F, STEER_MAX: vehicle.STEER_MAX, STEER_SPD: vehicle.STEER_SPD,
      STEER_RET: vehicle.STEER_RET, TIRE_COMPOUND_FRONT: vehicle.TIRE_COMPOUND_FRONT,
      TIRE_COMPOUND_REAR: vehicle.TIRE_COMPOUND_REAR, HANDBRAKE_MU_K: vehicle.HANDBRAKE_MU_K,
      AERO_DRAG: vehicle.AERO_DRAG, DOWNFORCE_COEFF: vehicle.DOWNFORCE_COEFF,
      DOWNFORCE_MIN_KMH: vehicle.DOWNFORCE_MIN_KMH,
      WEIGHT_TRANSFER_SCALE: vehicle.WEIGHT_TRANSFER_SCALE,
      SLIP_ANGLE_THRESHOLD: vehicle.SLIP_ANGLE_THRESHOLD, MAX_YAW_RATE: vehicle.MAX_YAW_RATE,
    };
    if (vehicle.drivetrain === 'AWD') {
      p.ATTESSA_MAX_FRONT = vehicle.ATTESSA_MAX_FRONT;
      p.ATTESSA_SLIP_THRESHOLD = vehicle.ATTESSA_SLIP_THRESHOLD;
      p.ATTESSA_RESPONSE = vehicle.ATTESSA_RESPONSE;
    }
    navigator.clipboard.writeText(JSON.stringify(p, null, 2)).then(() => {
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
    renderKbBindings(); renderGpBindings(); updateGpStatus();
    dzSlider.value = inputManager.deadzone;
    dzVal.textContent = inputManager.deadzone.toFixed(2);
    controlsModal.classList.add('open');
  }
  function closeControlsModal() {
    inputManager.cancelRebind(); controlsModal.classList.remove('open');
    document.querySelectorAll('.bind-row.waiting, .bind-key.waiting').forEach(el => el.classList.remove('waiting'));
  }

  document.getElementById('controls-btn').addEventListener('click', openControlsModal);
  document.getElementById('ctrl-close').addEventListener('click', closeControlsModal);
  document.getElementById('ctrl-done-btn').addEventListener('click', closeControlsModal);
  controlsModal.addEventListener('click', e => { if (e.target === controlsModal) closeControlsModal(); });

  window.addEventListener('keydown', e => {
    if (e.code === 'Escape') {
      if (inputManager._rebinding) {
        inputManager.cancelRebind();
        document.querySelectorAll('.bind-row.waiting, .bind-key.waiting').forEach(el => el.classList.remove('waiting'));
      } else if (controlsModal.classList.contains('open')) {
        closeControlsModal();
      }
    }
  });

  function renderKbBindings() {
    kbBindingsEl.innerHTML = '';
    Object.entries(ACTION_LABELS).forEach(([action, label]) => {
      const codes = inputManager.keyBindings[action] || [];
      const row   = document.createElement('div');
      row.className = 'bind-row'; row.dataset.action = action;
      const actionSpan = document.createElement('span');
      actionSpan.className = 'bind-action'; actionSpan.textContent = label;
      row.appendChild(actionSpan);
      const keysDiv = document.createElement('div'); keysDiv.className = 'bind-keys';
      const primary = document.createElement('span');
      primary.className = 'bind-key';
      primary.textContent = InputManager.codeLabel(codes[0] || '—');
      primary.title = 'Click to rebind';
      primary.addEventListener('click', () => startKbRebind(action, primary, row));
      keysDiv.appendChild(primary);
      if (codes[1]) {
        const sep = document.createElement('span'); sep.className = 'bind-sep'; sep.textContent = '/';
        keysDiv.appendChild(sep);
        const secondary = document.createElement('span');
        secondary.className = 'bind-key'; secondary.textContent = InputManager.codeLabel(codes[1]);
        secondary.style.opacity = '0.45'; secondary.style.cursor = 'default';
        keysDiv.appendChild(secondary);
      }
      row.appendChild(keysDiv); kbBindingsEl.appendChild(row);
    });
  }

  function startKbRebind(action, keyEl, row) {
    document.querySelectorAll('.bind-row.waiting, .bind-key.waiting').forEach(el => el.classList.remove('waiting'));
    keyEl.textContent = '...'; keyEl.classList.add('waiting'); row.classList.add('waiting');
    inputManager.startRebind(action, 'key', newCode => {
      keyEl.textContent = InputManager.codeLabel(newCode);
      keyEl.classList.remove('waiting'); row.classList.remove('waiting');
    });
  }

  function renderGpBindings() {
    gpBindingsEl.innerHTML = '';
    Object.entries(GP_ACTION_LABELS).forEach(([action, label]) => {
      const bind = inputManager.gamepadBindings[action]; if (!bind) return;
      const row = document.createElement('div'); row.className = 'bind-row'; row.dataset.action = action;
      const actionSpan = document.createElement('span');
      actionSpan.className = 'bind-action'; actionSpan.textContent = label;
      row.appendChild(actionSpan);
      const keysDiv = document.createElement('div'); keysDiv.className = 'bind-keys';
      const btn = document.createElement('span'); btn.className = 'bind-key';
      if (action === 'steer') {
        btn.textContent = 'L.STICK X'; btn.style.opacity = '0.45'; btn.style.cursor = 'default';
      } else {
        btn.textContent = InputManager.buttonLabel(bind.index); btn.title = 'Click to rebind';
        btn.addEventListener('click', () => startGpRebind(action, btn, row));
      }
      keysDiv.appendChild(btn); row.appendChild(keysDiv); gpBindingsEl.appendChild(row);
    });
  }

  function startGpRebind(action, btnEl, row) {
    document.querySelectorAll('.bind-row.waiting, .bind-key.waiting').forEach(el => el.classList.remove('waiting'));
    btnEl.textContent = 'PRESS BTN'; btnEl.classList.add('waiting'); row.classList.add('waiting');
    inputManager.startRebind(action, 'gamepad', newIndex => {
      btnEl.textContent = InputManager.buttonLabel(newIndex);
      btnEl.classList.remove('waiting'); row.classList.remove('waiting');
      renderGpBindings();
    });
  }

  function updateGpStatus() {
    const name = inputManager.connectedGamepadName;
    if (name) {
      gpStatusEl.className = 'connected';
      gpStatusEl.textContent = '● ' + (name.length > 48 ? name.slice(0, 48) + '…' : name);
    } else {
      gpStatusEl.className = 'disconnected'; gpStatusEl.textContent = 'NO CONTROLLER DETECTED';
    }
  }

  window.addEventListener('inputmanager:gamepad', e => {
    updateGpStatus(); if (e.detail.status === 'connected') renderGpBindings();
  });

  document.getElementById('ctrl-reset-btn').addEventListener('click', () => {
    inputManager.resetToDefaults();
    dzSlider.value = inputManager.deadzone; dzVal.textContent = inputManager.deadzone.toFixed(2);
    renderKbBindings(); renderGpBindings();
  });

  dzSlider.addEventListener('input', () => {
    const v = parseFloat(dzSlider.value);
    inputManager.deadzone = v; dzVal.textContent = v.toFixed(2); inputManager._saveBindings();
  });

  // ── Car select screen ─────────────────────────────────────
  const CAR_DESCS = {
    katana:  'Twitchy and fast to rotate. Snap oversteer on entry, unforgiving if you ignore the countersteer window. High risk, high reward.',
    bruiser: 'Heavy, planted, powerful. ATTESSA torque transfer fights your drift. Commit hard to break it loose — when it slides it stays stable.',
    specr:   "Shouldn't drift. Does. Throttle pushes to understeer — use the handbrake and weight transfer. Scandinavian flick is your entry. Rewarding to master.",
  };
  const carGrid = document.querySelector('.car-grid');
  if (carGrid) {
    carGrid.innerHTML = '';
    Object.values(CAR_PROFILES).forEach(p => {
      const card = document.createElement('div');
      card.className = 'car-card'; card.dataset.car = p.id;
      card.style.setProperty('--car-color', p.colorHex);
      const statRows = Object.entries(p.stats).map(([k, v]) =>
        `<div class="stat-row"><span class="stat-name">${k}</span>
         <div class="stat-track"><div class="stat-fill" style="width:${v}%;background:${p.colorHex}"></div></div></div>`
      ).join('');
      card.innerHTML =
        `<div class="car-name" style="color:${p.colorHex}">${p.name}</div>
         <div class="car-sub">${p.subtitle}</div>
         <div class="car-dt-badge" style="color:${p.colorHex}">${p.drivetrain} · ${p.subtitle}</div>
         <div class="car-desc">${CAR_DESCS[p.id] || ''}</div>${statRows}`;
      carGrid.appendChild(card);
    });
  }

  let chosenCar = 'katana';
  document.querySelectorAll('.car-card').forEach(card => {
    card.addEventListener('click', () => {
      document.querySelectorAll('.car-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected'); chosenCar = card.dataset.car;
    });
  });

  document.getElementById('start-btn').addEventListener('click', () => {
    const carSelectEl = document.getElementById('car-select');
    if (carSelectEl) {
      carSelectEl.style.opacity = '0';
      setTimeout(() => {
        carSelectEl.style.display = 'none';
        const mapSelectEl = document.getElementById('map-select');
        if (mapSelectEl) { mapSelectEl.style.display = 'flex'; requestAnimationFrame(() => mapSelectEl.style.opacity = '1'); }
      }, 400);
    }
  });

  const firstCard = document.querySelector('.car-card');
  if (firstCard) { firstCard.classList.add('selected'); chosenCar = firstCard.dataset.car; }

  // ── Map select ────────────────────────────────────────────
  let chosenMap = 'figure8', customTrackURL = null, wantChicanes = false;

  const importTrackBtn   = document.getElementById('import-track-btn');
  const importTrackName  = document.getElementById('import-track-name');
  const glbModal         = document.getElementById('glb-modal');
  const glbClose         = document.getElementById('glb-close');
  const glbDrop          = document.getElementById('glb-drop');
  const glbDropName      = document.getElementById('glb-drop-name');
  const glbBrowseBtn     = document.getElementById('glb-browse-btn');
  const importTrackInput = document.getElementById('import-track-input');

  const openGlbModal  = () => glbModal?.classList.add('open');
  const closeGlbModal = () => glbModal?.classList.remove('open');

  function applyTrackFile(file) {
    if (!file || !file.name.toLowerCase().endsWith('.glb')) return;
    if (customTrackURL) URL.revokeObjectURL(customTrackURL);
    customTrackURL = URL.createObjectURL(file); chosenMap = 'custom';
    document.querySelectorAll('.map-card').forEach(c => c.classList.remove('selected'));
    importTrackBtn.classList.add('loaded');
    importTrackName.textContent = file.name.toUpperCase();
    if (glbDropName) glbDropName.textContent = file.name.toUpperCase();
    closeGlbModal();
  }

  if (importTrackBtn) importTrackBtn.addEventListener('click', openGlbModal);
  if (glbClose)       glbClose.addEventListener('click', closeGlbModal);
  if (glbModal)       glbModal.addEventListener('click', e => { if (e.target === glbModal) closeGlbModal(); });
  if (glbBrowseBtn)   glbBrowseBtn.addEventListener('click', e => { e.stopPropagation(); importTrackInput?.click(); });
  if (glbDrop) {
    glbDrop.addEventListener('click',    () => importTrackInput?.click());
    glbDrop.addEventListener('dragover', e  => { e.preventDefault(); glbDrop.classList.add('dragover'); });
    glbDrop.addEventListener('dragleave',()  => glbDrop.classList.remove('dragover'));
    glbDrop.addEventListener('drop',     e  => { e.preventDefault(); glbDrop.classList.remove('dragover'); applyTrackFile(e.dataTransfer.files[0]); });
  }
  if (importTrackInput) importTrackInput.addEventListener('change', () => applyTrackFile(importTrackInput.files[0]));

  document.querySelectorAll('.map-card').forEach(card => {
    card.addEventListener('click', () => {
      document.querySelectorAll('.map-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected'); chosenMap = card.dataset.map;
    });
  });
  const firstMapCard = document.querySelector('.map-card');
  if (firstMapCard) { firstMapCard.classList.add('selected'); chosenMap = firstMapCard.dataset.map; }

  const chicaneToggle = document.getElementById('chicane-toggle');
  if (chicaneToggle) chicaneToggle.addEventListener('change', () => { wantChicanes = chicaneToggle.checked; });

  document.getElementById('map-start-btn').addEventListener('click', async () => {
    const mapSelectEl = document.getElementById('map-select');
    if (mapSelectEl) { mapSelectEl.style.opacity = '0'; setTimeout(() => mapSelectEl.style.display = 'none', 400); }
    setStatus('LOADING TRACK...'); setBar(80);

    track = await buildTrack(scene, chosenMap, customTrackURL, (resolvedTrack) => {
      track = resolvedTrack;
      if (wantChicanes) buildChicanes(scene, chosenMap);

      // ── TAG ALL MESHES FOR FAST RAYCASTING ───────────────
      // Must run after track geometry is loaded so all surface
      // and wall meshes exist in scene.meshes.
      RaycastVehicle.buildTargetList(scene);

      spawnCar(chosenCar);
      if (vehicle && track.surfaces) vehicle.trackSurfaces = track.surfaces;
      nextCpIdx = 0; allCpHit = false; lapHistory = []; lap = 1; lapStart = -1;
      refreshCpHighlight(); updateBestHUD();
      setStatus('READY'); setBar(100);
    });
  });

  setStatus('SELECT YOUR CAR'); setBar(100);
  setTimeout(() => {
    const el = document.getElementById('loading');
    if (el) { el.style.opacity = '0'; setTimeout(() => el.style.display = 'none', 700); }
  }, 400);

})();