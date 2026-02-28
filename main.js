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

  // ── Ground plane — oval only (GLB has its own terrain) ────
  function buildGroundPlane() {
    const ground = B.MeshBuilder.CreateGround('ground',
      { width: 1000, height: 1000, subdivisions: 1 }, scene);
    const gm = new B.StandardMaterial('groundMat', scene);
    gm.diffuseColor  = new B.Color3(0.13, 0.38, 0.10);
    gm.specularColor = new B.Color3(0, 0, 0);
    ground.material   = gm;
    ground.isPickable = false;
    new B.PhysicsAggregate(ground, B.PhysicsShapeType.BOX,
      { mass: 0, friction: 0.6, restitution: 0.02 }, scene);
  }

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
  let camPos        = camera.position.clone();
  let camTgt        = B.Vector3.Zero();  // updated each frame once car exists
  let camDriftAngle = 0; // extra yaw for drift camera lean

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

  // ── Lap timer ─────────────────────────────────────────────
  let lap = 1, lapStart = performance.now(), crossedSF = false;
  const fmtTime = ms => {
    const s = Math.floor(ms / 1000);
    return `${lap} · ${Math.floor(s / 60)}:${String(s % 60).padStart(2,'0')}.${String(Math.floor(ms % 1000)).padStart(3,'0')}`;
  };

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
    const camDist     = 5.5 + speedFactor * 1.5;
    const camHeight   = 1.8 + speedFactor * 0.4;

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

    // ── Lap ──────────────────────────────────────────────
    if (track && track.checkpoint) {
      if (B.Vector3.Distance(cp, track.checkpoint.position) < 9) {
        if (!crossedSF) { crossedSF = true; lap++; lapStart = now; }
      } else { crossedSF = false; }
    }

    // ── HUD updates ──────────────────────────────────────
    if (hudSpeed) hudSpeed.textContent = Math.round(state.speedKmh * 0.621371);
    if (hudRpm)   hudRpm.style.width   = (state.rpm / 8500 * 100) + '%';
    if (hudGear)  hudGear.textContent  = state.reversing ? 'R' : state.gear;
    if (hudTime)  hudTime.textContent  = fmtTime(now - lapStart);
    if (driftEl)  driftEl.style.opacity = state.drifting ? '1' : '0';
    if (airEl)    airEl.style.opacity   = state.inAir    ? '1' : '0';

    // ATTESSA bar — only show for Bruiser
    if (attessaWrap) {
      attessaWrap.style.display = (state.drivetrain === 'AWD') ? 'block' : 'none';
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
  bind('s-drag',    'v-drag',    v => { if (vehicle) vehicle.AERO_DRAG = v; }, v => v.toFixed(2));
  bind('s-df',      'v-df',      v => { if (vehicle) vehicle.DOWNFORCE_COEFF = v; }, v => v.toFixed(2));
  bind('s-dfmin',   'v-dfmin',   v => { if (vehicle) vehicle.DOWNFORCE_MIN_KMH = v; }, v => Math.round(v));
  // ATTESSA
  bind('s-attessa-max',  'v-attessa-max',  v => { if (vehicle) vehicle.ATTESSA_MAX_FRONT = v; }, v => Math.round(v * 100) + '%');
  bind('s-attessa-thr',  'v-attessa-thr',  v => { if (vehicle) vehicle.ATTESSA_SLIP_THRESHOLD = v; }, v => v.toFixed(2));
  bind('s-attessa-resp', 'v-attessa-resp', v => { if (vehicle) vehicle.ATTESSA_RESPONSE = v; }, v => v.toFixed(2));

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
    setSlider('s-rgrip',   'v-rgrip',   vehicle.TIRE_COMPOUND_REAR,       v => v.toFixed(2));
    setSlider('s-hbgrip',  'v-hbgrip',  vehicle.TIRE_COMPOUND_FRONT,      v => v.toFixed(2));
    setSlider('s-sret',    'v-sret',    vehicle.STEER_RET,                v => v.toFixed(1));
    setSlider('s-sspd',    'v-sspd',    vehicle.STEER_SPD,                v => v.toFixed(1));
    setSlider('s-smax',    'v-smax',    vehicle.STEER_MAX,                v => v.toFixed(2));
    setSlider('s-dthresh', 'v-dthresh', vehicle.SLIP_ANGLE_THRESHOLD,     v => v.toFixed(2));
    setSlider('s-latscale','v-latscale',vehicle.WEIGHT_TRANSFER_SCALE,    v => v.toFixed(2));
    setSlider('s-cgheight','v-cgheight',vehicle.CG_HEIGHT,                v => v.toFixed(2));
    setSlider('s-hbforce', 'v-hbforce', vehicle.HBRK_F,                   v => Math.round(v));
    setSlider('s-hbmuk',   'v-hbmuk',   vehicle.HANDBRAKE_MU_K,           v => v.toFixed(2));
    setSlider('s-avcap',   'v-avcap',   vehicle.MAX_YAW_RATE,             v => v.toFixed(1));
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
  let chosenMap    = 'figure8';
  let wantChicanes = false;

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
    track = await buildTrack(scene, chosenMap, (resolvedTrack) => {
      track = resolvedTrack;
      if (chosenMap !== 'figure8') buildGroundPlane();
      if (wantChicanes) buildChicanes(scene, chosenMap);
      spawnCar(chosenCar);
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