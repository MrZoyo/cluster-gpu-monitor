// NODE_PATH=<Playwright modules> CHROME_BIN=<browser> node tests/browser_pai_quota.cjs
// Quota tab and quota detail on synthetic snapshots only; no production or cloud access.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const web = path.resolve(__dirname, '../web');

// Root quota "pool" with two subquotas. Most training jobs are submitted to the root and land on
// subquota nodes (parent-quota placement); one idle-time job borrows a subquota's nodes.
function fixture() {
  const assignment = (id, owner, extra) => ({ workload_id: id, owner_id: 'u-' + owner, owner_name: owner, pod: id + '-pod', fresh: true, ...extra });
  const card = (index, a, compute) => ({ index, assignments: a ? [a] : [], compute: compute == null ? null : { value: compute, fresh: true, recent: compute, recent_n: 8, sampled_at: 19990 }, memory: null });
  const node = (name, quota, cards, request) => ({ NodeName: name, NodeStatus: 'Ready', GPU: 4, GPUType: 'Demo GPU', AllocatableGPU: 4, RequestGPU: request,
    mapping_state: 'ok', free_known: true, health_rate: 10000, bound_quotas: ['q-root', quota], cards });
  const nodes = [
    node('node-a1', 'q-a', [card(0, assignment('root-train', 'bob'), 80), card(1, assignment('root-train', 'bob'), 70), card(2, assignment('a-dev', 'alice'), 2), card(3, null, null)], 3),
    node('node-a2', 'q-a', [card(0, null, null), card(1, null, null), card(2, null, null), card(3, null, null)], 0),
    node('node-b1', 'q-b', [card(0, assignment('b-train', 'carol'), 55), card(1, assignment('b-train', 'carol'), 60),
      card(2, assignment('idle-job', 'dave', { borrowed: true }), 40), card(3, assignment('idle-job', 'dave', { borrowed: true }), 45)], 2),
  ];
  const workload = (id, name, type, owner, quota, gpus, cards, extra) => ({ WorkloadId: id, WorkloadName: name, WorkloadType: type, WorkloadStatus: 'Running',
    UserId: 'u-' + owner, UserName: owner, QuotaId: quota, requested_gpu: gpus, scheduled_gpu: gpus, scheduled: true, oversold: false, cards, metrics: [], ...extra });
  const workloads = [
    workload('root-train', 'root-train', 'dlc', 'bob', 'q-root', 2, [{ node: 'node-a1', index: 0 }, { node: 'node-a1', index: 1 }]),
    workload('a-dev', 'a-dev', 'dsw', 'alice', 'q-a', 1, [{ node: 'node-a1', index: 2 }]),
    workload('b-train', 'b-train', 'dlc', 'carol', 'q-b', 2, [{ node: 'node-b1', index: 0 }, { node: 'node-b1', index: 1 }]),
    workload('idle-job', 'idle-job', 'dlc', 'dave', 'q-a', 2, [{ node: 'node-b1', index: 2 }, { node: 'node-b1', index: 3 }], { oversold: true }),
    workload('queued', 'queued-job', 'dlc', 'alice', 'q-a', 8, [], { WorkloadStatus: 'Pending', scheduled: false, scheduled_gpu: 0, enqueued_at: 19000 }),
  ];
  const quotas = [
    { quota_id: 'q-root', quota_name: 'training', parent_quota_id: null, gpu_capacity: 12, gpu_used: 5, allocated_gpu: 5, self_allocated_gpu: 2, descendants_allocated_gpu: 3, ancestors_allocated_gpu: 0, oversold_enabled: true, status: 'Ready' },
    { quota_id: 'q-a', quota_name: 'alpha', parent_quota_id: 'q-root', gpu_capacity: 8, gpu_used: 1, allocated_gpu: 3, self_allocated_gpu: 1, descendants_allocated_gpu: 0, ancestors_allocated_gpu: 2, oversold_enabled: true, status: 'Ready' },
    { quota_id: 'q-b', quota_name: 'beta', parent_quota_id: 'q-root', gpu_capacity: 4, gpu_used: 2, allocated_gpu: 2, self_allocated_gpu: 2, descendants_allocated_gpu: 0, ancestors_allocated_gpu: 0, oversold_enabled: false, status: 'Ready' },
  ];
  const users = ['alice', 'bob', 'carol', 'dave'].map((u) => ({ UserId: 'u-' + u, Username: u, used_gpu: 1, submitted_gpu: 1, running_workloads: 1 }));
  return { enabled: true, state: 'ok', now: 20000, quota_id: 'q-root', region: 'demo', workspace_id: 'ws', poll_interval_s: 120, round: { finished_at: 20000 },
    sources: [{ name: 'nodes', state: 'ok', fetched_at: 20000 }], quotas, nodes, workloads, users,
    summary: { physical_gpus: 12, mapped_gpus: 7, pool_scheduled_gpus: 7, task_compute_mean: 50, task_measured_gpus: 7, pool_compute_estimate: 30 } };
}
function ranking() {
  const feature = (id, name, root, gh, occ) => ({ quota_id: id, quota_name: name, is_root: root, rank: root ? null : 1, gpu_hours: gh, direct_gpu_hours: gh,
    root_attributed_gpu_hours: 0, oversold_gpu_hours: id === 'q-a' ? 4 : 0, measured_gpu_hours: gh * 0.9, effective_gpu_hours: gh * 0.45, hardware_efficiency_pct: 50,
    workloads: 3, occupancy_pct: occ, quota_coverage_pct: 97.5 });
  return { window: 'week', since: 0, until: 20000, generated_at: 20000, timezone: 'Asia/Shanghai', first_hour: 0,
    features: [feature('q-a', 'alpha', false, 120.4, 61.2), feature('q-b', 'beta', false, 80, 88.8)], root_quota: feature('q-root', 'training', true, 300, 70), totals: { gpu_hours: 500 } };
}

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}) });
  try {
    for (const locale of ['zh', 'en']) for (const width of [390, 1440]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.setContent('<main id="view" class="pai-scope" style="max-width:1400px;margin:20px auto;padding:0 12px"></main>');
      await page.addStyleTag({ path: path.join(web, 'css/style.css') });
      await page.addScriptTag({ path: path.join(web, 'vendor/echarts.min.js') });
      await page.evaluate((locale) => {
        window.locale = locale; window.I18n = { getLocale: () => locale, t: (k) => k };
        window.GM = { crumb() {}, setSourceHealth() {}, refreshFailed: () => false, state: { window: '24h', meta: { windows: ['24h'] } } };
        window.PageRecovery = { show() { window.recoveryShown = (window.recoveryShown || 0) + 1; } };
      }, locale);
      for (const file of ['refresh.js', 'components.js', 'pai-estimate.js', 'pai.js']) await page.addScriptTag({ path: path.join(web, 'js', file) });
      await page.evaluate(({ raw, rank }) => {
        window.fixture = raw; window.rank = rank; window.rankingCalls = 0; window.rankingFails = false;
        window.API = { paiOverview: async () => structuredClone(fixture),
          paiRanking: async () => { rankingCalls++; if (rankingFails) throw new Error('503'); return structuredClone(rank); } };
        window.renderTab = async (tab, id, soft = false) => {
          const root = document.querySelector('#view'); let next = root, wrapper;
          if (soft) { wrapper = document.createElement('div'); wrapper.setAttribute('data-refresh-draft', ''); wrapper.style.cssText = 'position:absolute;left:-10000px;visibility:hidden'; next = root.cloneNode(false); wrapper.append(next); document.body.append(wrapper); }
          else root.replaceChildren();
          await Views.pai.render(next, { tab, id });
          if (soft) { LiveDOM.commit(root, next); wrapper.remove(); }
        };
      }, { raw: fixture(), rank: ranking() });
      const fits = () => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);
      const zh = locale === 'zh';

      // Overview: the quota tab is listed with its count, and quota names link to the detail page.
      await page.evaluate(() => renderTab('overview'));
      const tab = page.locator('.pai-tabs a[href="#/pai/quotas"]');
      assert.equal(await tab.count(), 1);
      assert.equal(await tab.locator('.count').innerText(), '3');
      assert.equal(await page.locator('#paiQuotas a.pai-quota-link[href="#/pai/quota/q-a"]').count(), 1);
      assert.equal(await page.locator('#paiQuotas a[href="#/pai/quotas"]').count(), 1);
      assert.equal(await page.locator('#paiQuotas .pai-method').count(), 1);
      assert.equal(await page.locator('#paiQuotas .pai-chip', { hasText: zh ? '闲时共享关闭' : 'Idle sharing off' }).count(), 1);
      assert(await fits());

      // Quota tab: root card first, subquotas in the grid, derived counts and the per-node strip.
      await page.evaluate(() => renderTab('quotas'));
      assert.equal(await page.locator('.pai-tabs a.active[href="#/pai/quotas"]').count(), 1);
      const cards = page.locator('.pai-q-card');
      assert.equal(await cards.count(), 3);
      assert(await cards.first().evaluate((n) => n.classList.contains('root')));
      assert.equal(await page.locator('.pai-q-grid .pai-q-card').count(), 2);
      const alpha = page.locator('.pai-q-card[href="#/pai/quota/q-a"]');
      assert.match(await alpha.locator('.pai-q-cap').innerText(), /3\s*\/\s*8/);
      // alpha: root-train (parent) + a-dev (direct) run on its nodes, idle-job (direct, borrowing elsewhere); queued-job waits.
      const stats = await alpha.locator('.pai-q-stat b').allInnerTexts();
      assert.equal(stats[0].replace(/\s/g, ''), '2/2');
      assert.equal(stats[1], '3');
      assert.equal(stats[2], '3');
      assert.equal(await alpha.locator('.pai-q-strip-node').count(), 2);
      assert.equal(await alpha.locator('.pai-q-strip i').count(), 8);
      assert.equal(await alpha.locator('.pai-q-strip i.free').count(), 5);
      assert.match(await alpha.locator('.pai-q-flags').innerText(), zh ? /排队 1/ : /1 queued/);
      assert.match(await alpha.locator('.pai-q-flags').innerText(), zh ? /借入 2 卡/ : /Borrowing in 2/);
      const beta = page.locator('.pai-q-card[href="#/pai/quota/q-b"]');
      assert.match(await beta.locator('.pai-q-flags').innerText(), zh ? /借出 2 卡/ : /Lending out 2/);
      assert.equal(await page.locator('.pai-q-card.root .pai-q-strip-node').count(), 3);
      assert(await fits());

      // Detail: relations, week panel from the ranking API, bound nodes, filtered workloads and per-quota users.
      await page.evaluate(() => renderTab('quota', 'q-a'));
      assert.equal(await page.locator('.pai-tabs a.active[href="#/pai/quotas"]').count(), 1);
      assert.equal(await page.locator('.pai-q-detail h2').innerText(), 'alpha');
      assert.equal(await page.locator('.pai-q-detail a[href="#/pai/quota/q-root"]').count(), 1);
      assert.match(await page.locator('.pai-q-detail .pai-meta').innerText(), zh ? /本配额任务 1 · 子配额 0 · 父配额任务占用 2/ : /This quota 1 · subquotas 0 · parent-quota workloads 2/);
      assert.match(await page.locator('.pai-q-detail .pai-meta').innerText(), zh ? /8 张 · 本配额任务 1 · 父配额任务 2 · 借出 0 · 原配额空闲 5/ : /8 · this quota 1 · parent-quota 2 · lent out 0 · quota-idle 5/);
      assert.equal(await page.locator('#paiQuotaWeek .pai-rank-stat').count(), 4);
      assert.match(await page.locator('#paiQuotaWeek .pai-rank-stat').first().innerText(), /\b120\b/); // hrs() rounds values >= 100
      assert.match(await page.locator('#paiQuotaWeek .pai-rank-stat').nth(1).innerText(), /61\.2%/);
      assert.equal(await page.locator('.pai-node-grid .pai-node-tile').count(), 2);
      const seg = page.locator('.pai-panel').filter({ has: page.locator('.pai-wl-table') }).locator('.pai-seg button');
      assert.deepEqual((await seg.locator('.count').allInnerTexts()), ['4', '3', '1']); // all / submitted here (incl. queued + borrowing elsewhere) / parent-quota
      assert.equal(await page.locator('.pai-wl-table tbody tr').count(), 4);
      assert.equal(await page.locator('.pai-wl-table .pai-chip.rel-ancestor').count(), 1);
      await seg.nth(2).click();
      assert.equal(await page.locator('.pai-wl-table tbody tr').count(), 1);
      assert.match(await page.locator('.pai-wl-table tbody').innerText(), /root-train/);
      await seg.first().click();
      const users = page.locator('.pai-panel').filter({ has: page.locator('.pai-user-cell') }).locator('tbody tr');
      assert.equal(await users.count(), 3);
      assert.match(await users.filter({ hasText: 'bob' }).innerText(), zh ? /父配额任务/ : /Parent-quota job/);
      assert.match(await users.filter({ hasText: 'alice' }).innerText(), zh ? /排队 1/ : /1 queued/);
      assert(await fits());

      // The ranking call is cached for the detail page; a background refresh keeps the week panel and nodes.
      const calls = await page.evaluate(() => rankingCalls);
      await page.evaluate(() => { fixture.workloads[1].WorkloadName = 'a-dev-renamed'; return renderTab('quota', 'q-a', true); });
      assert.equal(await page.evaluate(() => rankingCalls), calls);
      assert.match(await page.locator('.pai-wl-table tbody').innerText(), /a-dev-renamed/);
      assert.equal(await page.locator('#paiQuotaWeek .pai-rank-stat').count(), 4);

      // Root quota uses its own ranking row; a failed ranking only degrades the week panel.
      await page.evaluate(() => renderTab('quota', 'q-root'));
      assert.equal(await page.locator('.pai-q-detail a[href^="#/pai/quota/q-"]').count(), 2);
      assert.match(await page.locator('#paiQuotaWeek').innerText(), /300/);
      assert.equal(await page.locator('.pai-node-grid .pai-node-tile').count(), 3);
      await page.evaluate(() => { PaiUI.ui.quota = 'all'; window.rankingFails = true; });
      await page.evaluate(() => { const live = document.querySelector('#paiQuotaWeek'); live.remove(); });
      assert.equal(await page.locator('#paiQuotaWeek').count(), 0);
      await page.evaluate(() => renderTab('quota', 'q-b'));
      assert.match(await page.locator('#paiQuotaWeek').innerText(), zh ? /排行读取失败|配额记账占用率/ : /Failed to load ranking|Quota-reported/);
      assert.equal(await page.locator('.pai-q-detail h2').innerText(), 'beta');
      assert.match(await page.locator('.pai-q-detail').innerText(), zh ? /借出 2 卡/ : /Lending out 2/);
      assert.equal(await page.locator('.pai-wl-table .pai-chip.rel-borrowed').count(), 1);
      await page.evaluate(() => renderTab('quota', 'missing'));
      assert.match(await page.locator('#view').innerText(), zh ? /配额未找到/ : /Quota not found/);
      assert(await fits());
      if (process.env.SHOT_DIR) {
        fs.mkdirSync(process.env.SHOT_DIR, { recursive: true });
        await page.evaluate(() => renderTab('quotas'));
        await page.screenshot({ path: path.join(process.env.SHOT_DIR, `quota-tab-${locale}-${width}.png`), fullPage: true });
      }
      assert.deepEqual(errors, []);
      console.log(`PASS ${locale} ${width}px: quota tab, cards, relations, week panel cache, detail filters, users, failures and overflow`);
      await page.close();
    }
  } finally { await browser.close(); }
})().catch((e) => { console.error(e); process.exitCode = 1; });
