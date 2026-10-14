// NODE_PATH=<Playwright modules> CHROME_BIN=<browser> node tests/browser_pai_attribution.cjs
// Synthetic data only. Verifies ranking, deduplicated totals, CSV and degraded states.
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const fixtures = JSON.parse(execFileSync(process.env.PYTHON || path.join(root, '.venv/bin/python'), ['-c',
  'import json,runpy; print(json.dumps(runpy.run_path("scripts/pai_demo.py")["fixtures"](1791720000, {"24h":86400})))'], { cwd: root }));
(async () => {
  const browser = await chromium.launch({ headless: true,
    ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}) });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.setContent('<main class="pai-scope"></main>');
    await page.addStyleTag({path:path.join(root,'web/css/style.css')});
    await page.evaluate(data => {
      window.fixture = data['pai_ranking.week.json'];
      window.originalFixture = structuredClone(window.fixture);
      window.emptyFixture = data['pai_ranking.last_week.json'];
      window.locale = 'zh';
      window.I18n = {getLocale:()=>window.locale,t:k=>k};
      window.GM = {state:{meta:{windows:['24h']}},render: async()=>{
        const host = document.querySelector('main'); host.replaceChildren(); await PaiUI.rankingPanel(host);
      }};
      window.API = {paiRanking:async()=>window.fixture};
      URL.createObjectURL = blob => {window.csvPromise=blob.text();return 'blob:test';};
      document.addEventListener('click',e=>{if(e.target.closest('a[download]'))e.preventDefault();});
    }, fixtures);
    for (const name of ['components.js','pai.js']) await page.addScriptTag({path:path.join(root,'web/js',name)});
    for (const locale of ['zh','en']) for (const width of [320,390,760,1024,1180,1440]) {
      await page.setViewportSize({width,height:1000});
      await page.evaluate(async locale=>{window.locale=locale;window.fixture=structuredClone(window.originalFixture);await GM.render();},locale);
      const table=page.locator('.pai-rank-table.feature');
      assert.equal(await table.count(),1);
      const ranked=table.locator('tbody.ranked'), unranked=table.locator('tbody.unranked');
      assert.equal(await ranked.locator('tr.root').count(),0);
      assert.deepEqual(await ranked.locator('.c-rank .pai-rank-no').allTextContents(),['1','2']);
      assert.equal(await unranked.locator('tr.root').count(),1);
      assert.equal(await unranked.locator('.pai-rank-no').count(),0);
      assert.match(await unranked.locator('tr.group').textContent(),locale==='zh'?/不参与排名/:/unranked/);
      assert.equal(await page.locator('.pai-rank-method').evaluate(n=>n.open),false);
      assert.equal(await page.locator('.pai-rank-attr').isVisible(),false);
      assert.equal(await page.locator('.pai-rank-warning').count(),0);
      assert.equal(await page.locator('.pai-rank-row-details[open]').count(),0);
      assert.equal(await ranked.locator('.pai-rank-src').first().isVisible(),false);
      assert.equal(await unranked.locator('.pai-rank-unattributed').isVisible(),true);
      const firstRow = ranked.locator('tr').first();
      const toggle = firstRow.locator('.pai-feature-toggle');
      assert.equal(await firstRow.getByText(locale === 'zh' ? '用量详情' : 'Usage details', {exact:true}).isVisible(), false);
      await toggle.focus(); await page.keyboard.press('Enter');
      assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
      await firstRow.locator('.pai-rank-detail-body').click();
      assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
      await page.keyboard.press('Tab');
      await toggle.focus(); await page.keyboard.press('Space');
      assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
      await firstRow.locator('.c-usage').click();
      assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
      await toggle.click();
      assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
      // Selecting a value must not expand the row.
      await firstRow.locator('.c-name b').evaluate(n => {const r=document.createRange();r.selectNodeContents(n);getSelection().removeAllRanges();getSelection().addRange(r);n.click();});
      assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
      await page.evaluate(()=>getSelection().removeAllRanges());
      // Visible splits close: direct + attributed = feature total; attributed + unattributed = root total.
      for (const row of [...await ranked.locator('tr').all(),unranked.locator('tr.root')]) {
        const detail=row.locator('.pai-rank-row-details');
        await row.locator('.c-jobs').click();
        assert.equal(await detail.evaluate(n=>n.open),true);
        assert.equal(await row.locator('.pai-rank-src').isVisible(),true);
        const n=s=>Number(s.replaceAll(',',''));
        const total=n(await row.locator('.pai-rank-usage-top b').textContent());
        const parts=(await row.locator('.pai-rank-src b').allTextContents()).map(n);
        assert.equal(parts.length,2); assert.equal(parts[0]+parts[1],total);
      }
      const attributed=ranked.locator('tr').filter({has:page.locator('.pai-rank-src .via b:not(:text-is("0"))')});
      assert.equal(await attributed.count(),1);
      assert.match(await attributed.locator('.pai-rank-src').textContent(),locale==='zh'?/直接提交.*归入/:/Direct.*From/);
      const attr=page.locator('.pai-rank-attr');
      assert.equal(await attr.evaluate(n=>n.classList.contains('info')),true);
      assert.match(await attr.textContent(),locale==='zh'?/历史窗口同样按当前角色重算/:/recalculated with current roles/);
      await page.locator('.pai-rank-method > summary').focus();
      await page.keyboard.press('Enter');
      assert.equal(await attr.isVisible(),true);
      assert.match(await attr.innerText(),locale==='zh'?/成员归属更新时间.*北京时间/:/Member attribution updated.*Asia\/Shanghai/);
      await page.evaluate(()=>GM.render());
      assert.equal(await page.locator('.pai-rank-method').evaluate(n=>n.open),true);
      assert.equal(await page.locator('.pai-rank-row-details[open]').count(),3);
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
      if(process.env.SHOT_DIR && [390,1440].includes(width)){
        require('node:fs').mkdirSync(process.env.SHOT_DIR,{recursive:true});
        await page.screenshot({path:path.join(process.env.SHOT_DIR,`details-${locale}-${width}-open.png`),fullPage:true});
      }
      await page.locator('.pai-rank-method > summary').click();
      while (await page.locator('.pai-rank-row-details[open]').count()) await page.locator('.pai-feature-toggle[aria-expanded="true"]').first().click();
      if(process.env.SHOT_DIR && [390,1440].includes(width)) await page.screenshot({path:path.join(process.env.SHOT_DIR,`details-${locale}-${width}-closed.png`),fullPage:true});
      // 72 observed hours * 20 GPUs = 1440, not 2016 (which would add root twice).
      const total=await page.locator('.pai-rank-stat.total b').textContent();
      assert.equal(Number(total.replaceAll(',','')),windowTotal(fixtures));
      await page.getByRole('button',{name:locale==='zh'?'导出 CSV':'Export CSV',exact:true}).click();
      const csv=await page.evaluate(()=>window.csvPromise);
      const lines=csv.trim().split('\r\n').map(l=>l.slice(1,-1).split('\",\"'));
      const header=lines.shift();
      const rows=lines.map(values=>Object.fromEntries(header.map((key,i)=>[key,values[i]])));
      assert.equal(rows.length,3);
      const rootRow=rows.find(r=>r.is_root==='true');
      assert.equal(rootRow.rank,'');
      assert.equal(rootRow.feature_attribution_basis,'current_workspace_roles');
      assert.equal(Number(rootRow.total_gpu_hours),windowTotal(fixtures));
      assert.equal(Number(rootRow.root_attributed_gpu_hours),Number(rootRow.gpu_hours));
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
      console.log(`PASS ${locale} ${width}px: root unranked, feature rank, totals, attribution and CSV`);
    }
    await page.evaluate(async()=>{
      window.locale='zh';window.fixture=structuredClone(window.originalFixture);
      fixture.quota_coverage_basis='window_excluding_known_absence';
      const feature=fixture.features[0];
      feature.expected_quota_hours=feature.observed_quota_hours;
      feature.absent_quota_hours=42.72;feature.quota_coverage_pct=100;
      await GM.render();
    });
    const coveredRow=page.locator('.pai-rank-table.feature tbody.ranked tr').first();
    await coveredRow.locator('.pai-feature-toggle').click();
    assert.match(await coveredRow.textContent(),/应观测时长.*已排除不存在时长/);
    assert.match(await coveredRow.textContent(),/42.7/);
    assert.doesNotMatch(await coveredRow.locator('.c-metric').first().textContent(),/仅覆盖/);
    await page.getByRole('button',{name:'导出 CSV',exact:true}).click();
    const coverageCsv=await page.evaluate(()=>window.csvPromise);
    for(const field of ['expected_quota_hours','absent_quota_hours','quota_coverage_basis','window_excluding_known_absence']) assert(coverageCsv.includes(field));
    console.log('PASS excluded absence: disclosure, coverage hint and CSV');
    await coveredRow.locator('.pai-feature-toggle').click();
    await page.evaluate(async()=>{window.locale='zh';window.fixture=structuredClone(window.originalFixture);fixture.feature_attribution.fresh=false;fixture.feature_attribution.state='error';await GM.render();});
    assert.equal(await page.locator('.pai-rank-warning').isVisible(),true);
    assert.equal(await page.locator('.pai-rank-attr.warn').isVisible(),false);
    await page.getByRole('button',{name:'查看详情',exact:true}).click();
    assert.equal(await page.locator('.pai-rank-attr.warn').isVisible(),true);
    assert.match(await page.locator('.pai-rank-attr.warn').textContent(),/成员角色读取失败.*暂不归入 Feature.*历史窗口同样按当前角色重算/);
    assert.equal(await page.locator('.pai-rank-attr.info').count(),0);
    assert.equal(await page.locator('.pai-rank-degraded').count(),1);
    assert.match(await page.locator('.pai-rank-legend .sort.warn').textContent(),/临时排序/);
    assert.equal(await page.locator('.pai-rank-no.top').count(),0);
    // Attribution not run: show unknown, never a computed zero.
    assert.deepEqual(await page.locator('.pai-rank-table.feature .pai-rank-src .via b').allTextContents(),['—','—','—']);
    await page.locator('.pai-rank-method > summary').click();
    for (const state of ['stale','unknown']) {
      await page.evaluate(async state=>{fixture.feature_attribution.state=state;await GM.render();},state);
      assert.equal(await page.locator('.pai-rank-warning').isVisible(),true);
      assert.equal(await page.locator('.pai-rank-method').evaluate(n=>n.open),false);
    }
    await page.getByRole('button',{name:'用户',exact:true}).click();
    assert.equal(await page.locator('.pai-rank-table.feature').count(),0);
    assert.equal(await page.locator('.pai-rank-table.user').count(),1);
    await page.getByRole('button',{name:'Feature',exact:true}).click();
    await page.evaluate(async()=>{window.fixture=structuredClone(window.emptyFixture);await GM.render();});
    assert.equal(await page.locator('.pai-rank-stat.total b').textContent(),'—');
    assert.deepEqual(await page.locator('.pai-rank-table.feature tbody.ranked .pai-rank-no').allTextContents(),['—','—']);
    assert.equal(await page.locator('.pai-rank-table.feature tbody.unranked .c-usage').textContent(),'—');
    assert.deepEqual(errors,[]);
    console.log('PASS unavailable membership, user toggle, empty history, no script errors');
  } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
function windowTotal(data){return data['pai_ranking.week.json'].totals.gpu_hours;}
