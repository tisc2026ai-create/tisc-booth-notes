import test from 'node:test';
import assert from 'node:assert/strict';
import {backupConfig, FieldSync} from '../field-sync.js';
import {createBundle, MAX_BUNDLE_BYTES} from '../archive.js';
import {recordingDigest,AUDIO_CHUNK_BYTES} from '../assets.js';
import {audioFixture} from './audio-fixtures.mjs';

const config={url:'https://tisc.example.ts.net/',token:'x'.repeat(43),deviceId:'013cf837-4a88-42cd-91d4-9a5afbd58ce9',label:'현장 담당'};
const now='2026-10-19T01:00:00.000Z';
const hash=async bytes=>Buffer.from(await crypto.subtle.digest('SHA-256',bytes)).toString('hex');
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
const later=record=>{record.updatedAt=new Date(Date.parse(record.updatedAt)+1).toISOString();};
async function fixture(size=128){
  const bytes=new Uint8Array(size);bytes.set([137,80,78,71,13,10,26,10]);
  const id=crypto.randomUUID(),recordId=crypto.randomUUID();
  const metadata={id,name:'현장 제품.png',type:'image/png',size,path:`cards/${id}.png`,kind:'product',caption:'현장에서 확인한 제품'};
  return {records:[{id:recordId,createdAt:now,updatedAt:now,startAt:now,endAt:null,company:'업체',memo:'',team:'',visitType:'booth',cards:[metadata]}],cards:[{...metadata,recordId,blob:new Blob([bytes],{type:metadata.type}),hash:await hash(bytes)}]};
}
function environment(t){
  const values=new Map(),original={fetch:globalThis.fetch,storage:globalThis.localStorage,navigator:Object.getOwnPropertyDescriptor(globalThis,'navigator')};
  globalThis.localStorage={getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,String(value)),removeItem:key=>values.delete(key)};
  Object.defineProperty(globalThis,'navigator',{value:{onLine:true},configurable:true});
  t.after(()=>{globalThis.fetch=original.fetch;globalThis.localStorage=original.storage;if(original.navigator)Object.defineProperty(globalThis,'navigator',original.navigator);else delete globalThis.navigator;});
  return values;
}
function client(snapshot){
  const messages=[],sync=new FieldSync(typeof snapshot==='function'?snapshot:async()=>snapshot,message=>messages.push(message));
  sync.schedule=()=>{};if(!sync.config)sync.connect(config);return {sync,messages};
}
function peer(chunkBytes=32){
  const pc={latest:null,blobs:new Map(),calls:[],chunkBytes,before:null,after:null};
  pc.fetch=async(url,options={})=>{
    assert.equal(options.headers.Authorization,`Bearer ${config.token}`);assert.equal(options.mode,'cors');assert.equal(options.credentials,'omit');assert.equal(options.redirect,'error');
    const parsed=new URL(url),path=parsed.pathname.split('/sync')[1],call={path,method:options.method||'GET',query:parsed.searchParams,bytes:options.body instanceof Blob?options.body.size:0};
    pc.calls.push(call);await pc.before?.(call,options);let response;
    if(path==='/status'){
      const body=JSON.parse(options.body),states=values=>(values||[]).map(photo=>{const stored=pc.blobs.get(photo.sha256);return {sha256:photo.sha256,offset:stored?.bytes.length||0,complete:stored?.complete||false};});
      response=json({schemaVersion:pc.latest?.schemaVersion||2,chunkBytes:pc.chunkBytes,revision:pc.latest?.revision||0,records:pc.latest?.records||[],hashes:pc.latest?.photos||[],recordingHashes:pc.latest?.recordings||[],photos:states(body.photos),recordings:states(body.recordings)});
    }
    else if(path?.startsWith('/blobs/')&&call.method==='POST'){
      const sha256=path.split('/').at(-1),offset=Number(call.query.get('offset')),size=Number(call.query.get('size')),type=call.query.get('type'),stored=pc.blobs.get(sha256)||{bytes:new Uint8Array(),complete:false,type};
      assert.equal(offset,stored.bytes.length);const incoming=new Uint8Array(await options.body.arrayBuffer()),bytes=new Uint8Array(offset+incoming.length);bytes.set(stored.bytes);bytes.set(incoming,offset);
      if(bytes.length===size)assert.equal(type.startsWith('audio/')?await recordingDigest(new Blob([bytes],{type})):await hash(bytes),sha256);pc.blobs.set(sha256,{bytes,complete:bytes.length===size,type});response=json({offset:bytes.length,complete:bytes.length===size});
    }else if(path==='/manifest'&&call.method==='POST'){
      const value=JSON.parse(options.body);call.manifest=value;
      if(value.expectedRevision!==(pc.latest?.revision||0))response=json({error:'최신 PC 백업을 복원해 주세요.',revision:pc.latest.revision},409);
      else{for(const photo of [...value.photos,...(value.recordings||[])])assert.equal(pc.blobs.get(photo.sha256)?.complete,true);pc.latest=value;response=json({records:value.records.length,photos:value.photos.length,...(value.schemaVersion===3?{recordings:value.recordings.length}:{}),revision:value.revision,savedAt:now});}
    }else if(path==='/manifest')response=pc.latest?json(pc.latest):json({error:'없음'},404);
    else if(path?.startsWith('/blobs/')){const photo=pc.blobs.get(path.split('/').at(-1)),offset=Number(call.query.get('offset')||0),length=Number(call.query.get('length')||photo.bytes.length);response=new Response(photo.bytes.slice(offset,offset+length),{headers:{'Content-Type':photo.type}});}
    else if(path===undefined&&pc.legacy)response=new Response(pc.legacy,{headers:{'Content-Type':'application/zip'}});
    else throw new Error('Unexpected synthetic route');
    await pc.after?.(call,options,response);return response;
  };
  globalThis.fetch=pc.fetch;return pc;
}
const binaryCalls=pc=>pc.calls.filter(call=>call.bytes);
const commits=pc=>pc.calls.filter(call=>call.path==='/manifest'&&call.method==='POST');

test('backup connection rejects credentials, paths, insecure URLs and malformed pairing values',()=>{
  assert.equal(backupConfig(config).url,'https://tisc.example.ts.net');
  for(const change of [{url:'http://host'},{url:'https://user:pass@host'},{url:'https://host/other'},{url:'https://host/?token=secret'},{token:'short'},{deviceId:'../other'},{label:'가'.repeat(81)}])assert.throws(()=>backupConfig({...config,...change}));
});
test('an empty cleared browser and offline device never overwrite their PC backup',async t=>{
  environment(t);const pc=peer(),{sync,messages}=client({records:[],cards:[]});await sync.send();assert.equal(pc.calls.length,0);assert.equal(sync.signature,null);assert.match(messages.at(-1),/복원/);
  navigator.onLine=false;await sync.send();assert.equal(pc.calls.length,0);assert.match(messages.at(-1),/기기에 저장/);
});
test('memo, photo descriptions and reconnection send no unchanged photo bytes',async t=>{
  environment(t);const snapshot=await fixture(),pc=peer(),{sync,messages}=client(snapshot);await sync.send();assert.ok(sync.signature);assert.equal(binaryCalls(pc).length,4);assert.ok(messages.some(value=>value.includes('남은')));
  const count=pc.calls.length;await sync.send();assert.equal(pc.calls.length,count);
  snapshot.records[0].memo='변경한 메모';later(snapshot.records[0]);snapshot.records[0].cards[0].caption=snapshot.cards[0].caption='추가 설명';snapshot.records[0].cards[0].kind=snapshot.cards[0].kind='booth';
  await sync.send();assert.equal(binaryCalls(pc).length,4);assert.match(messages.at(-2),/사진 전송 없음/);assert.equal(pc.latest.records[0].memo,'변경한 메모');assert.equal(pc.latest.records[0].cards[0].caption,'추가 설명');
  sync.connect(config);await sync.send();await client(snapshot).sync.send();assert.equal(binaryCalls(pc).length,4);
});
test('changing one photo uploads its new hash while identical image content is deduplicated',async t=>{
  environment(t);const snapshot=await fixture(),pc=peer(),{sync}=client(snapshot),id=crypto.randomUUID(),copy={...snapshot.records[0].cards[0],id,path:`cards/${id}.png`};
  snapshot.records[0].cards.push(copy);snapshot.cards.push({...snapshot.cards[0],...copy});await sync.send();assert.equal(binaryCalls(pc).length,4);
  const bytes=new Uint8Array(await snapshot.cards[0].blob.arrayBuffer());bytes[20]=1;snapshot.cards[0].blob=new Blob([bytes],{type:'image/png'});snapshot.cards[0].hash=await hash(bytes);later(snapshot.records[0]);
  await sync.send();assert.equal(binaryCalls(pc).length,8);assert.equal(pc.blobs.size,2);
});
for(const failure of ['before','after'])test(`interrupted photos resume at the PC-confirmed offset (${failure} chunk acknowledgement)`,async t=>{
  environment(t);const snapshot=await fixture(),original=JSON.stringify(snapshot.records),pc=peer(),{sync,messages}=client(snapshot);let failed=false;
  pc[failure]=async call=>{if(!failed&&call.bytes&&Number(call.query.get('offset'))===32){failed=true;throw new Error('synthetic network loss');}};
  await sync.send();assert.equal(sync.signature,null);assert.equal(pc.latest,null);assert.match(messages.at(-1),/기기 자료 유지/);
  const offset=pc.blobs.values().next().value.bytes.length,start=pc.calls.length;assert.equal(offset,failure==='before'?32:64);pc[failure]=null;
  await sync.send();assert.ok(sync.signature);assert.equal(Number(pc.calls.slice(start).find(call=>call.bytes).query.get('offset')),offset);assert.equal(JSON.stringify(snapshot.records),original);
});
test('a lost manifest acknowledgement survives reload without resending photos',async t=>{
  environment(t);const snapshot=await fixture(),pc=peer(),{sync}=client(snapshot);let fail=true;
  pc.after=async call=>{if(fail&&call.path==='/manifest'&&call.method==='POST'){fail=false;throw new Error('lost commit reply');}};
  await sync.send();assert.equal(sync.signature,null);assert.ok(pc.latest);assert.ok(sync.progress.pending);
  assert.equal(sync.progress.pending.signature,await hash(new TextEncoder().encode(JSON.stringify({records:pc.latest.records,photos:pc.latest.photos}))),'Photo-only pending signatures must stay compatible with the previous client');
  const commitCount=commits(pc).length,byteCount=binaryCalls(pc).length;
  const reloaded=client(snapshot).sync;await reloaded.send();assert.ok(reloaded.signature);assert.equal(reloaded.progress.revision,pc.latest.revision);assert.equal(commits(pc).length,commitCount);assert.equal(binaryCalls(pc).length,byteCount);
});
test('a lost commit acknowledgement cannot report success when its committed photo needs repair',async t=>{
  environment(t);const snapshot=await fixture(),pc=peer(),{sync}=client(snapshot);let fail=true;
  pc.after=async call=>{if(fail&&call.path==='/manifest'&&call.method==='POST'){fail=false;throw new Error('lost commit reply');}};
  await sync.send();assert.ok(sync.progress.pending);pc.blobs.clear();const previous=pc.latest.revision;
  const {sync:reloaded,messages}=client(snapshot);await reloaded.send();assert.ok(reloaded.signature);assert.ok(pc.latest.revision>previous);
  assert.equal(binaryCalls(pc).length,8);assert.equal(messages.some(value=>value.includes('사진 재전송 없음')),false);
});
test('CAS conflict and a remote deletion block stale writes until restore is acknowledged',async t=>{
  environment(t);const snapshot=await fixture(),pc=peer(),{sync,messages}=client(snapshot);await sync.send();snapshot.records[0].memo='전송 중 로컬 수정';later(snapshot.records[0]);let raced=false;
  pc.before=async(call,options)=>{if(!raced&&call.path==='/manifest'&&call.method==='POST'){raced=true;pc.latest={...JSON.parse(options.body),revision:JSON.parse(options.body).revision+1,records:[],photos:[]};}};
  const signature=sync.signature;await sync.send();assert.equal(sync.signature,signature);assert.match(messages.at(-1),/복원/);pc.before=null;const count=commits(pc).length;
  await sync.send();assert.equal(commits(pc).length,count);assert.deepEqual(pc.latest.records,[]);assert.match(messages.at(-1),/복원/);
});
test('first use adopts compatible existing backups but rejects missing records, conflicting sources and photo hashes',async t=>{
  const values=environment(t),snapshot=await fixture(),pc=peer(),{sync}=client(snapshot);await sync.send();const latest=structuredClone(pc.latest);
  const clear=()=>{for(const key of [...values.keys()])if(key.includes('-revision:'))values.delete(key);};
  sync.disconnect();clear();const compatible=client(snapshot).sync;await compatible.send();assert.ok(compatible.signature);compatible.disconnect();
  for(const mutate of [value=>value.records.push({...structuredClone(value.records[0]),id:crypto.randomUUID(),cards:[]}),value=>{value.records[0].memo='동일 시각 다른 메모';},value=>{value.photos[0].sha256='a'.repeat(64);}]){
    clear();pc.latest=structuredClone(latest);mutate(pc.latest);const {sync:stale,messages}=client(snapshot),count=pc.calls.length;await stale.send();assert.equal(stale.signature,null);assert.match(messages.at(-1),/복원/);assert.equal(pc.calls.length,count+1);stale.disconnect();
  }
});
test('disconnect aborts the active request and ignores its late response',async t=>{
  environment(t);const snapshot=await fixture(),pc=peer(),{sync,messages}=client(snapshot);let entered,signal;const reached=new Promise(resolve=>{entered=resolve;});
  pc.before=async(call,options)=>{if(call.bytes){signal=options.signal;entered();await new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError')),{once:true}));}};
  const pending=sync.send();await reached;sync.disconnect();await pending;assert.equal(signal.aborted,true);assert.equal(pc.latest,null);assert.equal(sync.signature,null);assert.equal(messages.at(-1),'PC 자동 백업 연결 안 됨');
});
test('restore cancels a send still awaiting its local snapshot before any upload starts',async t=>{
  environment(t);const snapshot=await fixture(),pc=peer(),{sync}=client(snapshot);await sync.send();
  let release;const held=new Promise(resolve=>{release=resolve;});sync.signature=null;sync.snapshot=()=>held;
  const start=pc.calls.length,sending=sync.send(),restoring=sync.restore();release(snapshot);
  await sending;const bundle=await restoring;
  assert.equal(pc.calls.slice(start).some(call=>call.method==='POST'),false);sync.cancelRestore(bundle);
});
test('deleting the last record after a successful backup commits an empty manifest without deleting local data itself',async t=>{
  environment(t);let snapshot=await fixture();const pc=peer(),{sync}=client(()=>snapshot);await sync.send();
  snapshot={records:[],cards:[]};sync.noteEmptyDeletion();await sync.send();assert.deepEqual(pc.latest.records,[]);assert.deepEqual(pc.latest.photos,[]);assert.ok(sync.signature);
});
test('intentional last deletion survives reload while cleared browsers and newly paired devices remain protected',async t=>{
  const values=environment(t);let snapshot=await fixture();const pc=peer(),{sync}=client(()=>snapshot);await sync.send();const saved=pc.latest.revision;
  snapshot={records:[],cards:[]};sync.noteEmptyDeletion();assert.equal(sync.progress.emptyIntent.revision,saved);
  const reloaded=client(()=>snapshot).sync;await reloaded.send();assert.deepEqual(pc.latest.records,[]);assert.equal(reloaded.progress.emptyIntent,undefined);
  reloaded.noteEmptyDeletion();reloaded.connect({...config,deviceId:crypto.randomUUID()});assert.equal(reloaded.progress,null);
  const count=pc.calls.length;await reloaded.send();assert.equal(pc.calls.length,count);
  values.clear();const cleared=client(()=>snapshot).sync;cleared.noteEmptyDeletion();await cleared.send();assert.equal(pc.calls.length,count);
});
test('last deletion never overwrites a newer remote revision, including deletion during an active own commit',async t=>{
  environment(t);let snapshot=await fixture();const pc=peer(),{sync,messages}=client(()=>snapshot);await sync.send();
  snapshot.records[0].memo='전송 직전 변경';later(snapshot.records[0]);let deleted=false;
  pc.before=async call=>{if(!deleted&&call.path==='/manifest'&&call.method==='POST'){deleted=true;snapshot={records:[],cards:[]};sync.noteEmptyDeletion();}};
  await sync.send();assert.equal(sync.progress.emptyIntent.revision,pc.latest.revision);
  const latest=structuredClone(pc.latest);pc.latest.revision++;pc.before=null;const count=commits(pc).length;
  await client(()=>snapshot).sync.send();assert.equal(commits(pc).length,count);assert.deepEqual(pc.latest.records,latest.records);
  assert.notDeepEqual(pc.latest.records,[]);assert.ok(messages.length);
});
test('last deletion during the first commit survives its acknowledgement and reload from a known zero baseline',async t=>{
  environment(t);let snapshot=await fixture();const pc=peer(),{sync}=client(()=>snapshot);let entered,release;
  const reached=new Promise(resolve=>{entered=resolve;}),held=new Promise(resolve=>{release=resolve;});
  pc.after=async call=>{if(call.path==='/manifest'&&call.method==='POST'){entered();await held;}};
  const sending=sync.send();await reached;assert.equal(sync.progress.revision,0);
  snapshot={records:[],cards:[]};sync.noteEmptyDeletion();assert.equal(sync.progress.emptyIntent.revision,0);
  assert.equal(client(()=>snapshot).sync.progress.emptyIntent.revision,0,'A confirmed zero baseline must survive reload while its first commit is pending');
  release();await sending;assert.equal(pc.latest.records.length,1);assert.equal(sync.progress.emptyIntent.revision,pc.latest.revision);
  pc.after=null;const reloaded=client(()=>snapshot).sync;await reloaded.send();assert.deepEqual(pc.latest.records,[]);assert.equal(reloaded.progress.emptyIntent,undefined);
});
test('restore preserves exact photos and captions; cancel never updates the revision baseline',async t=>{
  environment(t);const snapshot=await fixture(),pc=peer(),{sync}=client(snapshot);await sync.send();const previous=sync.progress.revision;pc.latest.revision++;pc.latest.records[0].memo='PC 최신 메모';later(pc.latest.records[0]);
  const bundle=await sync.restore();assert.equal(sync.progress.revision,previous);assert.equal(sync.restoring,true);assert.equal(bundle.records[0].memo,'PC 최신 메모');assert.equal(bundle.cards[0].caption,'현장에서 확인한 제품');assert.deepEqual(await bundle.cards[0].blob.arrayBuffer(),await snapshot.cards[0].blob.arrayBuffer());
  const count=pc.calls.length;await sync.send();assert.equal(pc.calls.length,count);sync.cancelRestore(bundle);assert.equal(sync.progress.revision,previous);
  const accepted=await sync.restore();sync.acknowledgeRestore(accepted);assert.equal(sync.progress.revision,pc.latest.revision);assert.equal(sync.restoring,false);
});
test('corrupted restore photos preserve the baseline, and legacy ZIP restoration remains available',async t=>{
  environment(t);const snapshot=await fixture(),pc=peer(),{sync}=client(snapshot);await sync.send();const previous=sync.progress.revision;pc.blobs.values().next().value.bytes[20]=1;
  await assert.rejects(sync.restore(),/검증/);assert.equal(sync.progress.revision,previous);assert.equal(sync.pendingRestore,null);
  pc.latest=null;pc.legacy=await createBundle(snapshot.records,snapshot.cards);const restored=await sync.restore();assert.equal(restored.cards[0].kind,'product');sync.acknowledgeRestore(restored);assert.equal(sync.progress,null);
});
test('automatic backup exceeds 256MiB without reading complete photos into a ZIP',async t=>{
  environment(t);class VirtualPhoto extends Blob{constructor(size){super([],{type:'image/png'});this.reportedSize=size;}get size(){return this.reportedSize;}arrayBuffer(){throw new Error('Complete virtual photo must not be read');}slice(start,end){return new VirtualPhoto(end-start);}}
  const snapshot=await fixture(),size=128*1024*1024+1,first=snapshot.records[0].cards[0];first.size=size;snapshot.cards[0]={...snapshot.cards[0],size,blob:new VirtualPhoto(size),hash:'a'.repeat(64)};
  const id=crypto.randomUUID(),second={...first,id,path:`cards/${id}.png`};snapshot.records[0].cards.push(second);snapshot.cards.push({...second,recordId:snapshot.records[0].id,blob:new VirtualPhoto(size),hash:'b'.repeat(64)});let sent=0,largest=0,manifest;
  globalThis.fetch=async(url,options)=>{const parsed=new URL(url);if(parsed.pathname.endsWith('/status'))return json({chunkBytes:1024*1024,revision:0,records:[],hashes:[],photos:JSON.parse(options.body).photos.map(photo=>({sha256:photo.sha256,offset:0,complete:false}))});
    if(parsed.pathname.includes('/blobs/')){sent+=options.body.size;largest=Math.max(largest,options.body.size);const offset=Number(parsed.searchParams.get('offset'))+options.body.size;return json({offset,complete:offset===size});}manifest=JSON.parse(options.body);return json({revision:manifest.revision,records:1,photos:2,savedAt:now});};
  const {sync}=client(snapshot);await sync.send();assert.ok(sync.signature);assert.ok(sent>MAX_BUNDLE_BYTES);assert.equal(sent,2*size);assert.equal(largest,1024*1024);assert.equal(manifest.photos.length,2);
});

test('visit audio resumes confirmed chunks, sends memo-only updates without audio bytes and restores by bounded ranges',async t=>{
  environment(t);const snapshot=await audioFixture(2*AUDIO_CHUNK_BYTES+64),pc=peer(AUDIO_CHUNK_BYTES),{sync}=client(snapshot);let fail=true;
  pc.after=async call=>{if(fail&&call.bytes){fail=false;throw new Error('Lost audio acknowledgement');}};
  await sync.send();assert.equal(sync.signature,null);assert.equal(pc.latest,null);assert.equal(pc.blobs.values().next().value.bytes.length,AUDIO_CHUNK_BYTES);
  const {sync:reloaded}=client(snapshot);await reloaded.send();assert.ok(reloaded.signature);assert.equal(pc.latest.schemaVersion,3);assert.equal(pc.latest.recordings.length,1);
  const sent=binaryCalls(pc).reduce((sum,call)=>sum+call.bytes,0);snapshot.records[0].memo+=' · 추가 메모';later(snapshot.records[0]);await reloaded.send();
  assert.equal(binaryCalls(pc).reduce((sum,call)=>sum+call.bytes,0),sent);
  const restored=await reloaded.restore();assert.deepEqual(restored.records,snapshot.records);assert.equal(restored.recordings[0].hash,snapshot.recordings[0].hash);
  assert.deepEqual(await restored.recordings[0].blob.arrayBuffer(),await snapshot.recordings[0].blob.arrayBuffer());
  const downloads=pc.calls.filter(call=>call.path?.startsWith('/blobs/')&&call.method==='GET');assert.equal(downloads.length,3);assert.ok(downloads.every(call=>Number(call.query.get('length'))<=AUDIO_CHUNK_BYTES));
  reloaded.cancelRestore(restored);snapshot.records=[];snapshot.recordings=[];reloaded.noteEmptyDeletion();await reloaded.send();assert.equal(pc.latest.schemaVersion,3);assert.deepEqual(pc.latest.recordings,[]);
});

test('corrupted ranged audio restoration leaves the known revision and local records intact',async t=>{
  environment(t);const snapshot=await audioFixture(AUDIO_CHUNK_BYTES+64),pc=peer(AUDIO_CHUNK_BYTES),{sync}=client(snapshot);await sync.send();const baseline=sync.progress.revision;
  pc.blobs.values().next().value.bytes[AUDIO_CHUNK_BYTES+20]^=1;
  await assert.rejects(sync.restore(),/녹음 검증/);assert.equal(sync.progress.revision,baseline);assert.equal(snapshot.recordings.length,1);assert.equal(sync.pendingRestore,null);
});

test('registered visits without audio use v3 and lost audio-manifest acknowledgements stay recoverable',async t=>{
  environment(t);const snapshot=await audioFixture(),pc=peer(AUDIO_CHUNK_BYTES),{sync}=client(snapshot);let fail=true;
  pc.after=async call=>{if(fail&&call.path==='/manifest'&&call.method==='POST'){fail=false;throw new Error('Lost v3 manifest acknowledgement');}};
  await sync.send();assert.equal(sync.signature,null);const count=commits(pc).length,bytes=binaryCalls(pc).length;
  const reloaded=client(snapshot).sync;await reloaded.send();assert.ok(reloaded.signature);assert.equal(commits(pc).length,count);assert.equal(binaryCalls(pc).length,bytes);
  snapshot.records[0].recordings=[];snapshot.recordings=[];later(snapshot.records[0]);await reloaded.send();assert.equal(pc.latest.schemaVersion,3);assert.deepEqual(pc.latest.recordings,[]);assert.equal(pc.latest.records[0].timeBasis,'registered');
});
