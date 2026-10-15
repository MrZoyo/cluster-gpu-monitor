// Synthetic snapshots only. Native disclosure, keyboard access and background-refresh regression.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require('playwright');
const web = path.resolve(__dirname, '../web');

(async () => {
  const browser = await chromium.launch({headless:true,
    ...(process.env.CHROME_BIN ? {executablePath:process.env.CHROME_BIN} : {})});
  try {
    for (const locale of ['zh', 'en']) for (const width of [390, 1440]) {
      const page = await browser.newPage({viewport:{width,height:900}}), errors = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.setContent('<main id="view" class="pai-scope" style="max-width:1280px;margin:24px auto;padding:0 12px"></main>');
      await page.addStyleTag({path:path.join(web,'css/style.css')});
      await page.addScriptTag({path:path.join(web,'vendor/echarts.min.js')});
      await page.evaluate(locale => {
        window.locale = locale;
        window.I18n = {getLocale:()=>window.locale, t:k=>k};
      },locale);
      for (const file of ['refresh.js','components.js','pai.js']) await page.addScriptTag({path:path.join(web,'js',file)});
      await page.evaluate(() => {
        window.fixture = {now:20000,nodes:[],users:[],quotas:[],workloads:Array.from({length:27},(_,i)=>({
          WorkloadId:'queued-'+i, WorkloadName:i===0?'Example training with a long descriptive workload name':'Example training '+(i+1),
          WorkloadType:'dlc',WorkloadStatus:'Pending',UserName:'Example owner',scheduled:false,
          requested_gpu:8,enqueued_at:1000+i,metrics:[],cards:[],job:{oversold_type:'AcceptQuotaOverSold',specs:[]}
        }))};
        window.renderQueue = soft => {
          const next = document.createElement('main');next.id='view';next.className='pai-scope';
          next.style.cssText=document.querySelector('#view').style.cssText;
          if(soft) next.setAttribute('data-refresh-draft','');
          const banner=PaiUI.queueBanner(PaiUI.prepare(structuredClone(fixture)));
          if(banner) next.appendChild(banner);
          next.appendChild(UI.el('section',{class:'panel'},[UI.el('h3',{},[locale==='zh'?'物理卡热力':'Physical GPU heatmap']),
            UI.el('p',{},[locale==='zh'?'收起排队列表后，可直接查看监控内容。':'Monitor content stays visible while the queue is collapsed.'])]));
          const root=document.querySelector('#view');
          if(soft) LiveDOM.commit(root,next);else root.replaceChildren(...next.childNodes);
        };
        renderQueue(false);
      });
      const queue=page.locator('#paiQueue'),summary=queue.locator('summary');
      assert.equal(await queue.evaluate(n=>n.open),false);
      assert.match(await summary.innerText(),locale==='zh'?/排队中的任务 27 个/:/27 queued workloads/);
      assert.match(await queue.locator('.pai-queue-preview').textContent(),locale==='zh'?/另 25 个/:/25 more/);
      assert(await queue.locator('.pai-queue-preview-more').evaluate(n=>{
        const r=n.getBoundingClientRect(),p=n.parentElement.getBoundingClientRect();
        return Math.ceil(r.width)>=n.scrollWidth&&r.right<=p.right+1&&r.left>=p.left;
      }));
      assert.equal(await queue.locator('.pai-queue-item:visible').count(),0);
      assert((await queue.boundingBox()).height<150);
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
      if(process.env.SHOT_DIR) {
        fs.mkdirSync(process.env.SHOT_DIR,{recursive:true});
        await page.screenshot({path:path.join(process.env.SHOT_DIR,`queue-${locale}-${width}-closed.png`),fullPage:true});
      }
      await summary.focus();await page.keyboard.press('Enter');
      assert.equal(await queue.evaluate(n=>n.open),true);
      assert.equal(await queue.locator('.pai-queue-item').count(),27);
      assert((await queue.locator('.pai-queue-list').boundingBox()).height<=481);
      assert.match(await queue.locator('.pai-queue-scroll-hint').innerText(),locale==='zh'?/可滚动.*27 项/:/Scroll.*27 workloads/);
      await queue.locator('.pai-queue-list').evaluate(n=>n.scrollTop=n.scrollHeight);
      assert(await queue.locator('.pai-queue-list').evaluate(n=>{
        const r=n.getBoundingClientRect(),last=n.lastElementChild.getBoundingClientRect();
        return last.top>=r.top-1&&last.bottom<=r.bottom+1;
      }));
      await page.evaluate(()=>{window.savedQueue=document.querySelector('#paiQueue');window.savedItem=document.querySelector('.pai-queue-item');document.querySelector('.pai-queue-list').scrollTop=120;});
      await page.evaluate(()=>{
        fixture.workloads.push({...fixture.workloads[1],WorkloadId:'new-queued',WorkloadName:'New queued workload'});
        fixture.workloads[0].UserName='Updated owner';renderQueue(true);
      });
      assert(await queue.evaluate(n=>n===savedQueue&&n.open));
      assert(await page.evaluate(()=>savedItem===document.querySelector('.pai-queue-item')&&document.querySelector('.pai-queue-list').scrollTop===120));
      assert.equal(await queue.locator('.pai-queue-item').count(),28);
      assert.match(await summary.innerText(),locale==='zh'?/排队中的任务 28 个/:/28 queued workloads/);
      assert.match(await queue.locator('.pai-queue-item').first().textContent(),/Updated owner/);
      assert(await page.evaluate(()=>document.activeElement===document.querySelector('#paiQueue summary')));
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
      if(process.env.SHOT_DIR) {
        await queue.locator('.pai-queue-list').evaluate(n=>n.scrollTop=0);
        await page.screenshot({path:path.join(process.env.SHOT_DIR,`queue-${locale}-${width}-open.png`),fullPage:true});
      }
      await page.keyboard.press('Space');
      assert.equal(await queue.evaluate(n=>n.open),false);
      await page.evaluate(()=>renderQueue(true));
      assert.equal(await queue.evaluate(n=>n.open),false);
      await summary.click();
      await page.waitForTimeout(20); // native toggle stores disclosure state for full route renders
      await page.evaluate(()=>renderQueue(false));
      assert.equal(await queue.evaluate(n=>n.open),true);
      await summary.click();await page.waitForTimeout(20);
      await page.evaluate(()=>{fixture.workloads=[];renderQueue(true);});
      assert.equal(await queue.count(),0);
      await page.evaluate(()=>{
        fixture.workloads=[{WorkloadId:'only',WorkloadName:'Single queued workload',WorkloadType:'dlc',WorkloadStatus:'Pending',metrics:[],cards:[],job:{specs:[]}}];
        renderQueue(true);
      });
      assert.equal(await queue.evaluate(n=>n.open),false);
      assert.match(await summary.innerText(),locale==='zh'?/排队中的任务 1 个/:/1 queued workloads/);
      assert.deepEqual(errors,[]);
      console.log(`PASS ${locale} ${width}px: collapsed queue, counts, keyboard, scroll/focus/node retention, live update, route state and empty queue`);
      await page.close();
    }
  } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
