# Bedsplit

Static site: cuts oversized STL/OBJ/3MF models into parts that fit a printer bed, and makes keyed casting molds. Everything runs in the browser.

- `site/` – the files that get deployed (Cloudflare Worker with static assets, see `wrangler.jsonc`)
- `site/js/splitter.js` – mesh cutting, joints, shells, exporters
- `site/js/mold.js` – mold mode: block minus model, parting planes, hemisphere keys, funnel and vents (uses Manifold WASM from `site/vendor/manifold/`)
- `site/js/app.js` – UI

Deploy: `npx wrangler deploy` → https://bedsplit.riley-hire.workers.dev
Mold mode direct link: https://bedsplit.riley-hire.workers.dev/#mold
