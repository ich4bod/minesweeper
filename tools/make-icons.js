/*
 * Rasterises the two icon SVGs in site/ into the PNGs the web manifest points
 * at. Android will not install a PWA from an SVG-only icon set, so these have
 * to be real bitmaps — but there is no ImageMagick, PIL or sharp on this host
 * and there is no reason to add one, because the Playwright image already
 * contains a renderer that is better at SVG than any of them.
 *
 *   docker run --rm --ipc=host \
 *     -v /srv/ichabod/apps/minesweeper/tools:/tools:ro \
 *     -v /srv/ichabod/apps/minesweeper/.verify/node_modules:/node_modules:ro \
 *     -v /srv/ichabod/apps/minesweeper/site:/site \
 *     mcr.microsoft.com/playwright:v1.55.0-noble \
 *     node /tools/make-icons.js
 *
 * The viewport is set to the icon's exact pixel size at deviceScaleFactor 1,
 * so the screenshot comes out at its final size and never needs resampling.
 */
let chromium;
try { chromium = require('playwright').chromium; }
catch (e) { chromium = require('playwright-core').chromium; }

const fs = require('fs');
const path = require('path');

const SITE = process.env.SITE_DIR || '/site';

const ICONS = [
  { src: 'icon.svg', out: 'icon-192.png', size: 192 },
  { src: 'icon.svg', out: 'icon-512.png', size: 512 },
  { src: 'icon-maskable.svg', out: 'icon-maskable-512.png', size: 512 },
];

async function main() {
  const browser = await chromium.launch();
  for (const icon of ICONS) {
    const svg = fs.readFileSync(path.join(SITE, icon.src), 'utf8');
    const uri = 'data:image/svg+xml;base64,' + Buffer.from(svg, 'utf8').toString('base64');
    const page = await browser.newPage({
      viewport: { width: icon.size, height: icon.size },
      deviceScaleFactor: 1,
    });
    await page.setContent(
      '<body style="margin:0">' +
      '<img src="' + uri + '" width="' + icon.size + '" height="' + icon.size + '">' +
      '</body>'
    );
    await page.locator('img').waitFor();
    const dest = path.join(SITE, icon.out);
    await page.screenshot({ path: dest });
    await page.close();
    console.log('  ' + icon.out + '  ' + icon.size + 'x' + icon.size +
      '  ' + fs.statSync(dest).size + ' bytes');
  }
  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
