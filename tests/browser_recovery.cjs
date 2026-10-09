// Optional browser regression: NODE_PATH=<Playwright modules> node tests/browser_recovery.cjs
// CHROME_BIN selects an installed browser; SHOT_DIR optionally saves screenshots outside the repo.
// All API responses are synthetic. No cloud, credentials or running deployment is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');
const web = path.resolve(__dirname, '../web');
const now = Math.floor(Date.now() / 1000);
const metric = (key) => ({ series_id: key, pod: 'pod-example', gpu: '0', metric: key,
  value: 20, ts: now - 60, fresh: true, recent_mean: 20, recent_n: 8 });
const workload = { WorkloadId: 'job-example', WorkloadName: 'Example development', WorkloadType: 'dsw',
  WorkloadStatus: 'Running', UserId: 'user-example', UserName: 'Example user', QuotaId: 'quota-example',
  requested_gpu: 1, scheduled_gpu: 1, requested_cpu: 8, requested_mem_gib: 32, scheduled: true,
  oversold: false, cards: [{ node: 'node-example', index: 0 }], metrics: ['compute', 'memory', 'cpu', 'ram'].map(metric) };
const pai = { enabled: true, state: 'ok', now, region: 'example-region', workspace_id: 'workspace-example',
  quota_id: 'quota-example', poll_interval_s: 120, round: { finished_at: now },
  sources: [{ name: 'nodes', state: 'ok', fetched_at: now }],
  summary: { physical_gpus: 8, mapped_gpus: 1, measured_gpus: 1, compute_mean: 20 },
  quotas: [{ quota_id: 'quota-example', quota_name: 'Example quota', gpu_capacity: 8, gpu_used: 1 }],
  nodes: [{ NodeName: 'node-example', GPU: 8, GPUType: 'Example GPU', NodeStatus: 'Ready', RequestGPU: 1,
    mapping_state: 'ok', health_rate: 10000, cards: Array.from({ length: 8 }, (_, index) => ({ index,
      assignments: index ? [] : [{ workload_id: 'job-example', owner_id: 'user-example', owner_name: 'Example user', fresh: true }],
      compute: index ? null : { value: 20, sampled_at: now, recent: 20, recent_n: 8, fresh: true }, memory: null })) }],
  workloads: [workload, { ...workload, WorkloadId: 'job-queued', WorkloadName: 'Example queued training',
    WorkloadType: 'dlc', WorkloadStatus: 'Pending', scheduled: false, requested_gpu: 16, scheduled_gpu: 0,
    cards: [], metrics: [], enqueued_at: now - 4000,
    job: { oversold_type: 'ForbiddenQuotaOverSold', specs: [{ type: 'Worker', pods: 2, gpu: 8, cpu: 32, mem_gib: 128 }] } }],
  users: [{ UserId: 'user-example', Username: 'Example user', used_gpu: 1, submitted_gpu: 17, running_workloads: 1 }] };
const fixtures = {
  '/api/meta': { windows: ['1h', '24h', '7d'], capacity_groups: [], poll_interval_s: 30 },
  '/api/overview': { now, summary: { window: '24h', cards_total: 0, cards_busy: 0, hosts_online: 0, hosts_total: 0 }, clusters: [] },
  '/api/metrics/avg_multi': { windows: ['1h', '24h', '7d'], items: [] },
  '/api/topology': { clusters: [] }, '/api/users/ranking': { users: [] },
  '/api/collector/status': { hosts: [] }, '/api/health': { last_sample_ts: now, last_sample_age_s: 0 },
  '/api/pai/status': { enabled: true, state: 'ok' }, '/api/pai/overview': pai,
  '/api/pai/ranking': { users: [], since: now - 3600, first_hour: null },
  '/api/pai/metrics/series': { points: ['compute', 'memory', 'cpu', 'ram'].flatMap(key =>
    [1, 2, 3].map(i => ({ ...metric(key), ts: now - i * 120, mean: 20 }))) },
};
let enabled = false;
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname.startsWith('/api/')) {
    const value = pathname.startsWith('/api/pai/') && !enabled ? undefined : fixtures[pathname];
    res.writeHead(value === undefined ? 404 : 200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(JSON.stringify(value === undefined ? { detail: 'Not Found' } : value));
  }
  const file = path.resolve(web, '.' + (pathname === '/' ? '/index.html' : pathname));
  if (!file.startsWith(web + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404); return res.end();
  }
  const type = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml' }[path.extname(file)];
  res.writeHead(200, { 'content-type': type || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(file).pipe(res);
});

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/`;
  let browser;
  const checks = [];
  const check = (name, ok) => { assert.ok(ok, name); checks.push(name); };
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}) });
    async function pageFor(platform = 'Win32', locale = 'zh', width = 1440) {
      const page = await browser.newPage({ viewport: { width, height: 960 } });
      await page.addInitScript(({ platform, locale }) => {
        Object.defineProperty(navigator, 'platform', { get: () => platform });
        Object.defineProperty(navigator, 'userAgentData', { get: () => undefined });
        localStorage.setItem('gpumon.locale', locale);
      }, { platform, locale });
      return page;
    }
    async function shot(page, name) {
      if (!process.env.SHOT_DIR) return;
      fs.mkdirSync(process.env.SHOT_DIR, { recursive: true });
      await page.screenshot({ path: path.join(process.env.SHOT_DIR, name + '.png'), fullPage: true });
    }
    async function notice(page, shortcut) {
      await page.locator('#page-recovery').waitFor();
      check('recovery: ' + shortcut, (await page.locator('#page-recovery').innerText()).includes(shortcut));
      check('one accessible alert', await page.locator('#page-recovery[role="alert"]').count() === 1);
    }
    const normal = await pageFor(); const errors = [];
    normal.on('pageerror', e => errors.push(e.message));
    await normal.goto(base); await normal.getByRole('heading', { name: '算力监控总览' }).waitFor();
    check('PAI disabled: no navigation or text', await normal.locator('#moduleNav').isHidden() && !(await normal.locator('body').innerText()).includes('PAI'));
    await normal.evaluate(() => GM.go('/pai/workloads'));
    await normal.waitForFunction(() => location.hash === '#/');
    check('PAI disabled: route redirects', await normal.locator('.pai-scope').count() === 0);
    check('ordinary optional 404 has no recovery alert', await normal.locator('#page-recovery').count() === 0);
    enabled = true;
    await normal.goto(base); await normal.locator('.home-stats').first().waitFor();
    check('PAI enabled: two entry cards', await normal.locator('a.home-card').count() === 2);
    for (const route of ['overview', 'nodes', 'workloads', 'users', 'user/user-example', 'node/node-example', 'workload/job-example', 'ranking']) {
      await normal.evaluate(async route => { history.replaceState(null, '', '#/pai/' + route); await GM.render(); }, route);
      await normal.locator('.pai-tabs').waitFor();
      await normal.waitForFunction(() => !document.querySelector('#view').textContent.includes('读取中…'));
      check('PAI page ' + route, await normal.locator('#page-recovery').count() === 0);
      if (route === 'workloads') {
        await normal.locator('.pai-search').fill('Example development');
        await normal.evaluate(() => GM.render({ soft: true }));
        check('filter survives refresh', await normal.locator('.pai-search').inputValue() === 'Example development');
      }
      if (route === 'workload/job-example') check('metric charts', await normal.locator('.pai-chart canvas').count() === 3);
      if (route === 'overview') await shot(normal, 'pai-overview');
    }
    check('normal pages: no uncaught errors', errors.length === 0);
    await normal.close(); enabled = false;

    for (const [platform, shortcut, width, locale] of [['Win32', 'Ctrl+Shift+R', 1440, 'zh'], ['MacIntel', 'Command+Shift+R', 1440, 'zh'], ['Linux', 'Ctrl+Shift+R', 390, 'en']]) {
      const page = await pageFor(platform, locale, width);
      await page.route('**/api/overview?*', r => r.fulfill({ json: { obsolete_schema: true } }));
      await page.goto(base); await notice(page, shortcut);
      const bounds = await page.locator('#page-recovery').boundingBox();
      check('notice fits viewport', bounds.x >= 0 && bounds.x + bounds.width <= width);
      check('administrator guidance', /管理员|administrator/.test(await page.locator('#page-recovery').innerText()));
      await shot(page, 'recovery-' + platform); await page.close();
    }
    for (const mode of ['init-schema', 'script', 'json', 'http', 'offline', 'async', 'sync', 'bad-route', 'pai-ranking']) {
      enabled = mode === 'pai-ranking';
      const page = await pageFor();
      if (mode === 'init-schema') await page.route('**/api/meta', r => r.fulfill({ json: { windows: null } }));
      if (mode === 'script') await page.route('**/js/app.js', r => r.abort());
      if (mode === 'json') await page.route('**/api/overview?*', r => r.fulfill({ contentType: 'application/json', body: '{broken' }));
      if (mode === 'http') await page.route('**/api/overview?*', r => r.fulfill({ status: 500, body: 'private backend error' }));
      if (mode === 'offline') await page.route('**/api/overview?*', r => r.abort());
      if (mode === 'pai-ranking') await page.route('**/api/pai/ranking?*', r => r.fulfill({ status: 503, body: 'unavailable' }));
      await page.goto(base + (enabled ? '#/pai/ranking' : ''));
      if (['async', 'sync', 'bad-route'].includes(mode)) {
        await page.getByRole('heading', { name: '算力监控总览' }).waitFor();
        await page.evaluate(mode => {
          if (mode === 'async') setTimeout(() => Promise.reject(new Error('private async error')), 0);
          if (mode === 'sync') setTimeout(() => { throw new Error('private sync error'); }, 0);
          if (mode === 'bad-route') location.hash = '#/cluster/%';
        }, mode);
      }
      await notice(page, 'Ctrl+Shift+R');
      check(mode + ': no raw error text', !(await page.locator('#page-recovery').innerText()).includes('private'));
      await page.close();
    }
    console.log(JSON.stringify({ passed: checks.length, checks }, null, 2));
  } finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
