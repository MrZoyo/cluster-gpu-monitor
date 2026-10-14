// Real app/DOM/ECharts; synthetic responses only. No GPU or cloud calls.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {chromium} = require('playwright');
const root = path.resolve(__dirname,'..');
const fixture = JSON.parse(execFileSync(process.env.PYTHON || path.join(root,'.venv/bin/python'),['-c',
 'import json,runpy; print(json.dumps(runpy.run_path("scripts/pai_demo.py")["fixtures"](1792015200,{"24h":86400})))'],{cwd:root}));
const loaded='a'.repeat(64);
(async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.CHROME_BIN?{executablePath:process.env.CHROME_BIN}:{})});
 try {
  const page=await browser.newPage({viewport:{width:Number(process.env.WIDTH || 390),height:700}});const errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  let data=structuredClone(fixture),failure='',version=loaded,gate=null,requests=0;
  let overview={now:1792015200,summary:{window:'24h',cards_expected:1,cards_total:1,cards_busy:1,hosts_online:1,hosts_total:1},
   capacity_groups:[{key:'test',name:'Test',palette:'lime'}],clusters:[{id:1,key:'test',name:'Test',status:'active',capacity_group:'test',hosts:[{
    key:'host',display_name:'Host',status:'active',online:true,gpu_count:1,gpus:[{gpu_id:1,index:0,util_recent:10,util_avg:10}]}]}]};
  await page.addInitScript(()=>{const timer=window.setTimeout;window.setTimeout=(fn,ms,...rest)=>{if(ms===120000||ms===30000)window.refreshTick=fn;return timer(fn,ms,...rest);};});
  await page.route('**/*',async route=>{
   const u=new URL(route.request().url());let p=u.pathname;
   if(p.startsWith('/api/')){
    requests++;
    if(gate&&p===gate.path){const g=gate;g.enter();await g.promise;}
    if(p===failure)return route.fulfill({status:503,body:'unavailable'});
    let body;
    if(p==='/api/frontend-release')body={protocol:1,version,backend:'c'.repeat(64)};
    else if(p==='/api/meta')body={windows:['24h'],capacity_groups:overview.capacity_groups,poll_interval_s:30};
    else if(p==='/api/pai/status')body=data['pai_status.json'];
    else if(p==='/api/pai/overview')body=data['pai_overview.json'];
    else if(p==='/api/pai/ranking')body=data['pai_ranking.'+u.searchParams.get('window')+'.json'];
    else if(p==='/api/pai/metrics/series')body=data['pai_series.'+u.searchParams.get('workload_id')+'.json'];
    else if(p==='/api/overview')body=overview;
    else if(p==='/api/metrics/avg_multi')body={windows:{'24h':[{host:'host',avg:10,coverage:1}]}};
    else if(p==='/api/collector/status')body={hosts:[]};
    else if(p==='/api/health')body={last_sample_age_s:0,last_sample_ts:1792015200};
    else return route.fulfill({status:404,body:'unknown fixture endpoint'});
    return route.fulfill({contentType:'application/json',body:JSON.stringify(body)});
   }
   p=p.replace(/^\/_frontend\/[a-f0-9]{64}/,'');
   const file=path.join(root,'web',p==='/'?'index.html':p);
   if(!fs.existsSync(file))return route.fulfill({status:404,body:''});
   const type=p.endsWith('.js')?'application/javascript':p.endsWith('.css')?'text/css':p.endsWith('.svg')?'image/svg+xml':'text/html';
   let body=fs.readFileSync(file);
   if(p==='/')body=body.toString().replace(/((?:src|href)=["'])(?:\.\/|\/)?(js\/|css\/|icons\/|vendor\/)/g,`$1/_frontend/${loaded}/$2`);
   return route.fulfill({contentType:type,body});
  });
  const refresh=()=>page.evaluate(()=>GM.render({soft:true}));
  const pause=async endpoint=>{
   let enter,release;const entered=new Promise(r=>enter=r),promise=new Promise(r=>release=r);
   gate={path:endpoint,enter,promise};await page.evaluate(()=>{window.refreshing=GM.render({soft:true});});await entered;
   return async()=>{gate=null;release();await page.evaluate(()=>window.refreshing);};
  };
  await page.goto('http://monitor.test/#/pai/ranking');
  await page.waitForSelector('.pai-feature-toggle');
  await page.locator('.pai-feature-toggle').first().click();
  await page.evaluate(()=>{window.savedRoot=document.querySelector('#view').firstElementChild;window.savedRow=document.querySelector('tr[data-refresh-key="demo-train"]');window.savedCell=savedRow.querySelector('.c-usage');window.scrollTo(0,300);window.savedY=scrollY;});
  const release=await pause('/api/pai/ranking');
  assert(await page.evaluate(()=>document.querySelector('#view').firstElementChild===savedRoot&&savedRow.isConnected&&savedRow.querySelector('details').open));
  const ranked=data['pai_ranking.week.json'];ranked.features[0].gpu_hours+=20;ranked.totals.gpu_hours+=20;
  ranked.features.reverse();ranked.features.forEach((f,i)=>f.rank=i+1);
  ranked.features.push({...ranked.features[0],quota_id:'new-feature',quota_name:'New feature',rank:3});
  await release();
  assert(await page.evaluate(()=>document.querySelector('#view').firstElementChild===savedRoot&&savedRow===document.querySelector('tr[data-refresh-key="demo-train"]')&&savedCell===savedRow.querySelector('.c-usage')&&savedRow.querySelector('details').open&&Math.abs(scrollY-savedY)<2));
  assert.equal(await page.locator('tbody.ranked > tr').count(),3);
  assert.equal(Number((await page.locator('tr[data-refresh-key="demo-train"] .pai-rank-usage-top b').textContent()).replaceAll(',','')),
    Math.round(ranked.features.find(f=>f.quota_id==='demo-train').gpu_hours));
  await page.locator('tr[data-refresh-key="demo-train"] .pai-feature-toggle').click();
  assert.equal(await page.locator('tr[data-refresh-key="demo-train"] details').evaluate(n=>n.open),false);
  await page.locator('tr[data-refresh-key="demo-train"] .c-name').click();
  assert.equal(await page.locator('tr[data-refresh-key="demo-train"] details').evaluate(n=>n.open),true);
  await refresh();
  assert(await page.evaluate(()=>savedRow===document.querySelector('tr[data-refresh-key="demo-train"]')&&savedCell===savedRow.querySelector('.c-usage')));
  // Updated handlers must read the latest payload, including CSV and dimension controls.
  await page.evaluate(()=>{URL.createObjectURL=blob=>{window.csv=blob.text();return 'blob:test';};document.addEventListener('click',e=>{if(e.target.closest('a[download]'))e.preventDefault();});});
  await page.getByRole('button',{name:'导出 CSV',exact:true}).click();assert((await page.evaluate(()=>window.csv)).includes('new-feature'));
  await page.getByRole('button',{name:'用户',exact:true}).click();assert.equal(await page.locator('.pai-rank-table.user').count(),1);
  await page.getByRole('button',{name:'Feature',exact:true}).click();assert.equal(await page.locator('tbody.ranked > tr').count(),3);
  // Failed secondary requests keep all last-good content and recover without a reload.
  await page.evaluate(()=>{window.oldHTML=document.querySelector('#view').innerHTML;});failure='/api/pai/ranking';await refresh();
  assert.equal(await page.locator('#refresh-stale').count(),1);assert(await page.evaluate(()=>document.querySelector('#view').innerHTML===oldHTML));
  failure='';await refresh();assert.equal(await page.locator('#refresh-stale').count(),0);
  failure='/api/pai/overview';await refresh();assert.equal(await page.locator('#refresh-stale').count(),1);
  assert.equal(await page.locator('tbody.ranked > tr').count(),3);failure='';await refresh();
  ranked.features=ranked.features.filter(f=>f.quota_id!=='new-feature');await refresh();assert.equal(await page.locator('tbody.ranked > tr').count(),2);
  const race=await pause('/api/pai/ranking');await page.evaluate(()=>location.hash='#/pai/nodes');await page.waitForSelector('.pai-node-list');await race();assert.equal(await page.locator('.pai-rank').count(),0);
  await refresh();await page.getByRole('button',{name:/有任务/}).click();assert((await page.locator('.pai-node-row').count())>0);
  await page.evaluate(()=>location.hash='#/pai/workloads');await page.waitForSelector('.pai-search');await refresh();
  const workloadName=data['pai_overview.json'].workloads.find(w=>w.WorkloadId==='demo-dsw-vision').WorkloadName;
  await page.locator('.pai-search').fill(workloadName);assert((await page.locator('.pai-wl-table tbody').textContent()).includes(workloadName));
  const before=requests;await page.evaluate(()=>refreshTick());await page.waitForTimeout(100);assert.equal(requests,before);
  await page.locator('.pai-search').fill('');await page.locator('.pai-search').blur();
  await page.evaluate(()=>location.hash='#/pai/workload/demo-dsw-vision');await page.waitForSelector('.pai-chart canvas');
  await page.evaluate(()=>{window.chartNode=document.querySelector('.pai-chart');window.chartInstance=echarts.getInstanceByDom(chartNode);window.chartSeries=chartInstance.getOption().series[0].name;chartInstance.dispatchAction({type:'legendUnSelect',name:chartSeries});});
  for(const point of data['pai_series.demo-dsw-vision.json'].points)point.mean+=1;
  await refresh();assert(await page.evaluate(()=>chartNode===document.querySelector('.pai-chart')&&chartInstance===echarts.getInstanceByDom(chartNode)&&chartInstance.getOption().legend[0].selected[chartSeries]===false));
  failure='/api/pai/metrics/series';await refresh();assert(await page.evaluate(()=>chartInstance===echarts.getInstanceByDom(chartNode)&&!chartInstance.isDisposed()));failure='';await refresh();
  await page.evaluate(()=>location.hash='#/baremetal');await page.waitForSelector('.cluster-block');
  await page.locator('.cluster-block > summary').click();await page.evaluate(()=>{window.clusterNode=document.querySelector('.cluster-block');window.gpuNode=document.querySelector('.host-row .card');});
  overview.clusters[0].hosts[0].gpus[0].util_recent=57;await refresh();
  assert(await page.evaluate(()=>clusterNode===document.querySelector('.cluster-block')&&!clusterNode.open&&gpuNode===document.querySelector('.host-row .card')&&gpuNode.querySelector('.now').textContent==='57'));
  // Real version detection is independent of data polling and never auto-reloads.
  version='b'.repeat(64);await page.evaluate(()=>{const now=Date.now;Date.now=()=>now()+61000;});await page.evaluate(()=>PageRecovery.checkVersion());
  assert.equal(await page.locator('#frontend-update').count(),1);assert.equal(await page.locator('#frontend-update button').textContent(),'重载刷新');
  failure='/api/frontend-release';await page.evaluate(()=>{const now=Date.now;Date.now=()=>now()+61000;});
  await page.evaluate(()=>PageRecovery.checkVersion());assert.equal(await page.locator('.cluster-block').count(),1);
  failure='';version=loaded;await page.evaluate(()=>{const now=Date.now;Date.now=()=>now()+61000;});
  await page.evaluate(()=>PageRecovery.checkVersion());assert.equal(await page.locator('#frontend-update').count(),0);
  await page.evaluate(()=>window.dispatchEvent(new Event('error')));assert.equal(await page.locator('#page-recovery').count(),1);
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  assert.deepEqual(errors,[]);
  console.log('PASS: delayed/failed refresh, stable rows/cells/charts, reorder/add, disclosure/scroll, current handlers, search, route race, bare-metal, version notice and recovery');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
