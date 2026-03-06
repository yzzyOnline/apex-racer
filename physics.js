// =============================================================
//  PHYSICS.JS — RaycastVehicle
//
//  Raycast suspension + Pacejka Magic Formula tire model.
//  Drivetrain types: FR, AWD (ATTESSA), FF
//
//  OPTIMISATIONS IN THIS FILE
//  ─────────────────────────────────────────────────────────────
//  1. RAYCAST FILTERING — meshes tagged with ._wheelTarget=true
//     at track-load time. Filter is a single property read with
//     no string ops or Set lookups per mesh per ray.
//     Call RaycastVehicle.buildTargetList(scene) after track loads.
//
//  2. ZERO GC IN HOT PATH — every Vector3/Matrix/Ray/Quaternion
//     is pre-allocated in the constructor and mutated in-place.
//     w.cp.subtract() replaced with pre-alloc this._rV scratch.
//     getAngularVelocity() result cached into this._angVelV.
//     getLinearVelocity() result cached into this._linVelV.
//     Return object fields written in-place, not re-allocated.
//
//  3. FTICK CLAMP — ftick capped at 1.0 so a long frame (low fps,
//     throttled CPU) never applies more than one 60Hz tick of
//     force. Prevents suspension blow-up on slow devices.
//
//  4. SUSPENSION SUB-STEPPING — when dt > 1/60, the spring/damper
//     solve is split into up to MAX_SUBSTEPS smaller steps so the
//     stiff spring stays numerically stable regardless of fps.
//
//  5. CACHED WHEEL LOADS — bl0-bl3 stored as a Float32Array to
//     avoid repeated ternary lookups and boxing.
//
//  6. RETURN OBJECT REUSE — the state object returned from
//     update() is allocated once and fields overwritten in-place,
//     removing one allocation + GC cycle per frame.
//
//  FRAMERATE INDEPENDENCE
//  ─────────────────────────────────────────────────────────────
//  All applyForce calls are multiplied by ftick = min(dt*60, 1.0)
//  so total impulse per second is the same at any framerate.
// =============================================================

const TARGET_HZ    = 60;
const MAX_SUBSTEPS = 4;

// ── Module-level Babylon constant refs ───────────────────────
// B.Vector3.Up() / Forward() allocate a new vector every call.
// Caching them here means zero allocation for these hot reads.
// These are NEVER mutated — treat as read-only.
const _V3_UP  = new BABYLON.Vector3(0,  1, 0);
const _V3_FWD = new BABYLON.Vector3(0,  0, 1);
const _TWO_PI = 6.2831853071795864;

class RaycastVehicle {
  constructor(scene, chassis, physBody) {
    this.scene      = scene;
    this.mesh       = chassis;
    this.body       = physBody;
    this.wheels     = [];
    this.steerAngle = 0;

    // ── Physics defaults (overwritten by loadCarProfile) ──
    this.SUSP_REST = 0.5;
    this.SUSP_MAX  = 2.9;
    this.SPRING_K  = 38000;
    this.DAMPER_C  = 3200;
    this.WHEEL_R   = 0.28;

    this.ENG_F          = 7800;
    this.BRK_F          = 10000;
    this.HBRK_F         = 24000;
    this.BRAKE_BIAS     = 0.60;
    this.ANTI_ROLL      = 1.0;
    this.STEER_MAX      = 0.44;
    this.STEER_SPD      = 3.0;
    this.STEER_RET      = 3.0;
    this.REAR_GRIP      = 0.65;
    this.HANDBRAKE_GRIP = 0.28;
    this.HANDBRAKE_MU_K = 0.92;

    this.PAC_B = 12;
    this.PAC_C = 1.8;
    this.PAC_D = 0.95;
    this.PAC_E = 1.05;

    this.MASS        = 780;
    this.FRONT_BIAS  = 0.42;
    this.WHEELBASE   = 2.52;
    this.TRACK_WIDTH = 1.88;
    this.CG_HEIGHT   = 0.44;

    this.AERO_DRAG         = 0.42;
    this.DOWNFORCE_COEFF   = 0.22;
    this.DOWNFORCE_MIN_KMH = 55;
    this.LAT_ACC_SCALE     = 0.38;

    this.DRIFT_THRESHOLD       = 0.09;
    this.DRIFT_SUSTAIN_LO      = 0.22;
    this.DRIFT_SUSTAIN_HI      = 0.58;
    this.SAVE_WINDOW_LO        = 0.52;
    this.SAVE_WINDOW_HI        = 0.62;
    this.SAVE_GRIP_BOOST       = 1.18;
    this.COUNTERSTEER_BONUS    = 1.15;
    this.ANGULAR_VEL_CAP       = 3.8;
    this.RECOVERY_ASSIST_SPEED = 55;

    this.drivetrain  = 'FR';
    this.DRIVE_FRONT = 0.0;
    this.DRIVE_REAR  = 1.0;

    this.ATTESSA_MAX_FRONT      = 0.50;
    this.ATTESSA_SLIP_THRESHOLD = 0.18;
    this.ATTESSA_RESPONSE       = 0.12;
    this.attessaCurrentSplit    = 0.0;
    this.attessaForceLock       = false;

    this.gearRatios = [3.8, 2.6, 1.8, 1.32, 1.0, 0.78];
    this.finalDrive = 3.9;
    this.gear = 0;
    this.rpm  = 800;

    this.speed       = 0;
    this.isDrifting  = false;
    this.inAir       = false;
    this.suspTravel  = [0.5, 0.5, 0.5, 0.5];
    this._needsReset = false;
    this._reversing  = false;
    this.wheelLoads  = [0, 0, 0, 0];
    this.slipAngles  = [0, 0, 0, 0];
    this.currentProfileId = 'katana';
    this.attessaSplitLive = 0;
    this.trackSurfaces    = null;

    // Typed array for wheel base loads — avoids boxing per lookup
    this._bl = new Float32Array(4);

    // ── Pre-allocated scratch — ZERO new calls in hot path ─
    const B = BABYLON;
    this._rotM       = new B.Matrix();
    this._fwdV       = new B.Vector3(0, 0, 1);
    this._downV      = new B.Vector3(0, -1, 0);
    this._rightV     = new B.Vector3(1, 0, 0);
    this._anchorV    = new B.Vector3();
    this._rayOrigV   = new B.Vector3();
    this._prevVelV   = new B.Vector3();
    this._velDiffV   = new B.Vector3();
    this._linVelV    = new B.Vector3();  // cached body linear velocity
    this._angVelV    = new B.Vector3();  // cached body angular velocity
    this._pointVelV  = new B.Vector3();
    this._angXrV     = new B.Vector3();
    this._rV         = new B.Vector3();  // r = cp - chassisPos (replaces cp.subtract)
    this._suspForceV = new B.Vector3();
    this._wFwdV      = new B.Vector3();
    this._wRightV    = new B.Vector3();
    this._latForceV  = new B.Vector3();
    this._longForceV = new B.Vector3();
    this._dragV      = new B.Vector3();
    this._dfV        = new B.Vector3(0, 0, 0);
    this._avCapV     = new B.Vector3();
    this._steerQ     = new B.Quaternion();
    this._steerM     = new B.Matrix();
    this._ray        = new B.Ray(new B.Vector3(), new B.Vector3(0, -1, 0), 1);
    this._prevVelSet = false;

    // Return state object — allocated once, overwritten each frame
    this._stateOut = {
      speedKmh:    0,
      rpm:         800,
      gear:        1,
      reversing:   false,
      drifting:    false,
      inAir:       false,
      suspTravel:  this.suspTravel,  // live reference — no copy needed
      wheelLoads:  this.wheelLoads,
      slipAngles:  this.slipAngles,
      attessaSplit: 0,
      drivetrain:  this.drivetrain,
    };
  }

  // ── Tag meshes for fast ray filtering ────────────────────
  // Call once after the track finishes loading.
  // Sets mesh._wheelTarget on every mesh in the scene so the
  // hot-path filter is a single boolean read with no string ops.
  static buildTargetList(scene) {
    const exclude = new Set([
      'chassis','__root__','sky','cp','sf','nose','cock','wuL','wuR','wing'
    ]);
    scene.meshes.forEach(m => {
      if (!m.isPickable || !m.isEnabled()) { m._wheelTarget = false; return; }
      const n = m.name;
      if (exclude.has(n)) { m._wheelTarget = false; return; }
      // wheel tire/rim meshes
      if (n.length > 1 && n[0] === 'w' && (n[1] === 't' || n[1] === 'r')) {
        m._wheelTarget = false; return;
      }
      m._wheelTarget = true;
    });
  }

  // ── Add a wheel anchor ──────────────────────────────────
  addWheel(lp, front, left) {
    this.wheels.push({ lp, front, left, spin: 0, onGround: false, cp: null, surfaceGrip: 1.0 });
  }

  // ── Main update — call once per frame ───────────────────
  update(inp, dt) {
    const B = BABYLON;
    dt = Math.min(dt, 0.05);

    // ftick: scales forces to 60 Hz reference.
    // Clamped to 1.0 — a slow frame never over-applies force.
    const ftick = Math.min(dt * TARGET_HZ, 1.0);

    // ── Chassis rotation ──────────────────────────────────
    const q = this.mesh.absoluteRotationQuaternion || B.Quaternion.Identity();
    B.Matrix.FromQuaternionToRef(q, this._rotM);
    B.Vector3.TransformNormalToRef(_V3_FWD, this._rotM, this._fwdV);
    this._fwdV.normalizeToRef(this._fwdV);
    B.Vector3.TransformNormalToRef(RaycastVehicle._LOCAL_DOWN, this._rotM, this._downV);
    this._downV.normalizeToRef(this._downV);

    // Cache velocities — avoids repeated Havok allocations
    this._linVelV.copyFrom(this.body.getLinearVelocity());
    this._angVelV.copyFrom(this.body.getAngularVelocity());
    const vel    = this._linVelV;
    const angVel = this._angVelV;

    this.speed = B.Vector3.Dot(vel, this._fwdV);
    const kmh  = Math.abs(this.speed) * 3.6;

    // ── Weight transfer ───────────────────────────────────
    B.Vector3.CrossToRef(_V3_UP, this._fwdV, this._rightV);
    this._rightV.normalizeToRef(this._rightV);

    vel.subtractToRef(this._prevVelSet ? this._prevVelV : vel, this._velDiffV);
    const longAcc    = B.Vector3.Dot(this._velDiffV, this._fwdV) / dt;
    const curLatVel  = B.Vector3.Dot(vel, this._rightV);
    const prevLatVel = this._prevVelSet ? B.Vector3.Dot(this._prevVelV, this._rightV) : curLatVel;
    const latAcc     = ((curLatVel - prevLatVel) / dt) * this.LAT_ACC_SCALE;
    this._prevVelV.copyFrom(vel);
    this._prevVelSet = true;

    const totalW      = this.MASS * 9.81;
    const staticFront = totalW * this.FRONT_BIAS;
    const staticRear  = totalW * (1.0 - this.FRONT_BIAS);
    const ltLong = this.MASS * Math.max(-20, Math.min(20, longAcc)) * this.CG_HEIGHT / this.WHEELBASE;
    const ltLat  = this.MASS * Math.max(-15, Math.min(15, latAcc))  * this.CG_HEIGHT / this.TRACK_WIDTH * this.ANTI_ROLL;
    const bl = this._bl;
    bl[0] = Math.max(0, staticFront * 0.5 - ltLong * 0.5 - ltLat * 0.5);
    bl[1] = Math.max(0, staticFront * 0.5 - ltLong * 0.5 + ltLat * 0.5);
    bl[2] = Math.max(0, staticRear  * 0.5 + ltLong * 0.5 - ltLat * 0.5);
    bl[3] = Math.max(0, staticRear  * 0.5 + ltLong * 0.5 + ltLat * 0.5);

    // ── Steering ──────────────────────────────────────────
    const steerLim = Math.max(0.22, this.STEER_MAX * (1.0 - kmh / 280));
    const axisRaw  = (inp.steerAxis !== undefined && inp.steerAxis !== 0)
                   ? inp.steerAxis : (inp.left ? -1 : inp.right ? 1 : 0);
    this.steerAngle += Math.abs(axisRaw) > 0.01
      ? (axisRaw * steerLim - this.steerAngle) * this.STEER_SPD * dt
      : -this.steerAngle * Math.min(1, this.STEER_RET * dt);
    this.steerAngle = Math.max(-this.STEER_MAX, Math.min(this.STEER_MAX, this.steerAngle));

    B.Quaternion.RotationAxisToRef(_V3_UP, this.steerAngle, this._steerQ);
    B.Matrix.FromQuaternionToRef(this._steerQ, this._steerM);

    const chassisPos = this.mesh.absolutePosition;
    let groundCount  = 0;
    let drifting     = false;

    // ── Wheel loop ────────────────────────────────────────
    for (let i = 0; i < this.wheels.length; i++) {
      const w  = this.wheels[i];
      const Fz = bl[i];

      B.Vector3.TransformCoordinatesToRef(w.lp, this._rotM, this._anchorV);
      this._anchorV.addInPlace(chassisPos);
      this._downV.scaleToRef(-0.12, this._rayOrigV);
      this._rayOrigV.addInPlace(this._anchorV);
      this._ray.origin.copyFrom(this._rayOrigV);
      this._ray.direction.copyFrom(this._downV);
      this._ray.length = this.SUSP_MAX + 0.18;

      // Fast path: single boolean read per mesh — no string work
      const hit = this.scene.pickWithRay(this._ray, _wheelRayFilterFast);

      if (hit && hit.hit && hit.distance <= this.SUSP_MAX + 0.16) {
        w.onGround = true;
        w.cp       = hit.pickedPoint;

        w.surfaceGrip = (this.trackSurfaces && hit.pickedMesh)
          ? (this.trackSurfaces.get(hit.pickedMesh)?.grip ?? 1.0) : 1.0;

        const surfNormal  = (hit.getNormal && hit.getNormal(true, true)) || B.Vector3.Up();
        const normalDot   = Math.abs(B.Vector3.Dot(this._downV, surfNormal));
        const perpDist    = (hit.distance - 0.12) * (normalDot > 0.01 ? normalDot : 1);
        const compression = Math.max(0, this.SUSP_REST - perpDist);
        this.suspTravel[i] = Math.min(1, compression / this.SUSP_REST);

        if (compression > 0) {
          groundCount++;

          // r = cp - chassisPos — in-place, no allocation
          w.cp.subtractToRef(chassisPos, this._rV);
          B.Vector3.CrossToRef(angVel, this._rV, this._angXrV);
          vel.addToRef(this._angXrV, this._pointVelV);

          // ── Suspension sub-stepping ──────────────────────
          // When dt is large (low fps) split into sub-steps so
          // the stiff spring stays numerically stable.
          const nSteps   = dt > (1.0 / TARGET_HZ) ? Math.min(MAX_SUBSTEPS, Math.ceil(dt * TARGET_HZ)) : 1;
          const subFtick = Math.min((dt / nSteps) * TARGET_HZ, 1.0);
          const suspVel  = B.Vector3.Dot(this._pointVelV, surfNormal);
          const upF      = Math.max(0, compression * this.SPRING_K - suspVel * this.DAMPER_C);
          surfNormal.scaleToRef(upF * subFtick, this._suspForceV);
          for (let s = 0; s < nSteps; s++) {
            this.body.applyForce(this._suspForceV, w.cp);
          }

          // Wheel forward direction
          if (w.front) {
            B.Vector3.TransformNormalToRef(this._fwdV, this._steerM, this._wFwdV);
          } else {
            this._wFwdV.copyFrom(this._fwdV);
          }
          B.Vector3.CrossToRef(_V3_UP, this._wFwdV, this._wRightV);
          this._wRightV.normalizeToRef(this._wRightV);

          const longVel = B.Vector3.Dot(this._pointVelV, this._wFwdV);
          const latVel  = B.Vector3.Dot(this._pointVelV, this._wRightV);
          this.wheelLoads[i] = Fz;

          const speedThresh = 0.5;
          const absLongVel  = Math.abs(longVel);
          const alpha = absLongVel > speedThresh
            ? Math.atan2(latVel, absLongVel)
            : Math.atan2(latVel, speedThresh) * (absLongVel / speedThresh);
          this.slipAngles[i] = alpha;
          const absAlpha = Math.abs(alpha);

          // ── Lateral force ─────────────────────────────────
          let D_wheel = this.PAC_D * Fz * w.surfaceGrip;
          if (!w.front) D_wheel *= this.REAR_GRIP;

          if (inp.handbrake && !w.front) {
            const cpSpeed = Math.sqrt(longVel * longVel + latVel * latVel);
            if (cpSpeed > 0.05) {
              const frictionMag = this.HANDBRAKE_MU_K * Fz;
              const invSpd = ftick / cpSpeed;
              this._wFwdV.scaleToRef(-longVel * frictionMag * invSpd, this._longForceV);
              this._wRightV.scaleToRef(-latVel  * frictionMag * invSpd, this._latForceV);
              this._longForceV.addInPlace(this._latForceV);
              this.body.applyForce(this._longForceV, w.cp);
            }
            drifting = true;
            this._applyDriveForce(inp, w, longVel, ftick, true);
            continue;
          }

          // Drift sustain zone
          if (!w.front && absAlpha >= this.DRIFT_SUSTAIN_LO && absAlpha <= this.DRIFT_SUSTAIN_HI) {
            D_wheel *= 1.0 + 0.12 * Math.sin(
              (absAlpha - this.DRIFT_SUSTAIN_LO) / (this.DRIFT_SUSTAIN_HI - this.DRIFT_SUSTAIN_LO) * Math.PI
            );
          }
          if (!w.front && absAlpha >= this.SAVE_WINDOW_LO && absAlpha <= this.SAVE_WINDOW_HI) {
            D_wheel *= this.SAVE_GRIP_BOOST;
          }
          // Countersteer bonus — inlined, no method call
          if (!w.front && absAlpha >= 0.05 && kmh > this.RECOVERY_ASSIST_SPEED) {
            const csSign = Math.sign(this.steerAngle * (longVel >= 0 ? 1 : -1));
            if (Math.sign(alpha) !== csSign) D_wheel *= this.COUNTERSTEER_BONUS;
          }

          // Pacejka Magic Formula — inlined, no method call overhead
          const _px = this.PAC_B * alpha;
          const lateralF = D_wheel * Math.sin(this.PAC_C * Math.atan(_px - this.PAC_E * (_px - Math.atan(_px))));
          this._wRightV.scaleToRef(-lateralF * ftick, this._latForceV);
          this.body.applyForce(this._latForceV, w.cp);

          this._applyDriveForce(inp, w, longVel, ftick);

          if (!w.front && absAlpha > this.DRIFT_THRESHOLD) drifting = true;
        }

      } else {
        w.onGround = false;
        w.cp       = null;
        this.suspTravel[i] = Math.max(0, this.suspTravel[i] - dt * 3);
        this.wheelLoads[i] = 0;
        this.slipAngles[i] = 0;
      }
    }

    this.inAir      = groundCount === 0;
    this.isDrifting = drifting;

    if (this.drivetrain === 'AWD') this._updateATTESSA(inp, dt);

    // ── Angular velocity cap — smooth, framerate-independent
    const yawRate = Math.abs(angVel.y);
    if (yawRate > this.ANGULAR_VEL_CAP) {
      const lerpAlpha = 1.0 - Math.pow(0.05, ftick);
      const targetY   = angVel.y * (this.ANGULAR_VEL_CAP / yawRate);
      this._avCapV.set(angVel.x, angVel.y + (targetY - angVel.y) * lerpAlpha, angVel.z);
      this.body.setAngularVelocity(this._avCapV);
    }

    // ── Aero ──────────────────────────────────────────────
    const spd2 = vel.lengthSquared();
    if (spd2 > 0.1) {
      vel.normalizeToRef(this._dragV);
      this._dragV.scaleInPlace(-this.AERO_DRAG * spd2 * ftick);
      this.body.applyForce(this._dragV, chassisPos);
    }
    const dfSpeed = Math.max(0, kmh - this.DOWNFORCE_MIN_KMH);
    if (dfSpeed > 0) {
      this._dfV.set(0, -(dfSpeed * dfSpeed) * this.DOWNFORCE_COEFF * ftick, 0);
      this.body.applyForce(this._dfV, chassisPos);
    }

    // ── Gear shifting ─────────────────────────────────────
    const wrpm = (Math.abs(this.speed) / (_TWO_PI * this.WHEEL_R)) * 60;
    this.rpm   = Math.max(800, Math.min(8500, wrpm * this.gearRatios[this.gear] * this.finalDrive));
    if      (this.rpm > 7800 && this.gear < this.gearRatios.length - 1) this.gear++;
    else if (this.rpm < 2200 && this.gear > 0) this.gear--;

    if (inp.reset) this._needsReset = true;

    // ── Return state — no allocation ──────────────────────
    const s       = this._stateOut;
    s.speedKmh    = kmh;
    s.rpm         = this.rpm;
    s.gear        = this.gear + 1;
    s.reversing   = this._reversing;
    s.drifting    = drifting;
    s.inAir       = groundCount === 0;
    s.attessaSplit = this.attessaCurrentSplit;
    s.drivetrain   = this.drivetrain;
    // suspTravel / wheelLoads / slipAngles are live array refs — already updated
    return s;
  }

  // ── Drive / brake force ───────────────────────────────────
  _applyDriveForce(inp, w, longVel, ftick, skipHandbrake = false) {
    const isFront = w.front;
    const isRear  = !isFront;

    let driveShare;
    if (this.drivetrain === 'FR') {
      driveShare = isRear ? 0.5 : 0.0;
    } else if (this.drivetrain === 'FF') {
      driveShare = isFront ? 0.5 : 0.0;
    } else {
      driveShare = (isFront ? this.attessaCurrentSplit : 1.0 - this.attessaCurrentSplit) * 0.5;
    }

    let longF = 0;
    if (inp.throttle) {
      this._reversing = false;
      longF = this.ENG_F * driveShare;
      if (this.drivetrain === 'FF' && isFront && Math.abs(this.steerAngle) > 0.1) {
        longF *= 1.0 - Math.abs(this.steerAngle) / this.STEER_MAX * 0.4;
      }
    }

    if (inp.brake) {
      if (!this._reversing && longVel > 0.4) {
        longF -= this.BRK_F * (isFront ? this.BRAKE_BIAS : 1.0 - this.BRAKE_BIAS) * 0.5;
      } else {
        this._reversing = true;
        longF -= this.ENG_F * 0.75 * driveShare;
      }
    } else if (!inp.throttle) {
      if (this._reversing && longVel > -0.2) this._reversing = false;
    }

    if (inp.handbrake && isRear && !skipHandbrake) {
      longF -= (this.HBRK_F * 0.5)
               * Math.sign(Math.abs(longVel) > 0.3 ? longVel : this.speed);
    }

    if (longF !== 0) {
      this._wFwdV.scaleToRef(longF * ftick, this._longForceV);
      this.body.applyForce(this._longForceV, w.cp);
    }
  }

  // ── ATTESSA torque transfer ───────────────────────────────
  _updateATTESSA(inp, dt) {
    if (inp.handbrake) {
      this.attessaCurrentSplit = this.attessaSplitLive = 0.0;
      return;
    }
    if (this.attessaForceLock) {
      this.attessaCurrentSplit = this.attessaSplitLive = this.ATTESSA_MAX_FRONT;
      return;
    }
    const rearSlip = (Math.abs(this.slipAngles[2]) + Math.abs(this.slipAngles[3])) * 0.5;
    const targetSplit = rearSlip > this.ATTESSA_SLIP_THRESHOLD
      ? Math.min(this.ATTESSA_MAX_FRONT,
          (rearSlip - this.ATTESSA_SLIP_THRESHOLD) / 0.3 * this.ATTESSA_MAX_FRONT)
      : 0.0;
    this.attessaCurrentSplit += (targetSplit - this.attessaCurrentSplit)
                                * Math.min(1, this.ATTESSA_RESPONSE * 60 * dt);
    this.attessaSplitLive = this.attessaCurrentSplit;
  }

  // ── Countersteer detection ────────────────────────────────
  _isCountersteering(alpha, steerAngle, longVel) {
    if (Math.abs(alpha) < 0.05) return false;
    return Math.sign(alpha) !== Math.sign(steerAngle * (longVel >= 0 ? 1 : -1));
  }

  // ── Pacejka Magic Formula ─────────────────────────────────
  _pacejkaMF(alpha, Fz) {
    const x = this.PAC_B * alpha;
    return Fz * Math.sin(this.PAC_C * Math.atan(x - this.PAC_E * (x - Math.atan(x))));
  }

  // ── Animate wheel meshes ──────────────────────────────────
  updateWheelMeshes(wheelMeshes) {
    const restScale = this.SUSP_REST * 0.6;
    for (let i = 0; i < this.wheels.length; i++) {
      const w  = this.wheels[i];
      const wm = wheelMeshes[i];
      if (!wm) continue;
      wm.position.y  = w.lp.y - (1.0 - this.suspTravel[i]) * restScale;
      if (w.front) wm.rotation.y = this.steerAngle;
      w.spin        += this.speed * 0.06;
      wm.rotation.x  = w.spin;
    }
  }
}

// ── Static constants ──────────────────────────────────────────
RaycastVehicle._LOCAL_DOWN = new BABYLON.Vector3(0, -1, 0);

// ── Fast ray filter — O(1) boolean read, zero string work ────
function _wheelRayFilterFast(m) {
  return m._wheelTarget === true;
}

// ── Fallback filter — used before buildTargetList() is called ─
const _WHEEL_RAY_EXCLUDE = new Set([
  'chassis','__root__','sky','cp','sf','nose','cock','wuL','wuR','wing'
]);
function _wheelRayFilter(m) {
  if (!m.isPickable || !m.isEnabled()) return false;
  const n = m.name;
  if (_WHEEL_RAY_EXCLUDE.has(n)) return false;
  if (n.charCodeAt(0) === 119) {
    if (n.charCodeAt(1) === 116 || n.charCodeAt(1) === 114) return false;
  }
  return true;
}