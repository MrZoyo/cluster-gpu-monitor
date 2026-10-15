// Synthetic UI fixtures only. No production or cloud access.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require('playwright');
const web=path.resolve(__dirname,'../web');

(async()=>{
  const browser=await chromium.launch({headless:true,...(process.env.CHROME_BIN?{executablePath:process.env.CHROME_BIN}:{})});
  try {
    for(const locale of ['zh','en']) for(const width of [390,1440]) {
      const page=await browser.newPage({viewport:{width,height:1000}}),errors=[];
      page.on('pageerror',e=>errors.push(e.message));
      await page.setContent('<main id="view" style="max-width:1400px;margin:20px auto;padding:0 12px"></main>');
      await page.addStyleTag({path:path.join(web,'css/style.css')});
      await page.addScriptTag({path:path.join(web,'vendor/echarts.min.js')});
      await page.evaluate(locale=>{
        window.locale=locale;window.I18n={getLocale:()=>locale,t:key=>key};
        window.GM={crumb(){},setSourceHealth(){},state:{window:'24h'}};
      },locale);
      for(const file of ['refresh.js','components.js','pai-estimate.js','pai.js'])await page.addScriptTag({path:path.join(web,'js',file)});
      await page.evaluate(()=>{
        const makeWorkload=(id,status,count)=>({WorkloadId:id,WorkloadName:id==='saving'?'Checkpoint example':'Training example',
          WorkloadType:'dlc',WorkloadStatus:status,UserId:'owner',UserName:'Example owner',scheduled:true,
          requested_gpu:count,scheduled_gpu:count,cards:[],metrics:[],job:{specs:[]}});
        const saving=makeWorkload('saving','Saving',8),running=makeWorkload('training','Running',12);
        running.metrics=Array.from({length:10},(_,i)=>({metric:'compute',gpu:String(i),pod:'worker',fresh:true,value:25}));
        const nodes=Array.from({length:16},(_,n)=>({NodeName:'example-node-'+String(n).padStart(2,'0'),NodeStatus:'Ready',
          GPU:8,AllocatableGPU:8,RequestGPU:n===0?8:n===1?8:n===2?4:0,mapping_state:'ok',free_known:true,
          cards:Array.from({length:8},(_,index)=>{
            const workload=n===0?saving:n===1||n===2&&index<4?running:null;
            if(workload)workload.cards.push({node:'example-node-'+String(n).padStart(2,'0'),index});
            return {index,assignments:workload?[{workload_id:workload.WorkloadId,owner_name:'Example owner',owner_id:'owner',fresh:true}]:[],compute:null,memory:null};
          })}));
        window.original={nodes,workloads:[saving,running],users:[],quotas:[],state:'ok',now:20000,round:{finished_at:20000},
          sources:[{name:'nodes',state:'ok'},{name:'workloads',state:'ok'}],
          summary:{physical_gpus:128,mapped_gpus:20,pool_scheduled_gpus:12,task_compute_mean:25,pool_compute_estimate:null}};
        window.fixture=structuredClone(original);
        window.API={paiOverview:async()=>structuredClone(fixture),overview:async()=>({summary:{},clusters:[]})};
        window.renderEstimate=async(mode,soft=false)=>{
          window.currentMode=mode;
          const root=document.querySelector('#view');let next=root,wrapper;
          if(soft){wrapper=document.createElement('div');wrapper.setAttribute('data-refresh-draft','');wrapper.style.cssText='position:absolute;left:-10000px;visibility:hidden';next=root.cloneNode(false);wrapper.append(next);document.body.append(wrapper);}
          else root.replaceChildren();
          if(mode==='home')await Views.home.render(next);else await Views.pai.render(next,{tab:mode});
          if(soft){LiveDOM.commit(root,next);wrapper.remove();}
        };
      });
      for(const mode of ['home','overview','nodes']) {
        await page.evaluate(mode=>renderEstimate(mode),mode);
        const metric=page.locator('.pai-estimate'),button=metric.locator('.pai-estimate-info'),tip=metric.locator('[popover]');
        assert.equal(await metric.count(),1);
        assert.equal(await metric.locator('.pai-estimate-value').innerText(),locale==='zh'?'暂无法估算':'Unavailable');
        assert.match(await metric.locator('.pai-estimate-reasons').innerText(),locale==='zh'?/8 张卡保存中/:/8 GPUs saving/);
        assert.match(await metric.locator('.pai-estimate-reasons').innerText(),locale==='zh'?/2 张卡缺指标/:/2 GPUs missing metrics/);
        assert.equal(await tip.isVisible(),false);
        assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
        await metric.scrollIntoViewIfNeeded();
        if(process.env.SHOT_DIR){fs.mkdirSync(process.env.SHOT_DIR,{recursive:true});await page.screenshot({path:path.join(process.env.SHOT_DIR,`estimate-${locale}-${width}-${mode}-closed.png`)});}
        await button.hover();assert.equal(await tip.isVisible(),true);
        assert.match(await tip.innerText(),/Checkpoint example/);
        assert(await tip.evaluate(n=>{const r=n.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1&&r.top>=0&&r.bottom<=innerHeight+1;}));
        if(process.env.SHOT_DIR)await page.screenshot({path:path.join(process.env.SHOT_DIR,`estimate-${locale}-${width}-${mode}-open.png`)});
        await page.mouse.move(0,0);await page.waitForTimeout(140);assert.equal(await tip.isVisible(),false);
        await button.focus();assert.equal(await tip.isVisible(),true);
        await page.keyboard.press('Escape');assert.equal(await tip.isVisible(),false);
        await button.click();assert.equal(await tip.isVisible(),true);
        assert.equal(await page.evaluate(()=>location.hash),''); // Details never follows the home card link.
        await page.mouse.move(0,0);await page.waitForTimeout(140);assert.equal(await tip.isVisible(),true);
        await page.evaluate(()=>{window.savedTip=document.querySelector('.pai-estimate-tip');window.savedButton=document.querySelector('.pai-estimate-info');
          fixture.workloads[0].WorkloadStatus='Stopping';fixture.workloads[0].WorkloadName='Updated checkpoint';return renderEstimate(currentMode,true);});
        assert(await tip.evaluate(n=>n===savedTip&&n.matches(':popover-open')));
        assert(await button.evaluate(n=>n===savedButton));
        assert(await tip.evaluate(n=>{
          const r=n.getBoundingClientRect(),b=savedButton.getBoundingClientRect();
          return r.left>=0&&r.right<=innerWidth+1&&r.top>=0&&r.bottom<=innerHeight+1&&(r.top>=b.bottom||r.bottom<=b.top);
        }));
        assert.match(await metric.locator('.pai-estimate-reasons').innerText(),locale==='zh'?/8 张卡停止中/:/8 GPUs stopping/);
        assert.match(await tip.innerText(),/Updated checkpoint/);
        await button.click();assert.equal(await tip.isVisible(),false);
        await page.evaluate(()=>{fixture=structuredClone(original);});
      }
      for(const value of [0,14.0625]) {
        await page.evaluate(async value=>{
          fixture=structuredClone(original);fixture.summary.pool_compute_estimate=value;fixture.summary.task_compute_mean=value?90:0;
          fixture.workloads.forEach(w=>{w.WorkloadStatus='Running';w.metrics=Array.from({length:w.scheduled_gpu},(_,i)=>({metric:'compute',gpu:String(i),pod:'worker',fresh:true,value:value?90:0}));});
          await renderEstimate('overview');
        },value);
        assert.equal(await page.locator('.pai-estimate-value').textContent(),Math.round(value)+'%');
        assert.match(await page.locator('.pai-estimate-summary').innerText(),locale==='zh'?/按 128 张物理卡折算/:/Across 128 physical GPUs/);
        assert.equal(await page.locator('.pai-estimate-reasons').count(),0);
        await page.locator('.pai-estimate').scrollIntoViewIfNeeded();
        if(process.env.SHOT_DIR)await page.screenshot({path:path.join(process.env.SHOT_DIR,`estimate-${locale}-${width}-normal-${value?'value':'zero'}.png`)});
      }
      await page.evaluate(async()=>{fixture=structuredClone(original);fixture.nodes[0].cards.forEach(c=>c.assignments.forEach(a=>a.fresh=false));await renderEstimate('overview');});
      assert.match(await page.locator('.pai-estimate-reasons').innerText(),locale==='zh'?/8 张卡状态待确认/:/8 GPUs awaiting confirmation/);
      assert.doesNotMatch(await page.locator('.pai-estimate-reasons').innerText(),locale==='zh'?/保存中/:/saving/);
      await page.evaluate(async()=>{
        fixture=structuredClone(original);fixture.workloads.push({...fixture.workloads[0],WorkloadId:'stopping',WorkloadStatus:'Stopping'});
        fixture.nodes[0].cards.forEach(c=>c.assignments.push({...c.assignments[0],workload_id:'stopping'}));await renderEstimate('overview');
      });
      assert.match(await page.locator('.pai-estimate-reasons').innerText(),locale==='zh'?/8 张卡占用状态待确认/:/8 GPUs with unconfirmed allocation state/);
      assert.doesNotMatch(await page.locator('.pai-estimate-reasons').innerText(),/16/);
      await page.evaluate(async()=>{
        fixture=structuredClone(original);fixture.nodes[3].mapping_conflict=true;
        fixture.nodes[4].cards[0].assignments=[{workload_id:'unlisted',fresh:true}];await renderEstimate('overview');
      });
      assert.match(await page.locator('.pai-estimate-more').innerText(),locale==='zh'?/另 2 项/:/2 more/);
      await page.locator('.pai-estimate-info').click();
      assert.equal(await page.locator('.pai-estimate-detail-reasons li').count(),4);
      await page.keyboard.press('Escape');
      await page.evaluate(()=>renderEstimate('home'));
      await page.locator('.home-card.pai-scope .home-main-link').focus();await page.keyboard.press('Enter');
      assert.equal(await page.evaluate(()=>location.hash),'#/pai');
      assert.deepEqual(errors,[]);
      console.log(`PASS ${locale} ${width}px: exact Saving/missing counts, all three views, hover/focus/click/Escape, preserved fresh tooltip, zero, stale mapping, overflow and home keyboard navigation`);
      await page.close();
    }
    const touch=await browser.newContext({viewport:{width:390,height:800},hasTouch:true,isMobile:true});
    const page=await touch.newPage();
    await page.setContent('<main class="pai-scope"></main>');await page.addStyleTag({path:path.join(web,'css/style.css')});
    await page.evaluate(()=>{window.I18n={getLocale:()=> 'zh'};});
    for(const file of ['components.js','pai-estimate.js','pai.js'])await page.addScriptTag({path:path.join(web,'js',file)});
    await page.evaluate(()=>{document.querySelector('main').append(PaiUI.estimateMetric({summary:{physical_gpus:128,pool_compute_estimate:25},estimateInfo:{available:true,reasons:[]}},'home'));});
    await page.locator('.pai-estimate-info').tap();assert.equal(await page.locator('[popover]').isVisible(),true);
    await page.locator('.pai-estimate-info').tap();assert.equal(await page.locator('[popover]').isVisible(),false);
    await touch.close();console.log('PASS touch: tap toggles estimate details');
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
