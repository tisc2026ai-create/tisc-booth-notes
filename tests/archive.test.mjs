import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createBundle, readBundle, validateRecord, MAX_BUNDLE_BYTES } from '../archive.js';
import {audioFixture} from './audio-fixtures.mjs';

const recordId = '013cf837-4a88-42cd-91d4-9a5afbd58ce9';
const cardId = '811d625a-9718-45da-b9f7-b0cba18c7fa4';
const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6U3sAAAAASUVORK5CYII=', 'base64'));
const photo = { id: cardId, name: '고객 명함.png', type: 'image/png', size: png.length, path: `cards/${cardId}.png` };

function record(overrides = {}) {
  return {
    id: recordId, createdAt: '2026-10-19T01:17:00.000Z', updatedAt: '2026-10-19T01:29:00.000Z',
    startAt: '2026-10-19T01:17:00.000Z', endAt: '2026-10-19T01:29:00.000Z',
    company: 'A 도로운영사', memo: '현장 데모 요청\n높이 제한 검지 교체 문의', team: '1조',
    visitType: 'booth', cards: [photo], ...overrides,
  };
}

function card(overrides = {}) {
  return { ...photo, recordId, blob: new Blob([png], { type: photo.type }), ...overrides };
}

async function fixture() {
  return createBundle([record()], [card()]);
}

function crc32(bytes) {
  let checksum = 0xffffffff;
  for (const byte of bytes) {
    checksum ^= byte;
    for (let bit = 0; bit < 8; bit++) checksum = (checksum >>> 1) ^ (checksum & 1 ? 0xedb88320 : 0);
  }
  return (checksum ^ 0xffffffff) >>> 0;
}

async function modifyManifest(bundle, oldText, newText) {
  assert.equal(Buffer.byteLength(oldText), Buffer.byteLength(newText));
  const bytes = new Uint8Array(await bundle.arrayBuffer());
  const view = new DataView(bytes.buffer);
  const dataStart = 30 + view.getUint16(26, true);
  const dataEnd = dataStart + view.getUint32(18, true);
  const before = new TextDecoder().decode(bytes.subarray(dataStart, dataEnd));
  assert.ok(before.includes(oldText));
  bytes.set(new TextEncoder().encode(before.replace(oldText, newText)), dataStart);
  const checksum = crc32(bytes.subarray(dataStart, dataEnd));
  view.setUint32(14, checksum, true);
  const centralStart = view.getUint32(bytes.length - 6, true);
  view.setUint32(centralStart + 16, checksum, true);
  return new Blob([bytes], { type: 'application/zip' });
}

test('round trip preserves Korean notes, consultation timestamps, card metadata and exact image bytes', async () => {
  const bundle = await fixture();
  assert.equal(bundle.type, 'application/zip');
  const restored = await readBundle(bundle);
  assert.deepEqual(restored.records, [record()]);
  const { blob, ...metadata } = restored.cards[0];
  assert.deepEqual(metadata, { ...photo, recordId });
  assert.equal(blob.type, 'image/png');
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), png);
});

test('empty exports and unfinished consultations remain usable', async () => {
  assert.deepEqual(await readBundle(await createBundle([], [])), { records: [], cards: [] });
  const draft = record({ company: '', endAt: null, cards: [] });
  assert.deepEqual((await readBundle(await createBundle([draft], []))).records, [draft]);
});

test('ZIP v2 preserves registered visits and exact audio bytes while v1 remains unchanged',async()=>{
  const fixture=await audioFixture();const bundle=await createBundle(fixture.records,fixture.cards,fixture.recordings),restored=await readBundle(bundle);
  assert.deepEqual(restored.records,fixture.records);assert.deepEqual(restored.cards,[]);assert.equal(restored.recordings.length,1);
  assert.deepEqual(await restored.recordings[0].blob.arrayBuffer(),await fixture.recordings[0].blob.arrayBuffer());
  assert.equal(restored.recordings[0].type,'audio/wav');assert.equal(restored.records[0].timeBasis,'registered');
  await assert.rejects(readBundle(await modifyManifest(bundle,'"schemaVersion":2','"schemaVersion":1')),/버전/);
  await assert.rejects(createBundle(fixture.records,[],[]),/누락/);
  assert.throws(()=>validateRecord({...fixture.records[0],endAt:fixture.records[0].createdAt}),/등록 시각/);
  assert.throws(()=>validateRecord({...fixture.records[0],recordings:[...fixture.records[0].recordings,...fixture.records[0].recordings]}),/하나/);
});

test('oversized audio ZIP is rejected before reading a complete recording',async()=>{
  const fixture=await audioFixture(),size=MAX_BUNDLE_BYTES+1;
  class OversizedAudio extends Blob{get size(){return size;}arrayBuffer(){throw new Error('Must not read oversized audio into a ZIP');}}
  fixture.records[0].recordings[0].size=size;fixture.recordings[0].size=size;fixture.recordings[0].blob=new OversizedAudio([],{type:'audio/wav'});
  await assert.rejects(createBundle(fixture.records,[],fixture.recordings),/256MB/);
});

test('photo purpose and description survive ZIP transfer without changing legacy metadata', async () => {
  for (const kind of ['card', 'badge', 'product', 'booth', 'other']) {
    const metadata = {...photo, kind, caption: '확인할 제품 표시'};
    const source = record({cards: [metadata]});
    const restored = await readBundle(await createBundle([source], [card(metadata)]));
    assert.deepEqual(restored.records, [source]);
    assert.equal(restored.cards[0].kind, kind);
    assert.equal(restored.cards[0].caption, metadata.caption);
  }
  assert.throws(() => validateRecord(record({cards: [{...photo, kind: 'invalid'}]})), /용도/);
  assert.throws(() => validateRecord(record({cards: [{...photo, caption: '가'.repeat(2001)}]})), /설명/);
  await assert.rejects(createBundle([record({cards: [{...photo, kind:'badge'}]})], [card()]), /연결/);
});

test('new records with no team and legacy team values both survive ZIP round trips', async () => {
  for (const team of ['', '1조', '2조']) {
    const source = record({ team, cards: [] });
    assert.deepEqual((await readBundle(await createBundle([source], []))).records, [source]);
  }
});

test('record validation rejects impossible dates, reversed times and oversized strings', () => {
  assert.throws(() => validateRecord(record({ startAt: '2026-02-30T01:17:00.000Z' })), /날짜/);
  assert.throws(() => validateRecord(record({ endAt: '2026-10-19T01:16:59.000Z' })), /종료/);
  assert.throws(() => validateRecord(record({ company: '가'.repeat(201) })), /회사명/);
  assert.throws(() => validateRecord(record({ memo: '가'.repeat(5001) })), /메모/);
});

test('card paths and image types cannot escape the supported schema', async () => {
  assert.throws(() => validateRecord(record({ cards: [{ ...photo, path: '../private.png' }] })), /경로/);
  assert.throws(() => validateRecord(record({ cards: [{ ...photo, type: 'image/svg+xml' }] })), /JPG/);
  assert.throws(() => validateRecord(record({ cards: [{ ...photo, type: ['image/png'] }] })), /JPG/);
  await assert.rejects(createBundle([record()], [card({ blob: new Blob([png], { type: 'image/jpeg' }) })]), /형식/);
  await assert.rejects(createBundle([record()], [card({ blob: new Blob([new Uint8Array(png.length)], { type: 'image/png' }) })]), /이미지 형식/);
});

test('missing, orphaned, duplicate or incorrectly linked cards are refused before export', async () => {
  await assert.rejects(createBundle([record()], []), /누락/);
  await assert.rejects(createBundle([record({ cards: [] })], [card()]), /불필요/);
  await assert.rejects(createBundle([record()], [card({ recordId: '2bb150b1-dbd3-44a7-93b9-2a547a2dbe0a' })]), /연결/);
  await assert.rejects(createBundle([record(), record()], [card()]), /상담 ID/);
  assert.throws(() => validateRecord(record({ cards: [photo, photo] })), /명함 ID/);
});

test('a corrupted image is rejected by CRC, and truncated files are rejected', async () => {
  const bundle = await fixture();
  const bytes = new Uint8Array(await bundle.arrayBuffer());
  const view = new DataView(bytes.buffer);
  const secondHeader = 30 + view.getUint16(26, true) + view.getUint32(18, true);
  const photoStart = secondHeader + 30 + view.getUint16(secondHeader + 26, true);
  bytes[photoStart + png.length - 1] ^= 1;
  await assert.rejects(readBundle(new Blob([bytes])), /손상/);
  await assert.rejects(readBundle(bundle.slice(0, bundle.size - 1)), /ZIP/);
});

test('a traversal path in the ZIP directory is rejected even when payload CRC remains valid', async () => {
  const bytes = new Uint8Array(await (await fixture()).arrayBuffer());
  const view = new DataView(bytes.buffer);
  const centralStart = view.getUint32(bytes.length - 6, true);
  bytes.set(new TextEncoder().encode('../ifest.json'), 30);
  bytes.set(new TextEncoder().encode('../ifest.json'), centralStart + 46);
  await assert.rejects(readBundle(new Blob([bytes])), /경로/);
});

test('duplicate ZIP names and unsupported compression are refused', async () => {
  const other = { ...photo, id: 'bde7fcf4-c3a5-4106-87be-04fe676f7c2d', path: 'cards/bde7fcf4-c3a5-4106-87be-04fe676f7c2d.png' };
  const bundle = await createBundle([record({ cards: [photo, other] })], [card(), card(other)]);
  const bytes = new Uint8Array(await bundle.arrayBuffer());
  const view = new DataView(bytes.buffer);
  const centralStart = view.getUint32(bytes.length - 6, true);
  const secondIndex = centralStart + 46 + view.getUint16(centralStart + 28, true);
  const thirdIndex = secondIndex + 46 + view.getUint16(secondIndex + 28, true);
  const thirdLocal = view.getUint32(thirdIndex + 42, true);
  bytes.set(new TextEncoder().encode(photo.path), thirdLocal + 30);
  bytes.set(new TextEncoder().encode(photo.path), thirdIndex + 46);
  await assert.rejects(readBundle(new Blob([bytes])), /중복/);

  const compressed = new Uint8Array(await (await fixture()).arrayBuffer());
  const compressedView = new DataView(compressed.buffer);
  compressedView.setUint16(compressedView.getUint32(compressed.length - 6, true) + 10, 8, true);
  await assert.rejects(readBundle(new Blob([compressed])), /지원하지 않는 ZIP/);
});

test('valid ZIP checksums do not bypass manifest version or timestamp validation', async () => {
  const bundle = await fixture();
  await assert.rejects(readBundle(await modifyManifest(bundle, '"schemaVersion":1', '"schemaVersion":3')), /버전/);
  await assert.rejects(readBundle(await modifyManifest(bundle, '2026-10-19T01:17:00.000Z', '2026-02-30T01:17:00.000Z')), /날짜/);
});

test('oversized input is rejected before reading the Blob', async () => {
  class OversizedBlob extends Blob {
    get size() { return MAX_BUNDLE_BYTES + 1; }
    arrayBuffer() { throw new Error('oversized input must not be read'); }
  }
  await assert.rejects(readBundle(new OversizedBlob()), /256MB/);
});

test('Python standard zipfile reads exported archives and verifies every checksum', async context => {
  const bytes = Buffer.from(await (await fixture()).arrayBuffer());
  const result = spawnSync('python3', ['-c', [
    'import io,json,sys,zipfile',
    'with zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())) as z:',
    ' assert z.testzip() is None',
    ' assert all(i.compress_type == zipfile.ZIP_STORED for i in z.infolist())',
    ' m=json.loads(z.read("manifest.json"))',
    ' assert m["schemaVersion"] == 1',
    ' assert m["records"][0]["company"] == "A 도로운영사"',
    ' assert z.read(m["records"][0]["cards"][0]["path"]).startswith(bytes([137,80,78,71]))',
  ].join('\n')], { input: bytes, encoding: 'utf8' });
  if (result.error?.code === 'ENOENT') return context.skip('Python is not installed; native round-trip tests still run.');
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
});
