import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile, mkdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBundle } from '../archive.js';

// Run against an isolated browser profile; no real consultation data is read.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = await mkdtemp(join(tmpdir(), 'tisc-booth-check-'));
const wait = ms => new Promise(done => setTimeout(done, ms));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
let servePreviousWorker = !process.argv[2];
const currentCache = (await readFile(join(root, 'sw.js'), 'utf8')).match(/const CACHE = '([^']+)'/)[1];
const server = createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const file = resolve(root, `.${path === '/' ? '/index.html' : path}`);
  if (!file.startsWith(`${root}/`)) { res.writeHead(403).end(); return; }
  try {
    let body = await readFile(file);
    if (servePreviousWorker && file === join(root, 'sw.js')) body = body.toString().replace(/const CACHE = '[^']+';/, "const CACHE = 'tisc-field-notes-v2';");
    res.setHeader('Content-Type', types[extname(file)] || 'application/octet-stream'); res.end(body);
  }
  catch { res.writeHead(404).end(); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const url = process.argv[2] || `http://127.0.0.1:${server.address().port}/`;
const chrome = spawn(process.env.CHROME_BIN || 'google-chrome', [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run',
  '--remote-debugging-port=0', `--user-data-dir=${scratch}`, 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });
let chromeError = '';
chrome.stderr.on('data', data => { chromeError = (chromeError + data).slice(-3000); });
chrome.on('error', error => { chromeError = error.message; });
let socket;
const pending = new Map();
let sequence = 0;
const exceptions = [];

try {
  let port;
  for (let attempt = 0; attempt < 120; attempt++) {
    try { port = Number((await readFile(join(scratch, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); break; }
    catch { await wait(100); }
  }
  if (!port) throw new Error(`Chrome did not start: ${chromeError}`);
  const page = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })).json();
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((done, reject) => { socket.addEventListener('open', done, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  socket.addEventListener('message', ({ data }) => {
    const response = JSON.parse(data);
    if (response.method === 'Runtime.exceptionThrown') exceptions.push(response.params.exceptionDetails.text);
    const call = pending.get(response.id);
    if (call) { pending.delete(response.id); clearTimeout(call.timer); response.error ? call.reject(new Error(response.error.message)) : call.resolve(response.result); }
  });
  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 15000);
      pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async function evaluate(expression) {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result?.value;
  }
  await send('Runtime.enable');
  await send('Page.enable');
  socket.addEventListener('message', ({ data }) => {
    if (JSON.parse(data).method === 'Page.javascriptDialogOpening') send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
  });
  async function eventually(expression) {
    for (let attempt = 0; attempt < 100; attempt++) { if (await evaluate(expression)) return; await wait(100); }
    throw new Error(`Condition did not become true: ${expression}\n${await evaluate('JSON.stringify({company:document.querySelector("#company")?.value,message:document.querySelector("#message")?.textContent,deleteOpen:document.querySelector("#delete-dialog")?.open,deleteError:document.querySelector("#delete-error")?.textContent})')}`);
  }
  await eventually('document.readyState === "complete" && document.body.innerText.includes("TiSC")');
  assert.equal(await evaluate('document.querySelector("h1").innerText.trim()'),'현장 상담 기록');
  assert.equal(await evaluate('document.querySelector("#team")'),null,'The recorder must not ask users to choose a team');
  assert.equal(await evaluate(`(async()=>{
    const {overlappingRecords}=await import('./app.js');
    const old={id:'old-1',team:'1조',startAt:'2026-10-19T01:00:00Z',endAt:'2026-10-19T01:05:00Z'};
    return overlappingRecords(old,[{...old,id:'old-2',team:'2조'},{...old,id:'adjacent',team:'3조',startAt:old.endAt}]).map(record=>record.id).join(',');
  })()`),'old-2','Legacy team names must not suppress actual time overlaps or invent adjacent ones');
  const fixture = await evaluate(`(async () => {
    const db = await import('./storage.js'); const archive = await import('./archive.js');
    await db.openStorage();
    const id = crypto.randomUUID(), cardId = crypto.randomUUID();
    const canvas = document.createElement('canvas'); canvas.width = 600; canvas.height = 300;
    const context = canvas.getContext('2d'); context.fillStyle = '#fff'; context.fillRect(0,0,600,300);
    context.fillStyle = '#a91836'; context.font = '32px sans-serif'; context.fillText('TEST CARD', 30, 80);
    const blob = await new Promise(done => canvas.toBlob(done, 'image/png'));
    const photo = {id:cardId, name:'test-card.png', type:blob.type, size:blob.size, path:'cards/'+cardId+'.png'};
    const now = new Date().toISOString();
    localStorage.setItem('tisc-team','99조');
    const record = {id,createdAt:now,updatedAt:now,startAt:now,endAt:null,company:'브라우저 검증 회사',memo:'<img src=x onerror=alert(1)>',team:'검증 1조',visitType:'booth',cards:[]};
    await db.saveRecord(record);
    record.cards=[photo]; record.updatedAt=new Date(Date.parse(now)+1).toISOString();
    await db.saveCard(record,{...photo,recordId:id,blob},now);
    const records=await db.getRecords(), cards=await db.getCards();
    const bundle=await archive.createBundle(records,cards), restored=await archive.readBundle(bundle);
    const duplicate=await db.importRecords(restored);
    if (duplicate.skipped!==1 || duplicate.added!==0) throw new Error('Duplicate import created data');
    const conflict=structuredClone(restored.records[0]); conflict.memo='conflicting same timestamp';
    let rejected=false; try {await db.importRecords({records:[conflict],cards:restored.cards});}catch{rejected=true;}
    if(!rejected)throw new Error('Conflicting import silently overwrote data');
    const replacement=structuredClone(restored.records[0]);replacement.updatedAt=new Date(Date.parse(record.updatedAt)+1).toISOString();replacement.memo='업데이트된 상담 메모';
    const merged=await db.importRecords({records:[replacement],cards:restored.cards});
    if(merged.updated!==1)throw new Error('Newer import did not update');
    const saved=(await db.getRecords())[0];if(saved.memo!==replacement.memo || (await db.getCards()).length!==1)throw new Error('Import lost card or memo');
    const end={...saved,endAt:new Date(Date.parse(now)+120000).toISOString(),updatedAt:new Date(Date.parse(replacement.updatedAt)+1).toISOString()};await db.saveRecord(end,saved.updatedAt);
    const stale={...saved,memo:'stale tab',updatedAt:new Date(Date.parse(end.updatedAt)+1).toISOString()};
    let staleRejected=false;try{await db.saveRecord(stale,saved.updatedAt);}catch{staleRejected=true;}
    if(!staleRejected)throw new Error('Stale browser tab overwrote newer notes');
    const snapshot=async()=>JSON.stringify({records:await db.getRecords(),cards:await db.getCards()});
    const original=await snapshot(), targets=[];
    for(let index=0;index<2;index++) {
      const target={...end,id:crypto.randomUUID(),company:'삭제 검증 '+index,cards:[]};
      await db.saveRecord(target);
      const metadata={...photo,id:crypto.randomUUID()};metadata.path='cards/'+metadata.id+'.png';
      const withPhoto={...target,updatedAt:new Date(Date.parse(target.updatedAt)+1).toISOString(),cards:[metadata]};
      await db.saveCard(withPhoto,{...metadata,recordId:target.id,blob},target.updatedAt);
      targets.push(withPhoto);
    }
    await new Promise((resolve,reject)=>{
      const request=indexedDB.open('tisc-booth-notes',1);
      request.onsuccess=()=>{
        const connection=request.result,tx=connection.transaction('cards','readwrite');
        const orphanId=crypto.randomUUID();
        tx.objectStore('cards').put({...photo,id:orphanId,recordId:targets[0].id,path:'cards/'+orphanId+'.png',blob});
        tx.oncomplete=()=>{connection.close();resolve();};tx.onabort=()=>{connection.close();reject(tx.error);};
      };request.onerror=()=>reject(request.error);
    });
    const beforeDeletion=await snapshot(), refs=targets.map(({id,updatedAt})=>({id,updatedAt}));
    for(const invalid of [{...refs[1],updatedAt:now},{id:crypto.randomUUID(),updatedAt:now}]) {
      let rejected=false;try{await db.deleteRecords([refs[0],invalid]);}catch{rejected=true;}
      if(!rejected || await snapshot()!==beforeDeletion)throw new Error('A stale or missing target must abort the whole deletion, including photos');
    }
    await db.deleteRecords(refs);
    if(await snapshot()!==original)throw new Error('Deletion must remove selected records and all their photos while preserving unrelated data');
    let resurrectionRejected=false;try{await db.saveRecord({...targets[0],updatedAt:new Date(Date.parse(targets[0].updatedAt)+1).toISOString()},targets[0].updatedAt);}catch{resurrectionRejected=true;}
    if(!resurrectionRejected || await snapshot()!==original)throw new Error('A stale save must not resurrect a deleted consultation');
    return {id,cardId,zipSize:bundle.size,png:canvas.toDataURL('image/png').split(',')[1]};
  })()`);
  assert.ok(fixture.zipSize > 0);
  await send('Page.reload');
  await eventually('document.body.innerText.includes("브라우저 검증 회사")');
  assert.equal(await evaluate('document.querySelectorAll("img[onerror]").length'), 0);
  const records = await evaluate('(async()=>{const db=await import("./storage.js");return await db.getRecords();})()');
  assert.equal(records.length, 1);
  assert.equal(records[0].cards.length, 1);
  assert.equal(records[0].team,'검증 1조','Existing team metadata must remain unchanged internally');
  assert.equal(await evaluate('/검증 1조|99조|조 미지정|기록 조/.test(document.body.innerText)'),false,'Legacy team metadata must not appear anywhere in the UI');
  await evaluate('document.querySelector("#search").value="검증 1조";document.querySelector("#search").dispatchEvent(new Event("input",{bubbles:true}))');
  assert.equal(await evaluate('document.querySelectorAll(".record-item").length'),0,'Hidden legacy team values must not affect company/memo search');
  await evaluate('document.querySelector("#search").value="";document.querySelector("#search").dispatchEvent(new Event("input",{bubbles:true}))');
  assert.equal(await evaluate('document.querySelectorAll(".record-item").length'),1,'Records with old team metadata must remain listed');
  await eventually('!document.querySelector("#new-record").disabled');
  await evaluate('document.querySelector("#new-record").click()');
  await eventually('!document.querySelector("#start-panel").hidden && !document.querySelector("#start-record").disabled');
  await evaluate('document.querySelector("#start-record").click()');
  await eventually('!document.querySelector("#record-form").hidden && !document.querySelector("#company").disabled');
  await evaluate(`(() => {
    for(const [id,value] of [['company','실제 버튼 상담'],['memo','현장 시연 요청 · <img src=x onerror=alert(1)>']]) {
      const input=document.getElementById(id);input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));
    }
  })()`);
  await eventually('(async()=>{const db=await import("./storage.js");return (await db.getRecords()).some(r=>r.company==="실제 버튼 상담" && r.memo.includes("현장 시연 요청"));})()');
  assert.equal(await evaluate('(async()=>{const db=await import("./storage.js");return (await db.getRecords()).find(r=>r.company==="실제 버튼 상담").team;})()'),'','New consultations must ignore any old saved team preference');
  assert.ok(await evaluate('document.querySelector("#overlap-warning").textContent.includes("브라우저 검증 회사")'),'A new consultation must see overlapping legacy records regardless of old team labels');
  const pngPath=join(scratch,'test-card.png');
  await writeFile(pngPath,Buffer.from(fixture.png,'base64'));
  const dom=await send('DOM.getDocument');
  assert.equal(await evaluate('document.querySelector("#card-file").getAttribute("capture")'),'environment');
  assert.equal(await evaluate('document.querySelector("#gallery-file").hasAttribute("capture")'),false);
  const fileInput=await send('DOM.querySelector',{nodeId:dom.root.nodeId,selector:'#gallery-file'});
  await send('DOM.setFileInputFiles',{nodeId:fileInput.nodeId,files:[pngPath]});
  await eventually('(async()=>{const db=await import("./storage.js");return (await db.getRecords()).some(r=>r.company==="실제 버튼 상담" && r.cards.length===1);})()');
  await eventually('!document.querySelector("#new-record").disabled');
  await evaluate(`(() => {
    const memo=document.querySelector('#memo');memo.value+=' · 다른 상담 추가 직전 수정';memo.dispatchEvent(new Event('input',{bubbles:true}));
    document.querySelector('#add-consultation').click();
  })()`);
  await eventually('document.querySelector("#company").value === "" && !document.querySelector("#company").disabled');
  assert.ok(await evaluate('(async()=>{const db=await import("./storage.js");return (await db.getRecords()).some(r=>r.company==="실제 버튼 상담" && r.memo.includes("추가 직전 수정") && r.cards.length===1);})()'),'Creating another consultation must save the pending memo and retain its photo');
  await evaluate(`(() => {
    for(const [id,value] of [['company','갑작스러운 문의 회사'],['memo','명함 전달 후 추후 연락 요청']]) {
      const input=document.getElementById(id);input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));
    }
  })()`);
  await eventually('(async()=>{const db=await import("./storage.js");const records=await db.getRecords();return records.filter(r=>r.endAt===null).length===2 && records.some(r=>r.company==="갑작스러운 문의 회사");})()');
  assert.ok(await evaluate('!document.querySelector("#overlap-warning").hidden'),'Overlapping consultations must be visible');
  assert.ok(await evaluate('document.querySelector("#active-count").textContent.includes("2")'),'Both unfinished consultations must stay visible');
  await evaluate(`(() => {
    const memo=document.querySelector('#memo');memo.value+=' · 전환 직전 수정';memo.dispatchEvent(new Event('input',{bubbles:true}));
    document.querySelector('.other-session').click();
  })()`);
  await eventually('document.querySelector("#company").value === "실제 버튼 상담" && !document.querySelector("#company").disabled');
  assert.ok(await evaluate('(async()=>{const db=await import("./storage.js");return (await db.getRecords()).some(r=>r.company==="갑작스러운 문의 회사" && r.memo.includes("전환 직전 수정"));})()'),'Switching consultations must flush pending input');
  await evaluate(`(() => {
    window.originalIdbTransaction=IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction=function(...args){if(args[1]==='readwrite')throw new DOMException('검증용 저장 실패','QuotaExceededError');return window.originalIdbTransaction.apply(this,args);};
    const memo=document.querySelector('#memo');memo.value+=' · 저장 실패 중 입력';memo.dispatchEvent(new Event('input',{bubbles:true}));
    document.querySelector('.other-session').click();
  })()`);
  await eventually('document.querySelector("#save-status").textContent.includes("저장 실패") && !document.querySelector("#add-consultation").disabled');
  assert.equal(await evaluate('document.querySelector("#company").value'),'실제 버튼 상담','A failed save must not switch the selected consultation');
  assert.ok(await evaluate('document.querySelector("#memo").value.includes("저장 실패 중 입력")'),'Unsaved input must remain visible');
  await evaluate('document.querySelector("#add-consultation").click()');
  await eventually('!document.querySelector("#add-consultation").disabled');
  assert.equal(await evaluate('(async()=>{const db=await import("./storage.js");return (await db.getRecords()).length;})()'),3,'A failed save must not create another consultation');
  await evaluate('IDBDatabase.prototype.transaction=window.originalIdbTransaction;delete window.originalIdbTransaction;document.querySelector("#retry-save").click();');
  await eventually('document.querySelector("#save-status").textContent.includes("기기에 저장됨")');
  await evaluate('document.querySelector(".other-session").click()');
  await eventually('document.querySelector("#company").value === "갑작스러운 문의 회사" && !document.querySelector("#end-record").disabled');
  await eventually('!document.querySelector("#end-record").disabled');
  await evaluate('document.querySelector("#end-record").click()');
  await eventually('(async()=>{const db=await import("./storage.js");const records=await db.getRecords();return records.some(r=>r.company==="갑작스러운 문의 회사" && r.endAt!==null) && records.some(r=>r.company==="실제 버튼 상담" && r.endAt===null);})()');
  await eventually('!document.querySelector("#next-record").disabled');
  await evaluate('document.querySelector("#next-record").click()');
  await eventually('document.querySelector("#company").value === "실제 버튼 상담" && !document.querySelector("#end-record").hidden');
  assert.equal(await evaluate('document.querySelectorAll("img[onerror]").length'),0);
  const downloads=join(scratch,'downloads');await mkdir(downloads);
  await send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:downloads});
  await eventually('!document.querySelector("#export-all").disabled');
  await evaluate('document.querySelector("#export-all").click()');
  let zipPath;
  for(let attempt=0;attempt<100;attempt++) {
    const name=(await readdir(downloads)).find(name=>name.endsWith('.zip'));
    if(name){zipPath=join(downloads,name);break;}await wait(100);
  }
  assert.ok(zipPath,'UI did not download a ZIP');
  const exported=await readBundle(new Blob([await readFile(zipPath)]));
  assert.equal(exported.records.length,3);assert.equal(exported.cards.length,2);
  assert.equal(exported.records.find(record=>record.id===fixture.id).team,'검증 1조','Export must preserve existing legacy metadata without showing it in the UI');
  assert.ok(exported.records.filter(record=>record.id!==fixture.id).every(record=>record.team===''),'All new consultation ZIP records must use empty team metadata');
  assert.equal(exported.records.find(r=>r.company==='실제 버튼 상담').endAt,null,'An unfinished consultation must be included in the ZIP');
  assert.equal(await evaluate('(async()=>{const db=await import("./storage.js");return (await db.getCards()).length;})()'),2,'Export must retain the photos in device storage');
  const importInput=await send('DOM.querySelector',{nodeId:dom.root.nodeId,selector:'#import-file'});
  await eventually('!document.querySelector("#import-file").disabled');
  await send('DOM.setFileInputFiles',{nodeId:importInput.nodeId,files:[zipPath]});
  await eventually('document.querySelector("#message").textContent.includes("기록 가져오기 완료")');
  assert.equal(await evaluate('(async()=>{const db=await import("./storage.js");return (await db.getRecords()).length;})()'),3);
  const snapshot = `(async()=>{
    const db=await import('./storage.js');
    const records=(await db.getRecords()).sort((a,b)=>a.id.localeCompare(b.id));
    const cards=await Promise.all((await db.getCards()).sort((a,b)=>a.id.localeCompare(b.id)).map(async card=>({
      id:card.id,recordId:card.recordId,type:card.type,size:card.size,
      sha256:Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await card.blob.arrayBuffer())),b=>b.toString(16).padStart(2,'0')).join('')
    })));
    return {records,cards};
  })()`;
  const beforeUiDeletion = await evaluate(snapshot);
  await evaluate('document.querySelector("#new-record").click()');
  await eventually('document.querySelector("#company").value === "" && !document.querySelector("#company").disabled');
  await evaluate('document.querySelector("#company").value="삭제 검증 상담";document.querySelector("#company").dispatchEvent(new Event("input",{bubbles:true}))');
  await eventually('document.querySelector("#save-status").textContent.includes("기기에 저장됨")');
  await send('DOM.setFileInputFiles',{nodeId:fileInput.nodeId,files:[pngPath]});
  await eventually('(async()=>{const db=await import("./storage.js");return (await db.getRecords()).some(r=>r.company==="삭제 검증 상담" && r.cards.length===1);})()');
  await eventually('!document.querySelector("#delete-record").disabled');
  await evaluate('document.querySelector("#memo").value="삭제 확인 직전 입력";document.querySelector("#memo").dispatchEvent(new Event("input",{bubbles:true}));document.querySelector("#delete-record").click()');
  await eventually('document.querySelector("#delete-dialog").open');
  assert.equal(await evaluate('document.activeElement.id'),'delete-cancel','Cancel must receive initial deletion dialog focus');
  assert.ok(await evaluate('document.querySelector("#delete-dialog").textContent.includes("삭제 검증 상담")'),'Deletion confirmation must identify the consultation');
  const beforeCancel = await evaluate(snapshot);
  assert.equal(beforeCancel.records.find(record=>record.company==='삭제 검증 상담').memo,'삭제 확인 직전 입력','Opening deletion must first save pending edits');
  await evaluate('document.querySelector("#delete-cancel").click()');
  await eventually('!document.querySelector("#delete-dialog").open');
  assert.deepEqual(await evaluate(snapshot),beforeCancel,'Cancel must retain every consultation and photo byte');
  await evaluate('document.querySelector("#delete-record").click()');
  await eventually('document.querySelector("#delete-dialog").open && !document.querySelector("#delete-confirm").disabled');
  await evaluate('document.querySelector("#delete-confirm").click()');
  await eventually('!document.querySelector("#delete-dialog").open && document.querySelector("#company").value === "실제 버튼 상담" && !document.querySelector("#company").disabled');
  assert.deepEqual(await evaluate(snapshot),beforeUiDeletion,'Deleting the selected active consultation must preserve other records and their photos');
  assert.equal(await evaluate('document.body.dataset.view'),'records','Deletion must return to the consultation list');
  await send('Page.reload');
  await eventually('document.querySelector("#company").value === "실제 버튼 상담" && !document.querySelector("#company").disabled');
  assert.deepEqual(await evaluate(snapshot),beforeUiDeletion,'Deletion and the surviving active consultation must persist after reload');
  await evaluate(`(() => {
    for(const [id,value] of [['company','A 도로운영사 · 테스트'],['memo','높이 제한 검지 시스템 교체 문의\\n현장 데모 요청']]) {
      const input=document.getElementById(id);input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));
    }
  })()`);
  await eventually('document.querySelector("#save-status").textContent.includes("기기에 저장됨")');
  const artifactDir = resolve(root, '../artifacts/exhibition-recorder-preview');
  await mkdir(artifactDir, { recursive: true });
  for (const [name, width, height] of [['desktop',1440,1050],['mobile',390,1000]]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: name === 'mobile' });
    await wait(200);
    assert.ok(await evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), `${name} page overflows horizontally`);
    if(name==='mobile') {
      for(const [view,selector] of [['records','.records-panel'],['editor','.editor-panel'],['transfer','.transfer-panel']]) {
        await evaluate('document.querySelector("#show-'+view+'").click()');
        await eventually('document.body.dataset.view === "'+view+'" && !document.querySelector("#show-'+view+'").disabled');
        assert.ok(await evaluate('document.querySelector("'+selector+'").getBoundingClientRect().height > 0'),'The selected mobile view must be visible');
        for(const other of ['.records-panel','.editor-panel','.transfer-panel'].filter(s=>s!==selector)) assert.equal(await evaluate('document.querySelector("'+other+'").getBoundingClientRect().height'),0,'Other mobile views must be hidden');
        assert.ok(await evaluate('document.documentElement.scrollWidth <= innerWidth + 1'),view+' mobile view overflows horizontally');
        assert.ok(await evaluate('Array.from(document.querySelectorAll(".field-nav button,.button,.text-button")).every(b=>getComputedStyle(b).borderTopWidth==="0px" && getComputedStyle(b).textDecorationLine==="none")'),'Buttons and navigation must have no separator borders or underlines');
        await evaluate('window.scrollTo({top:0,behavior:"instant"})');
        const shot=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:true});
        await writeFile(join(artifactDir,'mobile-'+view+'.png'),Buffer.from(shot.data,'base64'));
      }
      await evaluate('document.querySelector("#show-editor").click()');
      await eventually('document.body.dataset.view === "editor" && !document.querySelector("#show-editor").disabled');
    }
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    await writeFile(join(artifactDir, `${name}.png`), Buffer.from(shot.data, 'base64'));
  }
  if (await evaluate('"serviceWorker" in navigator')) {
    await evaluate('navigator.serviceWorker.ready.then(()=>true)');
    await send('Page.reload');
    await eventually('!!navigator.serviceWorker.controller');
    if (!process.argv[2]) {
      assert.ok(await evaluate('caches.has("tisc-field-notes-v2")'),'The previous worker must be active before the update');
      const beforeUpdate = await evaluate(snapshot);
      servePreviousWorker = false;
      await evaluate('navigator.serviceWorker.getRegistration().then(registration=>registration.update()).then(()=>true)');
      await eventually('navigator.serviceWorker.getRegistration().then(registration=>!!registration.waiting)');
      await send('Page.navigate',{url:'about:blank'});
      await eventually('location.href === "about:blank"');
      await wait(200);
      await send('Page.navigate',{url});
      await eventually('document.readyState === "complete" && !!navigator.serviceWorker.controller && document.body.innerText.includes("A 도로운영사 · 테스트")');
      await eventually('caches.has('+JSON.stringify(currentCache)+')');
      assert.deepEqual(await evaluate(snapshot),beforeUpdate,'A worker update must preserve every consultation and photo byte');
      assert.equal(await evaluate('caches.has("tisc-field-notes-v2")'),false,'Only the old screen cache should be removed');
    }
    await send('Network.enable');
    await send('Network.emulateNetworkConditions', { offline:true,latency:0,downloadThroughput:0,uploadThroughput:0 });
    await send('Page.reload');
    await eventually('document.body.innerText.includes("A 도로운영사 · 테스트")');
  }
  assert.deepEqual(exceptions, [], `Browser exceptions: ${exceptions.join(', ')}`);
  console.log('PASS: consultation and interruption UI, pending-save flush, failed-save switch/create prevention, camera/gallery selection, unfinished-consultation ZIP, retained photos, atomic revision-checked record/photo deletion, deletion cancel and survivor selection, stale-save resurrection prevention, duplicate/conflict/stale-tab protection, persistence, monochrome borderless mobile views, desktop/mobile layout, service-worker update preserves records/photos, offline reload');
  console.log(`Screenshots: ${artifactDir}`);
} finally {
  socket?.close();
  for (const call of pending.values()) { clearTimeout(call.timer); call.reject(new Error('Browser check closed')); }
  chrome.kill();
  server.closeAllConnections();
  await new Promise(done => server.close(done));
  await new Promise(done => { if(chrome.exitCode!==null)done();else {chrome.once('exit',done);setTimeout(done,2000);} });
  await rm(scratch,{recursive:true,force:true,maxRetries:3,retryDelay:100});
}
