import test from 'node:test';
import assert from 'node:assert/strict';
import { deleteRecords } from '../storage.js';

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
