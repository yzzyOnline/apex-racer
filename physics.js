// =============================================================
//  PHYSICS.JS — RaycastVehicle
//
//  Raycast suspension + Pacejka Magic Formula tire model.
//  Drivetrain types: FR, AWD (ATTESSA), FF
//  Drift systems: sustain zone, save window, countersteer bonus,
//                 angular velocity cap, recovery assist
//
//  Optimised: all Vector3/Matrix/Ray objects are pre-allocated
//  once in the constructor and mutated in-place each frame.
//  No per-frame `new` calls in the hot path — zero GC pressure
//  during gameplay, which was causing stutter on low-end devices.
// =============================================================

class RaycastVehicle {
  constructor(scene, chassis, physBody) {
    this.scene      = scene;
    this.mesh       = chassis;
    this.body       = physBody;
    this.wheels     = [];
    this.steerAngle = 0;

    // ── Defaults (overwritten by loadCarProfile) ──────────
    this.SUSP_REST = 0.5;
    this.SUSP_MAX  = 2.9;
    this.SPRING_K  = 38000;
    this.DAMPER_C  = 3200;
    this.WHEEL_R   = 0.28;

    this.ENG_F          = 7800;
    this.BRK_F          = 10000;
    this.HBRK_F         = 24000;
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
    this.currentProfileId  = 'katana';
    this.attessaSplitLive  = 0;
    this.trackSurfaces     = null;

    // ── Pre-allocated scratch objects ─────────────────────
    // Nothing inside update() or its callees uses `new` on
    // the hot path. Every object here is mutated in-place.
    const B = BABYLON;
    this._rotM       = new B.Matrix();           // chassis rotation matrix
    this._fwdV       = new B.Vector3(0, 0, 1);  // world forward
    this._downV      = new B.Vector3(0, -1, 0); // world down (local)
    this._rightV     = new B.Vector3(1, 0, 0);  // world right
    this._anchorV    = new B.Vector3();          // wheel anchor world pos
    this._rayOrigV   = new B.Vector3();          // ray origin
    this._prevVelV   = new B.Vector3();          // previous frame velocity
    this._velDiffV   = new B.Vector3();          // vel - prevVel
    this._pointVelV  = new B.Vector3();          // contact point velocity
    this._angXrV     = new B.Vector3();          // angVel cross r
    this._suspForceV = new B.Vector3();          // suspension force
    this._wFwdV      = new B.Vector3();          // wheel forward (steered)
    this._wRightV    = new B.Vector3();          // wheel right
    this._latForceV  = new B.Vector3();          // lateral force vector
    this._longForceV = new B.Vector3();          // longitudinal force vector
    this._dragV      = new B.Vector3();          // aero drag vector
    this._dfV        = new B.Vector3(0, 0, 0);  // downforce vector
    this._avCapV     = new B.Vector3();          // capped angular velocity
    this._steerQ     = new B.Quaternion();       // steer rotation quaternion
    this._steerM     = new B.Matrix();           // steer rotation matrix
    this._ray        = new B.Ray(new B.Vector3(), new B.Vector3(0,-1,0), 1);
    this._prevVelSet = false;                    // true once _prevVelV is valid
  }

  // ── Add a wheel anchor ──────────────────────────────────
  addWheel(lp, front, left) {
    this.wheels.push({ lp, front, left, spin: 0, onGround: false, cp: null, surfaceGrip: 1.0 });
  }

  // ── Main update — call once per frame ───────────────────
  update(inp, dt) {
    const B = BABYLON;
    dt = Math.min(dt, 0.05);

    // ── Compute chassis rotation matrix once ─────────────
    // Reused by _fwd, _down, wheel anchor transforms, steer.
    const q = this.mesh.absoluteRotationQuaternion || B.Quaternion.Identity();
    B.Matrix.FromQuaternionToRef(q, this._rotM);

    // Forward and down from cached matrix — no new Matrix() call
    B.Vector3.TransformNormalToRef(B.Vector3.Forward(), this._rotM, this._fwdV);
    this._fwdV.normalizeToRef(this._fwdV);

    B.Vector3.TransformNormalToRef(
      RaycastVehicle._LOCAL_DOWN, this._rotM, this._downV);
    this._downV.normalizeToRef(this._downV);

    const vel  = this.body.getLinearVelocity();  // Havok returns a new vec — unavoidable
    this.speed = B.Vector3.Dot(vel, this._fwdV);
    const kmh  = Math.abs(this.speed) * 3.6;

    // ── Weight transfer ───────────────────────────────────
    B.Vector3.CrossToRef(B.Vector3.Up(), this._fwdV, this._rightV);
    this._rightV.normalizeToRef(this._rightV);

    // vel - prevVel into scratch without allocating
    vel.subtractToRef(
      this._prevVelSet ? this._prevVelV : vel,
      this._velDiffV
    );
    const longAcc    = B.Vector3.Dot(this._velDiffV, this._fwdV) / dt;
    const curLatVel  = B.Vector3.Dot(vel, this._rightV);
    const prevLatVel = this._prevVelSet
      ? B.Vector3.Dot(this._prevVelV, this._rightV) : curLatVel;
    const latAcc     = ((curLatVel - prevLatVel) / dt) * this.LAT_ACC_SCALE;

    // Store prevVel in-place
    this._prevVelV.copyFrom(vel);
    this._prevVelSet = true;

    const G           = 9.81;
    const totalW      = this.MASS * G;
    const staticFront = totalW * this.FRONT_BIAS;
    const staticRear  = totalW * (1 - this.FRONT_BIAS);
    const ltLong = this.MASS * Math.max(-20, Math.min(20, longAcc))
                   * this.CG_HEIGHT / this.WHEELBASE;
    const ltLat  = this.MASS * Math.max(-15, Math.min(15, latAcc))
                   * this.CG_HEIGHT / this.TRACK_WIDTH;

    const bl0 = Math.max(0, staticFront / 2 - ltLong / 2 - ltLat / 2);
    const bl1 = Math.max(0, staticFront / 2 - ltLong / 2 + ltLat / 2);
    const bl2 = Math.max(0, staticRear  / 2 + ltLong / 2 - ltLat / 2);
    const bl3 = Math.max(0, staticRear  / 2 + ltLong / 2 + ltLat / 2);
    // Inline array avoids allocating a new array + .map every frame
    this._baseLoad0 = bl0; this._baseLoad1 = bl1;
    this._baseLoad2 = bl2; this._baseLoad3 = bl3;

    // ── Steering ──────────────────────────────────────────
    const steerLim = Math.max(0.22, this.STEER_MAX * (1 - kmh / 280));
    const axisRaw  = (inp.steerAxis !== undefined && inp.steerAxis !== 0)
                   ? inp.steerAxis
                   : (inp.left ? -1 : inp.right ? 1 : 0);
    const tgt      = axisRaw * steerLim;
    const isActive = Math.abs(axisRaw) > 0.01;
    this.steerAngle += isActive
      ? (tgt - this.steerAngle) * this.STEER_SPD * dt
      : -this.steerAngle * Math.min(1, this.STEER_RET * dt);
    this.steerAngle = Math.max(-this.STEER_MAX,
                               Math.min(this.STEER_MAX, this.steerAngle));

    // Pre-build steer quaternion + matrix once for front wheels
    B.Quaternion.RotationAxisToRef(B.Vector3.Up(), this.steerAngle, this._steerQ);
    B.Matrix.FromQuaternionToRef(this._steerQ, this._steerM);

    const chassisPos = this.mesh.absolutePosition;
    let groundCount  = 0;
    let drifting     = false;

    // ── Wheel loop ────────────────────────────────────────
    for (let i = 0; i < this.wheels.length; i++) {
      const w  = this.wheels[i];
      const Fz = i === 0 ? bl0 : i === 1 ? bl1 : i === 2 ? bl2 : bl3;

      // Wheel anchor in world space — mutate scratch in-place
      B.Vector3.TransformCoordinatesToRef(w.lp, this._rotM, this._anchorV);
      this._anchorV.addInPlace(chassisPos);

      // Ray origin: anchor offset slightly along local up
      this._downV.scaleToRef(-0.12, this._rayOrigV);
      this._rayOrigV.addInPlace(this._anchorV);

      // Mutate the pre-allocated ray
      this._ray.origin.copyFrom(this._rayOrigV);
      this._ray.direction.copyFrom(this._downV);
      this._ray.length = this.SUSP_MAX + 0.18;

      const hit = this.scene.pickWithRay(this._ray, _wheelRayFilter);

      if (hit && hit.hit && hit.distance <= this.SUSP_MAX + 0.16) {
        w.onGround = true;
        w.cp       = hit.pickedPoint;  // Babylon allocates this — unavoidable

        // Surface grip lookup
        if (this.trackSurfaces && hit.pickedMesh) {
          const def = this.trackSurfaces.get(hit.pickedMesh);
          w.surfaceGrip = def ? def.grip : 1.0;
        } else {
          w.surfaceGrip = 1.0;
        }

        const surfNormal = (hit.getNormal && hit.getNormal(true, true))
                           || B.Vector3.Up();

        const normalDot   = Math.abs(B.Vector3.Dot(this._downV, surfNormal));
        const perpDist    = (hit.distance - 0.12) * (normalDot > 0.01 ? normalDot : 1);
        const compression = Math.max(0, this.SUSP_REST - perpDist);
        this.suspTravel[i] = Math.min(1, compression / this.SUSP_REST);

        if (compression > 0) {
          groundCount++;

          const angVel = this.body.getAngularVelocity(); // unavoidable Havok alloc
          const r      = w.cp.subtract(chassisPos);      // unavoidable (cp is fresh each frame)

          // pointVel = vel + angVel × r — in scratch
          B.Vector3.CrossToRef(angVel, r, this._angXrV);
          vel.addToRef(this._angXrV, this._pointVelV);

          const suspVel = B.Vector3.Dot(this._pointVelV, surfNormal);
          const upF     = Math.max(0,
            compression * this.SPRING_K - suspVel * this.DAMPER_C);

          // Apply suspension force in-place
          surfNormal.scaleToRef(upF, this._suspForceV);
          this.body.applyForce(this._suspForceV, w.cp);

          // Wheel forward — front wheels use pre-built steer matrix
          if (w.front) {
            B.Vector3.TransformNormalToRef(this._fwdV, this._steerM, this._wFwdV);
          } else {
            this._wFwdV.copyFrom(this._fwdV);
          }

          B.Vector3.CrossToRef(B.Vector3.Up(), this._wFwdV, this._wRightV);
          this._wRightV.normalizeToRef(this._wRightV);

          const longVel = B.Vector3.Dot(this._pointVelV, this._wFwdV);
          const latVel  = B.Vector3.Dot(this._pointVelV, this._wRightV);

          this.wheelLoads[i] = Fz;

          // Slip angle
          const speedThresh = 0.5;
          let alpha = 0;
          if (Math.abs(longVel) > speedThresh) {
            alpha = Math.atan2(latVel, Math.abs(longVel));
          } else {
            alpha = Math.atan2(latVel, speedThresh)
                    * (Math.abs(longVel) / speedThresh);
          }
          this.slipAngles[i] = alpha;
          const absAlpha = Math.abs(alpha);

          // ── Lateral force ───────────────────────────────
          let D_wheel = this.PAC_D * Fz * w.surfaceGrip;
          if (!w.front) D_wheel *= this.REAR_GRIP;

          // Handbrake: kinetic friction replaces Pacejka for locked rear
          if (inp.handbrake && !w.front) {
            const cpSpeed = Math.sqrt(longVel * longVel + latVel * latVel);
            if (cpSpeed > 0.05) {
              const frictionMag = this.HANDBRAKE_MU_K * Fz;
              const fLong = -(longVel / cpSpeed) * frictionMag;
              const fLat  = -(latVel  / cpSpeed) * frictionMag;
              this._wFwdV.scaleToRef(fLong, this._longForceV);
              this._wRightV.scaleToRef(fLat, this._latForceV);
              this._longForceV.addInPlace(this._latForceV);
              this.body.applyForce(this._longForceV, w.cp);
            }
            drifting = true;
            this._applyDriveForce(inp, w, i, longVel, dt, true);
            continue;
          }

          // Sustain zone
          if (!w.front && absAlpha >= this.DRIFT_SUSTAIN_LO
                       && absAlpha <= this.DRIFT_SUSTAIN_HI) {
            const t = (absAlpha - this.DRIFT_SUSTAIN_LO)
                    / (this.DRIFT_SUSTAIN_HI - this.DRIFT_SUSTAIN_LO);
            D_wheel *= 1.0 + 0.12 * Math.sin(t * Math.PI);
          }

          // Save window
          if (!w.front && absAlpha >= this.SAVE_WINDOW_LO
                       && absAlpha <= this.SAVE_WINDOW_HI) {
            D_wheel *= this.SAVE_GRIP_BOOST;
          }

          // Countersteer bonus
          if (!w.front && this._isCountersteering(alpha, this.steerAngle, longVel)
                       && kmh > this.RECOVERY_ASSIST_SPEED) {
            D_wheel *= this.COUNTERSTEER_BONUS;
          }

          const lateralForceMag = this._pacejkaMF(alpha, D_wheel);
          this._wRightV.scaleToRef(-lateralForceMag, this._latForceV);
          this.body.applyForce(this._latForceV, w.cp);

          this._applyDriveForce(inp, w, i, longVel, dt);

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

    // ── Angular velocity cap ──────────────────────────────
    const av      = this.body.getAngularVelocity();
    const yawRate = Math.abs(av.y);
    if (yawRate > this.ANGULAR_VEL_CAP) {
      const scale = this.ANGULAR_VEL_CAP / yawRate;
      // Mutate scratch and set — avoids new Vector3
      this._avCapV.set(av.x, av.y * scale, av.z);
      this.body.setAngularVelocity(this._avCapV);
    }

    // ── Aero ──────────────────────────────────────────────
    const spd2 = vel.lengthSquared();
    if (spd2 > 0.1) {
      vel.normalizeToRef(this._dragV);
      this._dragV.scaleInPlace(-this.AERO_DRAG * spd2);
      this.body.applyForce(this._dragV, chassisPos);
    }
    const dfSpeed   = Math.max(0, kmh - this.DOWNFORCE_MIN_KMH);
    const downforce = -(dfSpeed * dfSpeed) * this.DOWNFORCE_COEFF;
    if (downforce !== 0) {
      this._dfV.set(0, downforce, 0);
      this.body.applyForce(this._dfV, chassisPos);
    }

    // ── Gear shifting ─────────────────────────────────────
    const ratio = this.gearRatios[this.gear] * this.finalDrive;
    const wrpm  = (Math.abs(this.speed) / (2 * Math.PI * this.WHEEL_R)) * 60;
    this.rpm = Math.max(800, Math.min(8500, wrpm * ratio));
    if (this.rpm > 7800 && this.gear < this.gearRatios.length - 1) this.gear++;
    else if (this.rpm < 2200 && this.gear > 0) this.gear--;

    if (inp.reset) this._needsReset = true;

    return {
      speedKmh:     kmh,
      rpm:          this.rpm,
      gear:         this.gear + 1,
      reversing:    this._reversing,
      drifting,
      inAir:        groundCount === 0,
      suspTravel:   this.suspTravel.slice(),
      wheelLoads:   this.wheelLoads.slice(),
      slipAngles:   this.slipAngles.slice(),
      attessaSplit: this.attessaCurrentSplit,
      drivetrain:   this.drivetrain,
    };
  }

  // ── Drive force ───────────────────────────────────────────
  // wFwd is now this._wFwdV — already correct for front/rear.
  _applyDriveForce(inp, w, i, longVel, dt, skipHandbrake = false) {
    const isFront = w.front;
    const isRear  = !w.front;

    let driveShare = 0;
    if (this.drivetrain === 'FR') {
      driveShare = isRear ? 0.5 : 0.0;
    } else if (this.drivetrain === 'FF') {
      driveShare = isFront ? 0.5 : 0.0;
    } else {
      // AWD — ATTESSA split, halved per wheel on each axle
      const frontShare = this.attessaCurrentSplit;
      driveShare = (isFront ? frontShare : 1.0 - frontShare) * 0.5;
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
        longF -= this.BRK_F / 4;
      } else {
        this._reversing = true;
        longF -= this.ENG_F * 0.75 * driveShare;
      }
    } else if (!inp.throttle) {
      if (this._reversing && longVel > -0.2) this._reversing = false;
    }

    if (inp.handbrake && isRear && !skipHandbrake) {
      longF -= (this.HBRK_F / 2)
               * Math.sign(Math.abs(longVel) > 0.3 ? longVel : this.speed);
    }

    if (longF !== 0) {
      this._wFwdV.scaleToRef(longF, this._longForceV);
      this.body.applyForce(this._longForceV, w.cp);
    }
  }

  // ── ATTESSA ───────────────────────────────────────────────
  _updateATTESSA(inp, dt) {
    if (inp.handbrake) {
      this.attessaCurrentSplit = 0.0;
      this.attessaSplitLive    = 0.0;
      return;
    }
    const rearSlip = (Math.abs(this.slipAngles[2] || 0)
                    + Math.abs(this.slipAngles[3] || 0)) / 2;
    let targetSplit = 0.0;
    if (rearSlip > this.ATTESSA_SLIP_THRESHOLD) {
      const excess = rearSlip - this.ATTESSA_SLIP_THRESHOLD;
      targetSplit  = Math.min(
        this.ATTESSA_MAX_FRONT,
        excess / 0.3 * this.ATTESSA_MAX_FRONT
      );
    }
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
    const B = this.PAC_B, C = this.PAC_C, E = this.PAC_E;
    const x = B * alpha;
    return Fz * Math.sin(C * Math.atan(x - E * (x - Math.atan(x))));
  }

  // ── Animate wheel meshes ──────────────────────────────────
  updateWheelMeshes(wheelMeshes) {
    for (let i = 0; i < this.wheels.length; i++) {
      const w  = this.wheels[i];
      const wm = wheelMeshes[i];
      if (!wm) continue;
      wm.position.y = w.lp.y - (1 - this.suspTravel[i]) * this.SUSP_REST * 0.6;
      if (w.front) wm.rotation.y = this.steerAngle;
      w.spin      += this.speed * 0.06;
      wm.rotation.x = w.spin;
    }
  }
}

// ── Static scratch — shared constants, never mutated ─────────
RaycastVehicle._LOCAL_DOWN = new BABYLON.Vector3(0, -1, 0);

// ── Ray filter — hoisted out of the wheel loop ───────────────
// Defined once at module level so no closure is created per frame.
// Using a Set for O(1) lookup instead of multiple string comparisons.
const _WHEEL_RAY_EXCLUDE = new Set([
  'chassis','__root__','sky','cp','sf','nose','cock','wuL','wuR','wing'
]);
function _wheelRayFilter(m) {
  if (!m.isPickable || !m.isEnabled()) return false;
  const n = m.name;
  if (_WHEEL_RAY_EXCLUDE.has(n)) return false;
  if (n.charCodeAt(0) === 119) { // 'w'
    if (n.charCodeAt(1) === 116 || n.charCodeAt(1) === 114) return false; // 'wt', 'wr'
  }
  return true;
}