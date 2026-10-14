import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {AUDIO_CHUNK_BYTES,MAX_RECORDING_BYTES,recordingDigest,normalizeRecording,recordingMetadata,validateRecordingHeader} from '../assets.js';
import {wavBytes,audioFixture} from './audio-fixtures.mjs';

test('audio digest reads fixed bounded chunks and matches the Python reference including its domain prefix',async()=>{
  const bytes=wavBytes(AUDIO_CHUNK_BYTES+17),slices=[];
  class Bounded extends Blob{arrayBuffer(){throw new Error('Entire audio must not be read');}slice(start,end,type){slices.push(end-start);return super.slice(start,end,type);}}
  const progress=[],actual=await recordingDigest(new Bounded([bytes],{type:'audio/wav'}),(done,total)=>progress.push([done,total]));
  const reference=spawnSync('python3',['-c',"import sys,hashlib; b=sys.stdin.buffer.read(); n=1048576; prefix=('TISC-AUDIO-TREE-SHA256-v1\\0'+str(len(b))+'\\0audio/wav\\0'+str(n)+'\\0').encode(); print(hashlib.sha256(prefix+b''.join(hashlib.sha256(b[i:i+n]).digest() for i in range(0,len(b),n))).hexdigest())"],{input:bytes,encoding:'utf8'});
  assert.equal(reference.status,0);assert.equal(actual,reference.stdout.trim());assert.equal(Math.max(...slices),AUDIO_CHUNK_BYTES);assert.deepEqual(progress.at(-1),[bytes.length,bytes.length]);
});
test('recording normalization accepts alias and empty MIME only with matching names and content',async()=>{
  for(const type of ['','audio/x-wav','application/octet-stream','audio/wav'])assert.equal((await normalizeRecording(new File([wavBytes()],'녹음.WAV',{type}))).type,'audio/wav');
  const mp4=new Uint8Array(16);mp4.set(new TextEncoder().encode('ftyp'),4);
  assert.equal((await normalizeRecording(new File([mp4],'녹음.mp4',{type:'video/mp4'}))).type,'audio/mp4');
  assert.equal((await normalizeRecording(new File([mp4],'녹음.m4a',{type:'audio/x-m4a'}))).type,'audio/mp4');
  await assert.rejects(normalizeRecording(new File([wavBytes()],'잘못된.mp3',{type:''})),/일치/);
  await assert.rejects(normalizeRecording(new File([wavBytes()],'잘못된.wav',{type:'image/png'})),/형식/);
  await assert.rejects(normalizeRecording(new File([wavBytes()],'잘못된.html',{type:''})),/형식/);
});
test('audio metadata enforces canonical paths and the 2GiB cap before reading bytes',async()=>{
  const fixture=await audioFixture(),metadata=fixture.records[0].recordings[0];
  assert.deepEqual(recordingMetadata(metadata),metadata);
  assert.throws(()=>recordingMetadata({...metadata,path:'../audio.wav'}),/경로/);
  assert.throws(()=>recordingMetadata({...metadata,size:MAX_RECORDING_BYTES+1}),/2GiB/);
  class Oversized extends Blob{get size(){return MAX_RECORDING_BYTES+1;}slice(){throw new Error('must not read');}}
  await assert.rejects(recordingDigest(new Oversized([],{type:'audio/wav'})),/크기/);
  assert.throws(()=>validateRecordingHeader(wavBytes(),'audio/mpeg'),/일치/);
});
