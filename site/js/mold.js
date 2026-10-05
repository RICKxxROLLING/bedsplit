// Bedsplit mold maker: turns a solid model into a printable block with the model as a cavity,
// cut along one or two parting planes into parts that line up on hemisphere keys.
// Pours from +Z: a funnel runs from the top of the model up through the block, and thin vents
// run up from the other high points so air can get out. Needs the Manifold WASM module (MF).
(function (root) {
  'use strict';
  const S = root.Splitter || (typeof require !== 'undefined' ? require('./splitter.js') : null);

  // area of the model's cross-section on the plane axis k = c (Green's theorem over the cut segments)
  function sectionArea(m, k, c) {
    const P = m.pos, I = m.idx, u = (k + 1) % 3, v = (k + 2) % 3; let a2 = 0;
    for (let t = 0; t < I.length; t += 3) {
      const ids = [I[t] * 3, I[t + 1] * 3, I[t + 2] * 3], d = ids.map(q => P[q + k] - c), pts = [];
      for (let e = 0; e < 3; e++) {
        const f = (e + 1) % 3; if ((d[e] < 0) === (d[f] < 0)) continue;
        const s = d[e] / (d[e] - d[f]), p = ids[e], q = ids[f];
        pts.push([P[p + u] + s * (P[q + u] - P[p + u]), P[p + v] + s * (P[q + v] - P[p + v]), d[e] < 0]);
      }
      if (pts.length !== 2) continue;
      // the edge going from below to above starts the segment, which keeps the loop direction consistent
      const [A, B] = pts[0][2] ? [pts[1], pts[0]] : [pts[0], pts[1]];
      a2 += A[0] * B[1] - B[0] * A[1];
    }
    return Math.abs(a2) / 2;
  }

  // parting plane where the model is widest, which is where most shapes release best
  function autoParting(m, k) {
    const bb = S.bbox(m), lo = bb.min[k], L = bb.size[k], N = 48;
    let best = lo + L / 2, bestA = -1;
    for (let i = 0; i <= N; i++) {
      const c = lo + L * (0.08 + 0.84 * i / N), a = sectionArea(m, k, c) * (1 - 0.15 * Math.abs(i / N - 0.5)); // slight pull to the middle
      if (a > bestA + 1e-6) { bestA = a; best = c; }
    }
    return best;
  }

  // highest model surface over an XY grid (-Infinity where there is no model)
  function topField(m, g) {
    const bb = S.bbox(m), P = m.pos, I = m.idx, o = [bb.min[0], bb.min[1]];
    const nx = Math.max(2, Math.ceil(bb.size[0] / g) + 1), ny = Math.max(2, Math.ceil(bb.size[1] / g) + 1);
    const H = new Float64Array(nx * ny).fill(-Infinity), jx = g * 0.0137, jy = g * 0.0291;
    for (let t = 0; t < I.length; t += 3) {
      const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
      const xa = P[a], ya = P[a + 1], xb = P[b], yb = P[b + 1], xc = P[c], yc = P[c + 1];
      const det = (yb - yc) * (xa - xc) + (xc - xb) * (ya - yc); if (Math.abs(det) < 1e-12) continue;
      const i0 = Math.max(0, Math.floor((Math.min(xa, xb, xc) - o[0]) / g)), i1 = Math.min(nx - 1, Math.ceil((Math.max(xa, xb, xc) - o[0]) / g));
      const j0 = Math.max(0, Math.floor((Math.min(ya, yb, yc) - o[1]) / g)), j1 = Math.min(ny - 1, Math.ceil((Math.max(ya, yb, yc) - o[1]) / g));
      for (let i = i0; i <= i1; i++) { const px = o[0] + i * g + jx;
        for (let j = j0; j <= j1; j++) { const py = o[1] + j * g + jy;
          const l1 = ((yb - yc) * (px - xc) + (xc - xb) * (py - yc)) / det, l2 = ((yc - ya) * (px - xc) + (xa - xc) * (py - yc)) / det, l3 = 1 - l1 - l2;
          if (l1 < 0 || l2 < 0 || l3 < 0) continue;
          const z = l1 * P[a + 2] + l2 * P[b + 2] + l3 * P[c + 2], q = i * ny + j; if (z > H[q]) H[q] = z;
        } }
    }
    return { H, nx, ny, g, o, at: (i, j) => [o[0] + i * g, o[1] + j * g] };
  }

  // funnel over the highest point, vents over the other local peaks of the top surface
  function planChannels(m, sprueD, nVents, ventD) {
    const bb = S.bbox(m), g = Math.max(1, Math.min(4, Math.max(bb.size[0], bb.size[1]) / 80)), F = topField(m, g), { H, nx, ny } = F;
    const r = Math.max(1, Math.round(Math.max(sprueD / 2, 3) / g)); // a peak must be the highest point within ~this radius
    const peaks = [];
    for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
      const h = H[i * ny + j]; if (h === -Infinity) continue;
      let top = true;
      for (let a = -r; a <= r && top; a++) for (let b = -r; b <= r; b++) {
        const x = i + a, y = j + b; if ((!a && !b) || x < 0 || y < 0 || x >= nx || y >= ny) continue;
        if (H[x * ny + y] > h + 0.01) { top = false; break; }
      }
      // the channel needs the surface under its whole footprint, not just the centre
      if (top) { let under = 0, all = 0; const rr = Math.max(1, Math.round(sprueD / 4 / g)); for (let a = -rr; a <= rr; a++) for (let b = -rr; b <= rr; b++) { const x = i + a, y = j + b; all++; if (x >= 0 && y >= 0 && x < nx && y < ny && H[x * ny + y] > h - sprueD) under++; } if (under / all > 0.6) peaks.push({ i, j, h }); }
    }
    peaks.sort((a, b) => b.h - a.h);
    if (!peaks.length) { // tiny or odd model: fall back to the highest vertex
      let z = -Infinity, q = 0; for (let v = 0; v < m.pos.length; v += 3) if (m.pos[v + 2] > z) { z = m.pos[v + 2]; q = v; }
      return { sprue: { x: m.pos[q], y: m.pos[q + 1], z, d: sprueD }, vents: [] };
    }
    // the funnel goes over the middle of the top plateau, not its edge
    const p0 = peaks[0], flat = peaks.filter(p => p.h > p0.h - 0.3 && Math.hypot(p.i - p0.i, p.j - p0.j) * g < Math.max(20, sprueD * 3));
    let ci = 0, cj = 0; for (const p of flat) { ci += p.i; cj += p.j; } ci /= flat.length; cj /= flat.length;
    let pick = flat[0], bd = Infinity; for (const p of flat) { const d = Math.hypot(p.i - ci, p.j - cj); if (d < bd) { bd = d; pick = p; } }
    const [sx, sy] = F.at(pick.i, pick.j);
    const sprue = { x: sx, y: sy, z: pick.h, d: sprueD }, vents = [];
    const sep = Math.max(12, sprueD * 2, Math.max(bb.size[0], bb.size[1]) / 8);
    for (const p of peaks) {
      if (vents.length >= nVents) break;
      const [x, y] = F.at(p.i, p.j);
      if (Math.hypot(x - sx, y - sy) < sep || vents.some(v => Math.hypot(x - v.x, y - v.y) < sep)) continue;
      vents.push({ x, y, z: p.h, d: ventD });
    }
    return { sprue, vents };
  }

  // keys sit near the corners of each parting face, in the wall between the cavity and the outside
  function planKeys(box, planes, w, r, clr, channels) {
    const keys = [], inset = w / 2;
    for (let pi = 0; pi < planes.length; pi++) {
      const { k, c } = planes[pi], u = (k + 1) % 3, v = (k + 2) % 3;
      const us = [box.min[u] + inset, box.max[u] - inset], vs = [box.min[v] + inset, box.max[v] - inset];
      // long faces also get keys halfway along, when the wall is thick enough
      const room = w / 2 - r - clr - 1.2;
      if (room > 0 && box.max[u] - box.min[u] > 120) us.splice(1, 0, (box.min[u] + box.max[u]) / 2);
      if (room > 0 && box.max[v] - box.min[v] > 120) vs.splice(1, 0, (box.min[v] + box.max[v]) / 2);
      const inner = (arr, x) => x !== arr[0] && x !== arr[arr.length - 1];
      for (const a of us) for (const b of vs) {
        if (inner(us, a) && inner(vs, b)) continue; // the middle of the face is the cavity
        const p = [0, 0, 0]; p[k] = c; p[u] = a; p[v] = b;
        // stay clear of the other parting plane and of the pour channels
        if (planes.some((q, qi) => qi !== pi && Math.abs(p[q.k] - q.c) < r + clr + 2)) continue;
        if (channels.some(ch => p[2] > ch.z - r - 2 && Math.hypot(p[0] - ch.x, p[1] - ch.y) < r + clr + ch.rTop + 1.5)) continue;
        keys.push({ plane: pi, p });
      }
    }
    return keys;
  }

  function toMF(MF, m) { return new MF.Manifold(new MF.Mesh({ numProp: 3, vertProperties: Float32Array.from(m.pos), triVerts: Uint32Array.from(m.idx) })); }
  function fromMF(man) {
    const g = man.getMesh(), np = g.numProp, nv = g.vertProperties.length / np, pos = new Float64Array(nv * 3);
    for (let i = 0; i < nv; i++) for (let q = 0; q < 3; q++) pos[3 * i + q] = g.vertProperties[np * i + q];
    return { pos, idx: Uint32Array.from(g.triVerts) };
  }

  // opts: { wall, axis (0|1|2), at (parting coordinate, null = widest section), quarters, keyD, clr, sprueD, vents, ventD }
  // mesh must sit with its min corner at the origin (as Bedsplit's work mesh does).
  function make(mesh, opts, MF) {
    const { Manifold } = MF;
    const w = Math.max(4, opts.wall || 10), k = opts.axis == null ? 2 : opts.axis, clr = Math.max(0, opts.clr == null ? 0.2 : opts.clr);
    const bb = S.bbox(mesh), size = bb.size;
    const box = { min: bb.min.map(x => x - w), max: bb.max.map(x => x + w) };
    const c = opts.at == null ? autoParting(mesh, k) : Math.min(bb.max[k] - 0.5, Math.max(bb.min[k] + 0.5, opts.at));
    const planes = [{ k, c }];
    if (opts.quarters) {
      const others = [0, 1, 2].filter(q => q !== k), k2 = size[others[0]] >= size[others[1]] ? others[0] : others[1];
      planes.push({ k: k2, c: autoParting(mesh, k2) });
    }
    // keys: as big as asked, but always with at least 1.2 mm of wall round them
    const r = Math.max(1.5, Math.min((opts.keyD || 6) / 2, w / Math.SQRT2 - clr - 1.5, w / 2 - 0.8));
    const sprueD = Math.max(3, Math.min(opts.sprueD || 8, w * 1.5)), ventD = Math.max(1, opts.ventD || 2.5);
    const ch = planChannels(mesh, sprueD, Math.max(0, Math.round(opts.vents == null ? 3 : opts.vents)), ventD);
    const top = box.max[2];
    const channels = [Object.assign({ rBot: sprueD / 2, rTop: sprueD, kind: 'funnel' }, ch.sprue)].concat(ch.vents.map(v => Object.assign({ rBot: ventD / 2, rTop: ventD / 2, kind: 'vent' }, v)));
    const keys = planKeys(box, planes, w, r, clr, channels);

    const trash = [], keep = (x) => { trash.push(x); return x; };
    try {
      let model;
      try { model = keep(toMF(MF, mesh)); }
      catch (e) { return { ok: false, note: 'The model has holes or overlapping surfaces, so it can\'t be turned into a mold. Repair it in your slicer (or Meshmixer / Blender 3D-Print toolbox) first.' }; }
      if (model.isEmpty()) return { ok: false, note: 'The model has no inside (is it watertight?), so there is nothing to cast.' };
      const blockSize = box.max.map((x, i) => x - box.min[i]);
      let block = keep(keep(Manifold.cube(blockSize, false)).translate(box.min));
      // channels start 1 mm inside the model so they always connect to the cavity
      const tools = [model];
      for (const q of channels) { const z0 = q.z - 1, h = top + 1 - z0; tools.push(keep(keep(Manifold.cylinder(h, q.rBot, q.rTop, q.kind === 'funnel' ? 48 : 16)).translate([q.x, q.y, z0]))); }
      block = keep(block.subtract(keep(Manifold.union(tools))));

      // parts: one per side of each plane
      const sides = planes.length === 1 ? [[-1], [1]] : [[-1, -1], [-1, 1], [1, -1], [1, 1]];
      const unit = (q, s) => { const n = [0, 0, 0]; n[q] = s; return n; };
      const parts = sides.map(sg => {
        let pm = block; sg.forEach((s, i) => { const { k: q, c: cc } = planes[i]; pm = keep(pm.trimByPlane(unit(q, s), s * cc)); });
        return { sg, man: pm };
      });
      // a key adds a dome to the part on the low side of its plane and a socket (dome + clearance) to the part on the high side
      const seg = Math.max(24, Math.min(64, Math.round(r * 8)));
      const adds = parts.map(() => []), subs = parts.map(() => []);
      for (const key of keys) {
        const other = planes.length > 1 ? planes[1 - key.plane] : null;
        const pick = (s) => parts.findIndex(p => p.sg[key.plane] === s && (!other || p.sg[1 - key.plane] === Math.sign(key.p[other.k] - other.c)));
        const lo = pick(-1), hi = pick(1); if (lo < 0 || hi < 0) continue;
        adds[lo].push(keep(keep(Manifold.sphere(r, seg)).translate(key.p)));
        subs[hi].push(keep(keep(Manifold.sphere(r + clr, seg)).translate(key.p)));
        key.lo = lo; key.hi = hi;
      }
      const out = [];
      parts.forEach((p, i) => {
        let pm = p.man;
        if (adds[i].length) pm = keep(Manifold.union([pm].concat(adds[i])));
        if (subs[i].length) pm = keep(pm.subtract(keep(Manifold.union(subs[i]))));
        if (pm.isEmpty()) return;
        // the main parting face goes up when printing, so the cavity is an open pit with no supports
        const dir = [0, 0, 0]; p.sg.forEach((s, j) => { dir[planes[j].k] = s; });
        out.push({ mesh: fromMF(pm), sg: p.sg, dir, print: { k, s: p.sg[0] }, keys: adds[i].length, sockets: subs[i].length, vol: pm.volume() });
      });
      const cone = (h, a, b) => Math.PI * h / 3 * (a * a + a * b + b * b);
      const chanVol = channels.reduce((acc, q) => acc + cone(top - q.z, q.rBot, q.rTop), 0);
      return {
        ok: true, parts: out, planes, keys: keys.filter(q => q.lo != null), keyD: 2 * r, clr, wall: w, box,
        sprue: channels[0], vents: channels.slice(1), cavityVol: model.volume(), channelVol: chanVol, blockSize
      };
    } finally { for (const x of trash) { try { x.delete(); } catch (e) {} } }
  }

  const api = { make, autoParting, sectionArea, planChannels };
  root.Mold = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
