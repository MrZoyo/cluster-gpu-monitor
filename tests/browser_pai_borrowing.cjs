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
        const node = (name, mapped) => ({ NodeName: name, NodeStatus: 'Ready', GPU: 4, AllocatableGPU: 4,
          RequestGPU: 1, mapping_state: mapped ? 'ok' : 'error', free_known: mapped,
          possibly_borrowed: false, cards: Array.from({ length: 4 }, (_, i) => ({ index: i,
            assignments: i < 3 && mapped ? [{ workload_id: i ? 'borrower' : 'job', owner_name: i ? 'Borrower' : 'Example',
              owner_id: i ? 'u-borrower' : 'u-example', borrowed: i > 0, pod: i ? 'borrowed-worker' : 'worker', fresh: true }] : [],
            compute: i < 3 && mapped ? { value: i ? 47 : 81, fresh: true } : null, memory: null })) });
        const fixture = { nodes: [node('mapped-node', true), node('failed-mapping-node', false)],
          workloads: [{ WorkloadId: 'job', WorkloadName: 'Training', WorkloadType: 'dlc', WorkloadStatus: 'Running',
            requested_gpu: 1, cards: [{node:'mapped-node', index:0}], metrics: [] },
          { WorkloadId: 'borrower', WorkloadName: 'Borrowing', WorkloadType: 'dlc', WorkloadStatus: 'Running',
            UserName: 'Borrower', UserId: 'u-borrower', scheduled_gpu: 2, oversold: true,
            cards: [{node:'mapped-node',index:1},{node:'mapped-node',index:2}], metrics: [] }], users: [], quotas: [],
          summary: { physical_gpus: 8, mapped_gpus: 3, pool_scheduled_gpus: 3,
            cluster_compute_mean: null, pool_compute_estimate: 35 } };
        window.baseFixture = structuredClone(fixture);
        const m = PaiUI.prepare(fixture);
        const root = document.querySelector('main');
        root.replaceChildren(PaiUI.kpis(m), PaiUI.heatPanel(m), PaiUI.nodesPanel(m));
        const cells = [...document.querySelectorAll('#paiHeat .pai-cell')];
        const title = cells.find(c => c.textContent === '0').title;
        const cardLabel = document.querySelector('.pai-card.free .avg').textContent;
        const legacy = structuredClone(fixture);
        const legacyNode = legacy.nodes.find(n => n.NodeName === 'mapped-node');
        legacyNode.free_known = false;
        legacyNode.possibly_borrowed = true;
        legacyNode.cards[1].assignments = [];
        legacyNode.cards[1].compute = null;
        const legacyModel = PaiUI.prepare(legacy);
        return { zeros: cells.filter(c => c.textContent === '0').length,
          unknown: cells.filter(c => c.textContent === '?').length,
          measured: cells.filter(c => c.textContent === '81').length,
          borrowedMeasured: cells.filter(c => c.textContent === '47').length,
          borrowedTitle: cells.find(c => c.textContent === '47').title,
          mappedBorrowed: m.sx.borrowedMapped, borrowedUnmapped: m.sx.borrowedUnmapped.length,
          mappedNode: m.workloads.find(w => w.WorkloadId === 'borrower').nodes[0],
          heatNote: document.querySelector('#paiHeat .pai-note.oversold').textContent,
          title, cardLabel, summary: m.summary,
          allocated: document.querySelector('.pai-allocation-kpi .v').textContent,
          borrowed: document.querySelector('.pai-allocation-kpi .pai-borrowed-subset').textContent,
          purple: getComputedStyle(document.querySelector('.pai-borrowed-subset')).color,
          expectedPurple: getComputedStyle(document.documentElement).getPropertyValue('--mem').trim(),
          kpis: document.querySelectorAll('.pai-kpis .kpi').length,
          legacyUnknown: legacyModel.nodes.find(n => n.NodeName === 'mapped-node').cards[1].state,
          overflow: document.documentElement.scrollWidth > innerWidth };
      }, locale);
      assert.equal(result.zeros, 1);
      assert.equal(result.unknown, 4);
      assert.equal(result.measured, 1);
      assert.equal(result.borrowedMeasured, 2);
      assert.equal(result.mappedBorrowed, 2);
      assert.equal(result.borrowedUnmapped, 0);
      assert.equal(result.mappedNode.name, 'mapped-node');
      assert.deepEqual(result.mappedNode.indices, [1, 2]);
      assert.match(result.borrowedTitle, locale === 'zh' ? /闲时借用.*Borrower.*borrower.*borrowed-worker/ : /Idle borrowing.*Borrower.*borrower.*borrowed-worker/);
      assert.equal(result.cardLabel, locale === 'zh' ? '原配额空闲' : 'Quota idle');
      assert.match(result.title, locale === 'zh' ? /Pod 映射一致/ : /match Pod mapping/);
      assert.match(result.heatNote, locale === 'zh' ? /已确认物理映射 2 卡/ : /2 have confirmed physical mappings/);
      assert.equal(result.summary.cluster_compute_mean, null);
      assert.equal(result.summary.pool_compute_estimate, 35);
      assert.equal(result.legacyUnknown, 'unknown');
      assert.equal(result.allocated, '3 / 8');  // Borrowing is part of allocation, never added twice.
      assert.match(result.borrowed, locale === 'zh' ? /其中借用 2 卡/ : /Including 2 borrowed GPUs/);
      assert.equal(result.kpis, 5);
      assert.notEqual(result.purple, '');
      assert.equal(result.overflow, false);
      if (process.env.SHOT_DIR) {
        require('node:fs').mkdirSync(process.env.SHOT_DIR, { recursive: true });
        await page.evaluate(() => scrollTo(0, 0));
        await page.waitForTimeout(150);
        await page.screenshot({ path: path.join(process.env.SHOT_DIR, `borrowing-${locale}-${width}-top.png`) });
        if (width < 768) {
          await page.locator('.pai-node-list').screenshot({ path: path.join(process.env.SHOT_DIR, `borrowing-${locale}-${width}-lower.png`) });
        }
      }
      await page.evaluate(async () => {
        window.API={paiOverview:async()=>structuredClone(baseFixture)};
        window.GM={crumb(){},setSourceHealth(){}};
        const root=document.querySelector('main');root.replaceChildren();
        await Views.pai.render(root,{tab:'node',id:'mapped-node'});
      });
      const regular=locale==='zh'?'可分配 / 普通请求':'Allocatable / regular requests';
      const mapped=locale==='zh'?'已定位占用 / 其中借用':'Mapped allocation / borrowed subset';
      assert.equal(await page.locator('.pai-meta dt').filter({hasText:regular}).evaluate(n=>n.nextElementSibling.textContent),'4 / 1');
      assert.equal(await page.locator('.pai-meta dt').filter({hasText:mapped}).evaluate(n=>n.nextElementSibling.textContent),'3 / 2');
      const row=page.locator('.pai-table tbody tr').filter({has:page.locator('td', {hasText:'#1'})});
      assert.match(await row.textContent(),locale==='zh'?/Borrowing.*闲时借用.*Borrower/:/Borrowing.*Idle borrowing.*Borrower/);
      assert.equal(await row.locator('a[href="#/pai/workload/borrower"]').count(),1);
      assert.equal(await row.locator('a[href="#/pai/user/u-borrower"]').count(),1);
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
      if(process.env.SHOT_DIR) await page.screenshot({path:path.join(process.env.SHOT_DIR,`borrowed-node-${locale}-${width}.png`),fullPage:true});
      await page.evaluate(async () => {
        const root=document.querySelector('main');root.replaceChildren();
        await Views.pai.render(root,{tab:'workload',id:'borrower'});
      });
      const physical=locale==='zh'?'物理节点':'Node';
      assert.match(await page.locator('.pai-meta dt').filter({hasText:new RegExp('^'+physical+'$')}).evaluate(n=>n.nextElementSibling.textContent),/mapped-node.*GPU 1,2/);
      assert.doesNotMatch(await page.locator('main').textContent(),/不公开|undisclosed|hidden/);
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
      console.log(`PASS ${locale} ${width}px: confirmed borrower, owner and card indices; unknown mapping; legacy snapshot; no double count or overflow`);
    }
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
