import test from 'node:test';
import assert from 'node:assert/strict';
import { deleteRecords, importRecords } from '../storage.js';

const target = { id: '013cf837-4a88-42cd-91d4-9a5afbd58ce9', updatedAt: '2026-10-14T01:17:00.000Z' };

test('deletion validates IDs and canonical revision times before opening storage', async () => {
  const invalid = [null, {}, [], new Array(5001).fill(target), [null], [[]], [{}],
    [{ ...target, id: 123 }], [{ ...target, id: '../other-record' }],
    [{ ...target, updatedAt: null }], [{ ...target, updatedAt: '2026-02-30T01:17:00.000Z' }],
    [{ ...target, updatedAt: '2026-10-14T01:17:00+00:00' }], [{ ...target, updatedAt: '2026-10-14T01:17:00Z' }]];
  for (const values of invalid) await assert.rejects(deleteRecords(values), /삭제할 상담/);
});

test('deletion refuses duplicate target IDs including different UUID letter case', async () => {
  await assert.rejects(deleteRecords([target, { ...target, updatedAt: '2026-10-14T02:00:00.000Z' }]), /중복/);
  await assert.rejects(deleteRecords([target, { ...target, id: target.id.toUpperCase() }]), /중복/);
});

test('restore reads and hashes one photo at a time before its atomic storage transaction', async () => {
  let reading = 0, peak = 0, completed = 0;
  class MeasuredPhoto extends Blob {
    async arrayBuffer() {
      reading++; peak = Math.max(peak, reading);
      await new Promise(resolve => setTimeout(resolve, 1));
      try { return await super.arrayBuffer(); }
      finally { reading--; completed++; }
    }
  }
  const photos = Array.from({length: 8}, () => {
    const id = crypto.randomUUID(), blob = new MeasuredPhoto([new Uint8Array(64)], {type: 'image/png'});
    return {id, recordId: target.id, name: 'restore.png', type: blob.type, size: blob.size, path: `cards/${id}.png`, blob};
  });
  const record = {id: target.id, createdAt: target.updatedAt, updatedAt: target.updatedAt, startAt: target.updatedAt,
    endAt: null, company: '', memo: '', team: '', visitType: 'booth', cards: photos.map(({recordId, blob, ...metadata}) => metadata)};
  // Node has no IndexedDB: validation and every hash finish before storage is opened.
  await assert.rejects(importRecords({records: [record], cards: photos}), /기기 저장 기능/);
  assert.equal(completed, 8);
  assert.equal(peak, 1, 'Restoration must not allocate all photo ArrayBuffers concurrently');
});
