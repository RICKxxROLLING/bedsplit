// Splitter core: plane slicing, capping, connectors, exporters.
(function (root) {
  'use strict';
  const THREE = root.THREE || (typeof require !== 'undefined' ? require('three') : null);

  // ---------- mesh helpers ----------
  function weld(positions, tol) {
    tol = tol || 1e-4;
    const inv = 1 / tol, map = new Map(), pos = [], n = positions.length / 3;
    const ids = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      const x = positions[3 * i], y = positions[3 * i + 1], z = positions[3 * i + 2];
      const key = Math.round(x * inv) + ',' + Math.round(y * inv) + ',' + Math.round(z * inv);
      let id = map.get(key);
      if (id === undefined) { id = pos.length / 3; pos.push(x, y, z); map.set(key, id); }
      ids[i] = id;
    }
    const tris = [];
    for (let t = 0; t < n; t += 3) {
      const a = ids[t], b = ids[t + 1], c = ids[t + 2];
      if (a !== b && b !== c && a !== c) tris.push(a, b, c);
    }
    return { pos: Float64Array.from(pos), idx: Uint32Array.from(tris) };
  }

  function fromGeometry(geom) {
    const g = geom.index ? geom.toNonIndexed() : geom;
    return weld(g.attributes.position.array);
  }

  function bbox(m) {
    const P = m.pos, mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    // only vertices referenced by triangles
    const I = m.idx;
    for (let t = 0; t < I.length; t++) {
      const i = I[t] * 3;
      for (let k = 0; k < 3; k++) { const v = P[i + k]; if (v < mn[k]) mn[k] = v; if (v > mx[k]) mx[k] = v; }
    }
    return { min: mn, max: mx, size: [mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]] };
  }

  function volume(m) {
    const P = m.pos, I = m.idx; let v = 0;
    for (let t = 0; t < I.length; t += 3) {
      const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
      v += P[a] * (P[b + 1] * P[c + 2] - P[b + 2] * P[c + 1])
         - P[a + 1] * (P[b] * P[c + 2] - P[b + 2] * P[c])
         + P[a + 2] * (P[b] * P[c + 1] - P[b + 1] * P[c]);
    }
    return v / 6;
  }

  function transform(m, fn) { // fn(x,y,z) -> [x,y,z]
    const P = new Float64Array(m.pos.length);
    for (let i = 0; i < P.length; i += 3) { const r = fn(m.pos[i], m.pos[i + 1], m.pos[i + 2]); P[i] = r[0]; P[i + 1] = r[1]; P[i + 2] = r[2]; }
    return { pos: P, idx: m.idx };
  }
  function flip(m) { const I = Uint32Array.from(m.idx); for (let t = 0; t < I.length; t += 3) { const x = I[t + 1]; I[t + 1] = I[t + 2]; I[t + 2] = x; } return { pos: m.pos, idx: I }; }

  function openEdges(m) { // count of directed edges without an opposite partner
    const I = m.idx, nv = m.pos.length / 3, cnt = new Map();
    for (let t = 0; t < I.length; t += 3) for (let e = 0; e < 3; e++) {
      const a = I[t + e], b = I[t + (e + 1) % 3];
      const key = a * nv + b; cnt.set(key, (cnt.get(key) || 0) + 1);
    }
    let bad = 0;
    cnt.forEach((n, key) => { const a = Math.floor(key / nv), b = key - a * nv; const o = cnt.get(b * nv + a) || 0; if (o !== n) bad++; });
    return bad;
  }

  // ---------- builder ----------
  class Builder {
    constructor(nOrig) { this.pos = []; this.idx = []; this.om = new Int32Array(nOrig).fill(-1); this.cm = new Map(); }
    orig(i, P) { let v = this.om[i]; if (v < 0) { v = this.pos.length / 3; this.pos.push(P[3 * i], P[3 * i + 1], P[3 * i + 2]); this.om[i] = v; } return v; }
    cut(j, C) { let v = this.cm.get(j); if (v === undefined) { v = this.pos.length / 3; this.pos.push(C[3 * j], C[3 * j + 1], C[3 * j + 2]); this.cm.set(j, v); } return v; }
    add(x, y, z) { const v = this.pos.length / 3; this.pos.push(x, y, z); return v; }
    tri(a, b, c) { this.idx.push(a, b, c); }
    triN(a, b, c, n) {
      const P = this.pos;
      const ux = P[3 * b] - P[3 * a], uy = P[3 * b + 1] - P[3 * a + 1], uz = P[3 * b + 2] - P[3 * a + 2];
      const vx = P[3 * c] - P[3 * a], vy = P[3 * c + 1] - P[3 * a + 1], vz = P[3 * c + 2] - P[3 * a + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      if (nx * n[0] + ny * n[1] + nz * n[2] < 0) this.idx.push(a, c, b); else this.idx.push(a, b, c);
    }
    empty() { return this.idx.length === 0; }
    mesh() { return { pos: Float64Array.from(this.pos), idx: Uint32Array.from(this.idx) }; }
  }

  // ---------- 2D helpers ----------
  function area2(pts) { let a = 0; for (let i = 0, n = pts.length; i < n; i++) { const p = pts[i], q = pts[(i + 1) % n]; a += p[0] * q[1] - q[0] * p[1]; } return a / 2; }
  function inPoly(x, y, pts) {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const xi = pts[i][0], yi = pts[i][1], xj = pts[j][0], yj = pts[j][1];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  function segDist2(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay; const l = dx * dx + dy * dy;
    let t = l > 0 ? ((px - ax) * dx + (py - ay) * dy) / l : 0; t = t < 0 ? 0 : t > 1 ? 1 : t;
    const ex = ax + t * dx - px, ey = ay + t * dy - py; return ex * ex + ey * ey;
  }

  // ray from plane point along +/-k; returns distance to first surface, or Infinity. tris: filtered Uint32Array
  function rayDist(P, tris, k, c, pu, pv, dir) {
    const u = (k + 1) % 3, v = (k + 2) % 3; let best = Infinity;
    for (let t = 0; t < tris.length; t += 3) {
      const a = tris[t] * 3, b = tris[t + 1] * 3, cc = tris[t + 2] * 3;
      const ua = P[a + u], ub = P[b + u], uc = P[cc + u];
      if (pu < ua && pu < ub && pu < uc) continue; if (pu > ua && pu > ub && pu > uc) continue;
      const va = P[a + v], vb = P[b + v], vc = P[cc + v];
      if (pv < va && pv < vb && pv < vc) continue; if (pv > va && pv > vb && pv > vc) continue;
      const det = (vb - vc) * (ua - uc) + (uc - ub) * (va - vc); if (Math.abs(det) < 1e-12) continue;
      const l1 = ((vb - vc) * (pu - uc) + (uc - ub) * (pv - vc)) / det;
      const l2 = ((vc - va) * (pu - uc) + (ua - uc) * (pv - vc)) / det; const l3 = 1 - l1 - l2;
      if (l1 < -1e-9 || l2 < -1e-9 || l3 < -1e-9) continue;
      const kk = l1 * P[a + k] + l2 * P[b + k] + l3 * P[cc + k]; const tt = (kk - c) * dir;
      if (tt > 1e-6 && tt < best) best = tt;
    }
    return best;
  }

  // ---------- connector placement ----------
  function placeConnectors(outer, holes, area, spec) {
    // spec: {need, maxCount, spacing, avoid(u,v), depthOK(u,v)}
    let target = Math.min(spec.maxCount, Math.max(1, Math.floor(area / 2500)));
    if (target <= 0) return [];
    let mnU = Infinity, mnV = Infinity, mxU = -Infinity, mxV = -Infinity;
    for (const p of outer) { if (p[0] < mnU) mnU = p[0]; if (p[0] > mxU) mxU = p[0]; if (p[1] < mnV) mnV = p[1]; if (p[1] > mxV) mxV = p[1]; }
    if (mxU - mnU < 2 * spec.need || mxV - mnV < 2 * spec.need) return [];
    const edges = [];
    for (const loop of [outer].concat(holes)) for (let i = 0; i < loop.length; i++) { const p = loop[i], q = loop[(i + 1) % loop.length]; edges.push(p[0], p[1], q[0], q[1]); }
    const E = Float64Array.from(edges);
    const step = Math.max(spec.need * 0.35, Math.sqrt(area / 1800));
    const need2 = spec.need * spec.need, cands = [];
    for (let pu = mnU + step / 2; pu < mxU; pu += step) for (let pv = mnV + step / 2; pv < mxV; pv += step) {
      if (spec.avoid(pu, pv)) continue;
      if (!inPoly(pu, pv, outer)) continue;
      let inHole = false; for (const h of holes) if (inPoly(pu, pv, h)) { inHole = true; break; } if (inHole) continue;
      let md = Infinity;
      for (let e = 0; e < E.length; e += 4) { const d = segDist2(pu, pv, E[e], E[e + 1], E[e + 2], E[e + 3]); if (d < md) { md = d; if (md < need2) break; } }
      if (md >= need2) cands.push([pu, pv, md]);
    }
    if (!cands.length) return [];
    cands.sort((a, b) => b[2] - a[2]);
    const sel = []; let tries = 0; const alive = cands.slice();
    while (sel.length < target && alive.length && tries < 60) {
      let bi = -1;
      if (!sel.length) bi = 0;
      else {
        let bd = -1;
        for (let i = 0; i < alive.length; i++) {
          let m = Infinity; for (const s of sel) { const dx = alive[i][0] - s[0], dy = alive[i][1] - s[1]; m = Math.min(m, dx * dx + dy * dy); }
          const score = m + alive[i][2] * 0.05;
          if (m >= spec.spacing * spec.spacing && score > bd) { bd = score; bi = i; }
        }
        if (bi < 0) break;
      }
      const c = alive.splice(bi, 1)[0]; tries++;
      if (spec.depthOK(c[0], c[1])) sel.push(c);
    }
    return sel.map(c => [c[0], c[1]]);
  }

  // ---------- split one mesh by axis plane ----------
  // J: {type:'peg'|'dowel'|'flat', d, len, clr, wall, maxPer, avoid(u,v), gapBelow, gapAbove}
  function splitMesh(mesh, k, c, J) {
    const P = mesh.pos, I = mesh.idx, nv = P.length / 3;
    const u = (k + 1) % 3, v = (k + 2) % 3;
    // nudge the plane off any vertex it would graze (avoids sliver loops)
    for (let tries = 0; tries < 12; tries++) {
      let hit = false;
      for (let t = 0; t < I.length; t++) { const z = P[3 * I[t] + k] - c; if (z > -2e-3 && z < 2e-3) { hit = true; break; } }
      if (!hit) break; c += 0.0137 * (tries % 2 ? -(tries + 1) : (tries + 1));
    }
    const d = new Float64Array(nv);
    for (let i = 0; i < nv; i++) { let x = P[3 * i + k] - c; if (x > -1e-7 && x < 1e-7) x = 1e-7; d[i] = x; }
    const L = new Builder(nv), U = new Builder(nv);
    const cutPos = [], edgeMap = new Map();
    const cutId = (a, b) => {
      const key = a < b ? a * nv + b : b * nv + a;
      let id = edgeMap.get(key);
      if (id === undefined) {
        const t = d[a] / (d[a] - d[b]); const p = [0, 0, 0];
        for (let q = 0; q < 3; q++) p[q] = P[3 * a + q] + t * (P[3 * b + q] - P[3 * a + q]);
        p[k] = c; id = cutPos.length / 3; cutPos.push(p[0], p[1], p[2]); edgeMap.set(key, id);
      }
      return id;
    };
    const segs = [], capDirL = new Set();
    for (let t = 0; t < I.length; t += 3) {
      const a = I[t], b = I[t + 1], cc = I[t + 2];
      const sa = d[a] < 0, sb = d[b] < 0, sc = d[cc] < 0;
      if (sa && sb && sc) { L.tri(L.orig(a, P), L.orig(b, P), L.orig(cc, P)); continue; }
      if (!sa && !sb && !sc) { U.tri(U.orig(a, P), U.orig(b, P), U.orig(cc, P)); continue; }
      let lone, v1, v2, lb;
      if (sa !== sb && sa !== sc) { lone = a; v1 = b; v2 = cc; lb = sa; }
      else if (sb !== sa && sb !== sc) { lone = b; v1 = cc; v2 = a; lb = sb; }
      else { lone = cc; v1 = a; v2 = b; lb = sc; }
      const p1 = cutId(lone, v1), p2 = cutId(lone, v2);
      const B1 = lb ? L : U, B2 = lb ? U : L;
      B1.tri(B1.orig(lone, P), B1.cut(p1, cutPos), B1.cut(p2, cutPos));
      const q1 = B2.cut(p1, cutPos), w1 = B2.orig(v1, P), w2 = B2.orig(v2, P), q2 = B2.cut(p2, cutPos);
      B2.tri(q1, w1, w2); B2.tri(q1, w2, q2);
      if (p1 !== p2) { segs.push(p1, p2); if (lb) capDirL.add(p2 + '_' + p1); else capDirL.add(p1 + '_' + p2); }
    }
    if (L.empty() || U.empty()) return { lower: L.empty() ? null : mesh, upper: U.empty() ? null : mesh, connectors: [], open: 0, trivial: true };

    // loops
    const adj = new Map();
    const link = (p, q) => { if (!adj.has(p)) adj.set(p, []); adj.get(p).push(q); };
    for (let s = 0; s < segs.length; s += 2) { link(segs[s], segs[s + 1]); link(segs[s + 1], segs[s]); }
    const unlink = (p, q) => { const l = adj.get(p); const i = l.indexOf(q); if (i >= 0) l.splice(i, 1); };
    const loops = []; let open = 0;
    for (const start of adj.keys()) {
      while (adj.get(start).length) {
        const loop = [start]; let cur = start, closed = false;
        for (;;) {
          const l = adj.get(cur); if (!l.length) break;
          const nx = l[0]; unlink(cur, nx); unlink(nx, cur);
          if (nx === start) { closed = true; break; }
          loop.push(nx); cur = nx;
        }
        if (closed && loop.length >= 3) loops.push(loop); else open++;
      }
    }
    const L2 = loops.map(lp => lp.map(id => [cutPos[3 * id + u], cutPos[3 * id + v]]));
    const areas = L2.map(area2);
    const keep = []; for (let i = 0; i < loops.length; i++) if (Math.abs(areas[i]) > 1e-6) keep.push(i);
    const depth = {}, parent = {};
    for (const i of keep) {
      let dep = 0, best = -1, bestA = Infinity; const p = L2[i][0];
      for (const j of keep) if (j !== i && inPoly(p[0], p[1], L2[j])) { dep++; if (Math.abs(areas[j]) < bestA) { bestA = Math.abs(areas[j]); best = j; } }
      depth[i] = dep; parent[i] = best;
    }
    const regions = [];
    for (const i of keep) if (depth[i] % 2 === 0) regions.push({ outer: i, holes: keep.filter(j => depth[j] % 2 === 1 && parent[j] === i) });

    // connectors
    const r = J.d / 2;
    let sideL = null, sideU = null; // {kind, R, h}
    if (J.type === 'peg') { sideL = { kind: 'peg', R: r, h: J.len }; sideU = { kind: 'hole', R: r + J.clr, h: J.len + 0.6 }; }
    else if (J.type === 'dowel') { const h = J.len / 2 + 0.5; sideL = { kind: 'hole', R: r + J.clr, h }; sideU = { kind: 'hole', R: r + J.clr, h }; }
    const needL = sideL && sideL.kind === 'hole' ? sideL.h + 1.2 : 0;
    const needU = sideU ? sideU.h + 1.2 : 0;
    let band = null;
    const connectorsAll = [];
    for (const rg of regions) {
      rg.conn = [];
      if (!sideL) continue;
      if (needL > J.gapBelow - 0.5 || needU > J.gapAbove - 0.5) continue;
      if (!band) {
        const lo = c - needL - 1, hi = c + needU + 1, arr = [];
        for (let t = 0; t < I.length; t += 3) {
          let mn = Infinity, mx = -Infinity;
          for (let q = 0; q < 3; q++) { const z = P[3 * I[t + q] + k]; if (z < mn) mn = z; if (z > mx) mx = z; }
          if (mx >= lo && mn <= hi) arr.push(I[t], I[t + 1], I[t + 2]);
        }
        band = Uint32Array.from(arr);
      }
      const Rm = Math.max(sideL.R, sideU.R);
      const outer = L2[rg.outer], holes = rg.holes.map(h => L2[h]);
      const ar = Math.abs(areas[rg.outer]) - rg.holes.reduce((s, h) => s + Math.abs(areas[h]), 0);
      const depthOK = (pu, pv) => {
        const pts = [[pu, pv]]; for (let a = 0; a < 8; a++) pts.push([pu + (Rm + 0.8) * Math.cos(a * Math.PI / 4), pv + (Rm + 0.8) * Math.sin(a * Math.PI / 4)]);
        for (const p of pts) {
          if (needL && rayDist(P, band, k, c, p[0], p[1], -1) < needL) return false;
          if (needU && rayDist(P, band, k, c, p[0], p[1], +1) < needU) return false;
        }
        return true;
      };
      rg.conn = placeConnectors(outer, holes, ar, {
        need: Rm + J.wall, maxCount: J.maxPer, spacing: Math.max(3 * J.d, 2 * Rm + J.wall * 2),
        avoid: (pu, pv) => J.avoid(pu, pv, Rm + J.wall), depthOK
      });
      for (const cn of rg.conn) connectorsAll.push(cn);
    }

    // caps
    const SEG = 32;
    const pt3 = (pu, pv, pk) => { const p = [0, 0, 0]; p[u] = pu; p[v] = pv; p[k] = pk; return p; };
    function cap(B, s, side) {
      const nrm = [0, 0, 0]; nrm[k] = s;
      for (const rg of regions) {
        const loopsIdx = [rg.outer].concat(rg.holes);
        const refs = [], shapes = [];
        for (const li of loopsIdx) {
          let lp = loops[li], p2 = L2[li];
          refs.push(lp.map(id => B.cut(id, cutPos)));
          shapes.push(p2.map(p => new THREE.Vector2(p[0], p[1])));
        }
        const rings = [];
        if (side) for (const cn of rg.conn) {
          const ring = [], ring2 = [];
          for (let i = 0; i < SEG; i++) {
            const a = i / SEG * Math.PI * 2, x = cn[0] + side.R * Math.cos(a), y = cn[1] + side.R * Math.sin(a);
            const p = pt3(x, y, c); ring.push(B.add(p[0], p[1], p[2])); ring2.push(new THREE.Vector2(x, y));
          }
          refs.push(ring); shapes.push(ring2); rings.push({ cn, ring });
        }
        const all = [].concat(...refs);
        const faces = THREE.ShapeUtils.triangulateShape(shapes[0], shapes.slice(1));
        // repair vertices earcut dropped (collinear) to avoid T-junctions
        const used = new Set(); for (const f of faces) for (const q of f) used.add(q);
        const edgeTri = new Map(); const tris = faces.map(f => [all[f[0]], all[f[1]], all[f[2]]]);
        const ek = (a, b) => a < b ? a + '_' + b : b + '_' + a;
        const reg = (ti, on) => { const t = tris[ti]; for (let e = 0; e < 3; e++) { const key = ek(t[e], t[(e + 1) % 3]); if (!edgeTri.has(key)) edgeTri.set(key, []); const l = edgeTri.get(key); if (on) l.push(ti); else { const i = l.indexOf(ti); if (i >= 0) l.splice(i, 1); } } };
        tris.forEach((t, ti) => reg(ti, true));
        let off = 0;
        for (const rf of refs) {
          const n = rf.length; const loc = [];
          for (let i = 0; i < n; i++) if (used.has(off + i)) loc.push(i);
          if (loc.length && loc.length < n) {
            for (let q = 0; q < loc.length; q++) {
              const i0 = loc[q], i1 = loc[(q + 1) % loc.length];
              const gap = (i1 - i0 + n) % n; if (gap <= 1) continue;
              const a = rf[i0], b = rf[i1]; const lst = edgeTri.get(ek(a, b)); if (!lst || !lst.length) continue;
              const ti = lst[0]; const t = tris[ti]; if (!t) continue;
              const x = t.find(z => z !== a && z !== b);
              const chain = [a]; for (let g = 1; g < gap; g++) chain.push(rf[(i0 + g) % n]); chain.push(b);
              reg(ti, false); tris[ti] = null;
              const fw = t[(t.indexOf(a) + 1) % 3] === b;
              for (let g = 0; g < chain.length - 1; g++) { tris.push(fw ? [chain[g], chain[g + 1], x] : [chain[g + 1], chain[g], x]); reg(tris.length - 1, true); }
            }
          }
          off += n;
        }
        const p2 = new Map(); refs.forEach((rf, i) => rf.forEach((id, j) => p2.set(id, shapes[i][j])));
        let sa = 0; for (const t of tris) if (t) { const A = p2.get(t[0]), Bq = p2.get(t[1]), C = p2.get(t[2]); sa += (Bq.x - A.x) * (C.y - A.y) - (Bq.y - A.y) * (C.x - A.x); }
        const flipT = (sa > 0) !== (s > 0), seenT = new Set();
        for (const t of tris) if (t) { const key = t.slice().sort((a, b) => a - b).join('_'); if (seenT.has(key)) continue; seenT.add(key); if (flipT) B.tri(t[0], t[2], t[1]); else B.tri(t[0], t[1], t[2]); }
        // extrusions
        for (const { cn, ring } of rings) {
          const radial = (i) => { const a = (i + 0.5) / SEG * Math.PI * 2; return [Math.cos(a), Math.sin(a)]; };
          const mk = (R, kk) => { const out = []; for (let i = 0; i < SEG; i++) { const a = i / SEG * Math.PI * 2; const p = pt3(cn[0] + R * Math.cos(a), cn[1] + R * Math.sin(a), kk); out.push(B.add(p[0], p[1], p[2])); } return out; };
          const wall = (r0, r1, inward, kz) => {
            for (let i = 0; i < SEG; i++) {
              const j = (i + 1) % SEG, rd = radial(i); const n3 = pt3(rd[0] * (inward ? -1 : 1), rd[1] * (inward ? -1 : 1), kz);
              B.triN(r0[i], r0[j], r1[j], n3); B.triN(r0[i], r1[j], r1[i], n3);
            }
          };
          const disk = (rr, kk, sgn) => { const cp = pt3(cn[0], cn[1], kk); const ci = B.add(cp[0], cp[1], cp[2]); const n3 = [0, 0, 0]; n3[k] = sgn; for (let i = 0; i < SEG; i++) B.triN(ci, rr[i], rr[(i + 1) % SEG], n3); };
          if (side.kind === 'hole') {
            const r1 = mk(side.R, c - s * side.h); wall(ring, r1, true, 0); disk(r1, c - s * side.h, s);
          } else {
            const ch = Math.min(0.6, side.h / 3, side.R / 3);
            const r1 = mk(side.R, c + s * (side.h - ch)), r2 = mk(side.R - ch, c + s * side.h);
            wall(ring, r1, false, 0); wall(r1, r2, false, s * 0.7); disk(r2, c + s * side.h, s);
          }
        }
      }
    }
    cap(L, +1, sideL); cap(U, -1, sideU);
    // sliver outlines with ~zero area still need closing so the part stays watertight
    for (let i = 0; i < loops.length; i++) {
      if (Math.abs(areas[i]) > 1e-6) continue;
      const lp = loops[i], fwd = capDirL.has(lp[0] + '_' + lp[1]);
      const seq = fwd ? lp : lp.slice().reverse();
      for (let q = 1; q + 1 < seq.length; q++) {
        L.tri(L.cut(seq[0], cutPos), L.cut(seq[q], cutPos), L.cut(seq[q + 1], cutPos));
        U.tri(U.cut(seq[0], cutPos), U.cut(seq[q + 1], cutPos), U.cut(seq[q], cutPos));
      }
    }
    return { lower: L.mesh(), upper: U.mesh(), connectors: connectorsAll, open, c, k };
  }

  // ---------- plan + split whole model ----------
  function planCuts(bb, bed, margin, protrude) {
    const cuts = [[], [], []];
    for (let k = 0; k < 3; k++) {
      const usable = bed[k] - 2 * margin - protrude; const S = bb.size[k];
      const n = Math.max(1, Math.ceil((S - 1e-6) / usable));
      for (let i = 1; i < n; i++) cuts[k].push(bb.min[k] + S * i / n);
    }
    return cuts;
  }

  function splitAll(mesh, cuts, joint) { const g = splitSteps(mesh, cuts, joint); let r; while (!(r = g.next()).done); return r.value; }
  async function splitAllAsync(mesh, cuts, joint, onProgress) {
    const g = splitSteps(mesh, cuts, joint); let r;
    while (!(r = g.next()).done) { if (onProgress) onProgress(r.value); await new Promise(res => setTimeout(res, 0)); }
    return r.value;
  }
  function* splitSteps(mesh, cuts, joint) {
    let pieces = [{ mesh, cell: [0, 0, 0], joints: 0 }]; const planes = new Set();
    let totalConn = 0, open = 0; const total = cuts[0].length + cuts[1].length + cuts[2].length; let done = 0;
    for (let k = 0; k < 3; k++) {
      const cs = cuts[k].slice().sort((a, b) => a - b);
      for (let j = 0; j < cs.length; j++) {
        const c = cs[j]; const next = [];
        const avoid = (pu, pv, rad) => {
          const u = (k + 1) % 3, v = (k + 2) % 3;
          for (const w of cuts[u]) if (Math.abs(pu - w) < rad + 0.5) return true;
          for (const w of cuts[v]) if (Math.abs(pv - w) < rad + 0.5) return true;
          return false;
        };
        const J = Object.assign({}, joint, { avoid, gapBelow: j > 0 ? c - cs[j - 1] : Infinity, gapAbove: j < cs.length - 1 ? cs[j + 1] - c : Infinity });
        for (const pc of pieces) {
          if (pc.cell[k] !== j) { next.push(pc); continue; }
          const r = splitMesh(pc.mesh, k, c, J);
          if (r.trivial) {
            if (r.lower) next.push(pc); else { const cell = pc.cell.slice(); cell[k] = j + 1; next.push({ mesh: pc.mesh, cell, joints: pc.joints }); }
            continue;
          }
          planes.add(k + ':' + r.c);
          const nc = r.connectors.length; totalConn += nc; open += r.open;
          next.push({ mesh: r.lower, cell: pc.cell.slice(), joints: pc.joints + nc });
          const cell = pc.cell.slice(); cell[k] = j + 1; next.push({ mesh: r.upper, cell, joints: pc.joints + nc });
        }
        pieces = next; done++; yield done / total;
      }
    }
    return { pieces, connectors: totalConn, open, planes };
  }

  // ---------- adaptive planning (fewest parts) ----------
  // Planning runs on a sampled solid: voxel centres (the inside, so cut faces are represented)
  // plus surface samples (exact outer extents). Thousands of trial cuts stay cheap.
  function voxelize(m, s) {
    const P = m.pos, I = m.idx, bb = bbox(m);
    const nx = Math.max(1, Math.ceil(bb.size[0] / s)), ny = Math.max(1, Math.ceil(bb.size[1] / s));
    const jx = s * 0.0137, jy = s * 0.0291; // jitter so rays miss vertices/edges
    const cols = new Array(nx * ny);
    for (let t = 0; t < I.length; t += 3) {
      const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
      const xa = P[a], ya = P[a + 1], xb = P[b], yb = P[b + 1], xc = P[c], yc = P[c + 1];
      const det = (yb - yc) * (xa - xc) + (xc - xb) * (ya - yc); if (Math.abs(det) < 1e-12) continue;
      const i0 = Math.max(0, Math.floor((Math.min(xa, xb, xc) - bb.min[0]) / s - 0.5)), i1 = Math.min(nx - 1, Math.ceil((Math.max(xa, xb, xc) - bb.min[0]) / s - 0.5));
      const j0 = Math.max(0, Math.floor((Math.min(ya, yb, yc) - bb.min[1]) / s - 0.5)), j1 = Math.min(ny - 1, Math.ceil((Math.max(ya, yb, yc) - bb.min[1]) / s - 0.5));
      for (let i = i0; i <= i1; i++) {
        const px = bb.min[0] + (i + 0.5) * s + jx;
        for (let j = j0; j <= j1; j++) {
          const py = bb.min[1] + (j + 0.5) * s + jy;
          const l1 = ((yb - yc) * (px - xc) + (xc - xb) * (py - yc)) / det, l2 = ((yc - ya) * (px - xc) + (xa - xc) * (py - yc)) / det, l3 = 1 - l1 - l2;
          if (l1 < 0 || l2 < 0 || l3 < 0) continue;
          const z = l1 * P[a + 2] + l2 * P[b + 2] + l3 * P[c + 2];
          const q = i * ny + j; (cols[q] || (cols[q] = [])).push(z);
        }
      }
    }
    const out = [];
    for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
      const zs = cols[i * ny + j]; if (!zs || zs.length < 2) continue; zs.sort((p, q) => p - q);
      for (let q = 0; q + 1 < zs.length; q += 2) {
        const k0 = Math.ceil((zs[q] - bb.min[2]) / s - 0.5), k1 = Math.floor((zs[q + 1] - bb.min[2]) / s - 0.5);
        for (let k = k0; k <= k1; k++) out.push(bb.min[0] + (i + 0.5) * s, bb.min[1] + (j + 0.5) * s, bb.min[2] + (k + 0.5) * s);
      }
    }
    return out;
  }
  function surfacePoints(m, spacing, budget) {
    const P = m.pos, I = m.idx, nv = P.length / 3, used = new Uint8Array(nv), out = [];
    for (let t = 0; t < I.length; t++) used[I[t]] = 1;
    for (let i = 0; i < nv; i++) if (used[i]) out.push(P[3 * i], P[3 * i + 1], P[3 * i + 2]);
    for (let t = 0; t < I.length && out.length < budget * 9; t += 3) for (let e = 0; e < 3; e++) {
      const a = I[t + e], b = I[t + (e + 1) % 3]; if (a > b) continue;
      const dx = P[3 * b] - P[3 * a], dy = P[3 * b + 1] - P[3 * a + 1], dz = P[3 * b + 2] - P[3 * a + 2];
      const n = Math.floor(Math.sqrt(dx * dx + dy * dy + dz * dz) / spacing);
      for (let q = 1; q <= n; q++) { const f = q / (n + 1); out.push(P[3 * a] + dx * f, P[3 * a + 1] + dy * f, P[3 * a + 2] + dz * f); }
    }
    return out;
  }
  // keep extremes along every axis, stride-sample the rest
  function thin(arr, budget) {
    const n = arr.length / 3; if (n <= budget) return arr;
    const keep = new Uint8Array(n);
    for (let k = 0; k < 3; k++) { let mi = 0, ma = 0; for (let i = 1; i < n; i++) { if (arr[3 * i + k] < arr[3 * mi + k]) mi = i; if (arr[3 * i + k] > arr[3 * ma + k]) ma = i; } keep[mi] = keep[ma] = 1; }
    const step = n / budget, out = [];
    for (let f = 0; f < n; f += step) keep[Math.floor(f)] = 1;
    for (let i = 0; i < n; i++) if (keep[i]) out.push(arr[3 * i], arr[3 * i + 1], arr[3 * i + 2]);
    return out;
  }
  function sampleSolid(m, voxBudget, surfBudget) {
    const bb = bbox(m), V = Math.abs(volume(m)), boxV = bb.size[0] * bb.size[1] * bb.size[2];
    const s = Math.max(0.8, Math.cbrt(Math.max(V, boxV * 0.05) / voxBudget));
    let vox = voxelize(m, s); if (vox.length / 3 > voxBudget * 3) vox = thin(vox, voxBudget * 2);
    const surf = thin(surfacePoints(m, s, surfBudget), surfBudget);
    return { pts: Float32Array.from(vox.concat(surf)), s };
  }
  function rotatePts(src, M) {
    const n = src.length / 3, out = new Float32Array(src.length), mn = [Infinity, Infinity, Infinity];
    for (let i = 0; i < n; i++) {
      const x = src[3 * i], y = src[3 * i + 1], z = src[3 * i + 2];
      for (let r = 0; r < 3; r++) { const v = M[3 * r] * x + M[3 * r + 1] * y + M[3 * r + 2] * z; out[3 * i + r] = v; if (v < mn[r]) mn[r] = v; }
    }
    for (let i = 0; i < n; i++) for (let r = 0; r < 3; r++) out[3 * i + r] -= mn[r];
    return { pts: out, min: mn };
  }
  function rotZ(a) { const c = Math.cos(a), s = Math.sin(a); return [c, -s, 0, s, c, 0, 0, 0, 1]; }
  function mul3(A, B) { const C = new Array(9); for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) { let s = 0; for (let k = 0; k < 3; k++) s += A[3 * i + k] * B[3 * k + j]; C[3 * i + j] = Math.abs(s) < 1e-12 ? 0 : s; } return C; }
  const PERMS = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];

  // connected clusters of sample points (26-neighbour cells of size s) -> array of id lists
  function pointComponents(pts, ids, s) {
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < ids.length; i++) { const o = ids[i] * 3; for (let k = 0; k < 3; k++) { const v = pts[o + k]; if (v < mn[k]) mn[k] = v; if (v > mx[k]) mx[k] = v; } }
    let cs = s * 1.2, nx, ny, nz;
    for (;;) { nx = Math.floor((mx[0] - mn[0]) / cs) + 1; ny = Math.floor((mx[1] - mn[1]) / cs) + 1; nz = Math.floor((mx[2] - mn[2]) / cs) + 1; if (nx * ny * nz <= 3e6) break; cs *= 1.25; }
    const grid = new Int32Array(nx * ny * nz).fill(-2), cellOf = new Int32Array(ids.length), inv = 1 / cs;
    for (let i = 0; i < ids.length; i++) {
      const o = ids[i] * 3; const c = (Math.floor((pts[o] - mn[0]) * inv) * ny + Math.floor((pts[o + 1] - mn[1]) * inv)) * nz + Math.floor((pts[o + 2] - mn[2]) * inv);
      grid[c] = -1; cellOf[i] = c;
    }
    let label = 0; const stack = [];
    for (let i = 0; i < ids.length; i++) {
      const c0 = cellOf[i]; if (grid[c0] !== -1) continue;
      grid[c0] = label; stack.push(c0);
      while (stack.length) {
        const c = stack.pop(), z = c % nz, y = ((c - z) / nz) % ny, x = (c - z - y * nz) / (nz * ny);
        for (let dx = -1; dx <= 1; dx++) { const X = x + dx; if (X < 0 || X >= nx) continue;
          for (let dy = -1; dy <= 1; dy++) { const Y = y + dy; if (Y < 0 || Y >= ny) continue;
            for (let dz = -1; dz <= 1; dz++) { const Z = z + dz; if (Z < 0 || Z >= nz) continue;
              const q = (X * ny + Y) * nz + Z; if (grid[q] === -1) { grid[q] = label; stack.push(q); } } } }
      }
      label++;
    }
    if (label === 1) return [ids];
    const counts = new Int32Array(label); for (let i = 0; i < ids.length; i++) counts[grid[cellOf[i]]]++;
    const out = Array.from(counts, n => new Uint32Array(n)), fill = new Int32Array(label);
    for (let i = 0; i < ids.length; i++) { const l = grid[cellOf[i]]; out[l][fill[l]++] = ids[i]; }
    return out;
  }
  // split a mesh into its connected pieces (shared vertices)
  function meshComponents(m) {
    const P = m.pos, I = m.idx, nv = P.length / 3, par = new Int32Array(nv);
    for (let i = 0; i < nv; i++) par[i] = i;
    const find = (x) => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; };
    const uni = (a, b) => { a = find(a); b = find(b); if (a !== b) par[a] = b; };
    for (let t = 0; t < I.length; t += 3) { uni(I[t], I[t + 1]); uni(I[t], I[t + 2]); }
    const groups = new Map();
    for (let t = 0; t < I.length; t += 3) { const r = find(I[t]); let g = groups.get(r); if (!g) { g = []; groups.set(r, g); } g.push(t); }
    if (groups.size <= 1) return [m];
    const out = [];
    for (const tris of groups.values()) {
      const map = new Map(), pos = [], idx = new Uint32Array(tris.length * 3);
      tris.forEach((t, j) => { for (let q = 0; q < 3; q++) { const v = I[t + q]; let n = map.get(v); if (n === undefined) { n = pos.length / 3; map.set(v, n); pos.push(P[3 * v], P[3 * v + 1], P[3 * v + 2]); } idx[3 * j + q] = n; } });
      out.push({ pos: Float64Array.from(pos), idx });
    }
    return out;
  }

  // like meshComponents, but a closed cavity (inward-facing surface) stays with the solid around it
  function solidComponents(m) {
    const comps = meshComponents(m);
    if (comps.length < 2) return comps;
    const info = comps.map(c => ({ c, v: volume(c), bb: bbox(c) }));
    const solids = info.filter(x => x.v > 0), holes = info.filter(x => x.v < 0), groups = solids.map(x => [x.c]);
    for (const h of holes) {
      let best = -1, bv = Infinity;
      solids.forEach((sd, i) => { if ([0, 1, 2].every(k => sd.bb.min[k] <= h.bb.min[k] + 1e-6 && sd.bb.max[k] >= h.bb.max[k] - 1e-6) && sd.v < bv) { bv = sd.v; best = i; } });
      if (best >= 0) groups[best].push(h.c);
    }
    return groups.map(g => g.length === 1 ? g[0] : merge(g));
  }

  // pts: sampled solid; s: sample spacing; usable: bed minus margins; pegLen: peg protrusion
  function makePlanner(pts, s, usable, pegLen, budget, islands) {
    const bedS = usable.slice().sort((a, b) => a - b);
    const T = Array.from(new Set(bedS));
    let work = 0;
    const bbOf = (pc) => {
      const ids = pc.ids, mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < ids.length; i++) { const o = ids[i] * 3; for (let k = 0; k < 3; k++) { const v = pts[o + k]; if (v < mn[k]) mn[k] = v; if (v > mx[k]) mx[k] = v; } }
      for (let k = 0; k < 3; k++) { // material touching a cut plane reaches the plane itself
        if (pc.hi[k] < Infinity && mx[k] > pc.hi[k] - 1.5 * s) mx[k] = pc.hi[k];
        if (pc.lo[k] > -Infinity && mn[k] < pc.lo[k] + 1.5 * s) mn[k] = pc.lo[k];
      }
      return { min: mn, max: mx };
    };
    const eff = (bb, mask) => [0, 1, 2].map(k => bb.max[k] - bb.min[k] + ((mask >> k) & 1 ? pegLen : 0));
    const fits = (sz) => { const a = sz.slice().sort((x, y) => x - y); return a[0] <= bedS[0] + 1e-6 && a[1] <= bedS[1] + 1e-6 && a[2] <= bedS[2] + 1e-6; };
    const est = (sz) => { if (fits(sz)) return 1; let best = Infinity; for (const p of PERMS) { let n = 1; for (let k = 0; k < 3; k++) n *= Math.max(1, Math.ceil((sz[k] - 1e-6) / Math.max(1, usable[p[k]] - pegLen))); best = Math.min(best, n); } return best; };
    const split = (pc, k, c) => {
      const ids = pc.ids; let nl = 0, near = 0;
      for (let i = 0; i < ids.length; i++) { const v = pts[ids[i] * 3 + k]; if (v < c) nl++; if (v > c - s && v < c + s) near++; }
      const L = new Uint32Array(nl), U = new Uint32Array(ids.length - nl); let a = 0, b = 0;
      for (let i = 0; i < ids.length; i++) { const id = ids[i]; if (pts[id * 3 + k] < c) L[a++] = id; else U[b++] = id; }
      work += ids.length;
      const lh = pc.hi.slice(); lh[k] = c; const ul = pc.lo.slice(); ul[k] = c;
      return { L: { ids: L, lo: pc.lo, hi: lh }, U: { ids: U, lo: ul, hi: pc.hi }, near };
    };
    function candidates(pc, bb, mask) {
      const out = [];
      for (let k = 0; k < 3; k++) {
        const lo = bb.min[k], hi = bb.max[k], S = hi - lo; if (S < 4 * s) continue;
        const cs = [lo + S / 2];
        for (const t of T) {
          cs.push(lo + t - pegLen);                                   // lower slab (gets pegs) fills t exactly
          cs.push(hi - (t - ((mask >> k) & 1 ? pegLen : 0)));         // upper slab fills t exactly
          const n = Math.ceil(S / Math.max(1, t - pegLen)); if (n > 1) cs.push(lo + S / n);
        }
        // natural waist: thinnest cross-section in the middle 80%
        const bins = Math.min(200, Math.max(8, Math.floor(S / Math.max(2, s)))), hist = new Uint32Array(bins), ids = pc.ids;
        for (let i = 0; i < ids.length; i++) { const q = Math.min(bins - 1, Math.max(0, Math.floor((pts[ids[i] * 3 + k] - lo) / S * bins))); hist[q]++; }
        let bi = -1, bv = Infinity; for (let q = Math.floor(bins * 0.1); q < Math.ceil(bins * 0.9); q++) if (hist[q] < bv) { bv = hist[q]; bi = q; }
        if (bi >= 0) cs.push(lo + (bi + 0.5) / bins * S);
        const seen = new Set();
        for (const c of cs) { if (!(c > lo + s && c < hi - s)) continue; const key = Math.round(c * 2); if (seen.has(key)) continue; seen.add(key); out.push([k, c]); }
      }
      return out;
    }
    const clamp = (mn, mx, lo, hi) => {
      for (let k = 0; k < 3; k++) {
        if (hi[k] < Infinity && mx[k] > hi[k] - 1.5 * s) mx[k] = hi[k];
        if (lo[k] > -Infinity && mn[k] < lo[k] + 1.5 * s) mn[k] = lo[k];
      }
      return { min: mn, max: mx };
    };
    // one pass: both children's bounding boxes without building index arrays
    const evalCut = (pc, k, c) => {
      const ids = pc.ids, a0 = [Infinity, Infinity, Infinity], a1 = [-Infinity, -Infinity, -Infinity], b0 = [Infinity, Infinity, Infinity], b1 = [-Infinity, -Infinity, -Infinity];
      let nl = 0, near = 0;
      for (let i = 0; i < ids.length; i++) {
        const o = ids[i] * 3, x = pts[o], y = pts[o + 1], z = pts[o + 2], w = pts[o + k];
        if (w > c - s && w < c + s) near++;
        if (w < c) { nl++; if (x < a0[0]) a0[0] = x; if (x > a1[0]) a1[0] = x; if (y < a0[1]) a0[1] = y; if (y > a1[1]) a1[1] = y; if (z < a0[2]) a0[2] = z; if (z > a1[2]) a1[2] = z; }
        else { if (x < b0[0]) b0[0] = x; if (x > b1[0]) b1[0] = x; if (y < b0[1]) b0[1] = y; if (y > b1[1]) b1[1] = y; if (z < b0[2]) b0[2] = z; if (z > b1[2]) b1[2] = z; }
      }
      work += ids.length;
      const lh = pc.hi.slice(); lh[k] = c; const ul = pc.lo.slice(); ul[k] = c;
      return { nl, nu: ids.length - nl, near, bbL: clamp(a0, a1, pc.lo, lh), bbU: clamp(b0, b1, ul, pc.hi) };
    };
    const comps = (ids) => pointComponents(pts, ids, s);
    function greedy(pc, mask, depth, look) {
      const bb = bbOf(pc), sz = eff(bb, mask);
      if (fits(sz) || depth > 16 || pc.ids.length < 4) {
        // count physically separate pieces honestly on the final plan
        const n = islands && look && pc.ids.length ? comps(pc.ids).length : 1;
        return { leaf: true, count: Math.max(1, n), bb, ok: fits(sz) };
      }
      // empty space: if this piece is really several separate islands, plan each one on its own
      if (islands && !pc.single) {
        const cs = comps(pc.ids).filter(c => c.length >= 3);
        if (cs.length > 1) {
          const kids = cs.map(ids => {
            const kid = greedy({ ids, lo: pc.lo, hi: pc.hi, single: true }, mask, depth, look);
            const step = Math.max(1, Math.floor(ids.length / 400)), rp = []; // a few sample points to recognise this island later
            for (let i = 0; i < ids.length; i += step) rp.push(pts[ids[i] * 3], pts[ids[i] * 3 + 1], pts[ids[i] * 3 + 2]);
            kid.rep = Float32Array.from(rp); return kid;
          });
          return { islands: kids, count: kids.reduce((a, k) => a + k.count, 0), bb, ok: kids.every(k => k.ok) };
        }
      }
      const scored = [];
      for (const [k, c] of candidates(pc, bb, mask)) {
        const r = evalCut(pc, k, c); if (!r.nl || !r.nu) continue;
        const sl = eff(r.bbL, mask | (1 << k)), su = eff(r.bbU, mask);
        const tiny = Math.min(r.nl, r.nu) < pc.ids.length * 0.01 ? 0.5 : 0; // avoid shaving off slivers
        scored.push({ k, c, score: est(sl) + est(su) + tiny, near: r.near / pc.ids.length });
      }
      if (!scored.length) return { leaf: true, count: 1, bb, ok: false };
      scored.sort((a, b) => a.score - b.score || a.near - b.near);
      let pick = scored[0], pr = null;
      if (look && work < budget) {
        let best = Infinity;
        for (const sc of scored.slice(0, 5)) {
          const r = split(pc, sc.k, sc.c);
          const n = greedy(r.L, mask | (1 << sc.k), depth + 1, false).count + greedy(r.U, mask, depth + 1, false).count;
          if (n < best || (n === best && sc.near < pick.near)) { best = n; pick = sc; pr = r; }
        }
      }
      if (!pr) pr = split(pc, pick.k, pick.c);
      const lo = greedy(pr.L, mask | (1 << pick.k), depth + 1, look), hi = greedy(pr.U, mask, depth + 1, look);
      return { k: pick.k, c: pick.c, lo, hi, count: lo.count + hi.count, bb, ok: lo.ok && hi.ok };
    }
    const all = new Uint32Array(pts.length / 3); for (let i = 0; i < all.length; i++) all[i] = i;
    const root = { ids: all, lo: [-Infinity, -Infinity, -Infinity], hi: [Infinity, Infinity, Infinity] };
    return { plan: (look) => greedy(root, 0, 0, look), work: () => work };
  }
  function stripTree(n) {
    let o;
    if (n.leaf) o = { leaf: true, count: n.count, bb: n.bb, ok: n.ok };
    else if (n.islands) o = { islands: n.islands.map(stripTree), count: n.count, bb: n.bb, ok: n.ok };
    else o = { k: n.k, c: n.c, lo: stripTree(n.lo), hi: stripTree(n.hi), count: n.count, bb: n.bb, ok: n.ok };
    if (n.rep) o.rep = n.rep; return o;
  }

  // opts: {usable:[3], pegLen, rotate:boolean}; yields progress 0..1, returns {M, yaw, tilt, tree, count, ok, gridCount}
  function* planAdaptive(mesh, opts) {
    const coarse = sampleSolid(mesh, 14000, 8000); yield 0.05;
    const fine = sampleSolid(mesh, 60000, 30000); yield 0.1;
    const I3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    const tilts = [I3, [1, 0, 0, 0, 0, -1, 0, 1, 0], [0, 0, 1, 0, 1, 0, -1, 0, 0]];
    const frames = [];
    if (opts.rotate) { for (let b = 0; b < 3; b++) for (let d = 0; d < 180; d += 15) frames.push({ M: mul3(rotZ(d * Math.PI / 180), tilts[b]), yaw: d, tilt: b }); }
    else frames.push({ M: I3, yaw: 0, tilt: 0 });
    const quick = [];
    for (let i = 0; i < frames.length; i++) {
      const { pts } = rotatePts(coarse.pts, frames[i].M);
      const t = makePlanner(pts, coarse.s, opts.usable, opts.pegLen, 0).plan(false);
      quick.push({ i, count: t.count, ok: t.ok });
      yield 0.1 + 0.5 * (i + 1) / frames.length;
    }
    const rank = quick.slice().sort((a, b) => (b.ok - a.ok) || a.count - b.count || a.i - b.i);
    const short = rank.slice(0, Math.min(3, rank.length));
    if (!short.some(q => q.i === 0)) short.push(quick[0]); // always consider the model as you oriented it
    let best = null;
    for (let j = 0; j < short.length; j++) {
      const f = frames[short[j].i]; const { pts } = rotatePts(fine.pts, f.M);
      const tree = makePlanner(pts, fine.s, opts.usable, opts.pegLen, 1.5e8, true).plan(true);
      const better = !best || (tree.ok && !best.tree.ok) || (tree.ok === best.tree.ok && (tree.count < best.tree.count || (tree.count === best.tree.count && short[j].i < best.i)));
      if (better) best = { i: short[j].i, tree, f };
      yield 0.6 + 0.4 * (j + 1) / short.length;
    }
    return { M: best.f.M, yaw: best.f.yaw, tilt: best.f.tilt, tree: stripTree(best.tree), count: best.tree.count, ok: best.tree.ok, sample: fine.s };
  }
  // how many physical pieces an even grid would give (empty cells skipped, islands counted)
  function gridPieces(mesh, cuts) {
    const f = sampleSolid(mesh, 40000, 20000), pts = f.pts, n = pts.length / 3, cells = new Map();
    for (let i = 0; i < n; i++) {
      let key = 0; for (let k = 0; k < 3; k++) { let j = 0; while (j < cuts[k].length && pts[3 * i + k] >= cuts[k][j]) j++; key = key * 64 + j; }
      let g = cells.get(key); if (!g) { g = []; cells.set(key, g); } g.push(i);
    }
    let total = 0; for (const g of cells.values()) total += pointComponents(pts, Uint32Array.from(g), f.s).length;
    return total;
  }
  // fast part-count estimate for another bed size (coarse sample only). Yields between frames.
  // cache: {} reused across calls for the same mesh so the sample is taken once.
  function* quickCount(mesh, usable, pegLen, rotate, cache) {
    if (!cache.coarse) { cache.coarse = sampleSolid(mesh, 14000, 8000); yield; }
    const I3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    const tilts = [I3, [1, 0, 0, 0, 0, -1, 0, 1, 0], [0, 0, 1, 0, 1, 0, -1, 0, 0]];
    if (!cache.frames) {
      const fr = [];
      if (rotate) { for (let b = 0; b < 3; b++) for (let d = 0; d < 180; d += 30) fr.push(mul3(rotZ(d * Math.PI / 180), tilts[b])); }
      else fr.push(I3);
      cache.frames = fr.map(M => rotatePts(cache.coarse.pts, M).pts);
      yield;
    }
    let best = Infinity, bestOk = false;
    for (const pts of cache.frames) {
      const t = makePlanner(pts, cache.coarse.s, usable, pegLen, 0).plan(false);
      if ((t.ok && !bestOk) || (t.ok === bestOk && t.count < best)) { best = t.count; bestOk = t.ok; }
      yield;
    }
    return { count: best, ok: bestOk };
  }
  function planAdaptiveSync(mesh, opts) { const g = planAdaptive(mesh, opts); let r; while (!(r = g.next()).done); return r.value; }
  // plan the unrotated model only (used to refine a part that came out too big)
  function planLocal(mesh, usable, pegLen) {
    const f = sampleSolid(mesh, 30000, 15000); const { pts, min } = rotatePts(f.pts, [1, 0, 0, 0, 1, 0, 0, 0, 1]);
    const tree = stripTree(makePlanner(pts, f.s, usable, pegLen, 5e7, true).plan(true));
    const shift = (n) => { if (n.rep) for (let i = 0; i < n.rep.length; i++) n.rep[i] += min[i % 3]; if (n.bb) for (let k = 0; k < 3; k++) { n.bb.min[k] += min[k]; n.bb.max[k] += min[k]; } if (n.islands) n.islands.forEach(shift); else if (!n.leaf) { n.c += min[n.k]; shift(n.lo); shift(n.hi); } return n; };
    return shift(tree);
  }

  function treeCuts(n, out) {
    out = out || [];
    if (n.islands) for (const k of n.islands) treeCuts(k, out);
    else if (!n.leaf) { out.push(n); treeCuts(n.lo, out); treeCuts(n.hi, out); }
    return out;
  }
  function treeIslands(n) { let c = 0; if (n.islands) { c += n.islands.length - 1; for (const k of n.islands) c += treeIslands(k); } else if (!n.leaf) c += treeIslands(n.lo) + treeIslands(n.hi); return c; }

  // execute a planned tree on the real mesh with joints
  function* execTree(mesh, tree, joint) {
    const parts = []; let conn = 0, open = 0; const total = treeCuts(tree).length; let done = 0; const planes = new Set();
    const stack = [{ n: tree, mesh, ex: [0, 0, 0], joints: 0, path: '' }];
    while (stack.length) {
      const it = stack.pop(), n = it.n;
      if (n.leaf) { parts.push({ mesh: it.mesh, ex: it.ex, joints: it.joints, path: it.path, planned: n }); continue; }
      if (n.islands) { // route each separate piece of the real mesh to the island planned for it
        const groups = n.islands.map(() => []);
        for (const cm of meshComponents(it.mesh)) {
          const nv = cm.pos.length / 3, step = Math.max(1, Math.floor(nv / 24));
          let bi = 0, bd = Infinity;
          n.islands.forEach((isl, i) => {
            const R = isl.rep; let d = 0;
            for (let v = 0; v < nv; v += step) {
              const x = cm.pos[3 * v], y = cm.pos[3 * v + 1], z = cm.pos[3 * v + 2]; let m = Infinity;
              for (let q = 0; q < R.length; q += 3) { const dx = R[q] - x, dy = R[q + 1] - y, dz = R[q + 2] - z, e = dx * dx + dy * dy + dz * dz; if (e < m) m = e; }
              d += m;
            }
            if (d < bd) { bd = d; bi = i; }
          });
          groups[bi].push(cm);
        }
        n.islands.forEach((isl, i) => { if (groups[i].length) stack.push({ n: isl, mesh: groups[i].length === 1 ? groups[i][0] : merge(groups[i]), ex: it.ex, joints: it.joints, path: it.path + 'I' + i }); });
        continue;
      }
      const k = n.k, u = (k + 1) % 3, v = (k + 2) % 3;
      const lc = treeCuts(n.lo), hc = treeCuts(n.hi), desc = lc.concat(hc);
      let gb = Infinity, ga = Infinity;
      for (const d of lc) if (d.k === k && d.c < n.c) gb = Math.min(gb, n.c - d.c);
      for (const d of hc) if (d.k === k && d.c > n.c) ga = Math.min(ga, d.c - n.c);
      const avoid = (pu, pv, rad) => { for (const d of desc) { if (d.k === k) continue; const x = d.k === u ? pu : pv; if (Math.abs(x - d.c) < rad + 0.5) return true; } return false; };
      const r = splitMesh(it.mesh, k, n.c, Object.assign({}, joint, { avoid, gapBelow: gb, gapAbove: ga }));
      const exL = it.ex.slice(), exU = it.ex.slice(); exL[k] -= 0.5; exU[k] += 0.5;
      if (r.trivial) {
        if (r.lower) stack.push({ n: n.lo, mesh: it.mesh, ex: it.ex, joints: it.joints, path: it.path + 'L' });
        else stack.push({ n: n.hi, mesh: it.mesh, ex: it.ex, joints: it.joints, path: it.path + 'U' });
      } else {
        planes.add(k + ':' + r.c);
        const nc = r.connectors.length; conn += nc; open += r.open;
        stack.push({ n: n.hi, mesh: r.upper, ex: exU, joints: it.joints + nc, path: it.path + 'U' });
        stack.push({ n: n.lo, mesh: r.lower, ex: exL, joints: it.joints + nc, path: it.path + 'L' });
      }
      done++; yield done / Math.max(1, total);
    }
    return { parts, connectors: conn, open, planes };
  }

  // ---------- joints as a post-pass on the finished parts ----------
  // Every cut face of every part is found, faces that touch across a cut become "contacts",
  // and each part's largest cut face is kept peg-free (holes only) so it can print flat on it.

  // fill one planar face: loops of vertex refs (+2D coords) and round features (pegs / holes)
  function fillCap(B, k, c, s, loops, loops2, feats) {
    const u = (k + 1) % 3, v = (k + 2) % 3, SEG = 32, nrm = [0, 0, 0]; nrm[k] = s;
    const pt3 = (pu, pv, pk) => { const p = [0, 0, 0]; p[u] = pu; p[v] = pv; p[k] = pk; return p; };
    const refs = loops.map(l => l.slice()), shapes = loops2.map(l => l.map(p => new THREE.Vector2(p[0], p[1])));
    const rings = [];
    for (const f of feats) {
      const ring = [], ring2 = [];
      for (let i = 0; i < SEG; i++) { const a = i / SEG * Math.PI * 2, x = f.u + f.R * Math.cos(a), y = f.v + f.R * Math.sin(a); const p = pt3(x, y, c); ring.push(B.add(p[0], p[1], p[2])); ring2.push(new THREE.Vector2(x, y)); }
      refs.push(ring); shapes.push(ring2); rings.push({ f, ring });
    }
    const all = [].concat(...refs);
    const faces = THREE.ShapeUtils.triangulateShape(shapes[0], shapes.slice(1));
    const used = new Set(); for (const f of faces) for (const q of f) used.add(q);
    const tris = faces.map(f => [all[f[0]], all[f[1]], all[f[2]]]), edgeTri = new Map();
    const ek = (a, b) => a < b ? a + '_' + b : b + '_' + a;
    const reg = (ti, on) => { const t = tris[ti]; for (let e = 0; e < 3; e++) { const key = ek(t[e], t[(e + 1) % 3]); if (!edgeTri.has(key)) edgeTri.set(key, []); const l = edgeTri.get(key); if (on) l.push(ti); else { const i = l.indexOf(ti); if (i >= 0) l.splice(i, 1); } } };
    tris.forEach((t, ti) => reg(ti, true));
    let off = 0;
    for (const rf of refs) { // re-insert boundary points earcut skipped (keeps the part watertight)
      const n = rf.length, loc = [];
      for (let i = 0; i < n; i++) if (used.has(off + i)) loc.push(i);
      if (loc.length && loc.length < n) for (let q = 0; q < loc.length; q++) {
        const i0 = loc[q], i1 = loc[(q + 1) % loc.length], gap = (i1 - i0 + n) % n; if (gap <= 1) continue;
        const a = rf[i0], b = rf[i1], lst = edgeTri.get(ek(a, b)); if (!lst || !lst.length) continue;
        const ti = lst[0], t = tris[ti]; if (!t) continue; const x = t.find(z => z !== a && z !== b);
        const chain = [a]; for (let g = 1; g < gap; g++) chain.push(rf[(i0 + g) % n]); chain.push(b);
        reg(ti, false); tris[ti] = null;
        const fw = t[(t.indexOf(a) + 1) % 3] === b;
              for (let g = 0; g < chain.length - 1; g++) { tris.push(fw ? [chain[g], chain[g + 1], x] : [chain[g + 1], chain[g], x]); reg(tris.length - 1, true); }
      }
      off += n;
    }
    const p2 = new Map(); refs.forEach((rf, i) => rf.forEach((id, j) => p2.set(id, shapes[i][j])));
    let sa = 0; for (const t of tris) if (t) { const A = p2.get(t[0]), Bq = p2.get(t[1]), C = p2.get(t[2]); sa += (Bq.x - A.x) * (C.y - A.y) - (Bq.y - A.y) * (C.x - A.x); }
    const flipT = (sa > 0) !== (s > 0), seenT = new Set();
    for (const t of tris) if (t) { const key = t.slice().sort((a, b) => a - b).join('_'); if (seenT.has(key)) continue; seenT.add(key); if (flipT) B.tri(t[0], t[2], t[1]); else B.tri(t[0], t[1], t[2]); }
    for (const { f, ring } of rings) {
      const radial = (i) => { const a = (i + 0.5) / SEG * Math.PI * 2; return [Math.cos(a), Math.sin(a)]; };
      const mk = (R, kk) => { const out = []; for (let i = 0; i < SEG; i++) { const a = i / SEG * Math.PI * 2; const p = pt3(f.u + R * Math.cos(a), f.v + R * Math.sin(a), kk); out.push(B.add(p[0], p[1], p[2])); } return out; };
      const wall = (r0, r1, inward, kz) => { for (let i = 0; i < SEG; i++) { const j = (i + 1) % SEG, rd = radial(i); const n3 = pt3(rd[0] * (inward ? -1 : 1), rd[1] * (inward ? -1 : 1), kz); B.triN(r0[i], r0[j], r1[j], n3); B.triN(r0[i], r1[j], r1[i], n3); } };
      const disk = (rr, kk, sgn) => { const cp = pt3(f.u, f.v, kk); const ci = B.add(cp[0], cp[1], cp[2]); const n3 = [0, 0, 0]; n3[k] = sgn; for (let i = 0; i < SEG; i++) B.triN(ci, rr[i], rr[(i + 1) % SEG], n3); };
      if (f.kind === 'hole') { const r1 = mk(f.R, c - s * f.h); wall(ring, r1, true, 0); disk(r1, c - s * f.h, s); }
      else {
        const ch = Math.min(0.6, f.h / 3, f.R / 3), r1 = mk(f.R, c + s * (f.h - ch)), r2 = mk(f.R - ch, c + s * f.h);
        wall(ring, r1, false, 0); wall(r1, r2, false, s * 0.7); disk(r2, c + s * f.h, s);
      }
    }
  }

  // find the cut faces of one part
  function partFaces(m, planes, pi) {
    const P = m.pos, I = m.idx, groups = new Map();
    for (let t = 0; t < I.length; t += 3) {
      const a = I[t] * 3, b = I[t + 1] * 3, cc = I[t + 2] * 3;
      for (let k = 0; k < 3; k++) {
        if (P[a + k] !== P[b + k] || P[a + k] !== P[cc + k]) continue;
        const key = k + ':' + P[a + k]; if (!planes.has(key)) break;
        const u = (k + 1) % 3, v = (k + 2) % 3;
        const nk = (P[b + u] - P[a + u]) * (P[cc + v] - P[a + v]) - (P[b + v] - P[a + v]) * (P[cc + u] - P[a + u]);
        if (Math.abs(nk) < 1e-9) break; // zero-area slivers stay as they are
        const g = key + ':' + (nk > 0 ? 1 : -1); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(t); break;
      }
    }
    const faces = [];
    for (const [g, tris] of groups) {
      const [ks, cs, ss] = g.split(':'), k = +ks, c = P[I[tris[0]] * 3 + k], s = +ss, u = (k + 1) % 3, v = (k + 2) % 3;
      const dir = new Map();
      for (const t of tris) for (let e = 0; e < 3; e++) { const a = I[t + e], b = I[t + (e + 1) % 3]; dir.set(a + '_' + b, [a, b]); }
      const next = new Map();
      for (const [key, [a, b]] of dir) if (!dir.has(b + '_' + a)) { if (!next.has(a)) next.set(a, []); next.get(a).push(b); }
      const loops = [];
      for (const start of next.keys()) {
        while (next.get(start).length) {
          const loop = [start]; let cur = start, ok = false;
          for (let guard = 0; guard < 1e6; guard++) { const l = next.get(cur); if (!l || !l.length) break; const nx = l.pop(); if (nx === start) { ok = true; break; } loop.push(nx); cur = nx; }
          if (ok && loop.length >= 3) loops.push(loop);
        }
      }
      const L2 = loops.map(l => l.map(id => [P[id * 3 + u], P[id * 3 + v]])), areas = L2.map(area2);
      const depth = loops.map((l, i) => { let d = 0; for (let j = 0; j < loops.length; j++) if (j !== i && inPoly(L2[i][0][0], L2[i][0][1], L2[j])) d++; return d; });
      const regions = [];
      loops.forEach((l, i) => {
        if (depth[i] % 2) return;
        const holes = []; loops.forEach((h, j) => { if (depth[j] === depth[i] + 1 && inPoly(L2[j][0][0], L2[j][0][1], L2[i])) holes.push(j); });
        regions.push({ outer: i, holes, area: Math.abs(areas[i]) - holes.reduce((a, j) => a + Math.abs(areas[j]), 0) });
      });
      const edges = []; let mn = [Infinity, Infinity], mx = [-Infinity, -Infinity];
      for (const l of L2) for (let i = 0; i < l.length; i++) { const p = l[i], q = l[(i + 1) % l.length]; edges.push(p[0], p[1], q[0], q[1]); for (let d = 0; d < 2; d++) { if (p[d] < mn[d]) mn[d] = p[d]; if (p[d] > mx[d]) mx[d] = p[d]; } }
      faces.push({ pi, k, c, s, key: k + ':' + c, tris, loops, L2, regions, area: regions.reduce((a, r) => a + r.area, 0), E: Float64Array.from(edges), mn, mx, feats: [], contacts: [] });
    }
    return faces;
  }
  function inFace(F, x, y) { for (const rg of F.regions) { if (!inPoly(x, y, F.L2[rg.outer])) continue; let h = false; for (const j of rg.holes) if (inPoly(x, y, F.L2[j])) { h = true; break; } if (!h) return true; } return false; }
  function faceClear2(F, x, y, need2) { const E = F.E; let md = Infinity; for (let e = 0; e < E.length; e += 4) { const d = segDist2(x, y, E[e], E[e + 1], E[e + 2], E[e + 3]); if (d < md) { md = d; if (md < need2) return md; } } return md; }
  function capsuleGap(a0, a1, b0, b1) { // approximate distance between two segments
    let m = Infinity;
    for (let i = 0; i <= 6; i++) { const t = i / 6, p = [0, 1, 2].map(q => a0[q] + (a1[q] - a0[q]) * t);
      for (let j = 0; j <= 6; j++) { const w = j / 6, d = Math.hypot(p[0] - (b0[0] + (b1[0] - b0[0]) * w), p[1] - (b0[1] + (b1[1] - b0[1]) * w), p[2] - (b0[2] + (b1[2] - b0[2]) * w)); if (d < m) m = d; } }
    return m;
  }

  // candidate connector spots along the middle of thin walls: walk each outline, look straight
  // inward to the far side of the wall, and take the midpoint when the wall is thick enough
  function ringCands(A, Bf, need, lo, hi) {
    const out = [], both = (x, y) => inFace(A, x, y) && inFace(Bf, x, y), need2 = need * need;
    for (const F of [A]) for (const rg of F.regions) for (const li of [rg.outer].concat(rg.holes)) {
      const L = F.L2[li], n = L.length; let acc = 0; const every = Math.max(1.5, need * 0.8);
      for (let i = 0; i < n; i++) {
        const p = L[i], q = L[(i + 1) % n], ex = q[0] - p[0], ey = q[1] - p[1], len = Math.hypot(ex, ey); if (len < 1e-9) continue;
        for (let t = (every - acc) % every; t < len; t += every) {
          const x0 = p[0] + ex * t / len, y0 = p[1] + ey * t / len;
          if (x0 < lo[0] - 1 || y0 < lo[1] - 1 || x0 > hi[0] + 1 || y0 > hi[1] + 1) continue;
          for (const sg of [1, -1]) {
            const nx = -ey / len * sg, ny = ex / len * sg;
            if (!both(x0 + nx * 0.3, y0 + ny * 0.3)) continue;
            let T = 0.3; while (T < 6 * need && both(x0 + nx * (T + 0.4), y0 + ny * (T + 0.4))) T += 0.4;
            let hi2 = T + 0.4; for (let it = 0; it < 4; it++) { const mid = (T + hi2) / 2; if (both(x0 + nx * mid, y0 + ny * mid)) T = mid; else hi2 = mid; }
            if (T < 2 * need - 0.05) break;
            const cx = x0 + nx * T / 2, cy = y0 + ny * T / 2, d = Math.min(faceClear2(A, cx, cy, need2), faceClear2(Bf, cx, cy, need2));
            if (d >= need2) out.push([cx, cy, d]);
            break;
          }
        }
        acc = (acc + len) % every;
      }
    }
    return out;
  }

  // meshes: final parts; planes: Set of 'k:c'; J: joint settings; fits(size[3]) -> bool
  function addJoints(meshes, planes, J, fits) {
    const info = meshes.map(() => ({ pegs: 0, holes: 0, print: null, pinFaces: 0 }));
    if (J.type === 'flat' || !planes.size) return { meshes, info, connectors: 0, pins: 0 };
    const r = J.d / 2, Rs = r + J.clr, need = Rs + J.wall, L = J.len;
    const faces = []; meshes.forEach((m, pi) => { for (const f of partFaces(m, planes, pi)) faces.push(f); });
    const byPlane = new Map();
    for (const f of faces) { if (!byPlane.has(f.key)) byPlane.set(f.key, { pos: [], neg: [] }); byPlane.get(f.key)[f.s > 0 ? 'pos' : 'neg'].push(f); }
    // contacts with candidate connector spots
    const contacts = [];
    for (const { pos, neg } of byPlane.values()) for (const A of pos) for (const Bf of neg) {
      const lo = [Math.max(A.mn[0], Bf.mn[0]), Math.max(A.mn[1], Bf.mn[1])], hi = [Math.min(A.mx[0], Bf.mx[0]), Math.min(A.mx[1], Bf.mx[1])];
      if (hi[0] - lo[0] < 1 || hi[1] - lo[1] < 1) continue;
      const ov = (hi[0] - lo[0]) * (hi[1] - lo[1]); let step = Math.max(need * 0.35, Math.sqrt(ov / 1500)); const need2 = need * need;
      if (J.shellWall) step = Math.min(step, Math.max(0.8, J.shellWall * 0.45)); // thin rings: sample finely enough to land in the wall
      const cands = []; let inside = 0;
      for (let x = lo[0] + step / 2; x < hi[0]; x += step) for (let y = lo[1] + step / 2; y < hi[1]; y += step) {
        if (!inFace(A, x, y) || !inFace(Bf, x, y)) continue; inside++;
        const d = Math.min(faceClear2(A, x, y, need2), faceClear2(Bf, x, y, need2)); if (d >= need2) cands.push([x, y, d]);
      }
      if (!inside) continue;
      if (J.shellWall) for (const c2 of ringCands(A, Bf, need, lo, hi)) cands.push(c2);
      const ct = { A, B: Bf, k: A.k, c: A.c, cands, area: inside * step * step };
      contacts.push(ct); A.contacts.push(ct); Bf.contacts.push(ct);
    }
    // each part keeps its largest touching face peg-free
    // prefer a big face whose neighbours are not also keeping that contact flat (that would need pins)
    const flatOf = new Map(), byPart = new Map();
    for (const f of faces) { if (!f.contacts.length) continue; f.cArea = f.contacts.reduce((s2, c2) => s2 + c2.area, 0); if (!byPart.has(f.pi)) byPart.set(f.pi, []); byPart.get(f.pi).push(f); }
    const order = Array.from(byPart.keys()).sort((a, b) => byPart.get(a).length - byPart.get(b).length);
    for (const pi of order) {
      const fs = byPart.get(pi).sort((a, b) => b.cArea - a.cArea), big = fs[0].cArea;
      const other = (f, ct) => ct.A === f ? ct.B : ct.A;
      const pick = fs.find(f => f.cArea >= 0.2 * big && f.contacts.every(ct => !other(f, ct).flat)) || fs[0];
      pick.flat = true; flatOf.set(pi, { f: pick });
    }
    for (const ct of contacts) ct.mode = J.type === 'dowel' || (ct.A.flat && ct.B.flat) ? 'pin' : ct.A.flat ? 'pegB' : 'pegA';
    // pegs must not push a part past the bed: fall back to pins where they would
    const tally0 = { pin: 0, pegA: 0, pegB: 0 }; for (const ct of contacts) tally0[ct.mode]++;
    if (J.type === 'peg' && fits) {
      const bbs = meshes.map(m => bbox(m));
      const pegFace = (ct) => ct.mode === 'pegA' ? ct.A : ct.mode === 'pegB' ? ct.B : null;
      const partFits = (pi) => {
        const grow = [[0, 0], [0, 0], [0, 0]];
        for (const f of faces) if (f.pi === pi) for (const ct of f.contacts) if (pegFace(ct) === f) grow[f.k][f.s > 0 ? 1 : 0] = L;
        return fits(bbs[pi].size.map((x, k) => x + grow[k][0] + grow[k][1]));
      };
      for (let pass = 0; pass < 4; pass++) {
        let changed = false;
        for (let pi = 0; pi < meshes.length; pi++) {
          if (partFits(pi)) continue;
          for (const f of faces) if (f.pi === pi) for (const ct of f.contacts) {
            if (pegFace(ct) !== f) continue;
            const other = ct.A === f ? ct.B : ct.A, prev = ct.mode;
            if (!other.flat) { ct.mode = ct.A === other ? 'pegA' : 'pegB'; if (partFits(other.pi)) { changed = true; continue; } }
            ct.mode = 'pin'; changed = changed || prev !== 'pin';
          }
        }
        if (!changed) break;
      }
    }
    // place connectors, biggest contacts first, never letting two collide inside a part
    const caps = meshes.map(() => []), pinLens = []; let total = 0, pins = 0;
    const bands = new Map();
    const band = (pi, k, c, reach) => {
      const key = pi + '|' + k + '|' + c; if (bands.has(key)) return bands.get(key);
      const P = meshes[pi].pos, I = meshes[pi].idx, arr = [];
      for (let t = 0; t < I.length; t += 3) { let mn = Infinity, mx = -Infinity; for (let q = 0; q < 3; q++) { const z = P[3 * I[t + q] + k]; if (z < mn) mn = z; if (z > mx) mx = z; } if (mx >= c - reach && mn <= c + reach) arr.push(I[t], I[t + 1], I[t + 2]); }
      const b = Uint32Array.from(arr); bands.set(key, b); return b;
    };
    contacts.sort((a, b) => b.area - a.area);
    for (const ct of contacts) {
      if (!ct.cands.length) continue;
      const { A, B: Bf, k, c } = ct, u = (k + 1) % 3, v = (k + 2) % 3;
      const depths = (Lc) => [ct.mode === 'pegA' ? 0 : ct.mode === 'pegB' ? Lc + 0.6 : Lc / 2 + 0.5,   // depth into the lower part
                              ct.mode === 'pegB' ? 0 : ct.mode === 'pegA' ? Lc + 0.6 : Lc / 2 + 0.5];  // depth into the upper part
      const reach = L + 4, bA = band(A.pi, k, c, reach), bB = band(Bf.pi, k, c, reach);
      const pt = (x, y, z) => { const p = [0, 0, 0]; p[u] = x; p[v] = y; p[k] = z; return p; };
      // solid shells need a lot of room around a hole; a thin shell wall only needs a skin over it,
      // and in a curved wall a shorter peg is better than none
      const ringR = J.shellWall ? Rs + 0.6 : Rs + 0.8, skin = J.shellWall ? 0.6 : 1.2;
      const lens = J.shellWall ? [L, L * 0.7, L * 0.5].filter((x, i) => i === 0 || x >= 4) : [L];
      const ok = (x, y) => {
        const pts = [[x, y]]; for (let a2 = 0; a2 < 8; a2++) pts.push([x + ringR * Math.cos(a2 * Math.PI / 4), y + ringR * Math.sin(a2 * Math.PI / 4)]);
        // how deep can we go on each side at these points?
        let dA = Infinity, dB = Infinity;
        for (const p of pts) { dA = Math.min(dA, rayDist(meshes[A.pi].pos, bA, k, c, p[0], p[1], -1)); dB = Math.min(dB, rayDist(meshes[Bf.pi].pos, bB, k, c, p[0], p[1], +1)); }
        for (const Lc of lens) {
          const [hA, hB] = depths(Lc);
          if ((hA && dA < hA + skin) || (hB && dB < hB + skin)) continue;
          const segA = [pt(x, y, c), pt(x, y, c - Math.max(hA, 0.1))], segB = [pt(x, y, c), pt(x, y, c + Math.max(hB, 0.1))];
          let clash = false;
          for (const q of caps[A.pi]) if (capsuleGap(segA[0], segA[1], q[0], q[1]) < 2 * Rs + J.wall) { clash = true; break; }
          if (!clash) for (const q of caps[Bf.pi]) if (capsuleGap(segB[0], segB[1], q[0], q[1]) < 2 * Rs + J.wall) { clash = true; break; }
          if (clash) return 0;
          return Lc;
        }
        return 0;
      };
      // shells: always aim for several pegs spread round the ring, that's what keeps it aligned
      const target = J.shellWall ? J.maxPer : Math.min(J.maxPer, Math.max(1, Math.floor(ct.area / 2500))), spacing = Math.max(3 * J.d, 2 * Rs + 2 * J.wall);
      const alive = ct.cands.slice().sort((a, b) => b[2] - a[2]), sel = []; let tries = 0;
      while (sel.length < target && alive.length && tries < (J.shellWall ? 200 : 60)) {
        let bi = -1;
        if (!sel.length) bi = 0;
        else { let bd = -1; for (let i = 0; i < alive.length; i++) { let m = Infinity; for (const q of sel) { const dx = alive[i][0] - q[0], dy = alive[i][1] - q[1]; m = Math.min(m, dx * dx + dy * dy); } const sc = m + alive[i][2] * 0.05; if (m >= spacing * spacing && sc > bd) { bd = sc; bi = i; } } if (bi < 0) break; }
        const cnd = alive.splice(bi, 1)[0]; tries++;
        const Lc = ok(cnd[0], cnd[1]); if (Lc) { sel.push([cnd[0], cnd[1], Lc]); const [hA, hB] = depths(Lc); caps[A.pi].push([pt(cnd[0], cnd[1], c), pt(cnd[0], cnd[1], c - Math.max(hA, 0.1))]); caps[Bf.pi].push([pt(cnd[0], cnd[1], c), pt(cnd[0], cnd[1], c + Math.max(hB, 0.1))]); }
      }
      for (const [x, y, Lc] of sel) {
        const [hA, hB] = depths(Lc);
        if (ct.mode === 'pegA') { A.feats.push({ u: x, v: y, kind: 'peg', R: r, h: Lc }); Bf.feats.push({ u: x, v: y, kind: 'hole', R: Rs, h: hB }); info[A.pi].pegs++; info[Bf.pi].holes++; }
        else if (ct.mode === 'pegB') { A.feats.push({ u: x, v: y, kind: 'hole', R: Rs, h: hA }); Bf.feats.push({ u: x, v: y, kind: 'peg', R: r, h: Lc }); info[A.pi].holes++; info[Bf.pi].pegs++; }
        else { A.feats.push({ u: x, v: y, kind: 'hole', R: Rs, h: hA }); Bf.feats.push({ u: x, v: y, kind: 'hole', R: Rs, h: hB }); info[A.pi].holes++; info[Bf.pi].holes++; pins++; pinLens.push(Lc); }
        total++;
      }
    }
    // rebuild the faces that received features
    const out = meshes.map((m, pi) => {
      const pf = faces.filter(f => f.pi === pi && f.feats.length);
      if (!pf.length) return m;
      const drop = new Set(); for (const f of pf) for (const t of f.tris) drop.add(t);
      const B = new Builder(0); B.pos = Array.from(m.pos);
      for (let t = 0; t < m.idx.length; t += 3) if (!drop.has(t)) B.idx.push(m.idx[t], m.idx[t + 1], m.idx[t + 2]);
      for (const f of pf) for (const rg of f.regions) {
        const li = [rg.outer].concat(rg.holes);
        const feats = f.feats.filter(ft => inPoly(ft.u, ft.v, f.L2[rg.outer]) && !rg.holes.some(j => inPoly(ft.u, ft.v, f.L2[j])));
        // keep the face's outward winding: loops were traced from the face triangles
        fillCap(B, f.k, f.c, f.s, li.map(i => f.loops[i]), li.map(i => f.L2[i]), feats);
      }
      return B.mesh();
    });
    for (const { f } of flatOf.values()) info[f.pi].print = { k: f.k, s: f.s };
    const tally1 = { pin: 0, pegA: 0, pegB: 0 }; for (const ct of contacts) tally1[ct.mode]++;
    return { meshes: out, info, connectors: total, pins, pinLens, debug: { tally0, tally1 } };
  }

  // ---------- dovetail joints (sliding rails, or separate slide-in keys) ----------
  // Needs the Manifold WASM module (MF) for the boolean operations.
  // J: {dw: rail base width, dh: rail depth, clr, wall, maxPer, keysOnly}
  // Rails: one part grows a dovetail rail, its neighbour gets a matching slot. Parts are
  // assembled in index order; each new part slides in along one axis, chosen so its path is
  // clear and every slot is open on the side the rail enters from.
  // Keys: both parts get a channel and a printed double-dovetail key slides in afterwards
  // (used where both faces must print flat, where a rail can't be slid in, or when keysOnly).
  function addDovetails(meshes, planes, J, fits, MF) {
    const { Manifold, Mesh } = MF;
    const N = meshes.length;
    const info = meshes.map(() => ({ rails: 0, slots: 0, keySlots: 0, pegs: 0, holes: 0, print: null }));
    const result = { meshes, info, connectors: 0, pins: 0, keys: [], steps: [], rails: 0, skipped: 0 };
    if (!planes.size || N < 2) return result;
    const TAN = Math.tan(15 * Math.PI / 180);
    const hw = J.dw / 2, h = J.dh, clr = J.clr;
    const hwTop = hw + h * TAN;
    const need = hwTop + clr + J.wall;           // solid band needed either side of a rail line
    const depthNeed = h + clr + 1.0;             // material needed behind a slot / channel
    const minLen = Math.max(2 * J.dw, 12);

    // faces and touching pairs
    const faces = []; meshes.forEach((m, pi) => { for (const f of partFaces(m, planes, pi)) faces.push(f); });
    const byPlane = new Map();
    for (const f of faces) { if (!byPlane.has(f.key)) byPlane.set(f.key, { pos: [], neg: [] }); byPlane.get(f.key)[f.s > 0 ? 'pos' : 'neg'].push(f); }
    const contacts = [];
    for (const { pos, neg } of byPlane.values()) for (const A of pos) for (const Bf of neg) {
      const lo = [Math.max(A.mn[0], Bf.mn[0]), Math.max(A.mn[1], Bf.mn[1])], hi = [Math.min(A.mx[0], Bf.mx[0]), Math.min(A.mx[1], Bf.mx[1])];
      if (hi[0] - lo[0] < 1 || hi[1] - lo[1] < 1) continue;
      let step = Math.max(1, Math.sqrt((hi[0] - lo[0]) * (hi[1] - lo[1]) / 1500)); let inside = 0;
      if (J.shellWall) step = Math.min(step, Math.max(0.8, J.shellWall * 0.45));
      for (let x = lo[0] + step / 2; x < hi[0]; x += step) for (let y = lo[1] + step / 2; y < hi[1]; y += step) if (inFace(A, x, y) && inFace(Bf, x, y)) inside++;
      if (!inside) continue;
      const ct = { A, B: Bf, k: A.k, c: A.c, lo, hi, area: inside * step * step, lines: [null, null] };
      contacts.push(ct); A.contacts.push(ct); Bf.contacts.push(ct);
    }
    if (!contacts.length) return result;

    const otherFace = (f, ct) => ct.A === f ? ct.B : ct.A;
    for (const f of faces) f.cArea = f.contacts.reduce((s2, c2) => s2 + c2.area, 0);

    // ---- candidate lines on a contact, running along in-plane axis wi (0 = face u, 1 = face v) ----
    const bands = new Map();
    const band = (pi, k, c) => {
      const key = pi + '|' + k + '|' + c; if (bands.has(key)) return bands.get(key);
      const P = meshes[pi].pos, I = meshes[pi].idx, arr = [], reach = depthNeed + 2;
      for (let t = 0; t < I.length; t += 3) { let mn = Infinity, mx = -Infinity; for (let q = 0; q < 3; q++) { const z = P[3 * I[t + q] + k]; if (z < mn) mn = z; if (z > mx) mx = z; } if (mx >= c - reach && mn <= c + reach) arr.push(I[t], I[t + 1], I[t + 2]); }
      const b = Uint32Array.from(arr); bands.set(key, b); return b;
    };
    function linesFor(ct, wi) {
      if (ct.lines[wi]) return ct.lines[wi];
      const qi = 1 - wi, A = ct.A, B = ct.B, k = ct.k, c = ct.c;
      const qlo = ct.lo[qi] + need, qhi = ct.hi[qi] - need, out = [];
      ct.lines[wi] = out; if (qhi < qlo) return out;
      const wlo = ct.lo[wi], whi = ct.hi[wi];
      const nq = Math.min(J.shellWall ? 160 : 12, Math.max(1, Math.floor((qhi - qlo) / (J.shellWall ? 1.5 : 3)) + 1));
      const sw = Math.max(1, (whi - wlo) / 90);
      const P2 = (w, q) => wi === 0 ? [w, q] : [q, w];
      const bA = band(A.pi, k, c), bB = band(B.pi, k, c), PA = meshes[A.pi].pos, PB = meshes[B.pi].pos;
      const both = (w, q) => { const p = P2(w, q); return inFace(A, p[0], p[1]) && inFace(B, p[0], p[1]); };
      const deep = (P, bnd, dir, w, t) => { for (const q of [t, t - hwTop - clr, t + hwTop + clr]) { const p = P2(w, q); if (rayDist(P, bnd, k, c, p[0], p[1], dir) < depthNeed) return false; } return true; };
      for (let iq = 0; iq < nq; iq++) {
        const t = nq === 1 ? (qlo + qhi) / 2 : qlo + (qhi - qlo) * iq / (nq - 1);
        const ws = [], ok = [], dA = [], dB = [];
        for (let w = wlo + sw / 2; w < whi; w += sw) {
          const v = both(w, t) && both(w, t - hw) && both(w, t + hw) && both(w, t - need) && both(w, t + need);
          ws.push(w); ok.push(v); dA.push(v && deep(PA, bA, -1, w, t)); dB.push(v && deep(PB, bB, +1, w, t));
        }
        // present(X, w): does face X exist on this line just past an end?
        const present = (F, w) => { const p = P2(w, t); return inFace(F, p[0], p[1]); };
        out.push({ t, ws, ok, dA, dB, sw, present });
      }
      return out;
    }
    // longest usable run on a line. needA/needB: material required behind the plane on that side.
    function runs(line, needA, needB) {
      const res = []; let i0 = -1;
      const good = (i) => line.ok[i] && (!needA || line.dA[i]) && (!needB || line.dB[i]);
      for (let i = 0; i <= line.ws.length; i++) {
        if (i < line.ws.length && good(i)) { if (i0 < 0) i0 = i; continue; }
        if (i0 >= 0) {
          const w0 = line.ws[i0] - line.sw / 2, w1 = line.ws[i - 1] + line.sw / 2;
          if (w1 - w0 >= minLen) res.push({ w0, w1, len: w1 - w0 });
          i0 = -1;
        }
      }
      return res.sort((a, b) => b.len - a.len);
    }
    // open(F, run, end): face F does not continue past that end of the run (-1 = low end, +1 = high end)
    // the slot may run out through a short margin (round faces end a little past the usable run)
    const openAt = (line, F, run, end) => {
      for (let d = 1.5 * line.sw; d <= 2 * need + 5; d += line.sw) if (!line.present(F, end < 0 ? run.w0 - d : run.w1 + d)) return true;
      return false;
    };

    // ---- solids (needed for path checks and the final booleans) ----
    const trash = [];
    const keep = (m) => { trash.push(m); return m; };
    const mf = meshes.map(m => {
      try {
        const mm = new Manifold(new Mesh({ numProp: 3, vertProperties: Float32Array.from(m.pos), triVerts: Uint32Array.from(m.idx) }));
        return mm.isEmpty() ? null : keep(mm);
      } catch (e) { return null; }
    });
    const lite = mf.map(m => m ? keep(m.simplify(0.5)) : null); // lighter copies for collision sweeps
    const bbs = meshes.map(m => bbox(m));
    const FAR = 1e4;
    const boxHit = (a0, a1, b0, b1, pad) => [0, 1, 2].every(x => Math.min(a1[x], b1[x]) - Math.max(a0[x], b0[x]) > -pad);

    // convex prism: cross-section poly [[q, z]...] (z along +dir*k from the plane), extruded along the w axis from w0 to w1
    const axesOf = (ct, wi) => { const u = (ct.k + 1) % 3, v = (ct.k + 2) % 3; return wi === 0 ? { wAx: u, qAx: v } : { wAx: v, qAx: u }; };
    function prism(ct, wi, t, dir, poly, w0, w1) {
      const k = ct.k, { wAx, qAx } = axesOf(ct, wi);
      const B = new Builder(0), n = poly.length, bot = [], top = [];
      const pt = (q, z, w) => { const p = [0, 0, 0]; p[k] = ct.c + dir * z; p[qAx] = t + q; p[wAx] = w; return B.add(p[0], p[1], p[2]); };
      for (const [q, z] of poly) { bot.push(pt(q, z, w0)); top.push(pt(q, z, w1)); }
      for (let i = 1; i + 1 < n; i++) { B.tri(bot[0], bot[i + 1], bot[i]); B.tri(top[0], top[i], top[i + 1]); }
      for (let i = 0; i < n; i++) { const j = (i + 1) % n; B.tri(bot[i], bot[j], top[j]); B.tri(bot[i], top[j], top[i]); }
      let m = B.mesh(); if (volume(m) < 0) m = flip(m);
      return keep(new Manifold(new Mesh({ numProp: 3, vertProperties: Float32Array.from(m.pos), triVerts: Uint32Array.from(m.idx) })));
    }
    const dove = (hb, ht, d, e) => [[-hb, -e], [hb, -e], [hb, 0], [ht, d], [-ht, d], [-hb, 0]];
    // axis-aligned box a slot/channel occupies inside a part (dir: side of the plane it cuts into)
    function slotBox(ct, wi, t, dir, w0, w1) {
      const { wAx, qAx } = axesOf(ct, wi), mn = [0, 0, 0], mx = [0, 0, 0], r = hwTop + clr, d = h + clr;
      mn[qAx] = t - r; mx[qAx] = t + r; mn[wAx] = w0; mx[wAx] = w1;
      mn[ct.k] = Math.min(ct.c, ct.c + dir * d); mx[ct.k] = Math.max(ct.c, ct.c + dir * d);
      return { min: mn, max: mx };
    }
    // what a rail or key occupies: [{pi, box}] (slot extents already include open-end run-outs)
    function railBoxes(ct, cd, R, S, entry) {
      const { line, r, wi } = cd, dir = R === ct.A ? 1 : -1;
      const sLo = openAt(line, S, r, -1), sHi = openAt(line, S, r, 1);
      cd.s0 = (entry < 0 || sLo) ? r.w0 - FAR : r.w0; cd.s1 = (entry > 0 || sHi) ? r.w1 + FAR : r.w1;
      return [{ pi: S.pi, box: slotBox(ct, wi, line.t, dir, cd.s0, cd.s1) }];
    }
    function keyBoxes(ct, cd) {
      const { line, r, wi } = cd;
      cd.lowOut = openAt(line, ct.A, r, -1) && openAt(line, ct.B, r, -1); cd.highOut = openAt(line, ct.A, r, 1) && openAt(line, ct.B, r, 1);
      cd.e0 = cd.lowOut ? r.w0 - FAR : r.w0; cd.e1 = cd.highOut ? r.w1 + FAR : r.w1;
      return [{ pi: ct.A.pi, box: slotBox(ct, wi, line.t, -1, cd.e0, cd.e1) }, { pi: ct.B.pi, box: slotBox(ct, wi, line.t, 1, cd.e0, cd.e1) }];
    }
    const occ = meshes.map(() => []); // committed slot/channel boxes per part
    const clashes = (list, temp) => list.some(({ pi, box }) => occ[pi].concat(temp.filter(x => x.pi === pi).map(x => x.box)).some(o => boxHit(box.min, box.max, o.min, o.max, J.wall)));

    // choose up to maxPer well-spaced (line, run) pairs that pass test() and don't clash with other slots
    function pickLines(ct, wi, needA, needB, test, boxesOf, temp) {
      const qi = 1 - wi, cands = [];
      for (const line of linesFor(ct, wi)) for (const r of runs(line, needA, needB)) if (test(line, r)) cands.push({ line, r, wi });
      cands.sort((a, b) => b.r.len - a.r.len);
      const target = Math.min(J.maxPer, Math.max(1, Math.floor((ct.hi[qi] - ct.lo[qi]) / (4 * J.dw)))), spacing = Math.max(3 * J.dw, 2 * need);
      const sel = [], mine = [];
      for (const cd of cands) {
        if (sel.length >= target) break;
        if (!sel.every(s2 => Math.abs(s2.line.t - cd.line.t) >= spacing)) continue;
        const bx = boxesOf(cd);
        if (clashes(bx, temp.concat(mine))) continue;
        sel.push(cd); mine.push(...bx);
      }
      return { sel, boxes: mine };
    }

    // is the way out along axis a (direction sg) clear of the given parts? (moving solid, translated step by step)
    function sweepClear(moving, mb, a, sg, others) {
      const lo = mb.min.slice(), hi = mb.max.slice(); if (sg > 0) hi[a] = Infinity; else lo[a] = -Infinity;
      const hitList = others.filter(q => lite[q] && boxHit(lo, hi, bbs[q].min, bbs[q].max, -0.5));
      if (!hitList.length) return true;
      if (!moving) return false;
      for (const q of hitList) {
        const reach = (sg > 0 ? bbs[q].max[a] - mb.min[a] : mb.max[a] - bbs[q].min[a]) + 1;
        for (let d = 1; d <= reach; d += 2) {
          const v = [0, 0, 0]; v[a] = sg * d;
          const moved = moving.translate(v), x = moved.intersect(lite[q]), vol = x.volume(); moved.delete(); x.delete();
          if (vol > 0.5) return false;
        }
      }
      return true;
    }
    // key lines: material both sides, an end where both faces stop, and a clear way in from that end
    function keyPlan(ct, temp) {
      let best = null; const i = Math.max(ct.A.pi, ct.B.pi);
      const others = []; for (let q = 0; q <= i; q++) if (q !== ct.A.pi && q !== ct.B.pi) others.push(q);
      for (const wi of [0, 1]) {
        const { wAx } = axesOf(ct, wi);
        const pk = pickLines(ct, wi, true, true, (line, r) => {
          const cd = { line, r, wi }; keyBoxes(ct, cd);
          if (!cd.lowOut && !cd.highOut) return false;
          const sg = cd.lowOut ? -1 : 1, bx = slotBox(ct, wi, line.t, 1, r.w0, r.w1), bx2 = slotBox(ct, wi, line.t, -1, r.w0, r.w1);
          const kb = { min: bx.min.map((x, q) => Math.min(x, bx2.min[q])), max: bx.max.map((x, q) => Math.max(x, bx2.max[q])) };
          const kp = keep(Manifold.union(prism(ct, wi, line.t, 1, dove(hw, hwTop, h, 0.05), r.w0, r.w1), prism(ct, wi, line.t, -1, dove(hw, hwTop, h, 0.05), r.w0, r.w1)));
          return sweepClear(kp, kb, wAx, sg, others);
        }, (cd) => keyBoxes(ct, cd), temp);
        const score = pk.sel.reduce((s2, x) => s2 + x.r.len, 0);
        if (pk.sel.length && (!best || score > best.score)) best = { sel: pk.sel, boxes: pk.boxes, score };
      }
      return best ? { mode: 'key', sel: best.sel, boxes: best.boxes } : { mode: 'none', boxes: [] };
    }

    // ---- assembly order: part i slides in after parts 0..i-1 ----
    const MOVES = [[2, -1], [0, 1], [0, -1], [1, 1], [1, -1], [2, 1]]; // prefer dropping in from above
    const plans = new Map(); // contact -> {mode, sel, R, S, entry, boxes}
    const commit = (pl) => { for (const { pi, box } of pl.boxes) occ[pi].push(box); };
    for (let i = 1; i < N; i++) {
      const mine = contacts.filter(ct => Math.max(ct.A.pi, ct.B.pi) === i && ct.A.pi !== ct.B.pi);
      if (!mine.length) continue;
      const placed = []; for (let q = 0; q < i; q++) placed.push(q);
      let best = null;
      if (!J.keysOnly && mf[i]) for (const [a, sg] of MOVES) {
        const railable = mine.filter(ct => ct.k !== a);
        if (!railable.length) continue;
        // the part arrives travelling +sg along a, so it comes from the -sg side
        if (!sweepClear(lite[i], bbs[i], a, -sg, placed)) continue;
        let score = 0; const assign = new Map(), temp = [];
        for (const ct of railable) {
          const fP = ct.A.pi === i ? ct.A : ct.B, fQ = otherFace(fP, ct);
          const wi = a === (ct.k + 1) % 3 ? 0 : 1;
          let got = null;
          for (const R of [fQ, fP]) { // rails on the part already in place first, so the moving part keeps flat faces
            const S = otherFace(R, ct);
            const entry = S === fP ? sg : -sg; // slot end the rail enters from, in the slot part's coordinates
            const pk = pickLines(ct, wi, S === ct.A, S === ct.B, (line, r) => openAt(line, S, r, entry), (cd) => railBoxes(ct, cd, R, S, entry), temp);
            if (pk.sel.length) { got = { mode: 'rail', sel: pk.sel, boxes: pk.boxes, R, S, entry }; break; }
          }
          if (got) { score += got.sel.reduce((s2, x) => s2 + x.r.len, 0); assign.set(ct, got); temp.push(...got.boxes); }
        }
        if (score > 0 && (!best || score > best.score * 1.15)) best = { a, sg, score, assign };
      }
      const railsTo = [];
      for (const ct of mine) {
        const pl = best && best.assign.get(ct);
        if (pl) { plans.set(ct, pl); commit(pl); railsTo.push(otherFace(ct.A.pi === i ? ct.A : ct.B, ct).pi); }
      }
      for (const ct of mine) if (!plans.has(ct)) { const pl = keyPlan(ct, []); plans.set(ct, pl); commit(pl); }
      result.steps.push({ part: i, move: best ? [best.a, best.sg] : null, onto: Array.from(new Set(railsTo)).sort((x, y) => x - y) });
    }
    // rails stick out of their part: if that breaks the bed fit, use keys there instead
    if (fits) for (let pi = 0; pi < N; pi++) {
      const grow = [[0, 0], [0, 0], [0, 0]];
      for (const [ct, pl] of plans) if (pl.mode === 'rail' && pl.R.pi === pi) grow[ct.k][pl.R.s > 0 ? 1 : 0] = h;
      // fits(size) checks the usable area; fits(size, true) the bed less 1 mm per side.
      // A part that already overflows the usable area may keep rails only if it stays off the bed edge.
      const grown = bbs[pi].size.map((x, k) => x + grow[k][0] + grow[k][1]);
      if (fits(grown) || (!fits(bbs[pi].size) && fits(grown, true)) || !fits(bbs[pi].size, true)) continue;
      for (const [ct, pl] of plans) if (pl.mode === 'rail' && pl.R.pi === pi) {
        for (const { pi: q, box } of pl.boxes) { const j = occ[q].indexOf(box); if (j >= 0) occ[q].splice(j, 1); }
        const kp = keyPlan(ct, []); plans.set(ct, kp); commit(kp);
      }
    }
    for (const st of result.steps) { // refresh which rails survived
      st.onto = Array.from(new Set(Array.from(plans).filter(([ct, pl]) => pl.mode === 'rail' && Math.max(ct.A.pi, ct.B.pi) === st.part).map(([ct]) => ct.A.pi === st.part ? ct.B.pi : ct.A.pi))).sort((x, y) => x - y);
      if (!st.onto.length) st.move = null;
    }

    // print face: each part's largest cut face without a rail on it (slots and key channels print fine
    // face-down). A part with rails on every cut face prints in the model's own orientation.
    const railFaces = new Set(); for (const [, pl] of plans) if (pl.mode === 'rail') railFaces.add(pl.R);
    for (let pi = 0; pi < N; pi++) {
      const fs = faces.filter(f => f.pi === pi && f.contacts.length && !railFaces.has(f)).sort((a, b) => b.cArea - a.cArea);
      info[pi].print = fs.length ? { k: fs[0].k, s: fs[0].s } : null;
    }

    // ---- geometry ----
    const adds = meshes.map(() => []), subs = meshes.map(() => []);
    const unionCache = new Map();
    const pairUnion = (a, b) => { const key = a + '_' + b; if (!unionCache.has(key)) unionCache.set(key, keep(Manifold.union(mf[a], mf[b]))); return unionCache.get(key); };
    let keyNo = 0;
    for (const [ct, pl] of plans) {
      if (pl.mode === 'none' || !mf[ct.A.pi] || !mf[ct.B.pi]) { result.skipped++; continue; }
      const AB = pairUnion(ct.A.pi, ct.B.pi);
      if (pl.mode === 'rail') {
        const { R, S } = pl, dir = R === ct.A ? 1 : -1; // rail grows from R toward S
        for (const cd of pl.sel) {
          const { line, r, wi } = cd;
          const sLo = openAt(line, S, r, -1), sHi = openAt(line, S, r, 1);
          const rw0 = sLo ? r.w0 - 2 : r.w0 + clr, rw1 = sHi ? r.w1 + 2 : r.w1 - clr;
          const rail = keep(prism(ct, wi, line.t, dir, dove(hw, hwTop, h, 0.4), rw0, rw1).intersect(AB));
          const slot = prism(ct, wi, line.t, dir, dove(hw + clr, hwTop + clr, h + clr, 0.5), cd.s0, cd.s1);
          adds[R.pi].push(rail); subs[S.pi].push(slot);
          info[R.pi].rails++; info[S.pi].slots++; result.rails++; result.connectors++;
        }
      } else {
        for (const cd of pl.sel) {
          const { line, r, wi } = cd, lowOut = cd.lowOut, highOut = cd.highOut, e0 = cd.e0, e1 = cd.e1;
          for (const dir of [1, -1]) { const F = dir > 0 ? ct.B : ct.A; subs[F.pi].push(prism(ct, wi, line.t, dir, dove(hw + clr, hwTop + clr, h + clr, 0.5), e0, e1)); info[F.pi].keySlots++; }
          const k0 = lowOut ? r.w0 - 2 : r.w0 + clr, k1 = highOut ? r.w1 + 2 : r.w1 - clr;
          const half = (dir) => prism(ct, wi, line.t, dir, dove(hw, hwTop, h, 0.05), k0, k1);
          const key = keep(keep(Manifold.union(half(1), half(-1))).intersect(AB));
          const km = key.getMesh();
          if (km.triVerts.length) {
            keyNo++;
            const wAx = wi === 0 ? (ct.k + 1) % 3 : (ct.k + 2) % 3;
            result.keys.push({ name: 'K' + keyNo, a: ct.A.pi, b: ct.B.pi, mesh: { pos: Float64Array.from(km.vertProperties.filter((_, i) => i % km.numProp < 3)), idx: Uint32Array.from(km.triVerts) }, print: { k: ct.k, s: -1 }, from: lowOut ? [wAx, -1] : [wAx, 1], len: r.len });
            result.connectors++;
          }
        }
      }
    }
    const toMesh = (m) => { const g = m.getMesh(), np = g.numProp, n = g.vertProperties.length / np, pos = new Float64Array(n * 3); for (let i = 0; i < n; i++) for (let q = 0; q < 3; q++) pos[3 * i + q] = g.vertProperties[np * i + q]; return { pos, idx: Uint32Array.from(g.triVerts) }; };
    result.meshes = meshes.map((m, pi) => {
      if (!mf[pi] || (!adds[pi].length && !subs[pi].length)) return m;
      let r = adds[pi].length ? keep(Manifold.union([mf[pi]].concat(adds[pi]))) : mf[pi];
      if (subs[pi].length) r = keep(r.subtract(keep(Manifold.union(subs[pi]))));
      return r.isEmpty() ? m : toMesh(r);
    });
    result.failedParts = mf.filter(x => !x).length;
    for (const m of trash) { try { m.delete(); } catch (e) {} }
    return result;
  }

  // ---------- shell: keep a constant-thickness outer wall, remove the inside ----------
  // Inside/outside on a grid (ray parity per column), exact Euclidean distance transform to the
  // outside, then Manifold's level set pulls the inner surface at depth = wall. Accuracy ≈ ±s/2.
  // squared distance from point p to triangle (a,b,c are offsets into P) — Ericson, Real-Time Collision Detection 5.1.5
  function triDist2(P, a, b, c, px, py, pz) {
    const abx = P[b] - P[a], aby = P[b + 1] - P[a + 1], abz = P[b + 2] - P[a + 2], acx = P[c] - P[a], acy = P[c + 1] - P[a + 1], acz = P[c + 2] - P[a + 2];
    const apx = px - P[a], apy = py - P[a + 1], apz = pz - P[a + 2];
    const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
    const sq = (x, y, z) => x * x + y * y + z * z;
    if (d1 <= 0 && d2 <= 0) return sq(apx, apy, apz);
    const bpx = px - P[b], bpy = py - P[b + 1], bpz = pz - P[b + 2], d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
    if (d3 >= 0 && d4 <= d3) return sq(bpx, bpy, bpz);
    const vc = d1 * d4 - d3 * d2;
    if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); return sq(apx - v * abx, apy - v * aby, apz - v * abz); }
    const cpx = px - P[c], cpy = py - P[c + 1], cpz = pz - P[c + 2], d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
    if (d6 >= 0 && d5 <= d6) return sq(cpx, cpy, cpz);
    const vb = d5 * d2 - d1 * d6;
    if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); return sq(apx - w * acx, apy - w * acy, apz - w * acz); }
    const va = d3 * d6 - d5 * d4;
    if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) { const w = (d4 - d3) / ((d4 - d3) + (d5 - d6)); return sq(bpx - w * (P[c] - P[b]), bpy - w * (P[c + 1] - P[b + 1]), bpz - w * (P[c + 2] - P[b + 2])); }
    const den = 1 / (va + vb + vc), v = vb * den, w = vc * den;
    return sq(apx - abx * v - acx * w, apy - aby * v - acy * w, apz - abz * v - acz * w);
  }
  function edt1d(f, n, d, v, z) {
    let k = 0; v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
    for (let q = 1; q < n; q++) {
      let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) { k--; s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
      k++; v[k] = q; z[k] = s; z[k + 1] = Infinity;
    }
    k = 0;
    for (let q = 0; q < n; q++) { while (z[k + 1] < q) k++; d[q] = (q - v[k]) * (q - v[k]) + f[v[k]]; }
  }
  // returns {mesh, ok, removed (0..1 of the volume), step, note}
  function hollow(mesh, wall, MF) {
    const { Manifold, Mesh } = MF;
    const bb = bbox(mesh), P = mesh.pos, I = mesh.idx;
    let s = Math.min(3, Math.max(1, wall / 3.5));
    const dims = () => [0, 1, 2].map(k => Math.ceil((bb.size[k] + 4 * s) / s) + 1);
    let n = dims(); while (n[0] * n[1] * n[2] > 1.4e7) { s *= 1.15; n = dims(); }
    const [nx, ny, nz] = n, o = bb.min.map(x => x - 2 * s), N = nx * ny * nz;
    const at = (i, j, k) => (i * ny + j) * nz + k;
    // inside test on grid points: collect z crossings per (i,j) column
    const cols = new Array(nx * ny), jx = s * 0.0137, jy = s * 0.0291;
    for (let t = 0; t < I.length; t += 3) {
      const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
      const xa = P[a], ya = P[a + 1], xb = P[b], yb = P[b + 1], xc = P[c], yc = P[c + 1];
      const det = (yb - yc) * (xa - xc) + (xc - xb) * (ya - yc); if (Math.abs(det) < 1e-12) continue;
      const i0 = Math.max(0, Math.floor((Math.min(xa, xb, xc) - o[0]) / s)), i1 = Math.min(nx - 1, Math.ceil((Math.max(xa, xb, xc) - o[0]) / s));
      const j0 = Math.max(0, Math.floor((Math.min(ya, yb, yc) - o[1]) / s)), j1 = Math.min(ny - 1, Math.ceil((Math.max(ya, yb, yc) - o[1]) / s));
      for (let i = i0; i <= i1; i++) { const px = o[0] + i * s + jx;
        for (let j = j0; j <= j1; j++) { const py = o[1] + j * s + jy;
          const l1 = ((yb - yc) * (px - xc) + (xc - xb) * (py - yc)) / det, l2 = ((yc - ya) * (px - xc) + (xa - xc) * (py - yc)) / det, l3 = 1 - l1 - l2;
          if (l1 < 0 || l2 < 0 || l3 < 0) continue;
          const q = i * ny + j; (cols[q] || (cols[q] = [])).push(l1 * P[a + 2] + l2 * P[b + 2] + l3 * P[c + 2]);
        } }
    }
    const INF = 1e20, g = new Float64Array(N); // 0 outside, INF inside
    let insideCount = 0;
    for (let q = 0; q < nx * ny; q++) {
      const zs = cols[q]; if (!zs || zs.length < 2) continue; zs.sort((x, y) => x - y);
      const i = Math.floor(q / ny), j = q - i * ny;
      for (let m = 0; m + 1 < zs.length; m += 2) {
        const k0 = Math.max(0, Math.ceil((zs[m] - o[2]) / s)), k1 = Math.min(nz - 1, Math.floor((zs[m + 1] - o[2]) / s));
        for (let k = k0; k <= k1; k++) { g[at(i, j, k)] = INF; insideCount++; }
      }
    }
    if (!insideCount) return { mesh, ok: false, note: 'Couldn\'t find the inside of the model (is it watertight?).' };
    // squared EDT, separable along z, y, x
    const L = Math.max(nx, ny, nz), fbuf = new Float64Array(L), dbuf = new Float64Array(L), vbuf = new Int32Array(L), zbuf = new Float64Array(L + 1);
    for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) { const b0 = at(i, j, 0); for (let k = 0; k < nz; k++) fbuf[k] = g[b0 + k]; edt1d(fbuf, nz, dbuf, vbuf, zbuf); for (let k = 0; k < nz; k++) g[b0 + k] = dbuf[k]; }
    for (let i = 0; i < nx; i++) for (let k = 0; k < nz; k++) { for (let j = 0; j < ny; j++) fbuf[j] = g[at(i, j, k)]; edt1d(fbuf, ny, dbuf, vbuf, zbuf); for (let j = 0; j < ny; j++) g[at(i, j, k)] = dbuf[j]; }
    for (let j = 0; j < ny; j++) for (let k = 0; k < nz; k++) { for (let i = 0; i < nx; i++) fbuf[i] = g[at(i, j, k)]; edt1d(fbuf, nx, dbuf, vbuf, zbuf); for (let i = 0; i < nx; i++) g[at(i, j, k)] = dbuf[i]; }
    // depth below the surface (mm); the surface sits about half a step outside the last inside point
    const D = new Float32Array(N); let maxD = 0;
    for (let q = 0; q < N; q++) { const v = g[q] > 0 ? Math.sqrt(g[q]) * s - 0.5 * s : -s; D[q] = v; if (v > maxD) maxD = v; }
    if (maxD <= wall + s) return { mesh, ok: false, note: 'The model is thinner than twice the wall everywhere, so it is already a shell.' };
    // exact distance to the surface for grid points near the wall depth (removes the grid bias)
    {
      const band = [], lo = wall - 2 * s, hi = wall + 2 * s;
      for (let q = 0; q < N; q++) if (D[q] > lo && D[q] < hi) band.push(q);
      const cs = hi + s, hn = [0, 1, 2].map(k => Math.max(1, Math.ceil((bb.size[k] + 4 * s) / cs))), cells = new Map();
      const cid = (x, y, z) => (x * hn[1] + y) * hn[2] + z;
      const cl = (v, k) => Math.min(hn[k] - 1, Math.max(0, Math.floor((v - o[k]) / cs)));
      for (let t = 0; t < I.length; t += 3) {
        const mn = [0, 1, 2].map(k => cl(Math.min(P[I[t] * 3 + k], P[I[t + 1] * 3 + k], P[I[t + 2] * 3 + k]), k));
        const mx = [0, 1, 2].map(k => cl(Math.max(P[I[t] * 3 + k], P[I[t + 1] * 3 + k], P[I[t + 2] * 3 + k]), k));
        for (let x = mn[0]; x <= mx[0]; x++) for (let y = mn[1]; y <= mx[1]; y++) for (let z = mn[2]; z <= mx[2]; z++) { const c = cid(x, y, z); let l = cells.get(c); if (!l) cells.set(c, l = []); l.push(t); }
      }
      const seen = new Int32Array(I.length / 3).fill(-1);
      for (let bi = 0; bi < band.length; bi++) {
        const q = band[bi], k = q % nz, j = ((q - k) / nz) % ny, i = (q - k - j * nz) / (ny * nz);
        const px = o[0] + i * s, py = o[1] + j * s, pz = o[2] + k * s, cx = cl(px, 0), cy = cl(py, 1), cz = cl(pz, 2);
        let best = Infinity;
        for (let x = Math.max(0, cx - 1); x <= Math.min(hn[0] - 1, cx + 1); x++) for (let y = Math.max(0, cy - 1); y <= Math.min(hn[1] - 1, cy + 1); y++) for (let z = Math.max(0, cz - 1); z <= Math.min(hn[2] - 1, cz + 1); z++) {
          const l = cells.get(cid(x, y, z)); if (!l) continue;
          for (const t of l) { if (seen[t / 3] === bi) continue; seen[t / 3] = bi; const d2 = triDist2(P, I[t] * 3, I[t + 1] * 3, I[t + 2] * 3, px, py, pz); if (d2 < best) best = d2; }
        }
        if (best < Infinity) D[q] = Math.sqrt(best);
      }
    }
    const sdf = (p) => {
      let x = (p[0] - o[0]) / s, y = (p[1] - o[1]) / s, z = (p[2] - o[2]) / s;
      if (x < 0 || y < 0 || z < 0 || x >= nx - 1 || y >= ny - 1 || z >= nz - 1) return -wall;
      const i = Math.floor(x), j = Math.floor(y), k = Math.floor(z), fx = x - i, fy = y - j, fz = z - k, b = at(i, j, k);
      const c00 = D[b] * (1 - fz) + D[b + 1] * fz, c01 = D[b + nz] * (1 - fz) + D[b + nz + 1] * fz;
      const b1 = b + ny * nz, c10 = D[b1] * (1 - fz) + D[b1 + 1] * fz, c11 = D[b1 + nz] * (1 - fz) + D[b1 + nz + 1] * fz;
      return ((c00 * (1 - fy) + c01 * fy) * (1 - fx) + (c10 * (1 - fy) + c11 * fy) * fx) - wall;
    };
    const trash = [], keep = (m) => { trash.push(m); return m; };
    try {
      let outer;
      try { outer = keep(new Manifold(new Mesh({ numProp: 3, vertProperties: Float32Array.from(P), triVerts: Uint32Array.from(I) }))); }
      catch (e) { return { mesh, ok: false, note: 'The model has holes or overlapping surfaces, so it can\'t be hollowed. Repair it in your slicer first.' }; }
      const inner0 = keep(Manifold.levelSet(sdf, { min: o, max: o.map((x, k) => x + (n[k] - 1) * s) }, Math.max(s, wall / 2.5), 0));
      const inner = keep(inner0.simplify(Math.min(0.3, wall * 0.04))); // hidden surface: keep it light
      if (inner.isEmpty()) return { mesh, ok: false, note: 'Nothing left to remove at that wall thickness.' };
      const shell = keep(outer.subtract(inner));
      const g2 = shell.getMesh(), np = g2.numProp, nv = g2.vertProperties.length / np, pos = new Float64Array(nv * 3);
      for (let i = 0; i < nv; i++) for (let q = 0; q < 3; q++) pos[3 * i + q] = g2.vertProperties[np * i + q];
      return { mesh: { pos, idx: Uint32Array.from(g2.triVerts) }, ok: true, removed: inner.volume() / outer.volume(), step: s };
    } finally { for (const m of trash) { try { m.delete(); } catch (e) {} } }
  }

  // rotate a part so a face with outward normal s*axis(k) points down (-Z), then sit it on z=0
  function orientForPrint(m, pr) {
    let fn = (x, y, z) => [x, y, z];
    if (pr) {
      const { k, s } = pr;
      if (k === 2) fn = s > 0 ? (x, y, z) => [x, -y, -z] : fn;
      else if (k === 0) fn = s > 0 ? (x, y, z) => [z, y, -x] : (x, y, z) => [-z, y, x];
      else fn = s > 0 ? (x, y, z) => [x, z, -y] : (x, y, z) => [x, -z, y];
    }
    const r = transform(m, fn), bb = bbox(r);
    return transform(r, (x, y, z) => [x - bb.min[0], y - bb.min[1], z - bb.min[2]]);
  }

  // ---------- exporters ----------
  function stlBinary(m, name) {
    const I = m.idx, P = m.pos, n = I.length / 3;
    const buf = new ArrayBuffer(84 + n * 50), dv = new DataView(buf);
    const hdr = ('Split for printing: ' + (name || '')).slice(0, 79);
    for (let i = 0; i < hdr.length; i++) dv.setUint8(i, hdr.charCodeAt(i) & 127);
    dv.setUint32(80, n, true); let o = 84;
    for (let t = 0; t < I.length; t += 3) {
      const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
      const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
      const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx; const l = Math.hypot(nx, ny, nz) || 1;
      dv.setFloat32(o, nx / l, true); dv.setFloat32(o + 4, ny / l, true); dv.setFloat32(o + 8, nz / l, true); o += 12;
      for (const q of [a, b, c]) { dv.setFloat32(o, P[q], true); dv.setFloat32(o + 4, P[q + 1], true); dv.setFloat32(o + 8, P[q + 2], true); o += 12; }
      o += 2;
    }
    return new Uint8Array(buf);
  }

  function model3mf(parts) { // parts: [{name, mesh, offset:[x,y,z]}]
    const out = ['<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">\n<resources>\n'];
    parts.forEach((p, i) => {
      out.push('<object id="' + (i + 1) + '" type="model" name="' + p.name + '"><mesh><vertices>');
      const P = p.mesh.pos, I = p.mesh.idx; const s = [];
      for (let v = 0; v < P.length; v += 3) s.push('<vertex x="' + P[v].toFixed(4) + '" y="' + P[v + 1].toFixed(4) + '" z="' + P[v + 2].toFixed(4) + '"/>');
      out.push(s.join('')); out.push('</vertices><triangles>'); const t = [];
      for (let q = 0; q < I.length; q += 3) t.push('<triangle v1="' + I[q] + '" v2="' + I[q + 1] + '" v3="' + I[q + 2] + '"/>');
      out.push(t.join('')); out.push('</triangles></mesh></object>\n');
    });
    out.push('</resources>\n<build>\n');
    parts.forEach((p, i) => out.push('<item objectid="' + (i + 1) + '" transform="1 0 0 0 1 0 0 0 1 ' + p.offset.map(x => x.toFixed(3)).join(' ') + '"/>\n'));
    out.push('</build>\n</model>\n');
    return out.join('');
  }
  const CT3MF = '<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>';
  const RELS3MF = '<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>';

  // printed pin: chamfered cylinder along z
  function pinMesh(d, len, cx, cy) {
    const B = new Builder(0), SEG = 32, r = d / 2, ch = Math.min(0.5, r / 3, len / 4);
    const ring = (R, z) => { const o = []; for (let i = 0; i < SEG; i++) { const a = i / SEG * Math.PI * 2; o.push(B.add(cx + R * Math.cos(a), cy + R * Math.sin(a), z)); } return o; };
    const rs = [ring(r - ch, 0), ring(r, ch), ring(r, len - ch), ring(r - ch, len)];
    for (let q = 0; q < 3; q++) for (let i = 0; i < SEG; i++) {
      const j = (i + 1) % SEG, a = (i + 0.5) / SEG * Math.PI * 2, n = [Math.cos(a), Math.sin(a), 0];
      B.triN(rs[q][i], rs[q][j], rs[q + 1][j], n); B.triN(rs[q][i], rs[q + 1][j], rs[q + 1][i], n);
    }
    const c0 = B.add(cx, cy, 0), c1 = B.add(cx, cy, len);
    for (let i = 0; i < SEG; i++) { const j = (i + 1) % SEG; B.triN(c0, rs[0][i], rs[0][j], [0, 0, -1]); B.triN(c1, rs[3][i], rs[3][j], [0, 0, 1]); }
    return B.mesh();
  }
  function merge(ms) {
    let nv = 0, ni = 0; for (const m of ms) { nv += m.pos.length; ni += m.idx.length; }
    const P = new Float64Array(nv), I = new Uint32Array(ni); let po = 0, io = 0;
    for (const m of ms) { P.set(m.pos, po); for (let i = 0; i < m.idx.length; i++) I[io + i] = m.idx[i] + po / 3; po += m.pos.length; io += m.idx.length; }
    return { pos: P, idx: I };
  }

  const api = { weld, fromGeometry, bbox, volume, transform, flip, openEdges, splitMesh, planCuts, splitAll, splitAllAsync, planAdaptive, planAdaptiveSync, quickCount, planLocal, execTree, treeCuts, treeIslands, gridPieces, meshComponents, solidComponents, addJoints, addDovetails, hollow, orientForPrint, rotatePts, stlBinary, model3mf, CT3MF, RELS3MF, pinMesh, merge };
  root.Splitter = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);

