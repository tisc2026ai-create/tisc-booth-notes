import test from 'node:test';
import assert from 'node:assert/strict';
import {backupConfig, FieldSync} from '../field-sync.js';

const config = {url:'https://tisc.example.ts.net/', token:'x'.repeat(43), deviceId:'013cf837-4a88-42cd-91d4-9a5afbd58ce9', label:'현장 담당'};
test('backup connection rejects credentials, paths, insecure URLs and malformed pairing values', () => {
  assert.equal(backupConfig(config).url, 'https://tisc.example.ts.net');
  for (const change of [{url:'http://host'}, {url:'https://user:pass@host'}, {url:'https://host/other'},
    {url:'https://host/?token=secret'}, {token:'short'}, {deviceId:'../other'}, {label:'가'.repeat(81)}]) {
    assert.throws(() => backupConfig({...config, ...change}));
  }
});
test('an empty cleared browser cannot overwrite its PC backup, and failed sends remain retryable', async () => {
  globalThis.localStorage = {getItem:()=>null,setItem:()=>{},removeItem:()=>{}};
  Object.defineProperty(globalThis, 'navigator', {value:{onLine:true}, configurable:true});
  let posted = 0, status = '';
  const sync = new FieldSync(async()=>({records:[],cards:[]}), text=>{status=text;});
  sync.config = backupConfig(config); sync.schedule = ()=>{};
  sync.request = async()=>{posted++; throw new Error('offline');};
  await sync.send();
  assert.equal(posted, 0); assert.match(status, /복원/); assert.doesNotMatch(status, /PC 연결됨/);
  const record = {id:config.deviceId, createdAt:'2026-10-19T01:00:00.000Z',updatedAt:'2026-10-19T01:00:00.000Z',
    startAt:'2026-10-19T01:00:00.000Z',endAt:null,company:'업체',memo:'',team:'',visitType:'booth',cards:[]};
  sync.snapshot = async()=>({records:[record],cards:[]});
  await sync.send();
  assert.equal(posted,1); assert.equal(sync.signature,null); assert.match(status,/기기 자료 유지/);
  await sync.send(); assert.equal(posted,2);
  sync.request = async()=>{sync.config=null;status='PC 자동 백업 연결 안 됨';return new Response(JSON.stringify({records:1,savedAt:new Date().toISOString()}));};
  await sync.send();
  assert.equal(status,'PC 자동 백업 연결 안 됨','A late reply must not claim backup is connected after disconnection');
  assert.equal(sync.signature,null);
});
