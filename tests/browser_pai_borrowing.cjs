// NODE_PATH=<Playwright modules> CHROME_BIN=<browser> node tests/browser_pai_borrowing.cjs
// Synthetic snapshots only; no production or cloud access.
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require('playwright');
const web = path.resolve(__dirname, '../web');

(async () => {
  const browser = await chromium.launch({ headless: true,
    ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}) });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.setContent('<main class="pai-scope"></main>');
    await page.addStyleTag({ path: path.join(web, 'css/style.css') });
    await page.evaluate(() => { window.locale = 'zh'; window.I18n = { getLocale: () => window.locale, t: k => k }; });
    for (const file of ['components.js', 'pai.js']) await page.addScriptTag({ path: path.join(web, 'js', file) });
    for (const locale of ['zh', 'en']) for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      const result = await page.evaluate(locale => {
        window.locale = locale;
        const node = (name, borrowed) => ({ NodeName: name, NodeStatus: 'Ready', GPU: 4,
          RequestGPU: 1, mapping_state: borrowed ? 'ok' : 'error', free_known: false,
          possibly_borrowed: borrowed, cards: Array.from({ length: 4 }, (_, i) => ({ index: i,
            assignments: i === 0 && borrowed ? [{ workload_id: 'job', owner_name: 'Example', fresh: true }] : [],
            compute: i === 0 && borrowed ? { value: 81, fresh: true } : null, memory: null })) });
        const fixture = { nodes: [node('available-node', true), node('failed-mapping-node', false)],
          workloads: [{ WorkloadId: 'job', WorkloadName: 'Training', WorkloadType: 'dlc', WorkloadStatus: 'Running',
            requested_gpu: 1, cards: ['mapped-card'], metrics: [] },
          { WorkloadId: 'borrower', WorkloadName: 'Borrowing', WorkloadType: 'dlc', WorkloadStatus: 'Running',
            scheduled_gpu: 2, oversold: true, cards: [], metrics: [] }], users: [], quotas: [],
          summary: { physical_gpus: 8, mapped_gpus: 1, pool_scheduled_gpus: 3,
            cluster_compute_mean: null, pool_compute_estimate: 35 } };
        const m = PaiUI.prepare(fixture);
        const root = document.querySelector('main');
        root.replaceChildren(PaiUI.kpis(m), PaiUI.heatPanel(m), PaiUI.nodesPanel(m));
        const cells = [...document.querySelectorAll('#paiHeat .pai-cell')];
        const title = cells.find(c => c.textContent === '0').title;
        const cardLabel = document.querySelector('.pai-card.free .avg').textContent;
        const legacy = structuredClone(fixture);
        delete legacy.nodes[0].possibly_borrowed;
        const legacyModel = PaiUI.prepare(legacy);
        return { zeros: cells.filter(c => c.textContent === '0').length,
          unknown: cells.filter(c => c.textContent === '?').length,
          measured: cells.filter(c => c.textContent === '81').length,
          title, cardLabel, summary: m.summary,
          allocated: document.querySelector('.pai-allocation-kpi .v').textContent,
          borrowed: document.querySelector('.pai-allocation-kpi .pai-borrowed-subset').textContent,
          purple: getComputedStyle(document.querySelector('.pai-borrowed-subset')).color,
          expectedPurple: getComputedStyle(document.documentElement).getPropertyValue('--mem').trim(),
          kpis: document.querySelectorAll('.pai-kpis .kpi').length,
          legacyUnknown: legacyModel.nodes.find(n => n.NodeName === 'available-node').cards[1].state,
          overflow: document.documentElement.scrollWidth > innerWidth };
      }, locale);
      assert.equal(result.zeros, 3);
      assert.equal(result.unknown, 4);
      assert.equal(result.measured, 1);
      assert.equal(result.cardLabel, locale === 'zh' ? '可能被借用' : 'Possibly borrowed');
      assert.match(result.title, locale === 'zh' ? /不代表实测/ : /not measured/);
      assert.equal(result.summary.cluster_compute_mean, null);
      assert.equal(result.summary.pool_compute_estimate, 35);
      assert.equal(result.legacyUnknown, 'unknown');
      assert.equal(result.allocated, '3 / 8');  // Includes two borrowed GPUs, not just one mapped GPU.
      assert.match(result.borrowed, locale === 'zh' ? /其中借用 2 卡/ : /Including 2 borrowed GPUs/);
      assert.equal(result.kpis, 5);
      assert.notEqual(result.purple, '');
      assert.equal(result.overflow, false);
      if (process.env.SHOT_DIR) {
        require('node:fs').mkdirSync(process.env.SHOT_DIR, { recursive: true });
        await page.evaluate(() => scrollTo(0, 0));
        await page.waitForTimeout(150);
        await page.screenshot({ path: path.join(process.env.SHOT_DIR, `borrowing-${locale}-${width}-top.png`) });
        await page.evaluate(() => scrollTo(0, document.querySelector('.pai-node-list').getBoundingClientRect().top + scrollY - 50));
        await page.waitForTimeout(150);
        await page.screenshot({ path: path.join(process.env.SHOT_DIR, `borrowing-${locale}-${width}-lower.png`) });
      }
      console.log(`PASS ${locale} ${width}px: borrowing zero, real metrics, mapping failure, legacy snapshot, unchanged summary, no horizontal overflow`);
    }
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
