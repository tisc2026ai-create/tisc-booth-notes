import { validateRecord } from './archive.js';

let database = null;
let opening = null;
const metadataKeys = ['id', 'name', 'type', 'size', 'path'];

function storageError(error) {
  if (error?.name === 'QuotaExceededError') return new Error('기기 저장 공간이 부족합니다. 기록을 내보내 백업한 뒤 공간을 확보해 주세요.');
  return error || new Error('기기에 기록을 저장하지 못했습니다.');
}

export async function openStorage() {
  if (database) return;
  if (!opening) {
    opening = new Promise((resolve, reject) => {
      if (!globalThis.indexedDB) return reject(new Error('이 브라우저에서는 기기 저장 기능을 사용할 수 없습니다.'));
      const request = indexedDB.open('tisc-booth-notes', 1);
      let blocked = false;
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore('records', { keyPath: 'id' });
        db.createObjectStore('cards', { keyPath: 'id' }).createIndex('recordId', 'recordId');
      };
      request.onblocked = () => {
        blocked = true;
        reject(new Error('다른 탭에서 기록 화면을 닫은 뒤 다시 열어 주세요. 저장소 업데이트가 대기 중입니다.'));
      };
      request.onerror = () => reject(storageError(request.error));
      request.onsuccess = () => {
        const db = request.result;
        if (blocked) { db.close(); return; }
        database = db;
        db.onversionchange = () => {
          db.close();
          if (database === db) { database = null; opening = null; }
        };
        db.onclose = () => {
          if (database === db) { database = null; opening = null; }
        };
        resolve();
      };
    }).catch(error => { opening = null; throw error; });
  }
  await opening;
}

async function transaction(stores, mode, action) {
  await openStorage();
  return new Promise((resolve, reject) => {
    let tx;
    try { tx = database.transaction(stores, mode); }
    catch (error) { reject(storageError(error)); return; }
    let result;
    let failure;
    const abort = error => { failure = error; tx.abort(); };
    const receive = (request, callback) => {
      request.onsuccess = () => {
        try { callback(request.result); }
        catch (error) { abort(error); }
      };
    };
    tx.oncomplete = () => resolve(result);
    tx.onabort = () => reject(storageError(failure || tx.error));
    try { action(tx, receive, value => { result = value; }); }
    catch (error) { abort(error); }
  });
}

export async function getRecords() {
  return transaction(['records'], 'readonly', (tx, receive, result) => {
    receive(tx.objectStore('records').getAll(), result);
  });
}

export async function getCards() {
  return transaction(['cards'], 'readonly', (tx, receive, result) => {
    receive(tx.objectStore('cards').getAll(), result);
  });
}

function sameRecord(left, right) {
  return JSON.stringify(validateRecord(left)) === JSON.stringify(validateRecord(right));
}

function sameMetadata(left, right) {
  return metadataKeys.every(key => left[key] === right[key]);
}

function assertReferences(record, cards) {
  if (record.cards.length !== cards.size || record.cards.some(card => {
    const stored = cards.get(card.id);
    return !stored || stored.recordId !== record.id || !sameMetadata(card, stored);
  })) throw new Error('상담 기록과 명함 파일의 연결이 일치하지 않습니다. 기록을 다시 불러와 주세요.');
}

async function prepareCard(record, card) {
  const reference = record.cards.find(item => item.id === card?.id);
  const blob = card?.blob;
  if (!reference || card.recordId !== record.id || !sameMetadata(reference, card)
      || !(blob instanceof Blob) || blob.type !== reference.type || blob.size !== reference.size) {
    throw new Error('명함 파일과 상담의 연결 정보, 크기 또는 형식이 올바르지 않습니다.');
  }
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  return { ...reference, recordId: record.id, blob, hash };
}

function assertRevision(record, existing) {
  if (!existing) return;
  if (record.updatedAt < existing.updatedAt) throw new Error('더 최근에 저장된 상담이 있습니다. 기록을 다시 불러온 뒤 수정해 주세요.');
  if (record.updatedAt === existing.updatedAt && !sameRecord(record, existing)) {
    throw new Error('같은 수정 시각의 서로 다른 상담 내용이 있습니다. 덮어쓰지 않았습니다. 기록을 다시 불러와 주세요.');
  }
}

async function writeRecord(value, newCard = null, removedId = null, expectedUpdatedAt = null) {
  const record = validateRecord(value);
  const added = newCard ? await prepareCard(record, newCard) : null;
  return transaction(['records', 'cards'], 'readwrite', (tx, receive) => {
    const records = tx.objectStore('records');
    const cards = tx.objectStore('cards');
    receive(records.get(record.id), existing => {
      if ((existing?.updatedAt ?? null) !== expectedUpdatedAt) {
        throw new Error('다른 화면에서 이 상담을 수정했습니다. 덮어쓰지 않았습니다. 기록을 다시 불러온 뒤 수정해 주세요.');
      }
      assertRevision(record, existing);
      receive(cards.index('recordId').getAll(record.id), stored => {
        const linked = new Map(stored.map(card => [card.id, card]));
        const save = () => {
          if (removedId && !linked.has(removedId)) throw new Error('이 상담에 연결된 명함이 아닙니다. 삭제하지 않았습니다.');
          if (removedId) linked.delete(removedId);
          if (added) linked.set(added.id, added);
          assertReferences(record, linked);
          records.put(record);
          if (added) cards.put(added);
          if (removedId) cards.delete(removedId);
        };
        if (!added) { save(); return; }
        receive(cards.get(added.id), current => {
          if (current && current.recordId !== record.id) throw new Error('이미 다른 상담에 연결된 명함 ID입니다. 저장하지 않았습니다.');
          if (current && existing?.updatedAt === record.updatedAt && current.hash !== added.hash) {
            throw new Error('같은 수정 시각의 명함 사진 내용이 다릅니다. 덮어쓰지 않았습니다.');
          }
          save();
        });
      });
    });
  });
}

export async function saveRecord(record, expectedUpdatedAt = null) {
  await writeRecord(record, null, null, expectedUpdatedAt);
}

export async function saveCard(record, card, expectedUpdatedAt = null) {
  await writeRecord(record, card, null, expectedUpdatedAt);
}

export async function deleteCard(record, cardId, expectedUpdatedAt = null) {
  if (typeof cardId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(cardId)) throw new Error('삭제할 명함 ID가 올바르지 않습니다.');
  await writeRecord(record, null, cardId, expectedUpdatedAt);
}

export async function deleteRecords(values) {
  if (!Array.isArray(values) || !values.length || values.length > 5000) throw new Error('삭제할 상담 목록이 올바르지 않습니다.');
  const targets = new Map();
  for (const value of values) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || typeof value.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.id)
        || typeof value.updatedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.updatedAt)
        || !Number.isFinite(Date.parse(value.updatedAt)) || new Date(value.updatedAt).toISOString() !== value.updatedAt) {
      throw new Error('삭제할 상담 ID 또는 수정 시각이 올바르지 않습니다.');
    }
    const id = value.id.toLowerCase();
    if (targets.has(id)) throw new Error('삭제할 상담 ID가 중복되었습니다.');
    targets.set(id, value.updatedAt);
  }
  return transaction(['records', 'cards'], 'readwrite', (tx, receive) => {
    const records = tx.objectStore('records');
    const cards = tx.objectStore('cards');
    let remaining = targets.size;
    for (const [id, updatedAt] of targets) {
      receive(records.get(id), existing => {
        if (!existing || existing.updatedAt !== updatedAt) throw new Error('다른 화면에서 이 상담을 수정하거나 삭제했습니다. 아무 상담도 삭제하지 않았습니다. 기록을 다시 불러와 주세요.');
        if (--remaining) return;
        for (const targetId of targets.keys()) {
          records.delete(targetId);
          receive(cards.index('recordId').getAllKeys(targetId), ids => {
            for (const cardId of ids) cards.delete(cardId);
          });
        }
      });
    }
  });
}

export async function importRecords(bundle) {
  if (!bundle || !Array.isArray(bundle.records) || !Array.isArray(bundle.cards) || bundle.records.length > 5000 || bundle.cards.length > 4999) {
    throw new Error('가져올 상담 목록과 명함 목록이 올바르지 않습니다.');
  }
  const records = bundle.records.map(validateRecord);
  const byId = new Map(records.map(record => [record.id, record]));
  if (byId.size !== records.length) throw new Error('가져올 상담 ID가 중복되었습니다.');
  const references = new Map();
  for (const record of records) {
    for (const card of record.cards) {
      if (references.has(card.id)) throw new Error('명함이 여러 상담에 중복 연결되었습니다.');
      references.set(card.id, record.id);
    }
  }
  if (references.size !== bundle.cards.length) throw new Error('상담에 연결된 명함 파일이 누락되었거나 불필요한 명함이 있습니다.');
  const ids = new Set();
  for (const card of bundle.cards) {
    if (!card || ids.has(card.id) || references.get(card.id) !== card.recordId) throw new Error('명함 ID 또는 상담 연결이 올바르지 않습니다.');
    ids.add(card.id);
  }
  // 명함 검증과 해시는 트랜잭션 전에 완료해 비동기 대기 중 일부만 저장되는 일을 막습니다.
  const incomingCards = await Promise.all(bundle.cards.map(card => prepareCard(byId.get(card.recordId), card)));
  const incomingById = new Map(incomingCards.map(card => [card.id, card]));
  return transaction(['records', 'cards'], 'readwrite', (tx, receive, result) => {
    const recordStore = tx.objectStore('records');
    const cardStore = tx.objectStore('cards');
    receive(recordStore.getAll(), storedRecords => {
      const storedById = new Map(storedRecords.map(record => [record.id, record]));
      receive(cardStore.getAll(), storedCards => {
        const storedCardsById = new Map(storedCards.map(card => [card.id, card]));
        const counts = { added: 0, updated: 0, skipped: 0 };
        const changes = [];
        for (const record of records) {
          const existing = storedById.get(record.id);
          for (const card of record.cards) {
            const current = storedCardsById.get(card.id);
            if (current && current.recordId !== record.id) throw new Error('다른 상담에 연결된 명함 ID가 포함되어 있습니다. 아무 기록도 가져오지 않았습니다.');
          }
          if (existing && record.updatedAt === existing.updatedAt) {
            if (!sameRecord(record, existing) || record.cards.some(card => storedCardsById.get(card.id)?.hash !== incomingById.get(card.id).hash)) {
              throw new Error('같은 수정 시각의 서로 다른 상담 또는 명함이 있습니다. 아무 기록도 덮어쓰지 않았습니다.');
            }
            counts.skipped++;
          } else if (existing && record.updatedAt < existing.updatedAt) {
            counts.skipped++;
          } else {
            counts[existing ? 'updated' : 'added']++;
            changes.push(record);
          }
        }
        for (const record of changes) {
          for (const oldCard of storedCards) {
            if (oldCard.recordId === record.id) cardStore.delete(oldCard.id);
          }
          recordStore.put(record);
          for (const card of record.cards) cardStore.put(incomingById.get(card.id));
        }
        result(counts);
      });
    });
  });
}
