// =============================================================
//  PHYSICS.JS — RaycastVehicle
//
//  Raycast suspension + Pacejka Magic Formula tire model.
//  Drivetrain types: FR, AWD (ATTESSA), FF
//  Drift systems: sustain zone, save window, countersteer bonus,
//                 angular velocity cap, recovery assist
// =============================================================

class RaycastVehicle {
  constructor(scene, chassis, physBody) {
    this.scene   = scene;
    this.mesh    = chassis;
    this.body    = physBody;
    this.wheels  = [];
    this.steerAngle = 0;

    // ── Defaults (overwritten by loadCarProfile) ──────────
    this.SUSP_REST = .5;
    this.SUSP_MAX  = 2.9;   // matches all car profiles — was 2, causing one-frame sink on spawn
    this.SPRING_K  = 38000;
    this.DAMPER_C  = 3200;
    this.WHEEL_R   = 0.28;

    this.ENG_F    = 7800;
    this.BRK_F    = 10000;
    this.HBRK_F   = 24000;
    this.STEER_MAX = 0.44;
    this.STEER_SPD = 3.0;
    this.STEER_RET = 3.0;
    this.REAR_GRIP = 0.65;
    this.HANDBRAKE_GRIP = 0.28;
    this.HANDBRAKE_MU_K = 0.92;  // kinetic friction coeff for locked rear wheels

    this.PAC_B = 12;
    this.PAC_C = 1.8;
    this.PAC_D = 0.95;
    this.PAC_E = 1.05;

    this.MASS        = 780;
    this.FRONT_BIAS  = 0.42;
    this.WHEELBASE   = 2.52;
    this.TRACK_WIDTH = 1.88;
    this.CG_HEIGHT   = 0.44;

    // Aero
    this.AERO_DRAG         = 0.42;
    this.DOWNFORCE_COEFF   = 0.22;
    this.DOWNFORCE_MIN_KMH = 55;
    this.LAT_ACC_SCALE     = 0.38;

    // ── Drift feel ────────────────────────────────────────
    this.DRIFT_THRESHOLD       = 0.09;
    this.DRIFT_SUSTAIN_LO      = 0.22;  // slip angle band: stable drift zone
    this.DRIFT_SUSTAIN_HI      = 0.58;  // above this: unstable territory
    this.SAVE_WINDOW_LO        = 0.52;  // last-moment grip bump range
    this.SAVE_WINDOW_HI        = 0.62;
    this.SAVE_GRIP_BOOST       = 1.18;  // grip multiplier in save window
    this.COUNTERSTEER_BONUS    = 1.15;  // grip bonus when countersteering
    this.ANGULAR_VEL_CAP       = 3.8;   // rad/s — prevents helicopter spins
    this.RECOVERY_ASSIST_SPEED = 55;    // km/h below which assist is OFF

    // ── Drivetrain ────────────────────────────────────────
    this.drivetrain  = 'FR';
    this.DRIVE_FRONT = 0.0;
    this.DRIVE_REAR  = 1.0;

    // ATTESSA state
    this.ATTESSA_MAX_FRONT      = 0.50;
    this.ATTESSA_SLIP_THRESHOLD = 0.18;
    this.ATTESSA_RESPONSE       = 0.12;
    this.attessaCurrentSplit    = 0.0;

    // ── Gears ─────────────────────────────────────────────
    this.gearRatios = [3.8, 2.6, 1.8, 1.32, 1.0, 0.78];
    this.finalDrive = 3.9;
    this.gear = 0;
    this.rpm  = 800;

    // ── State ─────────────────────────────────────────────
    this.speed       = 0;
    this.isDrifting  = false;
    this.inAir       = false;
    this.suspTravel  = [0.5, 0.5, 0.5, 0.5];
    this._needsReset = false;
    this._reversing  = false;
    this._prevVel    = null;
    this.wheelLoads  = [0, 0, 0, 0];
    this.slipAngles  = [0, 0, 0, 0];
    this.currentProfileId = 'katana';

    // Telemetry exposed to HUD
    this.attessaSplitLive = 0;  // 0–1 fraction going to front
  }

  // ── Add a wheel anchor ──────────────────────────────────
  addWheel(lp, front, left) {
    this.wheels.push({ lp, front, left, spin: 0, onGround: false, cp: null });
  }

  // ── Main update — call once per frame ───────────────────
  update(inp, dt) {
    const B = BABYLON; // global alias — resolved once, not re-evaluated meaningfully per frame
    dt = Math.min(dt, 0.05);

    const vel  = this.body.getLinearVelocity();
    const fwdW = this._fwd();
    this.speed = B.Vector3.Dot(vel, fwdW);
    const kmh  = Math.abs(this.speed) * 3.6;
    const G    = 9.81;

    // ── Weight transfer ──────────────────────────────────
    const rightW = B.Vector3.Cross(B.Vector3.Up(), fwdW).normalize();

    const prevVel = this._prevVel || vel;
    const longAcc = B.Vector3.Dot(vel.subtract(prevVel), fwdW) / dt;

    // True lateral acceleration = delta(lateral velocity) / dt.
    // Using lateral velocity directly was wrong — it peaks mid-corner
    // rather than at corner entry/exit where load transfer is highest.
    const curLatVel  = B.Vector3.Dot(vel,     rightW);
    const prevLatVel = B.Vector3.Dot(prevVel, rightW);
    const latAcc     = ((curLatVel - prevLatVel) / dt) * this.LAT_ACC_SCALE;

    this._prevVel = vel.clone();

    const totalW      = this.MASS * G;
    const staticFront = totalW * this.FRONT_BIAS;
    const staticRear  = totalW * (1 - this.FRONT_BIAS);

    const ltLong = this.MASS * Math.max(-20, Math.min(20, longAcc))
                   * this.CG_HEIGHT / this.WHEELBASE;
    const ltLat  = this.MASS * Math.max(-15, Math.min(15, latAcc))
                   * this.CG_HEIGHT / this.TRACK_WIDTH;

    // Per-wheel normal loads [FL, FR, RL, RR]
    const baseLoad = [
      staticFront / 2 - ltLong / 2 - ltLat / 2,
      staticFront / 2 - ltLong / 2 + ltLat / 2,
      staticRear  / 2 + ltLong / 2 - ltLat / 2,
      staticRear  / 2 + ltLong / 2 + ltLat / 2,
    ].map(v => Math.max(0, v));

    // ── Steering ─────────────────────────────────────────
    // steerAxis is a -1..1 float from InputManager (analog stick or
    // keyboard ±1). Falls back to boolean left/right if absent.
    const steerLim  = Math.max(0.22, this.STEER_MAX * (1 - kmh / 280));
    const axisRaw   = (inp.steerAxis !== undefined && inp.steerAxis !== 0)
                    ? inp.steerAxis
                    : (inp.left ? -1 : inp.right ? 1 : 0);
    const tgt       = axisRaw * steerLim;
    const isActive  = Math.abs(axisRaw) > 0.01;
    this.steerAngle += isActive
      ? (tgt - this.steerAngle) * this.STEER_SPD * dt
      : -this.steerAngle * Math.min(1, this.STEER_RET * dt);
    this.steerAngle = Math.max(-this.STEER_MAX,
                               Math.min(this.STEER_MAX, this.steerAngle));

    const chassisPos  = this.mesh.absolutePosition;
    const chassisRotQ = this.mesh.absoluteRotationQuaternion
                        || B.Quaternion.Identity();
    const chassisRotM = chassisRotQ.toRotationMatrix(new B.Matrix());

    let groundCount = 0;
    let drifting    = false;

    // Local down — derived from chassis rotation, not hardcoded world (0,-1,0).
    // This single vector fixes upside-down driving, ramps, and banked corners.
    // On flat ground it equals world down exactly, so nothing changes there.
    const localDown = this._down();

    this.wheels.forEach((w, i) => {
      const anchorW = chassisPos.add(
        B.Vector3.TransformCoordinates(w.lp, chassisRotM)
      );
      // Offset origin slightly along local UP (away from ground) so the ray
      // starts just inside the hub rather than at the contact patch.
      const rayOrig = anchorW.add(localDown.scale(-0.12));
      const ray     = new B.Ray(rayOrig, localDown, this.SUSP_MAX + 0.18);

      const hit = this.scene.pickWithRay(ray, m => {
        if (!m.isPickable || !m.isEnabled()) return false;
        const n = m.name;
        if (n === 'chassis' || n === '__root__' || n === 'sky' ||
            n === 'cp'      || n === 'sf'       ||
            n.startsWith('wt') || n.startsWith('wr') ||
            n === 'nose' || n === 'cock' || n === 'wuL' ||
            n === 'wuR'  || n === 'wing') return false;
        return true;
      });

      if (hit && hit.hit && hit.distance <= this.SUSP_MAX + 0.16) {
        w.onGround = true;
        w.cp       = hit.pickedPoint;

        // Surface normal at the contact point.
        // Falls back to world up on meshes that don't return a normal.
        const surfNormal = (hit.getNormal && hit.getNormal(true, true))
                           || B.Vector3.Up();

        // Compression measured along the surface normal, not vertically.
        // On a ramp the raw ray distance is longer than true suspension
        // travel — projecting onto the normal gives the correct value.
        const normalDot   = Math.abs(B.Vector3.Dot(localDown, surfNormal));
        const perpDist    = (hit.distance - 0.12) * (normalDot > 0.01 ? normalDot : 1);
        const compression = Math.max(0, this.SUSP_REST - perpDist);
        this.suspTravel[i] = Math.min(1, compression / this.SUSP_REST);

        if (compression > 0) {
          groundCount++;

          const angVel   = this.body.getAngularVelocity();
          const r        = w.cp.subtract(chassisPos);
          const pointVel = vel.add(B.Vector3.Cross(angVel, r));
          // Damping velocity projected onto the surface normal.
          // On a ramp this resists motion into the surface, not motion upward.
          const suspVel  = B.Vector3.Dot(pointVel, surfNormal);

          // Spring + damper force applied along the surface normal.
          // On a ramp this pushes the car perpendicular to the ramp face —
          // making ramps launch correctly and banking keep the car planted.
          const upF = Math.max(0,
            compression * this.SPRING_K - suspVel * this.DAMPER_C);
          this.body.applyForce(surfNormal.scale(upF), w.cp);

          // Wheel forward (steered if front)
          let wFwd = fwdW.clone();
          if (w.front) {
            const sq = B.Quaternion.RotationAxis(
              B.Vector3.Up(), this.steerAngle);
            wFwd = B.Vector3.TransformNormal(
              wFwd, sq.toRotationMatrix(new B.Matrix()));
          }
          const wRight  = B.Vector3.Cross(B.Vector3.Up(), wFwd).normalize();
          const cpVel   = vel.add(B.Vector3.Cross(angVel, r));
          const longVel = B.Vector3.Dot(cpVel, wFwd);
          const latVel  = B.Vector3.Dot(cpVel, wRight);

          const Fz = baseLoad[i];
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

          // ── Lateral force with drift feel modifiers ──
          let D_wheel = this.PAC_D * Fz;

          // Rear grip reduction
          if (!w.front) D_wheel *= this.REAR_GRIP;

          // ── Handbrake: locked wheel = kinetic friction ──────
          // When the rear wheel is locked, Pacejka is no longer valid —
          // the wheel is not rolling so there is no slip angle in the
          // tyre sense. Instead the contact patch slides in whatever
          // direction the car is moving relative to the ground.
          // Kinetic friction opposes that full 2D sliding velocity,
          // which naturally produces the correct yaw torque at any speed
          // and in any input order (steer-then-brake or brake-then-steer).
          if (inp.handbrake && !w.front) {
            const cpSpeed = Math.sqrt(longVel * longVel + latVel * latVel);
            if (cpSpeed > 0.05) {
              const mu_k        = this.HANDBRAKE_MU_K;
              const frictionMag = mu_k * Fz;
              // Single force vector opposing the full contact patch velocity
              const fLong = -(longVel / cpSpeed) * frictionMag;
              const fLat  = -(latVel  / cpSpeed) * frictionMag;
              this.body.applyForce(
                wFwd.scale(fLong).add(wRight.scale(fLat)),
                w.cp
              );
            }
            // Drift detection — locked rear = always drifting
            drifting = true;
            // Apply throttle/brake but NOT the separate HBRK_F —
            // kinetic friction already covers the longitudinal braking.
            this._applyDriveForce(inp, w, i, wFwd, longVel, dt, true);
            return; // skip Pacejka path below for this wheel
          }

          // Sustain zone: extra grip in the stable drift band
          if (!w.front && absAlpha >= this.DRIFT_SUSTAIN_LO
                       && absAlpha <= this.DRIFT_SUSTAIN_HI) {
            const t = (absAlpha - this.DRIFT_SUSTAIN_LO)
                    / (this.DRIFT_SUSTAIN_HI - this.DRIFT_SUSTAIN_LO);
            // Bell curve — peak stability at midpoint
            const sustain = 1.0 + 0.12 * Math.sin(t * Math.PI);
            D_wheel *= sustain;
          }

          // Save window: brief grip bump before full spin
          if (!w.front && absAlpha >= this.SAVE_WINDOW_LO
                       && absAlpha <= this.SAVE_WINDOW_HI) {
            D_wheel *= this.SAVE_GRIP_BOOST;
          }

          // Countersteer bonus: reward correct input
          const isCountersteering = this._isCountersteering(
            alpha, this.steerAngle, longVel);
          if (!w.front && isCountersteering
                       && kmh > this.RECOVERY_ASSIST_SPEED) {
            D_wheel *= this.COUNTERSTEER_BONUS;
          }

          const lateralForceMag = this._pacejkaMF(alpha, D_wheel);
          this.body.applyForce(wRight.scale(-lateralForceMag), w.cp);

          // ── Longitudinal / drive force ────────────────
          this._applyDriveForce(inp, w, i, wFwd, longVel, dt);

          // Drift detection
          if (!w.front && absAlpha > this.DRIFT_THRESHOLD) drifting = true;
        }

      } else {
        w.onGround = false;
        w.cp       = null;
        this.suspTravel[i] = Math.max(0, this.suspTravel[i] - dt * 3);
        this.wheelLoads[i] = 0;
        this.slipAngles[i] = 0;
      }
    });

    this.inAir    = groundCount === 0;
    this.isDrifting = drifting;

    // ── ATTESSA torque split — runs after wheel loop so slip angles are current
    if (this.drivetrain === 'AWD') {
      this._updateATTESSA(inp, dt);
    }

    // ── Angular velocity cap ─────────────────────────────
    const av = this.body.getAngularVelocity();
    const yawRate = Math.abs(av.y);
    if (yawRate > this.ANGULAR_VEL_CAP) {
      const scale = this.ANGULAR_VEL_CAP / yawRate;
      this.body.setAngularVelocity(
        new B.Vector3(av.x, av.y * scale, av.z));
    }

    // ── Aero ─────────────────────────────────────────────
    const spd2 = vel.lengthSquared();
    if (spd2 > 0.1) {
      const drag = vel.normalizeToNew().scaleInPlace(-this.AERO_DRAG * spd2);
      this.body.applyForce(drag, chassisPos);
    }
    const dfSpeed    = Math.max(0, kmh - this.DOWNFORCE_MIN_KMH);
    const downforce  = -(dfSpeed * dfSpeed) * this.DOWNFORCE_COEFF;
    if (downforce !== 0)
      this.body.applyForce(new B.Vector3(0, downforce, 0), chassisPos);

    // ── Gear shifting ────────────────────────────────────
    const ratio = this.gearRatios[this.gear] * this.finalDrive;
    const wrpm  = (Math.abs(this.speed) / (2 * Math.PI * this.WHEEL_R)) * 60;
    this.rpm = Math.max(800, Math.min(8500, wrpm * ratio));
    if (this.rpm > 7800 && this.gear < this.gearRatios.length - 1) this.gear++;
    else if (this.rpm < 2200 && this.gear > 0) this.gear--;

    if (inp.reset) this._needsReset = true;

    return {
      speedKmh:    kmh,
      rpm:         this.rpm,
      gear:        this.gear + 1,
      reversing:   this._reversing,
      drifting,
      inAir:       groundCount === 0,
      suspTravel:  this.suspTravel.slice(),
      wheelLoads:  this.wheelLoads.slice(),
      slipAngles:  this.slipAngles.slice(),
      attessaSplit: this.attessaCurrentSplit,
      drivetrain:  this.drivetrain,
    };
  }

  // ── Drive force — respects drivetrain layout ─────────────
  _applyDriveForce(inp, w, i, wFwd, longVel, dt, skipHandbrake = false) {
    const isFront = w.front;
    const isRear  = !w.front;

    // Which wheels get drive torque?
    let driveShare = 0;
    if (this.drivetrain === 'FR') {
      driveShare = isRear ? 1.0 : 0.0;
    } else if (this.drivetrain === 'FF') {
      driveShare = isFront ? 1.0 : 0.0;
    } else if (this.drivetrain === 'AWD') {
      // ATTESSA: normally rear, transfers to front under slip
      const frontShare = this.attessaCurrentSplit;
      const rearShare  = 1.0 - frontShare;
      driveShare = isFront ? frontShare : rearShare;
      // Each axle has 2 wheels — split evenly
      driveShare *= 0.5;
    }

    // For FR / FF — each drive wheel is 1 of 2 on that axle
    if (this.drivetrain !== 'AWD') driveShare *= 0.5;

    let longF = 0;

    if (inp.throttle) {
      this._reversing = false;
      longF = this.ENG_F * driveShare;

      // FF: throttle oversteer penalty mid-corner
      // (traction and steering fight on the front axle)
      if (this.drivetrain === 'FF' && isFront && Math.abs(this.steerAngle) > 0.1) {
        const steerPenalty = 1.0 - Math.abs(this.steerAngle) / this.STEER_MAX * 0.4;
        longF *= steerPenalty;
      }
    }

    if (inp.brake) {
      // Braking applies to all wheels regardless of drivetrain
      if (!this._reversing && longVel > 0.4) {
        longF -= (this.BRK_F / 4);
      } else {
        this._reversing = true;
        // Reverse torque only on drive wheels
        longF -= (this.ENG_F * 0.75 * driveShare);
      }
    } else if (!inp.throttle) {
      if (this._reversing && longVel > -0.2) this._reversing = false;
    }

    // Handbrake — rear wheels only
    if (inp.handbrake && isRear && !skipHandbrake) {
      longF -= (this.HBRK_F / 2) * Math.sign(Math.abs(longVel) > 0.3 ? longVel : this.speed);
    }

    if (longF !== 0) this.body.applyForce(wFwd.scale(longF), w.cp);
  }


  // progressively transfers torque fraction to front axle.
  _updateATTESSA(inp, dt) {
    // Handbrake disengages ATTESSA — system stands down so the driver
    // can break rear traction freely without AWD fighting the slide.
    if (inp.handbrake) {
      this.attessaCurrentSplit = 0.0;
      this.attessaSplitLive    = 0.0;
      return;
    }

    // Estimate rear slip from average rear slip angles
    const rl = Math.abs(this.slipAngles[2] || 0);
    const rr = Math.abs(this.slipAngles[3] || 0);
    const rearSlip = (rl + rr) / 2;

    let targetSplit = 0.0;
    if (rearSlip > this.ATTESSA_SLIP_THRESHOLD) {
      // Proportional transfer — more slip = more front torque
      const excess = rearSlip - this.ATTESSA_SLIP_THRESHOLD;
      targetSplit = Math.min(
        this.ATTESSA_MAX_FRONT,
        excess / 0.3 * this.ATTESSA_MAX_FRONT
      );
    }

    // Smooth the transition
    this.attessaCurrentSplit += (targetSplit - this.attessaCurrentSplit)
                                * Math.min(1, this.ATTESSA_RESPONSE * 60 * dt);
    this.attessaSplitLive = this.attessaCurrentSplit;
  }

  // ── Countersteer detection ────────────────────────────────
  // True when steering OPPOSES the slide direction (correct catch input).
  // Positive alpha = rear sliding right → catch by steering LEFT (negative steerAngle).
  // So countersteer = signs are OPPOSITE, not equal.
  // When reversing the relationship flips, hence the dir factor.
  _isCountersteering(alpha, steerAngle, longVel) {
    if (Math.abs(alpha) < 0.05) return false;
    const dir = Math.sign(longVel >= 0 ? 1 : -1);
    return Math.sign(alpha) !== Math.sign(steerAngle * dir);
  }

  // ── Pacejka Magic Formula ─────────────────────────────────
  _pacejkaMF(alpha, Fz) {
    const { PAC_B: B, PAC_C: C, PAC_E: E } = this;
    const x = B * alpha;
    return Fz * Math.sin(C * Math.atan(x - E * (x - Math.atan(x))));
  }

  // ── Animate wheel meshes ──────────────────────────────────
  updateWheelMeshes(wheelMeshes) {
    this.wheels.forEach((w, i) => {
      const wm = wheelMeshes[i];
      if (!wm) return;
      const drop = (1 - this.suspTravel[i]) * this.SUSP_REST * 0.6;
      wm.position.y = w.lp.y - drop;
      if (w.front) wm.rotation.y = this.steerAngle;
      w.spin += this.speed * 0.06;
      wm.rotation.x = w.spin;
    });
  }

  // ── Forward vector in world space ────────────────────────
  _fwd() {
    const q = this.mesh.absoluteRotationQuaternion
              || BABYLON.Quaternion.Identity();
    return BABYLON.Vector3.TransformNormal(
      BABYLON.Vector3.Forward(),
      q.toRotationMatrix(new BABYLON.Matrix())
    ).normalize();
  }

  // ── Local down vector in world space ─────────────────────
  // Derived from chassis rotation so ramps, banks, and flips
  // all affect where the ray fires. On flat ground this is
  // identical to world (0,-1,0) — zero cost on normal tracks.
  _down() {
    const q = this.mesh.absoluteRotationQuaternion
              || BABYLON.Quaternion.Identity();
    return BABYLON.Vector3.TransformNormal(
      new BABYLON.Vector3(0, -1, 0),
      q.toRotationMatrix(new BABYLON.Matrix())
    ).normalize();
  }
}