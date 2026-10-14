import { validateRecord } from './archive.js';
import {recordingDigest} from './assets.js';

let database = null;
let opening = null;
const metadataKeys = ['id', 'name', 'type', 'size', 'path', 'kind', 'caption'];
const assetStores = ['cards','recordings'];

function storageError(error) {
  if (error?.name === 'QuotaExceededError') return new Error('기기 저장 공간이 부족합니다. 기록을 내보내 백업한 뒤 공간을 확보해 주세요.');
  return error || new Error('기기에 기록을 저장하지 못했습니다.');
}

export async function openStorage() {
  if (database) return;
  if (!opening) {
    opening = new Promise((resolve, reject) => {
      if (!globalThis.indexedDB) return reject(new Error('이 브라우저에서는 기기 저장 기능을 사용할 수 없습니다.'));
      const request = indexedDB.open('tisc-booth-notes', 2);
      let blocked = false;
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('records')) db.createObjectStore('records', {keyPath:'id'});
        for (const name of assetStores) if (!db.objectStoreNames.contains(name)) db.createObjectStore(name,{keyPath:'id'}).createIndex('recordId','recordId');
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

export async function getRecordings() {
  return transaction(['recordings'],'readonly',(tx,receive,result) => receive(tx.objectStore('recordings').getAll(),result));
}

export async function getSnapshot() {
  return transaction(['records', ...assetStores], 'readonly', (tx, receive, result) => {
    const snapshot = {};
    receive(tx.objectStore('records').getAll(), records => { snapshot.records = records; });
    receive(tx.objectStore('cards').getAll(), cards => { snapshot.cards = cards; });
    receive(tx.objectStore('recordings').getAll(), recordings => { snapshot.recordings = recordings; });
    result(snapshot);
  });
}

function sameRecord(left, right) {
  return JSON.stringify(validateRecord(left)) === JSON.stringify(validateRecord(right));
}

function sameMetadata(left, right, kind = 'cards') {
  return (kind === 'cards' ? metadataKeys : ['id','name','type','size','path']).every(key => left[key] === right[key]);
}

function assertReferences(record, cards, kind = 'cards') {
  const references = record[kind] || [];
  if (references.length !== cards.size || references.some(card => {
    const stored = cards.get(card.id);
    return !stored || stored.recordId !== record.id || !sameMetadata(card, stored, kind);
  })) throw new Error('상담 기록과 명함 파일의 연결이 일치하지 않습니다. 기록을 다시 불러와 주세요.');
}

async function prepareCard(record, card, kind = 'cards', onProgress) {
  const reference = (record[kind] || []).find(item => item.id === card?.id);
  const blob = card?.blob;
  if (!reference || card.recordId !== record.id || !sameMetadata(reference, card, kind)
      || !(blob instanceof Blob) || blob.type !== reference.type || blob.size !== reference.size) {
    throw new Error('명함 파일과 상담의 연결 정보, 크기 또는 형식이 올바르지 않습니다.');
  }
  if (kind === 'recordings') return {...reference,recordId:record.id,blob,hash:await recordingDigest(blob,onProgress)};
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

async function writeRecord(value, newAsset = null, removedId = null, expectedUpdatedAt = null, kind = 'cards', onProgress) {
  const record = validateRecord(value);
  const added = newAsset ? await prepareCard(record,newAsset,kind,onProgress) : null;
  return transaction(['records',...assetStores],'readwrite',(tx,receive) => {
    const records = tx.objectStore('records');
    receive(records.get(record.id),existing => {
      if ((existing?.updatedAt ?? null) !== expectedUpdatedAt) throw new Error('다른 화면에서 이 상담을 수정했습니다. 덮어쓰지 않았습니다. 기록을 다시 불러온 뒤 수정해 주세요.');
      assertRevision(record,existing);
      const linked = {}, removed = [];
      let pending = assetStores.length;
      const save = () => {
        const selected = linked[kind];
        if (removedId && !selected.has(removedId)) throw new Error('이 기록에 연결된 첨부 파일이 아닙니다. 삭제하지 않았습니다.');
        if (removedId) selected.delete(removedId);
        if (added) {
          if (kind === 'recordings') { for (const id of selected.keys()) if (id !== added.id) removed.push(id); selected.clear(); }
          selected.set(added.id,added);
        }
        for (const name of assetStores) assertReferences(record,linked[name],name);
        records.put(record);
        const store = tx.objectStore(kind);
        for (const id of removed) store.delete(id);
        if (removedId) store.delete(removedId);
        if (added) store.put(added);
      };
      const ready = () => {
        if (!added) { save(); return; }
        receive(tx.objectStore(kind).get(added.id),current => {
          if (current && current.recordId !== record.id) throw new Error('이미 다른 기록에 연결된 첨부 ID입니다. 저장하지 않았습니다.');
          if (current && existing?.updatedAt === record.updatedAt && current.hash !== added.hash) throw new Error('같은 수정 시각의 첨부 내용이 다릅니다. 덮어쓰지 않았습니다.');
          const other = kind === 'cards' ? 'recordings' : 'cards';
          receive(tx.objectStore(other).get(added.id),collision => {
            if (collision) throw new Error('사진과 녹음의 ID가 중복되었습니다.');
            save();
          });
        });
      };
      for (const name of assetStores) receive(tx.objectStore(name).index('recordId').getAll(record.id),stored => {
        linked[name] = new Map(stored.map(asset => [asset.id,asset]));
        if (!--pending) ready();
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

export async function saveRecording(record, recording, expectedUpdatedAt = null, onProgress) {
  await writeRecord(record,recording,null,expectedUpdatedAt,'recordings',onProgress);
}

export async function deleteRecording(record, id, expectedUpdatedAt = null) {
  if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) throw new Error('삭제할 녹음 ID가 올바르지 않습니다.');
  await writeRecord(record,null,id,expectedUpdatedAt,'recordings');
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
  return transaction(['records', ...assetStores], 'readwrite', (tx, receive) => {
    const records = tx.objectStore('records');
    let remaining = targets.size;
    for (const [id, updatedAt] of targets) {
      receive(records.get(id), existing => {
        if (!existing || existing.updatedAt !== updatedAt) throw new Error('다른 화면에서 이 상담을 수정하거나 삭제했습니다. 아무 상담도 삭제하지 않았습니다. 기록을 다시 불러와 주세요.');
        if (--remaining) return;
        for (const targetId of targets.keys()) {
          records.delete(targetId);
          for (const name of assetStores) {
            const store = tx.objectStore(name);
            receive(store.index('recordId').getAllKeys(targetId),ids => {for (const id of ids) store.delete(id);});
          }
        }
      });
    }
  });
}

export async function importRecords(bundle) {
  if (!bundle || !Array.isArray(bundle.records) || !Array.isArray(bundle.cards) || bundle.records.length > 5000
      || (bundle.recordings !== undefined && !Array.isArray(bundle.recordings))) throw new Error('가져올 기록과 첨부 목록이 올바르지 않습니다.');
  const records = bundle.records.map(validateRecord), byId = new Map(records.map(record => [record.id,record]));
  if (byId.size !== records.length) throw new Error('가져올 상담 ID가 중복되었습니다.');
  const incoming = {cards:bundle.cards,recordings:bundle.recordings || []}, incomingById = {}, ids = new Set();
  if (incoming.cards.length + incoming.recordings.length > 4999) throw new Error('첨부 파일 목록이 너무 큽니다.');
  for (const kind of assetStores) {
    const references = new Map();
    for (const record of records) for (const asset of record[kind] || []) {
      if (ids.has(asset.id)) throw new Error('첨부 ID가 중복되었습니다.');
      ids.add(asset.id); references.set(asset.id,record.id);
    }
    if (references.size !== incoming[kind].length) throw new Error('기록에 연결된 첨부 파일이 누락되었거나 불필요한 첨부가 있습니다.');
    const prepared = new Map();
    // Finish bounded, sequential hashing before opening the one atomic transaction.
    for (const asset of incoming[kind]) {
      if (!asset || prepared.has(asset.id) || references.get(asset.id) !== asset.recordId) throw new Error('첨부 ID 또는 기록 연결이 올바르지 않습니다.');
      prepared.set(asset.id,await prepareCard(byId.get(asset.recordId),asset,kind));
    }
    incomingById[kind] = prepared;
  }
  return transaction(['records',...assetStores],'readwrite',(tx,receive,result) => {
    const stored = {};
    let pending = 3;
    const apply = () => {
      const storedById = new Map(stored.records.map(record => [record.id,record]));
      const storedAssets = Object.fromEntries(assetStores.map(kind => [kind,new Map(stored[kind].map(asset => [asset.id,asset]))]));
      const counts = {added:0,updated:0,skipped:0}, changes = [];
      for (const record of records) {
        const existing = storedById.get(record.id);
        for (const kind of assetStores) for (const asset of record[kind] || []) {
          const current = storedAssets[kind].get(asset.id), other = kind === 'cards' ? 'recordings' : 'cards';
          if ((current && current.recordId !== record.id) || storedAssets[other].has(asset.id)) throw new Error('다른 기록에 연결되었거나 중복된 첨부 ID입니다. 아무 기록도 가져오지 않았습니다.');
        }
        if (existing && record.updatedAt === existing.updatedAt) {
          if (!sameRecord(record,existing) || assetStores.some(kind => (record[kind] || []).some(asset => storedAssets[kind].get(asset.id)?.hash !== incomingById[kind].get(asset.id).hash))) throw new Error('같은 수정 시각의 서로 다른 기록 또는 첨부가 있습니다. 아무 기록도 덮어쓰지 않았습니다.');
          counts.skipped++;
        } else if (existing && record.updatedAt < existing.updatedAt) counts.skipped++;
        else {
          if ((existing?.recordings?.length && record.recordings === undefined) || (existing?.timeBasis !== undefined && record.timeBasis === undefined)) throw new Error('방문·녹음 정보가 없는 기존 형식으로 방문 기록을 덮어쓸 수 없습니다.');
          counts[existing ? 'updated' : 'added']++;changes.push(record);
        }
      }
      for (const record of changes) {
        tx.objectStore('records').put(record);
        for (const kind of assetStores) {
          const store = tx.objectStore(kind);
          for (const asset of stored[kind]) if (asset.recordId === record.id) store.delete(asset.id);
          for (const asset of record[kind] || []) store.put(incomingById[kind].get(asset.id));
        }
      }
      result(counts);
    };
    for (const kind of ['records',...assetStores]) receive(tx.objectStore(kind).getAll(),values => {stored[kind] = values;if (!--pending) apply();});
  });
}
