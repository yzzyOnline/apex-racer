// =============================================================
//  TRACK.JS — Track loading and default oval builder
//
//  buildTrack(scene, chosenMap)
//    — Orchestrates track selection. Always call this once.
//    — chosenMap: 'figure8' | 'oval'
//    — Returns a trackData promise: { startPos, startRot, checkpoint }
//
//  Eliminates the window._trackData / window._respawnCar coupling
//  that made the previous version's control flow untraceable.
//  main.js passes a respawn callback directly into buildTrack.
// =============================================================

const trackSurfaces = new Set();

// ── buildTrack ───────────────────────────────────────────────
// Returns a Promise<trackData>. The caller awaits it, then spawns
// the car once both the track geometry and physics are ready.
// onPhysicsReady(trackData) is called when it's safe to spawn.
async function buildTrack(scene, chosenMap, onPhysicsReady) {
  const B = BABYLON;

  // Checkpoint trigger — shared by both track types
  const cp = B.MeshBuilder.CreateBox('cp', { width: 20, height: 5, depth: 5 }, scene);
  cp.isVisible  = false;
  cp.isPickable = false;

  const trackData = {
    startPos:   new B.Vector3(0, 2.5, 0),
    startRot:   B.Quaternion.RotationAxis(B.Vector3.Up(), 0),
    checkpoint: cp,
  };

  if (chosenMap === 'figure8') {
    await _loadGLB(scene, trackData, cp, onPhysicsReady);
  } else {
    _buildOval(scene, trackData, cp);
    // Oval is synchronous — fire callback immediately after a couple of
    // physics ticks so the rigid bodies are registered.
    _waitPhysicsTicks(scene, 4, () => onPhysicsReady(trackData));
  }

  return trackData;
}

// ── GLB loader ───────────────────────────────────────────────
async function _loadGLB(scene, trackData, cp, onPhysicsReady) {
  const B = BABYLON;
  cp.position.set(0, 2, 60);

  try {
    const result = await B.SceneLoader.ImportMeshAsync(
      '', '', 'named8track.glb', scene, null, '.glb'
    );

    // Log all mesh names to console for debugging
    console.log('[Track] GLB meshes:', result.meshes.map(m =>
      m.name + '(' + m.getTotalVertices() + 'v)').join(', '));

    // ── Procedural asphalt DynamicTexture ────────────────────
    console.log('[Asphalt] Building DynamicTexture...');
    const ASP_SIZE = 512;
    let aspTex;
    try {
      aspTex = new B.DynamicTexture('aspTex',
        { width: ASP_SIZE, height: ASP_SIZE }, scene, true);
      aspTex.wrapU = B.Texture.WRAP_ADDRESSMODE;
      aspTex.wrapV = B.Texture.WRAP_ADDRESSMODE;
      aspTex.uScale = 1;
      aspTex.vScale = 1;

      const ctx = aspTex.getContext();
      console.log('[Asphalt] Canvas context:', ctx ? 'OK' : 'NULL');

      const S = ASP_SIZE;
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

      // Verify a pixel was actually drawn before update
      const sample = ctx.getImageData(256, 256, 1, 1).data;
      console.log('[Asphalt] Canvas pixel at (256,256) before update: rgba(' +
        sample[0]+','+sample[1]+','+sample[2]+','+sample[3]+')');

      aspTex.update(false);
      console.log('[Asphalt] DynamicTexture update() called. isReady:', aspTex.isReady());

    } catch(texErr) {
      console.error('[Asphalt] DynamicTexture FAILED:', texErr);
      aspTex = null;
    }

    // ── Asphalt material ──────────────────────────────────────
    const mAsp = new B.StandardMaterial('mAsp', scene);
    if (aspTex) {
      mAsp.diffuseTexture = aspTex;
      console.log('[Asphalt] diffuseTexture assigned to mAsp');
    } else {
      mAsp.diffuseColor = new B.Color3(0.18, 0.18, 0.22);
      console.warn('[Asphalt] Fallback to diffuseColor — texture failed');
    }
    mAsp.specularColor   = new B.Color3(0.06, 0.06, 0.07);
    mAsp.specularPower   = 80;
    mAsp.backFaceCulling = false;

    const mWall = new B.StandardMaterial('mWall', scene);
    mWall.diffuseColor  = new B.Color3(0.08, 0.28, 0.92);
    mWall.emissiveColor = new B.Color3(0.01, 0.05, 0.18);
    mWall.backFaceCulling = false;

    result.meshes.forEach(mesh => {
      mesh.backFaceCulling = false;
      if (!mesh.getTotalVertices()) return;
      mesh.refreshBoundingInfo();
      const n = mesh.name.toLowerCase();

      const isWall = n.includes('wall') || n.includes('barrier') || n.includes('fence');

      if (isWall) {
        // Dispose GLB-embedded material before assigning ours
        if (mesh.material) mesh.material.dispose();
        mesh.material   = mWall;
        mesh.isPickable = true;
        new B.PhysicsAggregate(mesh, B.PhysicsShapeType.MESH,
          { mass: 0, friction: 0.4, restitution: 0.25 }, scene);
      } else {
        // Dispose GLB-embedded material — Babylon re-applies it after import
        // and it overrides whatever we assign, rendering the mesh black.
        if (mesh.material) {
          console.log('[Track] Disposing GLB material:', mesh.material.name,
            'type:', mesh.material.getClassName());
          mesh.material.dispose();
        }
        mesh.material   = mAsp;
        mesh.isPickable = true;
        new B.PhysicsAggregate(mesh, B.PhysicsShapeType.MESH,
          { mass: 0, friction: 0.9, restitution: 0.04 }, scene);
        trackSurfaces.add(mesh);
      }
    });

    // Wait for physics to settle, then signal the caller
    _waitPhysicsTicks(scene, 20, () => onPhysicsReady(trackData));

  } catch (e) {
    console.warn('GLB load failed — falling back to oval:', e);
    // Tear down the GLB checkpoint position and build oval instead
    _buildOval(scene, trackData, cp);
    _waitPhysicsTicks(scene, 4, () => onPhysicsReady(trackData));
  }
}

// ── Procedural oval ──────────────────────────────────────────
// Fully self-contained — does NOT read or write window._trackData.
// Updates trackData and cp in-place so the caller's reference stays valid.
function _buildOval(scene, trackData, cp) {
  const B  = BABYLON;
  const OX = 60, OZ = 38, TW = 14;
  const IX = OX - TW, IZ = OZ - TW;
  const SEG = 120;

  // Start position and checkpoint for oval layout
  trackData.startPos.set(OX - TW / 2, 1.8, -4);
  trackData.startRot.copyFrom(
    B.Quaternion.RotationAxis(B.Vector3.Up(), -Math.PI / 2)
  );
  cp.position.set(OX - TW / 2, 1, 0);

  // Materials
  const mAsp = new B.StandardMaterial('asp', scene);
  mAsp.diffuseColor = new B.Color3(0.17, 0.17, 0.21);

  const mCR = new B.StandardMaterial('cr2', scene);
  mCR.diffuseColor = new B.Color3(0.95, 0.07, 0.07);

  const mCW = new B.StandardMaterial('cw2', scene);
  mCW.diffuseColor = new B.Color3(0.96, 0.96, 0.96);

  const mWall = new B.StandardMaterial('wall_oval', scene);
  mWall.diffuseColor = new B.Color3(0.08, 0.28, 0.92);

  // ── Track surface mesh ───────────────────────────────────
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
      op[i].x, 0, op[i].z,
      op[i+1].x, 0, op[i+1].z,
      ip[i].x, 0, ip[i].z,
      ip[i+1].x, 0, ip[i+1].z
    );
    nrm.push(0,1,0, 0,1,0, 0,1,0, 0,1,0);
    uvs.push(0,0, 1,0, 0,1, 1,1);
    idx.push(b, b+2, b+1, b+1, b+2, b+3);
  }

  const trk = new B.Mesh('trk', scene);
  const vd  = new B.VertexData();
  vd.positions = pos;
  vd.indices   = idx;
  vd.normals   = nrm;
  vd.uvs       = uvs;
  vd.applyToMesh(trk);
  trk.material  = mAsp;
  trk.isPickable = true;
  new B.PhysicsAggregate(trk, B.PhysicsShapeType.MESH,
    { mass: 0, friction: 0.9, restitution: 0.04 }, scene);
  trackSurfaces.add(trk);

  // ── Curbs and barriers ───────────────────────────────────
  const CURB_D = 1.2, WALL_D = 0.55, WALL_H = 1.8, CURB_H = 0.09;

  function curbRing(prefix, rx, rz, n) {
    for (let i = 0; i < n; i++) {
      const ca  = Math.cos((i / n) * Math.PI * 2);
      const sa  = Math.sin((i / n) * Math.PI * 2);
      const eBx = Math.cos(((i+1) / n) * Math.PI * 2) * rx;
      const eBz = Math.sin(((i+1) / n) * Math.PI * 2) * rz;
      const eAx = ca * rx, eAz = sa * rz;
      const segW = Math.hypot(eBx - eAx, eBz - eAz);

      const box = B.MeshBuilder.CreateBox(prefix + i,
        { width: segW, height: CURB_H, depth: CURB_D }, scene);
      box.position.set(ca * rx, CURB_H / 2, sa * rz);
      box.rotation.y = Math.atan2(ca, sa);
      box.material   = (i % 2 === 0) ? mCR : mCW;
      new B.PhysicsAggregate(box, B.PhysicsShapeType.BOX,
        { mass: 0, restitution: 0.3, friction: 0.6 }, scene);
      trackSurfaces.add(box);
    }
  }

  function wallRing(prefix, rx, rz, n) {
    for (let i = 0; i < n; i++) {
      const ca  = Math.cos((i / n) * Math.PI * 2);
      const sa  = Math.sin((i / n) * Math.PI * 2);
      const eBx = Math.cos(((i+1) / n) * Math.PI * 2) * rx;
      const eBz = Math.sin(((i+1) / n) * Math.PI * 2) * rz;
      const eAx = ca * rx, eAz = sa * rz;
      const segW = Math.hypot(eBx - eAx, eBz - eAz);

      const box = B.MeshBuilder.CreateBox(prefix + i,
        { width: segW, height: WALL_H, depth: WALL_D }, scene);
      box.position.set(ca * rx, WALL_H / 2, sa * rz);
      box.rotation.y = Math.atan2(ca, sa);
      box.material   = mWall;
      new B.PhysicsAggregate(box, B.PhysicsShapeType.BOX,
        { mass: 0, restitution: 0.22, friction: 0.5 }, scene);
    }
  }

  curbRing('oc', OX + CURB_D / 2,           OZ + CURB_D / 2,           48);
  curbRing('ic', IX - CURB_D / 2,           IZ - CURB_D / 2,           40);
  wallRing('ow', OX + CURB_D + WALL_D / 2,  OZ + CURB_D + WALL_D / 2,  48);
  wallRing('iw', IX - CURB_D - WALL_D / 2,  IZ - CURB_D - WALL_D / 2,  40);
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