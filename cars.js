// =============================================================
//  CARS.JS — Car profiles for Apex Racer
//  Each profile contains all physics params, display info,
//  drivetrain type, and stat values for the selection screen.
//  Drivetrain types: 'FR' | 'AWD' | 'FF'
//
//  importCarParams(jsonString, vehicle) — paste a JSON blob
//  from the HUD copy button to hot-reload params at runtime.
// =============================================================

const CAR_PROFILES = {

  // ── KATANA ──────────────────────────────────────────────
  // Lightweight FR coupe. Rear-biased weight, soft rear
  // compound. Flickable and twitchy — high reward, high risk.
  katana: {
    id: 'katana',
    name: 'KATANA',
    subtitle: 'LIGHTWEIGHT FR',
    drivetrain: 'FR',
    colorHex: '#ff3300',
    color3: [0.95, 0.08, 0.04],

    stats: {
      WEIGHT:    30,
      POWER:     45,
      GRIP:      55,
      DRIFT:     85,
      STABILITY: 35,
    },

    MASS:         780,
    FRONT_BIAS:   0.43,
    WHEELBASE:    2.52,
    TRACK_WIDTH:  1.88,
    CG_HEIGHT:    0.55,

    PAC_B: 8,
    PAC_C: 1.6,
    PAC_D: 2,
    PAC_E: 0.75,

    SPRING_K:  38000,
    DAMPER_C:  4200,
    SUSP_REST: 0.5,
    SUSP_MAX:  2.9,
    WHEEL_R:   0.27,

    ENG_F:  5000,
    BRK_F:  10000,
    HBRK_F: 22000,

    STEER_MAX: 0.48,
    STEER_SPD: 3.2,
    STEER_RET: 2.6,

    TIRE_COMPOUND_FRONT: 1.0,
    TIRE_COMPOUND_REAR:  0.5,
    HANDBRAKE_MU_K:      0.92,

    AERO_DRAG:             0.40,
    DOWNFORCE_COEFF:       0.18,
    DOWNFORCE_MIN_KMH:     50,
    WEIGHT_TRANSFER_SCALE: 0.45,

    SLIP_ANGLE_THRESHOLD: 0.10,
    MAX_YAW_RATE:         10,

    gearRatios: [3.8, 2.6, 1.8, 1.32, 1.0, 0.78],
    finalDrive: 3.9,

    DRIVE_FRONT: 0.0,
    DRIVE_REAR:  1.0,
  },

  // ── BRUISER ─────────────────────────────────────────────
  // AWD with ATTESSA torque split. Heavy, planted, grippy.
  // Equal tire compounds and aggressive ATTESSA threshold
  // make it a tank — requires real commitment to break loose.
  bruiser: {
    id: 'bruiser',
    name: 'BRUISER',
    subtitle: 'AWD · ATTESSA',
    drivetrain: 'AWD',
    colorHex: '#ffe600',
    color3: [0.92, 0.82, 0.04],

    stats: {
      WEIGHT:    65,
      POWER:     90,
      GRIP:      92,
      DRIFT:     40,
      STABILITY: 88,
    },

    MASS:         1380,
    FRONT_BIAS:   0.51,
    WHEELBASE:    2.74,
    TRACK_WIDTH:  2.02,
    CG_HEIGHT:    0.45,

    PAC_B: 8,
    PAC_C: 1.6,
    PAC_D: 2,
    PAC_E: 0.75,

    SPRING_K:  40000,
    DAMPER_C:  4200,
    SUSP_REST: 0.5,
    SUSP_MAX:  2.9,
    WHEEL_R:   0.30,

    ENG_F:  13500,
    BRK_F:  14000,
    HBRK_F: 12000,

    STEER_MAX: 0.38,
    STEER_SPD: 2.6,
    STEER_RET: 3.8,

    TIRE_COMPOUND_FRONT: 1.0,
    TIRE_COMPOUND_REAR:  1.0,
    HANDBRAKE_MU_K:      0.82,

    AERO_DRAG:             0.55,
    DOWNFORCE_COEFF:       0.48,
    DOWNFORCE_MIN_KMH:     70,
    WEIGHT_TRANSFER_SCALE: 0.40,

    SLIP_ANGLE_THRESHOLD: 0.25,
    MAX_YAW_RATE:         10,

    gearRatios: [3.2, 2.2, 1.6, 1.18, 0.92, 0.74],
    finalDrive: 3.5,

    DRIVE_FRONT:            0.0,
    DRIVE_REAR:             1.0,
    ATTESSA_MAX_FRONT:      0.50,
    ATTESSA_SLIP_THRESHOLD: 0.05,
    ATTESSA_RESPONSE:       0.12,
    attessaCurrentSplit:    0.0,
  },

  // ── SPEC R ───────────────────────────────────────────────
  // FF layout. Very soft rear compound, high weight transfer
  // scale, slight rear weight bias for an FF. Lift-off
  // oversteer and handbrake are the primary entry tools.
  specr: {
    id: 'specr',
    name: 'SPEC R',
    subtitle: 'FRONT WHEEL DRIVE',
    drivetrain: 'FF',
    colorHex: '#00ff88',
    color3: [0.04, 0.92, 0.48],

    stats: {
      WEIGHT:    45,
      POWER:     55,
      GRIP:      68,
      DRIFT:     50,
      STABILITY: 60,
    },

    MASS:         1050,
    FRONT_BIAS:   0.40,
    WHEELBASE:    2.62,
    TRACK_WIDTH:  1.94,
    CG_HEIGHT:    0.52,

    PAC_B: 8,
    PAC_C: 1.6,
    PAC_D: 2,
    PAC_E: 0.75,

    SPRING_K:  30000,
    DAMPER_C:  2400,
    SUSP_REST: 0.5,
    SUSP_MAX:  2.9,
    WHEEL_R:   0.28,

    ENG_F:  6200,
    BRK_F:  9000,
    HBRK_F: 20000,

    STEER_MAX: 0.52,
    STEER_SPD: 2.8,
    STEER_RET: 2.4,

    TIRE_COMPOUND_FRONT: 1.0,
    TIRE_COMPOUND_REAR:  0.42,
    HANDBRAKE_MU_K:      0.95,

    AERO_DRAG:             0.44,
    DOWNFORCE_COEFF:       0.18,
    DOWNFORCE_MIN_KMH:     50,
    WEIGHT_TRANSFER_SCALE: 0.58,

    SLIP_ANGLE_THRESHOLD: 0.10,
    MAX_YAW_RATE:         10,

    gearRatios: [3.5, 2.4, 1.7, 1.28, 0.98, 0.78],
    finalDrive: 4.1,

    DRIVE_FRONT: 1.0,
    DRIVE_REAR:  0.0,
  },
};

// ── Internal: apply a param object to a live vehicle ─────────
function _applyParams(vehicle, p) {
  if (p.MASS         != null) vehicle.MASS         = p.MASS;
  if (p.FRONT_BIAS   != null) vehicle.FRONT_BIAS   = p.FRONT_BIAS;
  if (p.WHEELBASE    != null) vehicle.WHEELBASE    = p.WHEELBASE;
  if (p.TRACK_WIDTH  != null) vehicle.TRACK_WIDTH  = p.TRACK_WIDTH;
  if (p.CG_HEIGHT    != null) vehicle.CG_HEIGHT    = p.CG_HEIGHT;

  if (p.PAC_B != null) vehicle.PAC_B = p.PAC_B;
  if (p.PAC_C != null) vehicle.PAC_C = p.PAC_C;
  if (p.PAC_D != null) vehicle.PAC_D = p.PAC_D;
  if (p.PAC_E != null) vehicle.PAC_E = p.PAC_E;

  if (p.SPRING_K  != null) vehicle.SPRING_K  = p.SPRING_K;
  if (p.DAMPER_C  != null) vehicle.DAMPER_C  = p.DAMPER_C;
  if (p.SUSP_REST != null) vehicle.SUSP_REST = p.SUSP_REST;
  if (p.SUSP_MAX  != null) vehicle.SUSP_MAX  = p.SUSP_MAX;
  if (p.WHEEL_R   != null) vehicle.WHEEL_R   = p.WHEEL_R;

  if (p.ENG_F  != null) vehicle.ENG_F  = p.ENG_F;
  if (p.BRK_F  != null) vehicle.BRK_F  = p.BRK_F;
  if (p.HBRK_F != null) vehicle.HBRK_F = p.HBRK_F;

  if (p.STEER_MAX != null) vehicle.STEER_MAX = p.STEER_MAX;
  if (p.STEER_SPD != null) vehicle.STEER_SPD = p.STEER_SPD;
  if (p.STEER_RET != null) vehicle.STEER_RET = p.STEER_RET;

  if (p.TIRE_COMPOUND_FRONT != null) vehicle.TIRE_COMPOUND_FRONT = p.TIRE_COMPOUND_FRONT;
  if (p.TIRE_COMPOUND_REAR  != null) vehicle.TIRE_COMPOUND_REAR  = p.TIRE_COMPOUND_REAR;
  if (p.HANDBRAKE_MU_K      != null) vehicle.HANDBRAKE_MU_K      = p.HANDBRAKE_MU_K;

  if (p.AERO_DRAG             != null) vehicle.AERO_DRAG             = p.AERO_DRAG;
  if (p.DOWNFORCE_COEFF       != null) vehicle.DOWNFORCE_COEFF       = p.DOWNFORCE_COEFF;
  if (p.DOWNFORCE_MIN_KMH     != null) vehicle.DOWNFORCE_MIN_KMH     = p.DOWNFORCE_MIN_KMH;
  if (p.WEIGHT_TRANSFER_SCALE != null) vehicle.WEIGHT_TRANSFER_SCALE = p.WEIGHT_TRANSFER_SCALE;

  if (p.SLIP_ANGLE_THRESHOLD != null) vehicle.SLIP_ANGLE_THRESHOLD = p.SLIP_ANGLE_THRESHOLD;
  if (p.MAX_YAW_RATE         != null) vehicle.MAX_YAW_RATE         = p.MAX_YAW_RATE;

  if (p.gearRatios) vehicle.gearRatios = [...p.gearRatios];
  if (p.finalDrive != null) vehicle.finalDrive = p.finalDrive;

  if (p.drivetrain  != null) vehicle.drivetrain  = p.drivetrain;
  if (p.DRIVE_FRONT != null) vehicle.DRIVE_FRONT = p.DRIVE_FRONT;
  if (p.DRIVE_REAR  != null) vehicle.DRIVE_REAR  = p.DRIVE_REAR;

  if (p.ATTESSA_MAX_FRONT      != null) vehicle.ATTESSA_MAX_FRONT      = p.ATTESSA_MAX_FRONT;
  if (p.ATTESSA_SLIP_THRESHOLD != null) vehicle.ATTESSA_SLIP_THRESHOLD = p.ATTESSA_SLIP_THRESHOLD;
  if (p.ATTESSA_RESPONSE       != null) vehicle.ATTESSA_RESPONSE       = p.ATTESSA_RESPONSE;
}

// ── loadCarProfile ────────────────────────────────────────────
function loadCarProfile(vehicle, profileId) {
  const p = CAR_PROFILES[profileId];
  if (!p) { console.error('Unknown car profile:', profileId); return; }
  _applyParams(vehicle, p);
  vehicle.gear = 0;
  vehicle.rpm  = 800;
  vehicle.currentProfileId = profileId;
}

// ── importCarParams ───────────────────────────────────────────
// Parse a JSON string and hot-apply params to a live vehicle.
// Only keys present in the JSON are updated. The 'car' key is
// informational only — it does NOT switch the car model.
// Returns { ok, error, appliedKeys } for HUD feedback.
function importCarParams(jsonString, vehicle) {
  let parsed;
  try {
    parsed = JSON.parse(jsonString);
  } catch (e) {
    return { ok: false, error: 'Invalid JSON: ' + e.message, appliedKeys: [] };
  }

  const appliedKeys = Object.keys(parsed).filter(k => k !== 'car');
  _applyParams(vehicle, parsed);

  return { ok: true, error: null, appliedKeys };
}