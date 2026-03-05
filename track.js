// =============================================================
//  TRACK.JS — Track loading and default oval builder
//
//  buildTrack(scene, chosenMap, onPhysicsReady)
//    — chosenMap: 'figure8' | 'oval' | 'hooked'
//    — onPhysicsReady(trackData) fires once physics are settled
//
//  GLB Naming Convention (Blender object names):
//  ─────────────────────────────────────────────
//  spawn.0, spawn.1 …        Car start positions (grid slots).
//                             Position = world pos. Rotation Y = facing dir.
//                             spawn.0 is always the player start.
//
//  checkpoint.01, checkpoint.02 … Lap triggers, ordered by suffix.
//                             Uses Empty position + scale for trigger box size.
//                             checkpoint.01 is the start/finish line.
//
//  wall.*, barrier.*, fence.* Solid collision walls.
//
//  surface.asphalt.*          High-grip tarmac  (friction 0.90, restitution 0.04)
//  surface.gravel.*           Loose gravel      (friction 0.45, restitution 0.06)
//  surface.ice.*              Icy surface       (friction 0.12, restitution 0.02)
//  surface.dirt.*             Dirt / off-road   (friction 0.60, restitution 0.05)
//  surface.curb.*             Kerb strips       (friction 0.65, restitution 0.30)
//  surface.grass.*            Grass / runoff    (friction 0.50, restitution 0.05)
//  (anything else)            Falls back to asphalt physics + asphalt material
//
//  racing_line                Single Bezier/Poly curve — sampled into
//                             trackData.racingLine as Vector3[]. Not physical.
//
//  trackData shape (returned + passed to onPhysicsReady):
//  {
//    startPos      : Vector3          — player spawn position
//    startRot      : Quaternion       — player spawn rotation
//    spawns        : [{pos, rot}]     — all grid slots incl. [0]
//    checkpoints   : [{mesh, index}]  — ordered trigger boxes
//    checkpoint    : Mesh             — shorthand = checkpoints[0].mesh  (lap line)
//    surfaces      : Map<Mesh, surfaceDef>  — physics props per mesh
//    racingLine    : Vector3[]        — AI / ghost path (empty if not in GLB)
//  }
// =============================================================

const trackSurfaces = new Set();

// ── Surface definitions ──────────────────────────────────────
const SURFACE_DEFS = {
  asphalt: { friction: 0.90, restitution: 0.04, grip: 1.00, label: 'asphalt' },
  gravel:  { friction: 0.45, restitution: 0.06, grip: 0.45, label: 'gravel'  },
  ice:     { friction: 0.12, restitution: 0.02, grip: 0.12, label: 'ice'     },
  dirt:    { friction: 0.60, restitution: 0.05, grip: 0.60, label: 'dirt'    },
  curb:    { friction: 0.65, restitution: 0.30, grip: 0.70, label: 'curb'    },
  grass:   { friction: 0.50, restitution: 0.05, grip: 0.55, label: 'grass'   },
  _default:{ friction: 0.90, restitution: 0.04, grip: 1.00, label: 'asphalt' },
};

// ── buildTrack ───────────────────────────────────────────────
async function buildTrack(scene, chosenMap, onPhysicsReady) {
  const B = BABYLON;

  const cp = B.MeshBuilder.CreateBox('cp', { width: 20, height: 5, depth: 5 }, scene);
  cp.isVisible  = false;
  cp.isPickable = false;

  const trackData = {
    startPos:    new B.Vector3(0, 2.5, 0),
    startRot:    B.Quaternion.RotationAxis(B.Vector3.Up(), 0),
    checkpoint:  cp,
    spawns:      [],
    checkpoints: [],
    surfaces:    new Map(),
    racingLine:  [],
  };

  if (chosenMap === 'figure8') {
    await _loadGLB(scene, trackData, cp, onPhysicsReady, 'named8track.glb');
  } else if (chosenMap === 'hooked') {
    await _loadGLB(scene, trackData, cp, onPhysicsReady, 'hooked.glb');
  } else {
    // default: oval
    _buildOval(scene, trackData, cp);
    _waitPhysicsTicks(scene, 4, () => onPhysicsReady(trackData));
  }

  return trackData;
}

// ── GLB loader ───────────────────────────────────────────────
async function _loadGLB(scene, trackData, cpFallback, onPhysicsReady, filename) {
  const B = BABYLON;

  try {
    const result = await B.SceneLoader.ImportMeshAsync(
      '', '', filename, scene, null, '.glb'
    );

    console.log('[Track] GLB nodes:', result.meshes.map(m =>
      m.name + '(' + m.getTotalVertices() + 'v)').join(', '));

    // Empties export as TransformNodes in GLB, not meshes.
    // Scan both so spawn.* and checkpoint.* work whether the
    // user exports them as empties or as zero-geometry meshes.
    const allNodes = [
      ...result.meshes,
      ...(result.transformNodes || []),
    ];

    // ── Build materials ───────────────────────────────────
    const mAsp    = _makeAsphaltMaterial(scene);
    const mWall   = _makeWallMaterial(scene);
    const mGravel = _makeSimpleMaterial('mGravel', 0.72, 0.65, 0.45, scene);
    const mIce    = _makeSimpleMaterial('mIce',    0.72, 0.88, 0.98, scene);
    const mDirt   = _makeSimpleMaterial('mDirt',   0.38, 0.24, 0.12, scene);
    const mCurbR  = _makeCurbMaterial(scene);
    const mGrass  = _makeSimpleMaterial('mGrass',  0.22, 0.62, 0.18, scene);

    const spawnNodes      = [];
    const checkpointNodes = [];

    result.meshes.forEach(mesh => {
      mesh.backFaceCulling = false;
      const n = mesh.name.toLowerCase();

      // Skip spawn/checkpoint — handled separately via allNodes below
      if (n.startsWith('spawn.') || n.startsWith('checkpoint.')) return;

      if (n === 'racing_line' || n.startsWith('racing_line')) {
        trackData.racingLine = _sampleRacingLine(mesh);
        mesh.isVisible  = false;
        mesh.isPickable = false;
        console.log('[Track] Racing line sampled:', trackData.racingLine.length, 'points');
        return;
      }

      if (!mesh.getTotalVertices()) return;
      mesh.refreshBoundingInfo();

      if (n.startsWith('wall.') || n.startsWith('barrier.') || n.startsWith('fence.') ||
          n.includes('wall') || n.includes('barrier') || n.includes('fence')) {
        if (mesh.material) mesh.material.dispose();
        mesh.material   = mWall;
        mesh.isPickable = true;
        new B.PhysicsAggregate(mesh, B.PhysicsShapeType.MESH,
          { mass: 0, friction: 0.40, restitution: 0.25 }, scene);
        return;
      }

      if (n.startsWith('surface.')) {
        const token = n.split('.')[1] || 'asphalt';
        const def   = SURFACE_DEFS[token] || SURFACE_DEFS._default;
        _applySurface(mesh, def, token, { mAsp, mGravel, mIce, mDirt, mCurbR, mGrass }, scene, trackData);
        return;
      }

      if (mesh.material) {
        console.log('[Track] Disposing GLB material:', mesh.material.name, 'on', mesh.name);
        mesh.material.dispose();
      }
      mesh.material   = mAsp;
      mesh.isPickable = true;
      new B.PhysicsAggregate(mesh, B.PhysicsShapeType.MESH,
        { mass: 0, friction: SURFACE_DEFS._default.friction,
          restitution: SURFACE_DEFS._default.restitution }, scene);
      trackSurfaces.add(mesh);
      trackData.surfaces.set(mesh, SURFACE_DEFS._default);
    });

    // Scan all nodes (meshes + transform nodes) for spawn.* and checkpoint.*
    // Blender empties export as TransformNodes — they won't appear in result.meshes
    allNodes.forEach(node => {
      const n = node.name.toLowerCase();
      if (n.startsWith('spawn.')) {
        const idx = parseInt(n.split('.')[1]) || 0;
        // avoid duplicates if it somehow appeared in both lists
        if (!spawnNodes.find(s => s.idx === idx)) {
          spawnNodes.push({ idx, mesh: node });
        }
        if (node.isVisible !== undefined) node.isVisible = false;
      } else if (n.startsWith('checkpoint.')) {
        const idx = parseInt(n.split('.')[1]) || 0;
        if (!checkpointNodes.find(c => c.idx === idx)) {
          checkpointNodes.push({ idx, mesh: node });
        }
      }
    });

    spawnNodes.sort((a, b) => a.idx - b.idx);
    spawnNodes.forEach(({ mesh }) => {
      const pos = mesh.getAbsolutePosition().clone();
      const rot = _quatFromNode(mesh);
      trackData.spawns.push({ pos, rot });
    });

    if (trackData.spawns.length > 0) {
      trackData.startPos.copyFrom(trackData.spawns[0].pos);
      trackData.startRot.copyFrom(trackData.spawns[0].rot);
      console.log('[Track] Spawn loaded from GLB:', trackData.startPos.toString());
    } else {
      console.warn('[Track] No spawn. nodes found — using default (0, 2.5, 0).');
    }

    // ── Checkpoint materials ───────────────────────────────
    // Intermediate checkpoints — yellow / orange
    const mCpInactive = new B.StandardMaterial('mCpInactive', scene);
    mCpInactive.diffuseColor  = new B.Color3(1.0, 0.85, 0.0);
    mCpInactive.emissiveColor = new B.Color3(0.3, 0.25, 0.0);
    mCpInactive.alpha         = 0.28;
    mCpInactive.backFaceCulling = false;

    const mCpActive = new B.StandardMaterial('mCpActive', scene);
    mCpActive.diffuseColor  = new B.Color3(1.0, 0.45, 0.0);
    mCpActive.emissiveColor = new B.Color3(0.5, 0.18, 0.0);
    mCpActive.alpha         = 0.52;
    mCpActive.backFaceCulling = false;

    // S/F line — light blue / purple
    const mSFInactive = new B.StandardMaterial('mSFInactive', scene);
    mSFInactive.diffuseColor  = new B.Color3(0.55, 0.80, 1.0);
    mSFInactive.emissiveColor = new B.Color3(0.10, 0.20, 0.40);
    mSFInactive.alpha         = 0.35;
    mSFInactive.backFaceCulling = false;

    const mSFActive = new B.StandardMaterial('mSFActive', scene);
    mSFActive.diffuseColor  = new B.Color3(0.75, 0.50, 1.0);
    mSFActive.emissiveColor = new B.Color3(0.30, 0.10, 0.60);
    mSFActive.alpha         = 0.60;
    mSFActive.backFaceCulling = false;

    trackData._cpMatInactive = mCpInactive;
    trackData._cpMatActive   = mCpActive;
    trackData._sfMatInactive = mSFInactive;
    trackData._sfMatActive   = mSFActive;

    checkpointNodes.sort((a, b) => a.idx - b.idx);
    checkpointNodes.forEach(({ idx, mesh }, arrIdx) => {
      // Force world matrix so absolutePosition/Rotation are correct
      mesh.computeWorldMatrix(true);
      const scale = mesh.scaling || new B.Vector3(1, 1, 1);
      const trigger = B.MeshBuilder.CreateBox('cp_' + idx, {
        width:  Math.max(2, Math.abs(scale.x) * 2),
        height: Math.max(4, Math.abs(scale.y) * 2),
        depth:  Math.max(2, Math.abs(scale.z) * 2),
      }, scene);
      trigger.position.copyFrom(mesh.getAbsolutePosition());
      const absRot = mesh.absoluteRotationQuaternion;
      trigger.rotationQuaternion = absRot ? absRot.clone() : B.Quaternion.Identity();
      trigger._triggerRadius = Math.max(Math.abs(scale.x), Math.abs(scale.z), 4);
      // Index 0 = S/F line gets purple, rest get yellow
      trigger.material   = arrIdx === 0 ? mSFInactive : mCpInactive;
      trigger.isVisible  = true;
      trigger.isPickable = false;
      trackData.checkpoints.push({ mesh: trigger, index: idx });
      mesh.isVisible = false;
    });

    if (trackData.checkpoints.length > 0) {
      trackData.checkpoint = trackData.checkpoints[0].mesh;
      console.log('[Track]', trackData.checkpoints.length, 'checkpoint(s) loaded from GLB.');
    } else {
      cpFallback.position.set(0, 2, 60);
      trackData.checkpoint = cpFallback;
      console.warn('[Track] No checkpoint. nodes found — using fallback position (0,2,60).');
    }

    console.log('[Track] GLB parse complete. Surfaces:', trackData.surfaces.size,
      '| Spawns:', trackData.spawns.length,
      '| Checkpoints:', trackData.checkpoints.length,
      '| Racing line pts:', trackData.racingLine.length);

    _waitPhysicsTicks(scene, 20, () => onPhysicsReady(trackData));

  } catch (e) {
    console.warn('[Track] GLB load failed — falling back to oval:', e);
    _buildOval(scene, trackData, cpFallback);
    _waitPhysicsTicks(scene, 4, () => onPhysicsReady(trackData));
  }
}

// ── Apply surface material + physics to a mesh ───────────────
function _applySurface(mesh, def, token, mats, scene, trackData) {
  const B = BABYLON;
  if (mesh.material) mesh.material.dispose();
  switch (token) {
    case 'gravel': mesh.material = mats.mGravel; break;
    case 'ice':    mesh.material = mats.mIce;    break;
    case 'dirt':   mesh.material = mats.mDirt;   break;
    case 'curb':   mesh.material = mats.mCurbR;  break;
    case 'grass':  mesh.material = mats.mGrass;  break;
    default:       mesh.material = mats.mAsp;    break;
  }
  mesh.isPickable = true;
  new B.PhysicsAggregate(mesh, B.PhysicsShapeType.MESH,
    { mass: 0, friction: def.friction, restitution: def.restitution }, scene);
  trackSurfaces.add(mesh);
  trackData.surfaces.set(mesh, def);
}

// ── Sample a racing line mesh's vertex positions ─────────────
function _sampleRacingLine(mesh) {
  const B = BABYLON;
  const verts = mesh.getVerticesData(B.VertexBuffer.PositionKind);
  if (!verts) return [];
  const pts = [];
  for (let i = 0; i < verts.length - 2; i += 6) {
    pts.push(new B.Vector3(verts[i], verts[i + 1], verts[i + 2]));
  }
  return pts;
}

// ── Extract a world-space quaternion from a node ─────────────
function _quatFromNode(mesh) {
  const B = BABYLON;
  if (mesh.rotationQuaternion) return mesh.rotationQuaternion.clone();
  if (mesh.rotation) {
    return B.Quaternion.RotationYawPitchRoll(
      mesh.rotation.y, mesh.rotation.x, mesh.rotation.z);
  }
  return B.Quaternion.Identity();
}

// ── Material helpers ─────────────────────────────────────────
function _makeSimpleMaterial(name, r, g, b, scene) {
  const B = BABYLON;
  const m = new B.StandardMaterial(name, scene);
  m.diffuseColor    = new B.Color3(r, g, b);
  m.backFaceCulling = false;
  return m;
}

function _makeWallMaterial(scene) {
  const B = BABYLON;
  const m = new B.StandardMaterial('mWall', scene);
  m.diffuseColor    = new B.Color3(0.08, 0.28, 0.92);
  m.emissiveColor   = new B.Color3(0.01, 0.05, 0.18);
  m.backFaceCulling = false;
  return m;
}

function _makeCurbMaterial(scene) {
  const B    = BABYLON;
  const SIZE = 512;
  let tex = null;
  try {
    tex = new B.DynamicTexture('curbTex', { width: SIZE, height: SIZE }, scene, true);
    tex.wrapU = B.Texture.WRAP_ADDRESSMODE;
    tex.wrapV = B.Texture.WRAP_ADDRESSMODE;
    tex.uScale = 8;
    tex.vScale = 1;
    const ctx     = tex.getContext();
    const STRIPES = 64;
    const SW      = SIZE / STRIPES;
    for (let i = 0; i < STRIPES; i++) {
      ctx.fillStyle = (i % 2 === 0) ? '#ff1a1a' : '#ffffff';
      ctx.fillRect(i * SW, 0, SW, SIZE);
    }
    tex.update(false);
  } catch (err) {
    console.error('[Curb] DynamicTexture failed:', err);
    tex = null;
  }
  const m = new B.StandardMaterial('mCurb', scene);
  if (tex) {
    m.diffuseTexture  = tex;
    m.emissiveTexture = tex;
  } else {
    m.diffuseColor  = new B.Color3(0.95, 0.07, 0.07);
    m.emissiveColor = new B.Color3(0.4,  0.02, 0.02);
  }
  m.backFaceCulling = false;
  return m;
}

function _makeAsphaltMaterial(scene) {
  const B    = BABYLON;
  const SIZE = 512;
  let aspTex = null;

  try {
    aspTex = new B.DynamicTexture('aspTex', { width: SIZE, height: SIZE }, scene, true);
    aspTex.wrapU = B.Texture.WRAP_ADDRESSMODE;
    aspTex.wrapV = B.Texture.WRAP_ADDRESSMODE;

    const ctx = aspTex.getContext();
    const S   = SIZE;
    ctx.fillStyle = '#28282c';
    ctx.fillRect(0, 0, S, S);

    for (let i = 0; i < 18000; i++) {
      const x  = (i * 1619 + 7)  % S;
      const y  = (i * 1013 + 31) % S;
      const r  = 0.4 + (i % 5) * 0.22;
      const br = 58 + (i % 38);
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = `rgb(${br+18},${br+16},${br+20})`;
      ctx.fill();
    }
    for (let i = 0; i < 5000; i++) {
      const x  = (i * 2311 + 53) % S;
      const y  = (i * 1777 + 97) % S;
      const r  = 0.5 + (i % 3) * 0.3;
      const br = 12 + (i % 12);
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = `rgb(${br},${br},${br+2})`;
      ctx.fill();
    }
    for (let i = 0; i < 110; i++) {
      const y   = (i * (S / 110)) + (i % 7) * 1.2;
      const alp = 0.015 + (i % 4) * 0.005;
      ctx.fillStyle = `rgba(195,195,205,${alp.toFixed(3)})`;
      ctx.fillRect(0, y, S, 0.5 + (i % 3) * 0.5);
    }
    ctx.strokeStyle = 'rgba(14,14,16,0.5)';
    ctx.lineWidth = 1;
    for (let g = 128; g < S; g += 128) {
      ctx.beginPath(); ctx.moveTo(g, 0); ctx.lineTo(g, S); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, g); ctx.lineTo(S, g); ctx.stroke();
    }

    aspTex.update(false);
  } catch (err) {
    console.error('[Asphalt] DynamicTexture failed:', err);
    aspTex = null;
  }

  const m = new B.StandardMaterial('mAsp', scene);
  if (aspTex) {
    m.diffuseTexture = aspTex;
  } else {
    m.diffuseColor = new B.Color3(0.18, 0.18, 0.22);
  }
  m.specularColor   = new B.Color3(0.06, 0.06, 0.07);
  m.specularPower   = 80;
  m.backFaceCulling = false;
  return m;
}

// ── Procedural oval ──────────────────────────────────────────
function _buildOval(scene, trackData, cp) {
  const B  = BABYLON;
  const OX = 60, OZ = 38, TW = 14;
  const IX = OX - TW, IZ = OZ - TW;
  const SEG = 120;

  trackData.startPos.set(OX - TW / 2, 1.8, -4);
  trackData.startRot.copyFrom(
    B.Quaternion.RotationAxis(B.Vector3.Up(), -Math.PI / 2)
  );
  trackData.spawns = [{ pos: trackData.startPos.clone(), rot: trackData.startRot.clone() }];

  cp.position.set(OX - TW / 2, 1, 0);
  trackData.checkpoints = [{ mesh: cp, index: 1 }];
  trackData.checkpoint  = cp;

  const mAsp  = new B.StandardMaterial('asp', scene);
  mAsp.diffuseColor = new B.Color3(0.17, 0.17, 0.21);

  const mCR = new B.StandardMaterial('cr2', scene);
  mCR.diffuseColor = new B.Color3(0.95, 0.07, 0.07);

  const mCW = new B.StandardMaterial('cw2', scene);
  mCW.diffuseColor = new B.Color3(0.96, 0.96, 0.96);

  const mWall = new B.StandardMaterial('wall_oval', scene);
  mWall.diffuseColor = new B.Color3(0.08, 0.28, 0.92);

  function ovalPts(rx, rz, n) {
    const p = [];
    for (let i = 0; i <= n; i++) {
      const t = (i / n) * Math.PI * 2;
      p.push(new B.Vector3(Math.cos(t) * rx, 0, Math.sin(t) * rz));
    }
    return p;
  }

  const op = ovalPts(OX, OZ, SEG);
  const ip = ovalPts(IX, IZ, SEG);
  const pos = [], idx = [], nrm = [], uvs = [];

  for (let i = 0; i < SEG; i++) {
    const b = i * 4;
    pos.push(
      op[i].x, 0, op[i].z, op[i+1].x, 0, op[i+1].z,
      ip[i].x, 0, ip[i].z, ip[i+1].x, 0, ip[i+1].z
    );
    nrm.push(0,1,0, 0,1,0, 0,1,0, 0,1,0);
    uvs.push(0,0, 1,0, 0,1, 1,1);
    idx.push(b, b+2, b+1, b+1, b+2, b+3);
  }

  const trk = new B.Mesh('trk', scene);
  const vd  = new B.VertexData();
  vd.positions = pos; vd.indices = idx; vd.normals = nrm; vd.uvs = uvs;
  vd.applyToMesh(trk);
  trk.material   = mAsp;
  trk.isPickable = true;
  new B.PhysicsAggregate(trk, B.PhysicsShapeType.MESH,
    { mass: 0, friction: 0.9, restitution: 0.04 }, scene);
  trackSurfaces.add(trk);
  trackData.surfaces.set(trk, SURFACE_DEFS.asphalt);

  const CURB_D = 1.2, WALL_D = 0.55, WALL_H = 1.8, CURB_H = 0.09;

  function curbRing(prefix, rx, rz, n) {
    for (let i = 0; i < n; i++) {
      const ca  = Math.cos((i / n) * Math.PI * 2);
      const sa  = Math.sin((i / n) * Math.PI * 2);
      const eBx = Math.cos(((i+1)/n)*Math.PI*2)*rx, eBz = Math.sin(((i+1)/n)*Math.PI*2)*rz;
      const segW = Math.hypot(eBx - ca*rx, eBz - sa*rz);
      const box  = B.MeshBuilder.CreateBox(prefix+i,
        { width: segW, height: CURB_H, depth: CURB_D }, scene);
      box.position.set(ca*rx, CURB_H/2, sa*rz);
      box.rotation.y = Math.atan2(ca, sa);
      box.material   = (i%2===0) ? mCR : mCW;
      new B.PhysicsAggregate(box, B.PhysicsShapeType.BOX,
        { mass: 0, restitution: 0.3, friction: 0.6 }, scene);
      trackSurfaces.add(box);
      trackData.surfaces.set(box, SURFACE_DEFS.curb);
    }
  }

  function wallRing(prefix, rx, rz, n) {
    for (let i = 0; i < n; i++) {
      const ca  = Math.cos((i / n) * Math.PI * 2);
      const sa  = Math.sin((i / n) * Math.PI * 2);
      const eBx = Math.cos(((i+1)/n)*Math.PI*2)*rx, eBz = Math.sin(((i+1)/n)*Math.PI*2)*rz;
      const segW = Math.hypot(eBx - ca*rx, eBz - sa*rz);
      const box  = B.MeshBuilder.CreateBox(prefix+i,
        { width: segW, height: WALL_H, depth: WALL_D }, scene);
      box.position.set(ca*rx, WALL_H/2, sa*rz);
      box.rotation.y = Math.atan2(ca, sa);
      box.material   = mWall;
      new B.PhysicsAggregate(box, B.PhysicsShapeType.BOX,
        { mass: 0, restitution: 0.22, friction: 0.5 }, scene);
    }
  }

  curbRing('oc', OX+CURB_D/2,          OZ+CURB_D/2,          48);
  curbRing('ic', IX-CURB_D/2,          IZ-CURB_D/2,          40);
  wallRing('ow', OX+CURB_D+WALL_D/2,   OZ+CURB_D+WALL_D/2,   48);
  wallRing('iw', IX-CURB_D-WALL_D/2,   IZ-CURB_D-WALL_D/2,   40);
}

// ── Utility: fire callback after n physics ticks ─────────────
function _waitPhysicsTicks(scene, n, cb) {
  let ticks = 0;
  const obs = scene.onAfterPhysicsObservable.add(() => {
    if (++ticks >= n) {
      scene.onAfterPhysicsObservable.remove(obs);
      cb();
    }
  });
}