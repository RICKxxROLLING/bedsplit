(function () {
  'use strict';
  const S = window.Splitter;
  const $ = (id) => document.getElementById(id);
  const AX = ['X', 'Y', 'Z'];
  const BEDS = [
    ['a1mini', 'Bambu Lab A1 mini', [180, 180, 180]],
    ['a1', 'Bambu Lab A1 / P1S / X1C', [256, 256, 256]],
    ['h2d', 'Bambu Lab H2D (one nozzle)', [325, 320, 325]],
    ['mk4', 'Prusa MK4S', [250, 210, 220]],
    ['core1', 'Prusa CORE One', [250, 220, 270]],
    ['ender3', 'Creality Ender-3 V3', [220, 220, 250]],
    ['k1max', 'Creality K1 Max', [300, 300, 300]],
    ['custom', 'Custom…', null]
  ];
  const PALETTE = ['#E07A5F', '#3D85B8', '#6FB08F', '#E9B949', '#9C7FC4', '#4FB0AA', '#D6823C', '#7F93A6', '#C4677F', '#8DA84A'];

  const emit = (name, detail) => { try { window.dispatchEvent(new CustomEvent(name, { detail })); } catch (e) {} };
  const st = { base: null, name: 'sample', R: [1, 0, 0, 0, 1, 0, 0, 0, 1], work: null, bb: null, cuts: [[], [], []], result: null, parts: [], sel: -1, stale: false, busy: false, plan: null, planToken: 0, planning: false };
  const mode = () => document.querySelector('input[name=mode]:checked').value;
  const adaptive = () => mode() === 'adaptive';
  const usable = () => { const m = +$('margin').value || 0; return bed().map(x => Math.max(10, x - 2 * m)); };
  const curMesh = () => (adaptive() && st.plan) ? st.plan.work : st.work;
  const curBB = () => (adaptive() && st.plan) ? st.plan.bb : st.bb;

  // ---------- UI setup ----------
  const bedSel = $('bed');
  for (const [id, name] of BEDS) { const o = document.createElement('option'); o.value = id; o.textContent = name; bedSel.appendChild(o); }
  const setBed = (id) => { const b = BEDS.find(x => x[0] === id); if (b && b[2]) { $('bx').value = b[2][0]; $('by').value = b[2][1]; $('bz').value = b[2][2]; } };
  bedSel.value = 'a1mini'; setBed('a1mini');
  try { const saved = JSON.parse(localStorage.getItem('bedsplit.bed') || 'null'); if (saved) { bedSel.value = saved.id; $('bx').value = saved.d[0]; $('by').value = saved.d[1]; $('bz').value = saved.d[2]; } } catch (e) {}
  const bed = () => [+$('bx').value || 180, +$('by').value || 180, +$('bz').value || 180];
  const saveBed = () => { try { localStorage.setItem('bedsplit.bed', JSON.stringify({ id: bedSel.value, d: bed() })); } catch (e) {} };

  const jtype = () => document.querySelector('input[name=jt]:checked').value;
  let joint = () => ({ type: jtype(), d: +$('jd').value || 8, len: +$('jlen').value || 10, clr: Math.max(0, +$('jclr').value || 0), wall: +$('jwall').value || 2.5, maxPer: Math.max(1, Math.round(+$('jmax').value || 3)),
    dw: Math.max(4, +$('dw').value || 10), dh: Math.min(15, Math.max(2, +$('dh').value || 5)), keysOnly: $('dkeys').checked });
  const shellOn = () => $('shell').checked;
  const shellWall = () => Math.min(30, Math.max(3, +$('shellw').value || 6));
  // in a shell, connectors shrink to sit inside the wall with at least ~1.2 mm of plastic round them
  const jointRaw = joint;
  joint = () => {
    const j = jointRaw(); if (!shellOn()) return j;
    // at least 1 mm of plastic round every hole, plus 0.4 mm of slack each side so it can find a spot
    const w = shellWall(), mw = Math.min(j.wall, 1.0), T15 = Math.tan(Math.PI / 12);
    j.shellWall = w; j.wall = mw;
    j.d = Math.max(2, Math.min(j.d, w - 2 * (j.clr + mw) - 0.8));
    j.dh = Math.min(j.dh, Math.max(2, w * 0.5));
    j.dw = Math.max(3, Math.min(j.dw, 2 * (w / 2 - j.clr - mw - 0.4 - j.dh * T15)));
    j.maxPer = Math.max(j.maxPer, 3);
    return j;
  };
  const protrude = () => { const t = jtype(); return t === 'peg' ? joint().len : t === 'dovetail' && !$('dkeys').checked ? joint().dh : 0; };
  // Manifold (boolean geometry, ~0.5 MB) loads only when dovetails are used
  let mfP = null;
  const loadManifold = () => mfP || (mfP = import('/vendor/manifold/manifold.js').then(m => m.default()).then(w => { w.setup(); return w; }).catch(e => { mfP = null; throw e; }));
  const FLAT = { type: 'flat' };
  const faceName = (pr) => pr ? (pr.s > 0 ? '+' : '−') + 'XYZ'[pr.k] : '';
  const fmt = (n, d = 1) => (Math.round(n * 10 ** d) / 10 ** d).toFixed(d);

  function jointHint() {
    const t = jtype();
    $('jfields').hidden = t === 'flat';
    document.querySelectorAll('.peg-only').forEach(el => { el.hidden = t === 'dovetail'; });
    document.querySelectorAll('.dove-only').forEach(el => { el.hidden = t !== 'dovetail'; });
    $('jlenl').firstChild.textContent = t === 'dowel' ? 'Pin length, mm' : 'Peg length, mm';
    $('jthint').textContent = t === 'peg' ? 'Pegs on one side of a cut, sockets on the other. Each part keeps its biggest cut face peg-free (holes only) so it prints flat on it; where two parts both need that face, both get holes and a printed pin joins them.'
      : t === 'dowel' ? 'Both sides get blind holes. Use the printed pins included in the zip, or cut dowels or filament to length.'
      : t === 'dovetail' ? 'Parts slide together on dovetail rails and lock, so they can’t be pulled apart. Bedsplit plans the order and which way each part slides in. Where a rail can’t slide in, a separate printed key slides into both parts instead.'
      : 'Plain flat cuts. Glue, bolt or add your own joints later.';
    if (t === 'dovetail') loadManifold().catch(() => {});
    if (shellOn() && t !== 'flat') {
      const j = joint(), w = shellWall();
      $('jthint').textContent += t === 'dovetail'
        ? (w < 9 ? ` In a ${fmt(w)} mm shell there’s little room for rails: use pegs, or a wall of 9 mm or more.` : ` In the ${fmt(w)} mm shell: rails ${fmt(j.dw)} mm wide, ${fmt(j.dh)} mm deep.`)
        : ` In the ${fmt(w)} mm shell: ${fmt(j.d)} mm ${t === 'dowel' ? 'dowels' : 'pegs'}, up to ${j.maxPer} per seam, centred in the wall.`;
    }
  }
  // ---------- three.js ----------
  const view = $('view');
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  view.prepend(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(35, 1, 1, 20000);
  camera.up.set(0, 0, 1);
  const controls = new THREE.OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true; controls.dampingFactor = 0.12;
  scene.add(new THREE.HemisphereLight(0xffffff, 0x445048, 0.75));
  const d1 = new THREE.DirectionalLight(0xffffff, 0.75); d1.position.set(1, -1.4, 2); scene.add(d1);
  const d2 = new THREE.DirectionalLight(0xffffff, 0.3); d2.position.set(-1.5, 1, 0.6); scene.add(d2);
  const gModel = new THREE.Group(), gParts = new THREE.Group(), gPlanes = new THREE.Group(), gBed = new THREE.Group(), gGrid = new THREE.Group();
  scene.add(gGrid, gModel, gParts, gPlanes, gBed);

  const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  function themeColors() {
    renderer.setClearColor(new THREE.Color(css('--stage') || '#E3E8E5'));
    buildGrid(); if (st.work) { rebuildPlanes(); buildBedBox(); if (!st.result) showModel(); }
  }
  new MutationObserver(themeColors).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] });
  try { matchMedia('(prefers-color-scheme: dark)').addEventListener('change', themeColors); } catch (e) {}

  function resize() { const w = view.clientWidth, h = view.clientHeight; if (!w || !h) return; renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); }
  new ResizeObserver(resize).observe(view);
  (function loop() { requestAnimationFrame(loop); controls.update(); renderer.render(scene, camera); })();

  function disposeGroup(g) { while (g.children.length) { const c = g.children.pop(); c.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); }); } }

  function toGeom(m) {
    const n = m.idx.length, pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { const v = m.idx[i] * 3; pos[3 * i] = m.pos[v]; pos[3 * i + 1] = m.pos[v + 1]; pos[3 * i + 2] = m.pos[v + 2]; }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.computeVertexNormals(); return g;
  }

  function buildGrid() {
    disposeGroup(gGrid); const cb = curBB(); if (!cb) return;
    const s = cb.size, pad = 40, b = bed();
    const x0 = -pad, y0 = -pad, x1 = Math.max(s[0], b[0] + s[0] + 20) + pad, y1 = Math.max(s[1], b[1]) + pad;
    const minor = [], major = [];
    for (let x = Math.ceil(x0 / 10) * 10; x <= x1; x += 10) (x % 50 === 0 ? major : minor).push(x, y0, 0, x, y1, 0);
    for (let y = Math.ceil(y0 / 10) * 10; y <= y1; y += 10) (y % 50 === 0 ? major : minor).push(x0, y, 0, x1, y, 0);
    for (const [arr, col] of [[minor, css('--grid')], [major, css('--grid-major')]]) {
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
      const l = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: new THREE.Color(col) })); l.position.z = -0.05; gGrid.add(l);
    }
  }

  function buildBedBox() {
    disposeGroup(gBed); const cb = curBB(); if (!cb) return;
    const b = bed(); const geo = new THREE.BoxGeometry(b[0], b[1], b[2]);
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: new THREE.Color(css('--accent')) }));
    const fill = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: new THREE.Color(css('--accent')), transparent: true, opacity: 0.06, depthWrite: false }));
    const grp = new THREE.Group(); grp.add(fill, edges);
    grp.position.set(cb.size[0] + 30 + b[0] / 2 + explodeSpan(), b[1] / 2, b[2] / 2);
    gBed.add(grp); gBed.visible = $('showBed').checked;
  }
  function explodeSpan() { if (!st.result) return 0; let m = 0; for (const p of st.parts) m = Math.max(m, p.dir[0]); return (+$('explode').value) * m; }

  function rebuildPlanes() {
    disposeGroup(gPlanes); const cb = curBB(); if (!cb || st.result) return;
    const cols = ['--ax-x', '--ax-y', '--ax-z'];
    const list = [];
    if (adaptive()) { if (st.plan) for (const n of S.treeCuts(st.plan.tree)) list.push({ k: n.k, c: n.c, mn: n.bb.min, mx: n.bb.max, pad: 3 }); }
    else for (let k = 0; k < 3; k++) for (const c of st.cuts[k]) list.push({ k, c, mn: [0, 0, 0], mx: cb.size, pad: 12 });
    for (const { k, c, mn, mx, pad } of list) {
      const u = (k + 1) % 3, v = (k + 2) % 3;
      const col = new THREE.Color(css(cols[k]));
      const P = (a, b) => { const p = [0, 0, 0]; p[k] = c; p[u] = a; p[v] = b; return p; };
      const q = [P(mn[u] - pad, mn[v] - pad), P(mx[u] + pad, mn[v] - pad), P(mx[u] + pad, mx[v] + pad), P(mn[u] - pad, mx[v] + pad)];
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute([].concat(q[0], q[1], q[2], q[0], q[2], q[3]), 3));
      const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false }));
      const lg = new THREE.BufferGeometry(); lg.setAttribute('position', new THREE.Float32BufferAttribute([].concat(q[0], q[1], q[1], q[2], q[2], q[3], q[3], q[0]), 3));
      gPlanes.add(m, new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: col })));
    }
    gPlanes.visible = $('showPlanes').checked;
  }

  function showModel() {
    disposeGroup(gModel); disposeGroup(gParts); const cm = curMesh(); if (!cm) return;
    gModel.add(new THREE.Mesh(toGeom(cm), new THREE.MeshStandardMaterial({ color: new THREE.Color(css('--model')), roughness: 0.7, metalness: 0.05 })));
  }

  function frame() {
    const cb = curBB(); if (!cb) return; const s = cb.size, b = bed();
    const cx = (s[0] + 30 + b[0]) / 2, cy = Math.max(s[1], b[1]) / 2, cz = s[2] / 3;
    const r = Math.hypot(s[0] + b[0] + 30, Math.max(s[1], b[1]), s[2]) * 0.62;
    controls.target.set(cx, cy, cz);
    const dist = r / Math.sin((camera.fov * Math.PI / 180) / 2) * 0.8;
    camera.position.set(cx - dist * 0.45, cy - dist * 0.8, cz + dist * 0.5);
    camera.near = dist / 100; camera.far = dist * 20; camera.updateProjectionMatrix(); controls.update();
  }

  // ---------- model pipeline ----------
  function mulR(A, B) { const C = new Array(9); for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) { let s = 0; for (let k = 0; k < 3; k++) s += A[3 * i + k] * B[3 * k + j]; C[3 * i + j] = s; } return C; }
  const ROT = { x: [1, 0, 0, 0, 0, -1, 0, 1, 0], y: [0, 0, 1, 0, 1, 0, -1, 0, 0], z: [0, -1, 0, 1, 0, 0, 0, 0, 1] };

  async function rebuildWork(replan) {
    if (!st.base) return;
    const token = st.workToken = (st.workToken || 0) + 1;
    st.rebuilding = true; $('split').disabled = true;
    if (Date.now() - (st.splitArm || 0) < 1000) st.autoSplit = true; // Split was pressed as a field lost focus: do it once ready
    const f = (+$('scale').value || 100) / 100 * (+$('units').value || 1), R = st.R;
    let m = S.transform(st.base, (x, y, z) => [f * (R[0] * x + R[1] * y + R[2] * z), f * (R[3] * x + R[4] * y + R[5] * z), f * (R[6] * x + R[7] * y + R[8] * z)]);
    const bb = S.bbox(m);
    m = S.transform(m, (x, y, z) => [x - bb.min[0], y - bb.min[1], z - bb.min[2]]);
    st.shell = null;
    if (shellOn()) {
      const w = shellWall(), key = [st.baseId, R.join(','), f, w].join('|');
      if (st.shellCache && st.shellCache.key === key) { m = st.shellCache.mesh; st.shell = st.shellCache; }
      else {
        $('busy').hidden = false; $('busyText').textContent = `Hollowing into a ${fmt(w)} mm shell…`; $('busySub').textContent = 'Big models can take several seconds'; $('busyBar').style.width = '40%';
        await new Promise(r => setTimeout(r, 40));
        let MF = null; try { MF = await loadManifold(); } catch (e) { toast('Couldn\'t load the geometry engine for shells. Check your connection and try again.'); }
        if (token !== st.workToken) return;
        await new Promise(r => setTimeout(r, 20));
        const r = MF ? S.hollow(m, w, MF) : { ok: false, note: '' };
        $('busy').hidden = true;
        if (token !== st.workToken) return;
        if (r.ok) { const b2 = S.bbox(r.mesh); m = S.transform(r.mesh, (x, y, z) => [x - b2.min[0], y - b2.min[1], z - b2.min[2]]); st.shell = st.shellCache = { key, mesh: m, wall: w, removed: r.removed }; }
        else if (r.note) $('shellInfo').textContent = r.note;
      }
      st.wallApplied = w;
      if (st.shell) $('shellInfo').textContent = `Shell: ${fmt(w)} mm wall, about ${Math.round(st.shell.removed * 100)}% less plastic than solid.`;
    } else $('shellInfo').textContent = '';
    st.work = m; st.bb = S.bbox(m); st.plan = null; st.rebuilding = false;
    if (replan !== false) autoPlan();
    clearResult(); renderDims(); renderAxes(); showModel(); rebuildPlanes(); buildGrid(); buildBedBox(); frame();
    if (adaptive()) schedulePlan();
    else if (st.autoSplit) { st.autoSplit = false; setTimeout(runSplit, 30); }
  }

  // ---------- adaptive plan ----------
  let planTimer = 0;
  function schedulePlan() { clearTimeout(planTimer); st.plan = null; renderEst(); planTimer = setTimeout(runPlan, 250); }
  async function runPlan() {
    if (!st.work || !adaptive()) return;
    const token = ++st.planToken; st.planning = true; clearResult(); renderEst(); emit('bedsplit:planning', { token });
    const opts = { usable: usable(), pegLen: protrude(), rotate: $('adrot').checked };
    $('busy').hidden = false; $('busyText').textContent = 'Finding the fewest parts…'; $('busyBar').style.width = '0%';
    $('busySub').textContent = opts.rotate ? 'Trying 36 model angles and many cut positions' : 'Trying many cut positions';
    await new Promise(r => setTimeout(r, 30));
    try {
      const g = S.planAdaptive(st.work, opts); let r;
      while (!(r = g.next()).done) { if (token !== st.planToken) return; $('busyBar').style.width = (r.value * 100).toFixed(0) + '%'; await new Promise(res => setTimeout(res, 0)); }
      if (token !== st.planToken) return;
      const pl = r.value, M = pl.M;
      let w = S.transform(st.work, (x, y, z) => [M[0] * x + M[1] * y + M[2] * z, M[3] * x + M[4] * y + M[5] * z, M[6] * x + M[7] * y + M[8] * z]);
      const bb = S.bbox(w); w = S.transform(w, (x, y, z) => [x - bb.min[0], y - bb.min[1], z - bb.min[2]]);
      st.plan = Object.assign(pl, { work: w, bb: S.bbox(w), gridCount: gridCount(), gaps: S.treeIslands(pl.tree) });
      emit('bedsplit:plan', { mesh: st.work, count: pl.count, ok: pl.ok, bed: bed(), bedName: bedName(), margin: +$('margin').value || 0, pegLen: opts.pegLen, rotate: opts.rotate, token });
    } catch (e) { console.error(e); toast('Planning failed: ' + (e.message || e)); }
    finally {
      if (token === st.planToken) { st.planning = false; $('busy').hidden = true; renderEst(); showModel(); rebuildPlanes(); buildGrid(); buildBedBox(); frame(); if (st.autoSplit && st.plan) { st.autoSplit = false; setTimeout(runSplit, 30); } }
    }
  }
  function gridCount() { if (!st.bb) return 0; return S.gridPieces(st.work, S.planCuts(st.bb, bed(), +$('margin').value || 0, protrude())); }
  function turnText(pl) {
    if (!pl || (!pl.yaw && !pl.tilt)) return 'Kept your orientation';
    const parts = [];
    if (pl.tilt === 1) parts.push('tipped 90° about X'); if (pl.tilt === 2) parts.push('tipped 90° about Y');
    if (pl.yaw) parts.push(`turned ${pl.yaw}° about Z`);
    const t = parts.join(', then '); return t.charAt(0).toUpperCase() + t.slice(1);
  }
  function modeChanged() {
    const a = adaptive();
    $('adaptivePanel').hidden = !a; $('axes').hidden = a;
    clearResult();
    if (a) { if (!st.plan) schedulePlan(); } else { st.planToken++; st.planning = false; $('busy').hidden = true; }
    renderAxes(); showModel(); rebuildPlanes(); buildGrid(); buildBedBox(); frame();
  }
  function replanAll() { if (!st.bb) return; autoPlan(); clearResult(); renderAxes(); rebuildPlanes(); buildGrid(); buildBedBox(); if (adaptive()) schedulePlan(); }

  function autoPlan() { if (st.bb) st.cuts = S.planCuts(st.bb, bed(), +$('margin').value || 0, protrude()); }
  function setPieces(k, n) {
    n = Math.max(1, Math.min(40, n)); const S0 = st.bb.size[k]; st.cuts[k] = [];
    for (let i = 1; i < n; i++) st.cuts[k].push(S0 * i / n);
  }

  function clearResult() {
    if (st.result) { st.result = null; st.parts = []; st.sel = -1; disposeGroup(gParts); showModel(); }
    emit('bedsplit:clear', {});
    renderParts(); $('export').disabled = true; $('export').classList.remove('primary'); $('split').classList.add('primary');
    $('stalePill').hidden = true;
  }
  function markStale() {
    if (st.result) { $('stalePill').hidden = false; st.stale = true; $('split').classList.add('primary'); $('export').classList.remove('primary'); }
  }

  function renderDims() {
    const s = st.bb.size; const tris = st.work.idx.length / 3;
    $('dims').innerHTML = AX.map((a, k) => `<span><span class="ax-${a.toLowerCase()}">${a}</span> <i>${fmt(s[k])}</i></span>`).join('') + '<span style="color:var(--muted)">mm</span>';
    $('filemeta').innerHTML = `<strong>${escapeHtml(st.name)}</strong><br>${tris.toLocaleString()} triangles · ${fmt(s[0], 0)} × ${fmt(s[1], 0)} × ${fmt(s[2], 0)} mm`;
  }
  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  function renderAxes() {
    const wrap = $('axes'); wrap.innerHTML = ''; if (!st.bb) return;
    for (let k = 0; k < 3; k++) {
      const a = AX[k], n = st.cuts[k].length + 1;
      const el = document.createElement('div'); el.className = 'axis';
      el.innerHTML = `<div class="axis-head"><span class="tag ax-${a.toLowerCase()}">${a}</span><button class="icon" data-k="${k}" data-d="-1" aria-label="Fewer ${a} pieces">−</button><span class="cnt">${n} ${n === 1 ? 'piece' : 'pieces'}</span><button class="icon" data-k="${k}" data-d="1" aria-label="More ${a} pieces">+</button><span class="len">${fmt(st.bb.size[k])} mm</span></div>`;
      st.cuts[k].forEach((c, j) => {
        const row = document.createElement('div'); row.className = 'cut';
        const id = `cut-${k}-${j}`;
        row.innerHTML = `<input type="range" id="${id}" min="0" max="${st.bb.size[k].toFixed(2)}" step="0.5" value="${c.toFixed(2)}" aria-label="${a} cut ${j + 1} position"><output for="${id}">${fmt(c)}</output>`;
        const inp = row.querySelector('input'), out = row.querySelector('output');
        inp.addEventListener('input', () => {
          const lo = j > 0 ? st.cuts[k][j - 1] + 5 : 5, hi = j < st.cuts[k].length - 1 ? st.cuts[k][j + 1] - 5 : st.bb.size[k] - 5;
          let v = Math.min(hi, Math.max(lo, +inp.value)); inp.value = v; st.cuts[k][j] = v; out.textContent = fmt(v);
          if (st.result) { clearResult(); } rebuildPlanes(); renderEst();
        });
        el.appendChild(row);
      });
      wrap.appendChild(el);
    }
    wrap.querySelectorAll('button[data-k]').forEach(b => b.addEventListener('click', () => {
      const k = +b.dataset.k; setPieces(k, st.cuts[k].length + 1 + (+b.dataset.d)); clearResult(); renderAxes(); rebuildPlanes();
    }));
    renderEst();
  }

  function renderEst() {
    if (!st.bb) return;
    if (adaptive()) {
      $('est').innerHTML = '';
      const pl = st.plan;
      if (!pl) { $('gridaux').textContent = ''; $('plansum').innerHTML = `<div class="sub">${st.planning ? 'Planning…' : 'Waiting to plan…'}</div>`; $('split').disabled = true; return; }
      $('split').disabled = false;
      $('gridaux').textContent = `${S.treeCuts(pl.tree).length} cuts`;
      const saved = pl.gridCount - pl.count;
      $('plansum').innerHTML = `<div class="big">${pl.count} part${pl.count === 1 ? '' : 's'} <small>${saved > 0 ? `vs ${pl.gridCount} with an even grid` : pl.gridCount ? `same as an even grid` : ''}</small></div>` +
        `<div class="sub">${escapeHtml(turnText(pl))}${pl.ok ? '' : ' · some parts may still be too big'}</div>` +
        (pl.gaps ? `<div class="sub">Found ${pl.gaps} gap${pl.gaps === 1 ? '' : 's'} of empty space — the pieces on either side are kept apart, not cut.</div>` : '');
      return;
    }
    $('split').disabled = false;
    const mx = [0, 1, 2].map(k => { const e = [0].concat(st.cuts[k], [st.bb.size[k]]); let m = 0; for (let i = 1; i < e.length; i++) m = Math.max(m, e[i] - e[i - 1]); return m; });
    const n = [0, 1, 2].map(k => st.cuts[k].length + 1);
    $('gridaux').textContent = `${n[0]} × ${n[1]} × ${n[2]} grid`;
    const p = protrude();
    const worst = mx.map((x, k) => x + (st.cuts[k].length ? p : 0));
    const ok = fitsBed(worst);
    $('est').innerHTML = `<span>Largest block ≈ <span style="font-family:var(--mono);color:var(--ink)">${worst.map(x => fmt(x, 0)).join(' × ')}</span> mm${p ? ' incl. pegs' : ''}</span>` +
      `<span class="chip ${ok ? 'ok' : 'bad'}">${ok ? 'fits bed' : 'too big'}</span>`;
  }
  function fitsBed(d) { const a = d.slice().sort((x, y) => x - y), b = bed().slice().sort((x, y) => x - y); return a.every((x, i) => x <= b[i] + 0.01); }

  // ---------- split ----------
  async function runSplit() {
    st.splitArm = 0;
    if (st.rebuilding || st.planning || (adaptive() && !st.plan && st.work)) { st.autoSplit = true; toast('Splitting as soon as the plan is ready.'); return; }
    if (!st.work || st.busy) return;
    st.busy = true; $('busy').hidden = false; $('busyText').textContent = 'Splitting…'; $('busyBar').style.width = '0%';
    const total = adaptive() ? (st.plan ? S.treeCuts(st.plan.tree).length : 0) : st.cuts[0].length + st.cuts[1].length + st.cuts[2].length;
    $('busySub').textContent = total ? `${total} cut${total > 1 ? 's' : ''} across ${(curMesh().idx.length / 3).toLocaleString()} triangles` : 'Model already fits — nothing to cut';
    await new Promise(r => setTimeout(r, 30));
    try {
      const J = joint(); const parts = []; let res;
      if (adaptive()) {
        const pl = st.plan; if (!pl) throw new Error('No plan yet.');
        const g = S.execTree(pl.work, pl.tree, FLAT); let r;
        while (!(r = g.next()).done) { $('busyBar').style.width = (r.value * 90).toFixed(0) + '%'; await new Promise(res2 => setTimeout(res2, 0)); }
        res = r.value;
        // safety net: re-plan any part that still came out too big
        const out = [];
        for (const pc of res.parts) {
          if (fitsBed(S.bbox(pc.mesh).size)) { out.push(pc); continue; }
          const tree = S.planLocal(pc.mesh, usable(), protrude());
          if (tree.leaf) { out.push(pc); continue; }
          const g2 = S.execTree(pc.mesh, tree, FLAT); let r2; while (!(r2 = g2.next()).done);
          res.open += r2.value.open; for (const pl2 of r2.value.planes) res.planes.add(pl2);
          for (const q of r2.value.parts) out.push(Object.assign(q, { ex: q.ex.map((x, i) => x + pc.ex[i]), joints: q.joints + pc.joints }));
        }
        for (const pc of out) for (const cm of S.solidComponents(pc.mesh)) { // separate pieces become separate parts
          const vol = S.volume(cm); if (Math.abs(vol) < 1) continue;
          const bb = S.bbox(cm); parts.push({ mesh: cm, dir: pc.ex.map(x => x * 2), joints: pc.joints, bb, vol, fits: fitsBed(bb.size) });
        }
        const ctr = (p, k) => (p.bb.min[k] + p.bb.max[k]) / 2;
        parts.sort((a, b) => Math.round(ctr(a, 2) / 20) - Math.round(ctr(b, 2) / 20) || Math.round(ctr(a, 1) / 20) - Math.round(ctr(b, 1) / 20) || ctr(a, 0) - ctr(b, 0));
        parts.forEach((p, i) => { p.name = 'P' + String(i + 1).padStart(2, '0'); });
        st.result = { open: res.open, joint: J, adaptive: true, plan: st.plan };
      } else {
        res = await S.splitAllAsync(st.work, st.cuts, FLAT, (f) => { $('busyBar').style.width = (f * 100).toFixed(0) + '%'; });
        for (const pc of res.pieces) {
          const pieces = S.solidComponents(pc.mesh).filter(cm => Math.abs(S.volume(cm)) >= 1);
          const base = `X${pc.cell[0] + 1}-Y${pc.cell[1] + 1}-Z${pc.cell[2] + 1}`;
          pieces.forEach((cm, i) => {
            const bb = S.bbox(cm);
            parts.push({ mesh: cm, cell: pc.cell, dir: pc.cell.slice(), joints: pc.joints, bb, vol: S.volume(cm), name: pieces.length > 1 ? base + 'abcdefghijklmnopqrstuvwxyz'[i % 26] : base, fits: fitsBed(bb.size) });
          });
        }
        parts.sort((a, b) => a.cell[2] - b.cell[2] || a.cell[1] - b.cell[1] || a.cell[0] - b.cell[0]);
        st.result = { open: res.open, joint: J, cuts: st.cuts.map(c => c.slice()) };
      }
      // joints go on after all cuts: each part keeps one peg-free face to print on
      if (J.type === 'dovetail') {
        $('busyText').textContent = 'Adding dovetails…'; $('busySub').textContent = 'Planning the assembly order and cutting rails'; $('busyBar').style.width = '92%'; await new Promise(r => setTimeout(r, 20));
        let MF; try { MF = await loadManifold(); } catch (e) { throw new Error('Couldn\'t load the geometry engine for dovetails. Check your connection and try again.'); }
        const fitsUsable = (d, loose) => { const a = d.slice().sort((x, y) => x - y), b = (loose ? bed().map(x => x - 2) : usable()).slice().sort((x, y) => x - y); return a.every((x, i) => x <= b[i] + 0.01); };
        const jr = S.addDovetails(parts.map(p => p.mesh), res.planes, J, fitsUsable, MF);
        parts.forEach((p, i) => { const f = jr.info[i]; p.mesh = jr.meshes[i]; p.bb = S.bbox(p.mesh); p.fits = fitsBed(p.bb.size); p.rails = f.rails; p.slots = f.slots; p.keySlots = f.keySlots; p.joints = f.rails + f.slots + f.keySlots; p.pegs = 0; p.holes = 0; p.print = f.print; });
        Object.assign(st.result, { connectors: jr.connectors, pins: 0, rails: jr.rails, keys: jr.keys, steps: jr.steps, skipped: jr.skipped });
      } else if (J.type !== 'flat') {
        $('busyText').textContent = 'Adding joints…'; $('busyBar').style.width = '92%'; await new Promise(r => setTimeout(r, 20));
        const jr = S.addJoints(parts.map(p => p.mesh), res.planes, J, fitsBed);
        parts.forEach((p, i) => { p.mesh = jr.meshes[i]; p.bb = S.bbox(p.mesh); p.fits = fitsBed(p.bb.size); p.joints = jr.info[i].pegs + jr.info[i].holes; p.pegs = jr.info[i].pegs; p.holes = jr.info[i].holes; p.print = jr.info[i].print; });
        st.result.connectors = jr.connectors; st.result.pins = jr.pins; st.result.pinLens = jr.pinLens;
      } else { st.result.connectors = 0; st.result.pins = 0; parts.forEach(p => { p.joints = 0; p.pegs = 0; p.holes = 0; p.print = null; }); }
      st.parts = parts; st.sel = -1; st.stale = false;
      disposeGroup(gModel); disposeGroup(gPlanes); drawParts(); renderParts(); buildBedBox();
      emit('bedsplit:split', { parts: parts.length, joint: J.type, pins: st.result.pins || 0, name: st.name });
      $('stalePill').hidden = true; $('export').disabled = !parts.length; $('export').classList.add('primary'); $('split').classList.remove('primary');
    } catch (e) {
      console.error(e); toast('Splitting failed: ' + (e && e.message ? e.message : e));
    } finally { st.busy = false; $('busy').hidden = true; }
  }

  function drawParts() {
    disposeGroup(gParts); const ex = +$('explode').value;
    st.parts.forEach((p, i) => {
      const col = p.fits ? PALETTE[i % PALETTE.length] : css('--bad');
      const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color(col), roughness: 0.6, metalness: 0.02, transparent: true, opacity: 1 });
      const mesh = new THREE.Mesh(toGeom(p.mesh), mat); mesh.userData.i = i;
      mesh.position.set(p.dir[0] * ex, p.dir[1] * ex, p.dir[2] * ex);
      gParts.add(mesh); p.color = col;
    });
    applySel();
  }
  function applySel() {
    gParts.children.forEach(m => { const on = st.sel < 0 || m.userData.i === st.sel; m.material.opacity = on ? 1 : 0.14; m.material.depthWrite = on; });
    document.querySelectorAll('.part').forEach(el => el.classList.toggle('sel', +el.dataset.i === st.sel));
  }

  function renderParts() {
    const list = $('parts'), sum = $('summary'), warns = $('warns'); list.innerHTML = ''; sum.innerHTML = ''; warns.innerHTML = '';
    if (!st.result) { $('partsaux').textContent = ''; sum.innerHTML = '<span class="hint">Set the cuts, then press Split model.</span>'; return; }
    const P = st.parts, bad = P.filter(p => !p.fits).length, J = st.result.joint;
    $('partsaux').textContent = `${P.length} part${P.length === 1 ? '' : 's'}`;
    const jn = J.type === 'peg' ? 'peg joints' : J.type === 'dowel' ? 'dowel pins needed' : '';
    sum.innerHTML = (st.shell ? `<span class="chip note">${fmt(st.shell.wall)} mm shell</span>` : '') + (bad ? `<span class="chip bad">${bad} too big for bed</span>` : `<span class="chip ok">all fit ${escapeHtml(bedName())}</span>`) +
      (J.type === 'peg' ? `<span class="chip note">${st.result.connectors - st.result.pins} peg joints</span>` : '') +
      (J.type === 'dovetail' && st.result.rails ? `<span class="chip note">${st.result.rails} dovetail rail${st.result.rails === 1 ? '' : 's'}</span>` : '') +
      (J.type === 'dovetail' && st.result.keys && st.result.keys.length ? `<span class="chip note">${st.result.keys.length} slide-in key${st.result.keys.length === 1 ? '' : 's'}</span>` : '') +
      (st.result.pins ? `<span class="chip note">${st.result.pins} printed pins</span>` : '') +
      (J.type !== 'flat' && J.type !== 'dovetail' && P.length > 1 ? (P.every(p => p.print) ? `<span class="chip ok">every part has a flat face</span>` : '') : '');
    if (st.result.open) warns.insertAdjacentHTML('beforeend', `<p class="warn">${st.result.open} cut outline${st.result.open > 1 ? 's' : ''} didn't close, which means the mesh has holes near a cut. Those faces may be left open; run the parts through your slicer's repair.</p>`);
    if (bad) warns.insertAdjacentHTML('beforeend', `<p class="warn">Red parts exceed the bed in every orientation. ${st.result.adaptive ? 'Lower the safety margin or peg length and plan again.' : 'Add a piece on the longest axis, or lower the safety margin.'}</p>`);
    if (J.type === 'dovetail' && st.result.skipped) warns.insertAdjacentHTML('beforeend', `<p class="note">${st.result.skipped} seam${st.result.skipped > 1 ? 's' : ''} had no room for a rail or key (too small, too thin, or no clear way in). Glue ${st.result.skipped > 1 ? 'those' : 'that one'}, or try a smaller rail width.</p>`);
    if (J.type !== 'flat') { const lone = P.filter(p => p.joints === 0 && P.length > 1).length; if (lone) warns.insertAdjacentHTML('beforeend', `<p class="note">${lone} part${lone > 1 ? 's have' : ' has'} no joints — the cut face was too thin for a ${fmt(J.d)} mm connector plus wall. Glue those, or try a smaller diameter.</p>`); }
    P.forEach((p, i) => {
      const b = document.createElement('button'); b.className = 'part'; b.dataset.i = i; b.type = 'button';
      const s = p.bb.size;
      b.innerHTML = `<span class="sw" style="background:${p.color || PALETTE[i % PALETTE.length]}"></span><span class="nm">${p.name}<small>${fmt(s[0], 0)}×${fmt(s[1], 0)}×${fmt(s[2], 0)}${p.print ? ` · flat ${faceName(p.print)}` : ''}${p.rails ? ` · ${p.rails} rail${p.rails > 1 ? 's' : ''}` : ''}</small></span><span class="chip ${p.fits ? 'ok' : 'bad'}">${p.fits ? 'fits' : 'too big'}</span>`;
      b.addEventListener('click', () => { st.sel = st.sel === i ? -1 : i; applySel(); });
      list.appendChild(b);
    });
  }
  function bedName() { const b = BEDS.find(x => x[0] === bedSel.value); return b && b[2] ? b[1].replace('Bambu Lab ', '') : bed().join('×') + ' mm'; }

  // ---------- export ----------
  function saveBlob(filename, blob) {
    const url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
  async function exportZip() {
    if (!st.parts.length) return;
    const btn = $('export'); btn.disabled = true; const old = btn.textContent; btn.textContent = 'Packing…';
    await new Promise(r => setTimeout(r, 30));
    try {
      const base = (st.name.replace(/\.[^.]+$/, '').replace(/[^\w\-]+/g, '_').slice(0, 40)) || 'model';
      const enc = new TextEncoder(), files = {};
      // print-ready: each part turned so its flat (peg-free) face sits on the bed
      const printMeshes = st.parts.map(p => S.orientForPrint(p.mesh, p.print));
      st.parts.forEach((p, i) => {
        files[`print_ready/${base}_${p.name}.stl`] = S.stlBinary(printMeshes[i], p.name);
        files[`assembled_position/${base}_${p.name}.stl`] = S.stlBinary(p.mesh, p.name);
      });
      // 3MF with all parts laid out, flat face down
      let x = 0, y = 0, rowH = 0; const items = [];
      const order = st.parts.map((p, i) => ({ p, m: printMeshes[i], bb: S.bbox(printMeshes[i]) })).sort((a, b) => b.bb.size[1] - a.bb.size[1]);
      for (const { p, m, bb } of order) {
        const s = bb.size; if (x > 0 && x + s[0] > 700) { x = 0; y += rowH + 10; rowH = 0; }
        items.push({ name: `${base}_${p.name}`, mesh: m, offset: [x - bb.min[0], y - bb.min[1], -bb.min[2]] });
        x += s[0] + 10; rowH = Math.max(rowH, s[1]);
      }
      const inner = fflate.zipSync({ '[Content_Types].xml': enc.encode(S.CT3MF), '_rels/.rels': enc.encode(S.RELS3MF), '3D/3dmodel.model': enc.encode(S.model3mf(items)) }, { level: 6 });
      files[`${base}_all_parts.3mf`] = [inner, { level: 0 }];
      const J = st.result.joint;
      let pinsLine = '';
      if (st.result.pins) {
        // pins can differ in length (short ones where a shell wall curves away): group by length, 2 spares each
        const byLen = new Map(); for (const l of (st.result.pinLens && st.result.pinLens.length ? st.result.pinLens : Array(st.result.pins).fill(J.len))) { const key = fmt(l); byLen.set(key, (byLen.get(key) || 0) + 1); }
        const lines = [];
        for (const [len, cnt] of byLen) {
          const n = cnt + 2, cols = Math.ceil(Math.sqrt(n)), sp = J.d + 4, pins = [];
          for (let i = 0; i < n; i++) pins.push(S.pinMesh(J.d, +len, (i % cols) * sp, Math.floor(i / cols) * sp));
          const fn = `pins_${fmt(J.d)}x${len}mm_x${n}.stl`; files[fn] = S.stlBinary(S.merge(pins), 'pins');
          lines.push(`${fn}: ${n} pins (${cnt} needed + 2 spares), ${fmt(J.d)} mm x ${len} mm`);
        }
        pinsLine = `Pins: ${lines.join('; ')}. Print them standing up.\n`;
      }
      if (st.result.keys && st.result.keys.length) {
        let kx = 0; const km = [];
        for (const k of st.result.keys) { const m = S.orientForPrint(k.mesh, k.print), b = S.bbox(m); km.push(S.transform(m, (x, y, z) => [x + kx, y, z])); kx += b.size[0] + 4; }
        const fn = `keys_x${st.result.keys.length}.stl`; files[fn] = S.stlBinary(S.merge(km), 'keys');
        pinsLine = `Keys: ${fn} holds ${st.result.keys.length} slide-in dovetail key${st.result.keys.length > 1 ? 's' : ''}, already lying on a wide face. Print them as they are.\n`;
      }
      files['ASSEMBLY.txt'] = enc.encode(assemblyText(pinsLine));
      const zip = fflate.zipSync(files, { level: 6 });
      saveBlob(`${base}_split.zip`, new Blob([zip], { type: 'application/zip' }));
      emit('bedsplit:export', { parts: st.parts.length });
      toast(`Saved ${base}_split.zip`);
    } catch (e) {
      console.error(e); toast('Couldn\'t build the zip: ' + (e && e.message ? e.message : e));
    } finally { btn.disabled = false; btn.textContent = old; }
  }
  function assemblyText(pinsLine) {
    const J = st.result.joint, s = (st.result.adaptive ? st.result.plan.bb : st.bb).size, b = bed();
    const L = [];
    L.push('BEDSPLIT ASSEMBLY SHEET', '='.repeat(23), '');
    if (st.shell) L.push(`Shell: hollowed to a ${fmt(st.shell.wall)} mm wall (about ${Math.round(st.shell.removed * 100)}% less plastic than solid). Joints sit in the middle of the wall.`, 'Tip: a part whose inside is closed off (no cut opens it) has a hollow roof inside. Print it opening-down, or turn on supports so that roof has something to stand on.');
    L.push(`Source: ${st.name}`, `Model size: ${fmt(s[0])} x ${fmt(s[1])} x ${fmt(s[2])} mm`, `Printer bed: ${b.join(' x ')} mm (${bedName()})`);
    if (st.result.adaptive) {
      const pl = st.result.plan;
      L.push(`Mode: fewest parts (${st.parts.length} parts; an even grid would give ${pl.gridCount}).`);
      if (pl.gaps) L.push(`Empty space: ${pl.gaps} gap${pl.gaps === 1 ? '' : 's'} between separate pieces were used instead of cuts.`);
      L.push(`Orientation: ${turnText(pl)}. All parts share that orientation, so they still line up with each other.`);
      L.push(`Cuts (${S.treeCuts(pl.tree).length}), in the order they were made:`);
      S.treeCuts(pl.tree).forEach((n, i) => L.push(`  ${String(i + 1).padStart(2)}. ${'XYZ'[n.k]} = ${fmt(n.c)} mm`));
    } else {
      L.push(`Grid: ${st.cuts.map(c => c.length + 1).join(' x ')} (X x Y x Z)`);
      L.push(`Cut positions from model min corner: X [${st.cuts[0].map(c => fmt(c)).join(', ')}]  Y [${st.cuts[1].map(c => fmt(c)).join(', ')}]  Z [${st.cuts[2].map(c => fmt(c)).join(', ')}]`);
    }
    L.push('');
    if (J.type === 'peg') L.push(`Joints: printed pegs, ${fmt(J.d)} mm dia x ${fmt(J.len)} mm${st.shell ? ' (shorter where the wall curves away)' : ''}, sockets +${fmt(J.clr, 2)} mm clearance.`, 'Every part keeps one cut face with holes only, so it prints flat on that face. Where both neighbours need the same face flat, both get holes and a printed pin joins them.');
    else if (J.type === 'dovetail') {
      L.push(`Joints: sliding dovetails, ${fmt(J.dw)} mm wide x ${fmt(J.dh)} mm deep, 15 degree sides, ${fmt(J.clr, 2)} mm clearance.`, 'Rails lock the parts together: they only come apart by sliding back the way they went in.', '', 'ASSEMBLY ORDER');
      const AXW = (a, sg) => (sg > 0 ? '+' : '-') + 'XYZ'[a] + (a === 2 ? (sg < 0 ? ' (drop it down from above)' : ' (push it up from below)') : '');
      L.push(`  1. Place ${st.parts[0] ? st.parts[0].name : 'P01'}.`);
      let n = 2; const keysBy = new Map(); for (const k of (st.result.keys || [])) { const i = Math.max(k.a, k.b); if (!keysBy.has(i)) keysBy.set(i, []); keysBy.get(i).push(k); }
      for (let i = 1; i < st.parts.length; i++) {
        const stp = (st.result.steps || []).find(x => x.part === i), nm = st.parts[i].name;
        const ks = keysBy.get(i) || [];
        if (stp && stp.move) L.push(`  ${n++}. Slide ${nm} in along ${AXW(stp.move[0], stp.move[1])} onto ${stp.onto.map(q => st.parts[q].name).join(', ')}.`);
        else if (ks.length) L.push(`  ${n++}. Place ${nm} against ${Array.from(new Set(ks.map(k => st.parts[k.a === i ? k.b : k.a].name))).join(', ')}.`);
        else L.push(`  ${n++}. Set out ${nm}; later parts join onto it.`);
        for (const k of ks) L.push(`  ${n++}. Slide key ${k.name} into the channel between ${st.parts[k.a].name} and ${st.parts[k.b].name}, from the ${k.from[1] > 0 ? '+' : '-'}${'XYZ'[k.from[0]]} side.`);
      }
      L.push('Directions are in the model\'s own axes, the same axes as the files in assembled_position/.', 'Dry-fit first. If a rail is tight, sand it lightly or raise the clearance to 0.25-0.3 mm. A drop of CA glue on the rail makes the joint permanent.');
      if (st.result.skipped) L.push(`${st.result.skipped} seam(s) had no room for a dovetail: glue those.`);
    }
    else if (J.type === 'dowel') L.push(`Joints: blind holes for ${fmt(J.d)} mm dowels, ${fmt(J.len / 2 + 0.5)} mm deep on each side (+${fmt(J.clr, 2)} mm clearance).`);
    else L.push('Joints: none (flat cuts).');
    if (pinsLine) L.push(pinsLine.trim());
    if (st.result.adaptive) L.push('', 'Parts are numbered bottom to top, then front to back, then left to right.', 'Tip: import every STL into one slicer/CAD scene at once to see where each part goes.', '');
    else L.push('', 'Part names follow the grid: X2-Y1-Z3 = 2nd column along X, 1st along Y, 3rd layer up.', 'Assemble one Z layer at a time, starting from Z1.', '');
    const dv = J.type === 'dovetail';
    L.push(dv ? 'PART            SIZE (mm)                  RAILS SLOTS  PRINT ON     FITS' : 'PART            SIZE (mm)                  PEGS  HOLES  PRINT ON   FITS');
    for (const p of st.parts) { const z = p.bb.size; const a = dv ? p.rails || 0 : p.pegs || 0, b = dv ? (p.slots || 0) + (p.keySlots || 0) : p.holes || 0; L.push(`${p.name.padEnd(16)}${`${fmt(z[0])} x ${fmt(z[1])} x ${fmt(z[2])}`.padEnd(27)}${String(a).padEnd(6)}${String(b).padEnd(7)}${(p.print ? faceName(p.print).replace('−', '-') + ' face' : dv ? 'as modeled' : 'any').padEnd(dv ? 13 : 11)}${p.fits ? 'yes' : 'NO'}`); }
    L.push('', dv ? '"Print on" is a cut face with no rail on it ("as modeled" = keep the model\'s own up direction; rails then print standing up). Files in print_ready/ and the 3MF are already turned that way.' : '"Print on" is the flat cut face with only holes (no pegs). Files in print_ready/ and the 3MF are already turned so that face is on the bed.', 'Files in assembled_position/ keep every part where it sits in the finished model.');
    L.push('', 'Every part keeps its original position, so importing all STLs together reassembles the model.', 'The 3MF has all parts spread out; in Bambu Studio / OrcaSlicer press A to arrange them across plates.');
    return L.join('\n') + '\n';
  }

  // ---------- loading ----------
  function toast(msg) { const t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, 4200); }

  function groupToPositions(obj) {
    obj.updateMatrixWorld(true); const arrs = []; let n = 0;
    obj.traverse(o => { if (o.isMesh && o.geometry) { let g = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone(); g.applyMatrix4(o.matrixWorld); const a = g.attributes.position.array; arrs.push(a); n += a.length; } });
    const out = new Float32Array(n); let off = 0; for (const a of arrs) { out.set(a, off); off += a.length; } return out;
  }

  async function loadFile(file) {
    if (!file) return;
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    if (!['stl', 'obj', '3mf'].includes(ext)) { toast('Open an .stl, .obj or .3mf file.'); return; }
    $('busy').hidden = false; $('busyText').textContent = 'Reading ' + file.name; $('busySub').textContent = (file.size / 1048576).toFixed(1) + ' MB'; $('busyBar').style.width = '30%';
    await new Promise(r => setTimeout(r, 30));
    try {
      let pos;
      if (ext === 'stl') { const g = new THREE.STLLoader().parse(await file.arrayBuffer()); pos = g.attributes.position.array; }
      else if (ext === 'obj') { pos = groupToPositions(new THREE.OBJLoader().parse(await file.text())); }
      else { pos = groupToPositions(new THREE.ThreeMFLoader().parse(await file.arrayBuffer())); }
      if (!pos || pos.length < 9) throw new Error('No triangles found in the file.');
      $('busyBar').style.width = '70%'; await new Promise(r => setTimeout(r, 10));
      st.base = S.weld(pos); st.baseId = (st.baseId || 0) + 1; st.name = file.name; st.R = [1, 0, 0, 0, 1, 0, 0, 0, 1];
      if (S.volume(st.base) < 0) st.base = S.flip(st.base);
      rebuildWork();
      if (ext === 'obj') toast('OBJ files are often Y-up. If it lies on its side, press Rotate X.');
    } catch (e) { console.error(e); toast('Couldn\'t read that file: ' + (e.message || e)); }
    finally { $('busy').hidden = true; }
  }

  function loadSample() {
    const g = new THREE.TorusKnotGeometry(105, 34, 360, 44, 2, 3);
    st.base = S.fromGeometry(g); st.baseId = (st.baseId || 0) + 1; st.name = 'sample-torus-knot.stl'; st.R = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    if (S.volume(st.base) < 0) st.base = S.flip(st.base);
    $('scale').value = 100; $('units').value = '1';
    rebuildWork();
  }

  // ---------- events ----------
  $('file').addEventListener('change', e => { loadFile(e.target.files[0]); e.target.value = ''; });
  let dragDepth = 0;
  window.addEventListener('dragenter', e => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { dragDepth++; $('veil').hidden = false; e.preventDefault(); } });
  window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('veil').hidden = true; });
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', e => { e.preventDefault(); dragDepth = 0; $('veil').hidden = true; const f = e.dataTransfer && e.dataTransfer.files[0]; if (f) loadFile(f); });
  $('sample').addEventListener('click', loadSample);
  for (const a of ['x', 'y', 'z']) $('r' + a).addEventListener('click', () => { st.R = mulR(ROT[a], st.R); rebuildWork(); });
  $('scale').addEventListener('change', () => rebuildWork());
  $('shell').addEventListener('change', () => { $('shellFields').hidden = !shellOn(); jointHint(); rebuildWork(); });
  $('shellw').addEventListener('change', () => { jointHint(); if (shellOn() && shellWall() !== st.wallApplied) rebuildWork(); });
  $('split').addEventListener('pointerdown', () => { st.splitArm = Date.now(); });
  $('units').addEventListener('change', () => rebuildWork());
  const bedChanged = () => { saveBed(); $('bedlabel').textContent = `Bed ${bed().join(' × ')} mm · ${bedName()}`; $('bedaux').textContent = bedName(); replanAll(); frame(); };
  bedSel.addEventListener('change', () => { setBed(bedSel.value); bedChanged(); });
  for (const id of ['bx', 'by', 'bz']) $(id).addEventListener('change', () => { bedSel.value = 'custom'; bedChanged(); });
  $('margin').addEventListener('change', bedChanged);
  document.querySelectorAll('input[name=jt]').forEach(r => r.addEventListener('change', () => { jointHint(); replanAll(); }));
  document.querySelectorAll('input[name=mode]').forEach(r => r.addEventListener('change', modeChanged));
  $('adrot').addEventListener('change', () => { if (adaptive()) schedulePlan(); });
  for (const id of ['jd', 'jclr', 'jmax', 'jwall', 'dw']) $(id).addEventListener('change', markStale);
  $('dh').addEventListener('change', () => { if (jtype() === 'dovetail') replanAll(); });
  $('dkeys').addEventListener('change', () => { if (jtype() === 'dovetail') replanAll(); });
  $('jlen').addEventListener('change', () => { if (jtype() === 'peg') replanAll(); else markStale(); renderEst(); });
  $('split').addEventListener('click', runSplit);
  $('export').addEventListener('click', exportZip);
  $('explode').addEventListener('input', () => { $('explodeOut').textContent = $('explode').value + ' mm'; if (st.result) { const ex = +$('explode').value; gParts.children.forEach(m => { const c = st.parts[m.userData.i].dir; m.position.set(c[0] * ex, c[1] * ex, c[2] * ex); }); buildBedBox(); } });
  $('showBed').addEventListener('change', () => { gBed.visible = $('showBed').checked; });
  $('showPlanes').addEventListener('change', () => { gPlanes.visible = $('showPlanes').checked; });

  // ---------- start ----------
  jointHint(); bedChanged(); resize(); themeColors();
  st.autoSplit = true;
  loadSample();
})();

