// =============================================================
//  INPUT.JS — InputManager
//
//  Centralises all player input: keyboard and gamepad.
//  Keyboard and gamepad work simultaneously — inputs merge.
//
//  state object (read this every frame):
//    throttle  {boolean}  — accelerate
//    brake     {boolean}  — brake / reverse
//    left      {boolean}  — steer left (keyboard)
//    right     {boolean}  — steer right (keyboard)
//    handbrake {boolean}  — handbrake
//    reset     {boolean}  — respawn
//    steerAxis {number}   — -1..1, merged keyboard + gamepad analog
//    throttleAxis {number} — 0..1, gamepad trigger (or 1 if keyboard throttle)
//    brakeAxis    {number} — 0..1, gamepad trigger (or 1 if keyboard brake)
//
//  Default gamepad layout (Xbox / standard mapping):
//    Left stick X     → steer
//    RT (axis 5 / button 7) → throttle
//    LT (axis 4 / button 6) → brake
//    A  (button 0)    → handbrake
//    Y  (button 3)    → reset
//
//  Rebinding:
//    inputManager.startRebind(action, 'key' | 'gamepad', callback)
//    Next keypress or gamepad button press is captured and stored.
//    Bindings are saved to localStorage and reloaded on init.
// =============================================================

class InputManager {
  constructor() {

    // ── Default keyboard bindings ─────────────────────────
    // Each action maps to an array of KeyboardEvent.code strings.
    this.DEFAULT_KEY_BINDINGS = {
      throttle:  ['KeyW', 'ArrowUp'],
      brake:     ['KeyS', 'ArrowDown'],
      left:      ['KeyA', 'ArrowLeft'],
      right:     ['KeyD', 'ArrowRight'],
      handbrake: ['Space'],
      reset:     ['KeyR'],
    };

    // ── Default gamepad bindings ──────────────────────────
    // 'axis'   : { index, invert, isAnalog } — analog axis
    // 'button' : { index }                  — digital button
    // Standard mapping (Chrome / Firefox on Xbox / PS controllers):
    //   axis 0 = left stick X, axis 1 = left stick Y
    //   axis 2 = right stick X, axis 3 = right stick Y
    //   axis 4 = LT (some browsers), axis 5 = RT (some browsers)
    //   button 6 = LT, button 7 = RT (standard mapping)
    //   button 0 = A/Cross, button 3 = Y/Triangle
    this.DEFAULT_GAMEPAD_BINDINGS = {
      steerLeft:  { type: 'axis', index: 0, invert: true  },  // left stick X, negative = left
      steerRight: { type: 'axis', index: 0, invert: false },  // left stick X, positive = right
      throttle:   { type: 'button', index: 7  },   // RT
      brake:      { type: 'button', index: 6  },   // LT
      handbrake:  { type: 'button', index: 0  },   // A / Cross
      reset:      { type: 'button', index: 3  },   // Y / Triangle
    };

    // Live bindings (may be overwritten from localStorage)
    this.keyBindings     = this._deepClone(this.DEFAULT_KEY_BINDINGS);
    this.gamepadBindings = this._deepClone(this.DEFAULT_GAMEPAD_BINDINGS);

    // ── Input state ───────────────────────────────────────
    this.state = {
      throttle:     false,
      brake:        false,
      left:         false,
      right:        false,
      handbrake:    false,
      reset:        false,
      steerAxis:    0,
      throttleAxis: 0,
      brakeAxis:    0,
    };

    // Raw keyboard booleans (before merging with gamepad)
    this._keyState = {
      throttle: false, brake: false,
      left: false, right: false,
      handbrake: false, reset: false,
    };

    // Gamepad config
    this.deadzone          = 0.12;
    this.triggerThreshold  = 0.15;  // analog trigger → boolean threshold

    // Rebind state
    this._rebinding        = null;  // { action, type, callback }
    this._rebindKeyHandler = null;
    this._rebindGpHandler  = null;
    this._axisRebindTimer  = null;  // interval for axis capture

    // Connected gamepad index (-1 = none)
    this._gamepadIndex = -1;

    this._loadBindings();
    this._attachKeyListeners();
    this._attachGamepadListeners();
  }

  // ── Per-frame update — call at start of render loop ──────
  update() {
    this._pollGamepad();
    this._mergeState();
  }

  // ── Keyboard listeners ────────────────────────────────────
  _attachKeyListeners() {
    window.addEventListener('keydown', e => {
      // Rebind mode — capture this key
      if (this._rebinding && this._rebinding.type === 'key') {
        // Ignore modifier keys on their own
        if (['Shift','Control','Alt','Meta'].includes(e.key)) return;
        this._finishRebind(e.code);
        e.preventDefault();
        return;
      }
      // Normal input
        for (const [action, codes] of Object.entries(this.keyBindings)) {
        if (codes.includes(e.code)) {
          this._keyState[action] = true;
                if (e.code === 'Space') e.preventDefault();
        }
      }
    });

    window.addEventListener('keyup', e => {
      for (const [action, codes] of Object.entries(this.keyBindings)) {
        if (codes.includes(e.code)) this._keyState[action] = false;
      }
    });
  }

  // ── Gamepad connect / disconnect ──────────────────────────
  _attachGamepadListeners() {
    window.addEventListener('gamepadconnected', e => {
      if (this._gamepadIndex === -1) {
        this._gamepadIndex = e.gamepad.index;
            this._dispatchGamepadEvent('connected', e.gamepad.id);
      }
    });
    window.addEventListener('gamepaddisconnected', e => {
      if (e.gamepad.index === this._gamepadIndex) {
        this._gamepadIndex = -1;
            this._dispatchGamepadEvent('disconnected', '');
      }
    });
  }

  _dispatchGamepadEvent(detail, id) {
    window.dispatchEvent(new CustomEvent('inputmanager:gamepad', {
      detail: { status: detail, id }
    }));
  }

  // ── Poll the active gamepad ───────────────────────────────
  _pollGamepad() {
    this._gpState = {
      throttle: 0, brake: 0,
      handbrake: false, reset: false,
      steer: 0,
    };

    if (this._gamepadIndex === -1) {
      // Try to find any connected gamepad
      const pads = navigator.getGamepads ? navigator.getGamepads() : [];
      for (let i = 0; i < pads.length; i++) {
        if (pads[i]) { this._gamepadIndex = i; break; }
      }
      if (this._gamepadIndex === -1) return;
    }

    const pad = (navigator.getGamepads ? navigator.getGamepads() : [])[this._gamepadIndex];
    if (!pad) { this._gamepadIndex = -1; return; }

    // Rebind mode — watch for any button press
    if (this._rebinding && this._rebinding.type === 'gamepad') {
      for (let i = 0; i < pad.buttons.length; i++) {
        if (pad.buttons[i].pressed) {
          this._finishRebind(i);
          return;
        }
      }
    }

    // ── Steer axes (steerLeft + steerRight can be different axes) ──
    // Each returns a 0..1 value (magnitude only). We combine into -1..1.
    const slBind = this.gamepadBindings.steerLeft;
    const srBind = this.gamepadBindings.steerRight;

    const readAxis = (bind) => {
      let raw = pad.axes[bind.index] || 0;
      if (bind.invert) raw = -raw;  // invert so "left" axis gives positive value
      return Math.max(0, this._applyDeadzone(raw)); // clamp to 0..1 (one direction)
    };

    const leftAmt  = readAxis(slBind);   // 0..1, how much steering left
    const rightAmt = readAxis(srBind);   // 0..1, how much steering right

    // If both bindings use the same axis, they're naturally exclusive (one side = 0).
    // If different axes, combine: right is positive, left is negative.
    this._gpState.steer = Math.max(-1, Math.min(1, rightAmt - leftAmt));

    // ── Throttle ──────────────────────────────────────────
    const thrBind = this.gamepadBindings.throttle;
    if (thrBind.type === 'axis') {
      const raw = (pad.axes[thrBind.index] + 1) / 2; // remap -1..1 → 0..1
      this._gpState.throttle = this._applyDeadzone(raw, 0.02);
    } else {
      // button.value gives analog 0..1 on most browsers
      this._gpState.throttle = pad.buttons[thrBind.index]
        ? pad.buttons[thrBind.index].value
        : 0;
    }

    // ── Brake ─────────────────────────────────────────────
    const brkBind = this.gamepadBindings.brake;
    if (brkBind.type === 'axis') {
      const raw = (pad.axes[brkBind.index] + 1) / 2;
      this._gpState.brake = this._applyDeadzone(raw, 0.02);
    } else {
      this._gpState.brake = pad.buttons[brkBind.index]
        ? pad.buttons[brkBind.index].value
        : 0;
    }

    // ── Digital buttons ───────────────────────────────────
    this._gpState.handbrake = pad.buttons[this.gamepadBindings.handbrake.index]?.pressed || false;
    this._gpState.reset     = pad.buttons[this.gamepadBindings.reset.index]?.pressed     || false;
  }

  // ── Merge keyboard + gamepad into final state ─────────────
  _mergeState() {
    const ks = this._keyState;
    const gs = this._gpState || {};

    // Keyboard steer axis: -1, 0, or +1
    const kbSteer = (ks.left ? -1 : 0) + (ks.right ? 1 : 0);

    // Merge: clamp sum so simultaneous inputs don't exceed ±1
    const mergedSteer = Math.max(-1, Math.min(1, kbSteer + (gs.steer || 0)));

    // Analog throttle/brake — keyboard gives full 1.0
    const thrAxis = Math.max(ks.throttle ? 1 : 0, gs.throttle || 0);
    const brkAxis = Math.max(ks.brake    ? 1 : 0, gs.brake    || 0);

    this.state.steerAxis    = mergedSteer;
    this.state.throttleAxis = thrAxis;
    this.state.brakeAxis    = brkAxis;

    // Boolean versions (physics.js reads these)
    this.state.throttle  = thrAxis > this.triggerThreshold;
    this.state.brake     = brkAxis > this.triggerThreshold;
    this.state.left      = mergedSteer < -this.deadzone;
    this.state.right     = mergedSteer >  this.deadzone;
    this.state.handbrake = ks.handbrake || (gs.handbrake || false);
    this.state.reset     = ks.reset     || (gs.reset     || false);
  }

  // ── Deadzone helper ───────────────────────────────────────
  _applyDeadzone(v, dz) {
    dz = dz !== undefined ? dz : this.deadzone;
    if (Math.abs(v) < dz) return 0;
    // Rescale so response starts at 0 just outside deadzone
    return (v - Math.sign(v) * dz) / (1 - dz);
  }

  // ── Rebinding ─────────────────────────────────────────────
  // type: 'key' | 'gamepad'
  // callback(newBinding) — called when capture is done
  startRebind(action, type, callback) {
    this.cancelRebind();
    this._rebinding = { action, type, callback };

    if (type === 'axis') {
      // Sample axes for 2s, pick whichever moves most
      const baseline = this._sampleAxes();
      let bestAxis = -1, bestDelta = 0;
      this._axisRebindTimer = setInterval(() => {
        const pads = navigator.getGamepads ? navigator.getGamepads() : [];
        const pad  = pads[this._gamepadIndex];
        if (!pad) return;
        for (let i = 0; i < pad.axes.length; i++) {
          const delta = Math.abs(pad.axes[i] - (baseline[i] || 0));
          if (delta > bestDelta) { bestDelta = delta; bestAxis = i; }
        }
        if (bestAxis !== -1 && bestDelta > 0.5) {
          // Determine invert: if axis value is negative when moving in intended direction
          const axisVal = pad.axes[bestAxis];
          // steerLeft should be inverted (negative axis = left = we invert to positive)
          // steerRight should not be inverted (positive axis = right)
          const shouldInvert = (action === 'steerLeft') ? (axisVal > 0) : (axisVal < 0);
          clearInterval(this._axisRebindTimer);
          this._axisRebindTimer = null;
          this._finishRebind({ axisIndex: bestAxis, invert: shouldInvert });
        }
      }, 50);
      // Auto-cancel after 5s
      setTimeout(() => {
        if (this._axisRebindTimer) {
          clearInterval(this._axisRebindTimer);
          this._axisRebindTimer = null;
          this.cancelRebind();
        }
      }, 5000);
    }
  }

  _sampleAxes() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const pad  = pads[this._gamepadIndex];
    if (!pad) return {};
    const out = {};
    for (let i = 0; i < pad.axes.length; i++) out[i] = pad.axes[i];
    return out;
  }

  cancelRebind() {
    if (this._axisRebindTimer) {
      clearInterval(this._axisRebindTimer);
      this._axisRebindTimer = null;
    }
    this._rebinding = null;
  }

  _finishRebind(value) {
    if (!this._rebinding) return;
    const { action, type, callback } = this._rebinding;
    this._rebinding = null;

    if (type === 'key') {
      if (!this.keyBindings[action]) this.keyBindings[action] = [];
      this.keyBindings[action][0] = value;
    } else if (type === 'axis') {
      // value is { axisIndex, invert }
      if (this.gamepadBindings[action]) {
        this.gamepadBindings[action].index  = value.axisIndex;
        this.gamepadBindings[action].invert = value.invert;
      }
    } else {
      // gamepad button
      if (this.gamepadBindings[action]) {
        this.gamepadBindings[action].index = value;
      }
    }

    this._saveBindings();
    if (callback) callback(value);
  }

  // ── Reset to defaults ─────────────────────────────────────
  resetToDefaults() {
    this.keyBindings     = this._deepClone(this.DEFAULT_KEY_BINDINGS);
    this.gamepadBindings = this._deepClone(this.DEFAULT_GAMEPAD_BINDINGS);
    this._saveBindings();
  }

  // ── Persistence ───────────────────────────────────────────
  _saveBindings() {
    try {
      localStorage.setItem('apexracer_keybinds',  JSON.stringify(this.keyBindings));
      localStorage.setItem('apexracer_gpbinds',   JSON.stringify(this.gamepadBindings));
      localStorage.setItem('apexracer_deadzone',  String(this.deadzone));
    } catch(e) { /* storage unavailable */ }
  }

  _loadBindings() {
    try {
      const kb = localStorage.getItem('apexracer_keybinds');
      const gp = localStorage.getItem('apexracer_gpbinds');
      const dz = localStorage.getItem('apexracer_deadzone');
      if (kb) this.keyBindings     = { ...this.DEFAULT_KEY_BINDINGS,     ...JSON.parse(kb) };
      if (gp) this.gamepadBindings = { ...this.DEFAULT_GAMEPAD_BINDINGS, ...JSON.parse(gp) };
      if (dz) this.deadzone        = parseFloat(dz);
    } catch(e) { /* corrupt storage — use defaults */ }
  }

  // ── Helpers ───────────────────────────────────────────────
  _deepClone(obj) { return JSON.parse(JSON.stringify(obj)); }

  // Friendly display name for a KeyboardEvent.code string
  static codeLabel(code) {
    const map = {
      ArrowUp:'↑', ArrowDown:'↓', ArrowLeft:'←', ArrowRight:'→',
      Space:'SPACE', ShiftLeft:'L.SHIFT', ShiftRight:'R.SHIFT',
      ControlLeft:'L.CTRL', ControlRight:'R.CTRL',
      AltLeft:'L.ALT', AltRight:'R.ALT',
    };
    if (map[code]) return map[code];
    // KeyW → W,  Digit3 → 3,  Numpad0 → NUM0
    if (code.startsWith('Key'))    return code.slice(3);
    if (code.startsWith('Digit'))  return code.slice(5);
    if (code.startsWith('Numpad')) return 'NUM' + code.slice(6);
    return code;
  }

  // Friendly display name for a gamepad button index
  static buttonLabel(index) {
    const map = {
      0:'A / ✕', 1:'B / ○', 2:'X / □', 3:'Y / △',
      4:'LB / L1', 5:'RB / R1', 6:'LT / L2', 7:'RT / R2',
      8:'SELECT', 9:'START',
      10:'L3', 11:'R3',
      12:'D↑', 13:'D↓', 14:'D←', 15:'D→',
    };
    return map[index] !== undefined ? map[index] : 'BTN ' + index;
  }

  // Friendly display name for a gamepad axis index
  static axisLabel(index) {
    const map = { 0:'L.STICK X', 1:'L.STICK Y', 2:'R.STICK X', 3:'R.STICK Y', 4:'LT AXIS', 5:'RT AXIS' };
    return map[index] !== undefined ? map[index] : 'AXIS ' + index;
  }

  // Returns name of connected gamepad or null
  get connectedGamepadName() {
    if (this._gamepadIndex === -1) return null;
    const pad = (navigator.getGamepads ? navigator.getGamepads() : [])[this._gamepadIndex];
    return pad ? pad.id : null;
  }
}

// ── Singleton ─────────────────────────────────────────────────
window.inputManager = new InputManager();