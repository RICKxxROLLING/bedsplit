// Donate button, bigger-printer suggestions, supplies links and AdSense.
// Everything reads window.BEDSPLIT_CONFIG and stays hidden when a setting is empty.
(function () {
  'use strict';
  const C = window.BEDSPLIT_CONFIG || {};
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function affUrl(url) {
    if (!url) return '';
    let u; try { u = new URL(url); } catch (e) { return ''; }
    if (/(^|\.)amazon\./.test(u.hostname)) {
      if (!C.amazonTag) return '';           // no tag: don't send traffic to Amazon for free
      u.searchParams.set('tag', C.amazonTag);
    }
    return u.toString();
  }
  const link = (label, url) => { const h = affUrl(url); return h ? `<a href="${esc(h)}" target="_blank" rel="sponsored noopener">${esc(label)}</a>` : esc(label); };
  const hasAff = (url) => !!affUrl(url);
  const DISCLOSE = '<p class="disclose">Affiliate links. Bedsplit may earn a commission, at no cost to you.</p>';

  // ---------- donate ----------
  function initDonate() { const a = $('donate'); if (a && C.donateUrl) { a.href = C.donateUrl; a.hidden = false; } }

  // ---------- AdSense ----------
  let adsLoaded = false;
  function loadAdsense() {
    if (adsLoaded || !C.adsense || !C.adsense.client) return false;
    adsLoaded = true;
    const s = document.createElement('script');
    s.async = true; s.crossOrigin = 'anonymous';
    s.src = 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=' + encodeURIComponent(C.adsense.client);
    document.head.appendChild(s);
    return true;
  }
  function placeAd(container, slot) {
    if (!container || !slot || !C.adsense || !C.adsense.client) return;
    loadAdsense();
    container.innerHTML = `<div class="adlabel">Advertisement</div><ins class="adsbygoogle" data-ad-client="${esc(C.adsense.client)}" data-ad-slot="${esc(slot)}" data-ad-format="auto" data-full-width-responsive="true"></ins>`;
    container.hidden = false;
    try { (window.adsbygoogle = window.adsbygoogle || []).push({}); } catch (e) {}
  }
  function initAds() {
    placeAd($('adSide'), C.adsense && C.adsense.sidebarSlot);
    document.querySelectorAll('[data-ad="guide"]').forEach(el => placeAd(el, C.adsense && C.adsense.guideSlot));
  }

  // ---------- bigger-printer suggestions ----------
  let upToken = 0;
  const vol = (b) => b[0] * b[1] * b[2];
  const fitsIn = (a, b) => { const x = a.slice().sort((p, q) => p - q), y = b.slice().sort((p, q) => p - q); return x.every((v, i) => v <= y[i]); };
  const tick = () => new Promise(r => setTimeout(r, 0));
  async function run(gen) { let r; while (!(r = gen.next()).done) await tick(); return r.value; }

  async function suggest(d) {
    const el = $('upsell'); if (!el || !window.Splitter) return;
    const my = ++upToken;
    el.hidden = true; el.innerHTML = '';
    if (!d || !d.mesh || d.count <= 1 || !(C.printers || []).length) return;
    const S = window.Splitter, cache = {};
    const usable = (b) => b.map(x => Math.max(10, x - 2 * d.margin));
    // candidates: strictly bigger than the current bed in every sorted dimension
    const cands = C.printers.filter(p => p.bed && vol(p.bed) > vol(d.bed) && fitsIn(d.bed, p.bed)).sort((a, b) => vol(a.bed) - vol(b.bed));
    if (!cands.length) return;
    await tick();
    // baseline on the same coarse estimate so the comparison is like for like
    const base = await run(S.quickCount(d.mesh, usable(d.bed), d.pegLen, d.rotate, cache));
    if (my !== upToken) return;
    const rows = []; let lastCount = Math.min(base.count, d.count);
    for (const p of cands) {
      const r = await run(S.quickCount(d.mesh, usable(p.bed), d.pegLen, d.rotate, cache));
      if (my !== upToken) return;
      if (r.ok && r.count < lastCount) { rows.push({ p, count: r.count }); lastCount = r.count; }
      if (r.ok && r.count <= 1) break;
      if (rows.length >= 3) break;
    }
    if (!rows.length) return;
    const anyLink = rows.some(r => hasAff(r.p.url));
    el.innerHTML = `<h3>On a bigger bed</h3><ul>` +
      rows.map(r => `<li><span>${link(r.p.name, r.p.url)} <small style="color:var(--muted)">${r.p.bed.join('×')}</small></span><b>≈ ${r.count} part${r.count === 1 ? '' : 's'}</b></li>`).join('') +
      `</ul>` + (anyLink ? DISCLOSE : '');
    el.hidden = false;
  }

  // ---------- supplies ----------
  function supplies(d) {
    const el = $('supplies'); if (!el) return;
    const list = (C.supplies || []).filter(s => hasAff(s.url) && (!s.joints || s.joints.includes(d.joint)));
    if (!list.length || d.parts < 2) { el.hidden = true; return; }
    el.innerHTML = `<h3>For assembly</h3><ul>${list.map(s => `<li>${link(s.label, s.url)}</li>`).join('')}</ul>${DISCLOSE}`;
    el.hidden = false;
  }

  window.addEventListener('bedsplit:planning', () => { upToken++; const el = $('upsell'); if (el) el.hidden = true; });
  window.addEventListener('bedsplit:plan', (e) => { setTimeout(() => suggest(e.detail), 400); });
  window.addEventListener('bedsplit:split', (e) => supplies(e.detail));
  window.addEventListener('bedsplit:clear', () => { const el = $('supplies'); if (el) el.hidden = true; });

  const start = () => { initDonate(); initAds(); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
  window.BedsplitMonetize = { affUrl, placeAd };
})();
