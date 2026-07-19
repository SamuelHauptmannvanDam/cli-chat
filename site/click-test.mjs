import puppeteer from 'puppeteer-core';

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
});
const page = await browser.newPage();
await page.setViewport({ width: 1920, height: 1080 });
await page.goto('https://cli-chat-site.cli-chat-mcp.workers.dev/?v=' + Date.now(), { waitUntil: 'networkidle0' });
await new Promise(r => setTimeout(r, 1000));

const targets = ['top', 'modes', 'desk', 'handles', 'context', 'contact'];
const results = [];

async function settleScroll() {
  await page.evaluate(() => new Promise(resolve => {
    let last = -1, still = 0;
    (function poll() {
      if (scrollY === last) { if (++still > 8) return resolve(); }
      else { still = 0; last = scrollY; }
      requestAnimationFrame(poll);
    })();
  }));
}

for (const id of targets) {
  await page.click(`.agenda a[href="#${id}"]`);
  await settleScroll();
  await new Promise(r => setTimeout(r, 1200)); // let heading decrypt finish
  await page.screenshot({ path: `click-${id}.png` });

  const check = await page.evaluate((id, all) => {
    const EPS = 4; // px tolerance for shared border lines
    const vh = innerHeight;
    const intruders = [];
    for (const other of all) {
      if (other === id) continue;
      const el = other === 'top' ? document.querySelector('.hero') : document.getElementById(other);
      const r = el.getBoundingClientRect();
      const visible = Math.min(r.bottom, vh) - Math.max(r.top, 0);
      if (visible > EPS) intruders.push(other + ':' + Math.round(visible) + 'px');
    }
    return intruders;
  }, id, targets);

  results.push({ clicked: id, intruders: check, pass: check.length === 0 });
}

console.log(JSON.stringify(results, null, 2));
await browser.close();
