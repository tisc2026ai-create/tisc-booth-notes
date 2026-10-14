import {readBundle, validateRecord, validateImage} from './archive.js';
import {AUDIO_CHUNK_BYTES, recordingDigest, recordingTreeDigest, validateRecordingHeader, sha256} from './assets.js';

const KEY = 'tisc-pc-backup';
const MAX_JSON_BYTES = 8 * 1024 * 1024;
const MAX_CHUNK_BYTES = 8 * 1024 * 1024;
const HASH = /^[0-9a-f]{64}$/;
const RESTORE_FIRST = '다른 탭이나 기기의 최신 PC 백업이 있습니다. PC 백업 복원 후 다시 전송해 주세요.';
const encoder = new TextEncoder();
const digest = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
const progressKey = config => `${KEY}-revision:${config.url}/${config.deviceId}`;
const bytesLabel = bytes => bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)}KiB` : `${(bytes / (1024 * 1024)).toFixed(1)}MiB`;

function revision(value, allowZero = false) {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) throw new Error('PC 백업 버전이 올바르지 않습니다.');
  return value;
}

function manifestData(records, photos, recordings = [], version) {
  if (!Array.isArray(records) || records.length > 5000 || !Array.isArray(photos) || !Array.isArray(recordings) || photos.length + recordings.length > 4999) throw new Error('PC 백업 목록이 너무 크거나 올바르지 않습니다.');
  const clean = records.map(validateRecord).sort((a,b) => a.id.localeCompare(b.id));
  if (new Set(clean.map(record => record.id)).size !== clean.length) throw new Error('PC 백업 상담 ID가 중복되었습니다.');
  const inferred = clean.some(record => record.timeBasis !== undefined || record.recordings !== undefined) ? 3 : 2;
  if (version !== undefined && (![2,3].includes(version) || version < inferred)) throw new Error('PC 백업 버전과 첨부 정보가 일치하지 않습니다.');
  const references = new Map(), recordingReferences = new Map(), ids = new Set();
  for (const record of clean) for (const [assets,target] of [[record.cards,references],[record.recordings || [],recordingReferences]]) for (const asset of assets) {
    if (ids.has(asset.id)) throw new Error('여러 기록에 같은 첨부 ID가 연결되어 있습니다.');
    ids.add(asset.id);target.set(asset.id,{...asset,recordId:record.id});
  }
  const hashes = (values,refs) => {
    if (refs.size !== values.length) throw new Error('PC 백업 첨부 목록과 기록이 일치하지 않습니다.');
    const seen = new Set();
    return values.map(asset => {
      const reference = refs.get(asset?.id);
      if (!reference || seen.has(asset.id) || reference.recordId !== asset.recordId || !HASH.test(asset.sha256)) throw new Error('PC 백업 첨부의 연결 또는 해시가 올바르지 않습니다.');
      seen.add(asset.id);return {id:asset.id,recordId:asset.recordId,sha256:asset.sha256};
    }).sort((a,b) => a.id.localeCompare(b.id));
  };
  return {schemaVersion:version ?? inferred,records:clean,photos:hashes(photos,references),recordings:hashes(recordings,recordingReferences),references,recordingReferences};
}

function includesRemote(local, remote) {
  const records = new Map(local.records.map(record => [record.id,record]));
  const hashes = new Map([...local.photos,...local.recordings].map(asset => [asset.id,asset.sha256]));
  return remote.records.every(record => {
    const current = records.get(record.id);
    if (!current || current.updatedAt < record.updatedAt) return false;
    if (current.updatedAt > record.updatedAt) return true;
    return JSON.stringify(current) === JSON.stringify(record)
      && [...remote.photos,...remote.recordings].filter(asset => asset.recordId === record.id).every(asset => hashes.get(asset.id) === asset.sha256);
  });
}

const signatureOf = snapshot => digest(encoder.encode(JSON.stringify({records:snapshot.records,photos:snapshot.photos,
  ...(snapshot.schemaVersion === 3 ? {recordings:snapshot.recordings} : {})})));

export function backupConfig(value) {
  if (!value || typeof value !== 'object') throw new Error('PC 연결 정보가 올바르지 않습니다.');
  const url = new URL(value.url);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) throw new Error('PC의 HTTPS 기본 주소를 확인해 주세요.');
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(value.token) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.deviceId)
      || typeof value.label !== 'string' || value.label.length > 80) throw new Error('PC에서 새 연결 링크를 받아 주세요.');
  return {url: url.origin, token: value.token, deviceId: value.deviceId, label: value.label};
}

export class FieldSync {
  constructor(snapshot, status) {
    this.snapshot = snapshot; this.status = status; this.running = false; this.timer = null;
    try { this.config = backupConfig(JSON.parse(localStorage.getItem(KEY))); } catch { this.config = null; }
    this.signature = null; this.lastRevision = 0; this.requests = new Set(); this.restoring = false;
    this.progress = this.readProgress();
  }
  readProgress() {
    try {
      const value = JSON.parse(localStorage.getItem(progressKey(this.config)));
      revision(value.revision, true);
      if (value.pending && (!HASH.test(value.pending.signature) || !Number.isSafeInteger(value.pending.revision) || value.pending.revision < 1)) return null;
      if (value.emptyIntent && value.emptyIntent.revision !== value.revision) return null;
      return value;
    } catch { return null; }
  }
  assertConnection(connection) {
    if (this.config !== connection) throw new DOMException('PC 연결이 변경되었습니다.', 'AbortError');
  }
  assertSending(connection) {
    this.assertConnection(connection);
    if (this.restoring) throw new DOMException('PC 복원을 위해 전송을 중지했습니다.', 'AbortError');
  }
  saveProgress(connection, value) {
    this.assertConnection(connection);
    localStorage.setItem(progressKey(connection), JSON.stringify(value));
    this.progress = value;
  }
  abortRequests() {
    for (const request of this.requests) request.abort();
  }
  connect(value) {
    const config = backupConfig(value);
    localStorage.setItem(KEY, JSON.stringify(config));
    this.abortRequests(); this.config = config; this.pendingRestore = null; this.restoring = false;
    this.progress = this.readProgress(); this.signature = null; this.schedule();
  }
  disconnect() {
    this.abortRequests(); this.config = null; this.pendingRestore = null; this.restoring = false;
    localStorage.removeItem(KEY); clearTimeout(this.timer);
    this.status('PC 자동 백업 연결 안 됨');
  }
  noteEmptyDeletion() {
    if (!this.config || !this.progress) return;
    try { this.saveProgress(this.config, {...this.progress, emptyIntent: {revision: this.progress.revision}}); }
    catch { this.status('기기에서 삭제됨 · PC 삭제 반영 대기 · 연결 정보 저장 공간을 확인해 주세요.'); }
  }
  schedule(delay = 2000) {
    clearTimeout(this.timer);
    if (!this.config) { this.status('PC 자동 백업 연결 안 됨'); return; }
    this.timer = setTimeout(() => this.send(), delay);
  }
  async request(connection, path, options = {}) {
    if (!connection) throw new Error('PC 백업을 먼저 연결해 주세요.');
    if (options.method === 'POST') this.assertSending(connection);
    else this.assertConnection(connection);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120000);
    this.requests.add(controller);
    try {
      const response = await fetch(`${connection.url}/api/field-backups/${connection.deviceId}${path}`, {
        ...options, mode: 'cors', credentials: 'omit', redirect: 'error', signal: controller.signal,
        headers: {Authorization: `Bearer ${connection.token}`, ...options.headers},
      });
      this.assertConnection(connection);
      if (!response.ok) {
        let details = {};
        try { details = await response.json(); } catch {}
        const error = new Error(details.error || 'PC 백업에 연결하지 못했습니다.');
        error.status = response.status; error.revision = details.revision;
        throw error;
      }
      const body = await response.blob();
      this.assertConnection(connection);
      return new Response(body, {status: response.status, headers: response.headers});
    } finally { clearTimeout(timer); this.requests.delete(controller); }
  }
  json(connection, path, value) {
    const body = JSON.stringify(value);
    if (encoder.encode(body).length > MAX_JSON_BYTES) throw new Error('백업 기록 목록은 8MiB를 넘을 수 없습니다. 날짜별 ZIP을 별도로 보관해 주세요.');
    return this.request(connection, path, {method: 'POST', body, headers: {'Content-Type': 'application/json'}});
  }
  async prepare(snapshot, connection = this.config) {
    if (!snapshot || !Array.isArray(snapshot.cards) || (snapshot.recordings !== undefined && !Array.isArray(snapshot.recordings))) throw new Error('기기 첨부 목록이 올바르지 않습니다.');
    const photos = [], recordings = [], blobs = new Map();
    for (const [assets,target,kind] of [[snapshot.cards,photos,'photo'],[snapshot.recordings || [],recordings,'recording']]) for (const asset of assets) {
      if (!(asset.blob instanceof Blob) || asset.blob.size !== asset.size || asset.blob.type !== asset.type) throw new Error('기기 첨부의 크기 또는 형식이 일치하지 않습니다.');
      const hash = HASH.test(asset.hash) ? asset.hash : kind === 'recording' ? await recordingDigest(asset.blob,(done,total) => {
        this.assertSending(connection);this.status(`PC 녹음 확인 · ${bytesLabel(done)} / ${bytesLabel(total)}`);
      }) : await digest(await asset.blob.arrayBuffer());
      target.push({id:asset.id,recordId:asset.recordId,sha256:hash});
      const previous = blobs.get(hash);
      if (previous && (previous.size !== asset.size || previous.type !== asset.type || previous.kind !== kind)) throw new Error('같은 첨부 해시의 크기 또는 형식이 다릅니다.');
      blobs.set(hash,{sha256:hash,size:asset.size,type:asset.type,blob:asset.blob,kind});
    }
    const clean = manifestData(snapshot.records,photos,recordings);
    for (const [assets,refs,keys] of [[snapshot.cards,clean.references,['name','type','size','path','kind','caption']],
      [snapshot.recordings || [],clean.recordingReferences,['name','type','size','path']]]) for (const asset of assets) {
      const reference = refs.get(asset.id);
      if (keys.some(key => reference[key] !== asset[key])) throw new Error('기기 첨부와 기록의 연결 정보가 일치하지 않습니다.');
    }
    return {...clean,blobs};
  }

  send() {
    if (this.running || this.restoring || !this.config) return Promise.resolve();
    this.currentSend = this.sendSnapshot();
    return this.currentSend;
  }
  async sendSnapshot() {
    if (!navigator.onLine) { this.status('PC 백업 대기 · 기기에 저장됨'); this.schedule(30000); return; }
    this.running = true;
    const connection = this.config;
    const deletionAtStart = this.progress?.emptyIntent;
    try {
      const snapshot = await this.prepare(await this.snapshot());
      this.assertSending(connection);
      if (snapshot.records.length && deletionAtStart && this.progress?.emptyIntent === deletionAtStart) {
        const {emptyIntent, ...progress} = this.progress;
        this.saveProgress(connection, progress);
      }
      let signature = await signatureOf(snapshot);
      this.assertSending(connection);
      if (signature === this.signature) return;
      // An empty browser must restore its existing PC backup before replacing it.
      if (!snapshot.records.length && !this.progress?.emptyIntent) { this.status('PC 연결 정보 저장됨 · 복원으로 백업 확인'); return; }
      this.status('PC 첨부 전송 상태 확인 중…');
      const descriptors = kind => [...snapshot.blobs.values()].filter(asset => asset.kind === kind).map(({sha256,size,type}) => ({sha256,size,type}));
      const status = await (await this.json(connection,'/sync/status',{photos:descriptors('photo'),recordings:descriptors('recording')})).json();
      this.assertSending(connection);
      const expectedRevision = revision(status.revision, true);
      const remote = manifestData(status.records,status.hashes,status.recordingHashes || [],status.schemaVersion);
      if (remote.schemaVersion > snapshot.schemaVersion) { snapshot.schemaVersion = remote.schemaVersion;signature = await signatureOf(snapshot); }
      const pending = this.progress?.pending;
      const acknowledged = pending?.revision === expectedRevision && pending.signature === await signatureOf(remote);
      this.assertSending(connection);
      if (acknowledged) {
        this.saveProgress(connection, {revision: expectedRevision,
          ...(this.progress?.emptyIntent ? {emptyIntent: {revision: expectedRevision}} : {})});
      } else if (this.progress ? expectedRevision > this.progress.revision : !includesRemote(snapshot, remote)) {
        throw new Error(RESTORE_FIRST);
      }
      if (!this.progress) this.saveProgress(connection, {revision: expectedRevision});
      if (!snapshot.records.length && this.progress.emptyIntent?.revision !== expectedRevision) throw new Error(RESTORE_FIRST);
      if (!Number.isSafeInteger(status.chunkBytes) || status.chunkBytes < 1 || status.chunkBytes > MAX_CHUNK_BYTES || !Array.isArray(status.photos) || (status.recordings !== undefined && !Array.isArray(status.recordings)) || status.photos.length + (status.recordings || []).length !== snapshot.blobs.size) throw new Error('PC 사진 전송 상태가 올바르지 않습니다.');
      const offsets = new Map();
      for (const photo of [...status.photos,...(status.recordings || [])]) {
        const blob = snapshot.blobs.get(photo.sha256);
        if (!blob || offsets.has(photo.sha256) || !Number.isSafeInteger(photo.offset) || photo.offset < 0 || photo.offset > blob.size
            || typeof photo.complete !== 'boolean' || photo.complete !== (photo.offset === blob.size)) throw new Error('PC 사진의 이어 보내기 위치가 올바르지 않습니다.');
        offsets.set(photo.sha256, photo.offset);
      }
      let remaining = [...snapshot.blobs.values()].reduce((total, photo) => total + photo.size - offsets.get(photo.sha256), 0);
      const missing = [...snapshot.blobs.values()].filter(photo => offsets.get(photo.sha256) < photo.size);
      if (acknowledged && pending.signature === signature && !missing.length) {
        this.signature = signature;
        this.status(`PC 백업 확인 완료 · ${snapshot.records.length}건 · 사진 재전송 없음`);
        return;
      }
      for (let index = 0; index < missing.length; index++) {
        const photo = missing[index];
        let offset = offsets.get(photo.sha256);
        while (offset < photo.size) {
          this.assertSending(connection);
          this.status(`PC ${photo.kind === 'recording' ? '녹음' : '사진'} 전송 ${index + 1}/${missing.length} · 남은 ${bytesLabel(remaining)}`);
          const end = Math.min(photo.size, offset + status.chunkBytes);
          const result = await (await this.request(connection, `/sync/blobs/${photo.sha256}?offset=${offset}&size=${photo.size}&type=${encodeURIComponent(photo.type)}`, {
            method: 'POST', body: photo.blob.slice(offset, end), headers: {'Content-Type': 'application/octet-stream'},
          })).json();
          this.assertSending(connection);
          if (!Number.isSafeInteger(result.offset) || result.offset < end || result.offset > photo.size || result.complete !== (result.offset === photo.size)) throw new Error('PC 사진 전송 확인 위치가 올바르지 않습니다.');
          remaining -= result.offset - offset;
          offset = result.offset;
        }
      }
      this.status(missing.length ? 'PC 첨부 전송 완료 · 기록·메모 저장 중…' : 'PC 기록·메모 갱신 중 · 사진 전송 없음 · 녹음 전송 없음');
      this.lastRevision = Math.max(Date.now(), this.lastRevision + 1, expectedRevision + 1, (this.progress?.pending?.revision || 0) + 1);
      const nextRevision = revision(this.lastRevision);
      this.saveProgress(connection, {...this.progress, pending: {revision: nextRevision, signature}});
      const result = await (await this.json(connection, '/sync/manifest', {schemaVersion:snapshot.schemaVersion,revision:nextRevision,expectedRevision,
        label:connection.label,records:snapshot.records,photos:snapshot.photos,...(snapshot.schemaVersion === 3 ? {recordings:snapshot.recordings} : {})})).json();
      this.assertSending(connection);
      if (result.revision !== nextRevision || result.records !== snapshot.records.length || result.photos !== snapshot.photos.length || (snapshot.schemaVersion === 3 && result.recordings !== snapshot.recordings.length)) throw new Error('PC 백업 저장 확인이 올바르지 않습니다.');
      this.saveProgress(connection, {revision: nextRevision,
        ...(snapshot.records.length && this.progress.emptyIntent ? {emptyIntent: {revision: nextRevision}} : {})});
      this.signature = signature;
      this.status(`PC 백업 완료 · ${result.records}건 · ${new Date(result.savedAt).toLocaleTimeString('ko-KR', {hour:'2-digit', minute:'2-digit'})}`);
    } catch (error) {
      if (this.config === connection && !this.restoring) this.status(`PC 백업 대기 · ${error.message || '연결 확인 필요'} · 기기 자료 유지`);
    } finally {
      this.running = false; if (this.config && !this.restoring) this.schedule(30000);
    }
  }
  async restore() {
    if (!this.config) throw new Error('PC 백업을 먼저 연결해 주세요.');
    if (this.restoring) throw new Error('PC 백업 복원 확인을 먼저 마쳐 주세요.');
    const connection = this.config;
    this.restoring = true; clearTimeout(this.timer); this.abortRequests();
    try {
      await this.currentSend;
      this.assertConnection(connection);
      let manifest;
      let bundle;
      try { manifest = await (await this.request(connection, '/sync/manifest')).json(); }
      catch (error) {
        if (error.status !== 404) throw error;
        bundle = await readBundle(await (await this.request(connection, '')).blob());
      }
      if (manifest) {
        if (![2,3].includes(manifest.schemaVersion)) throw new Error('지원하지 않는 PC 백업 버전입니다.');
        revision(manifest.revision);
        const clean = manifestData(manifest.records,manifest.photos,manifest.recordings || [],manifest.schemaVersion);
        const blobs = new Map();
        const cards = [];
        for (const photo of clean.photos) {
          this.status(`PC 사진 복원 ${cards.length + 1}/${clean.photos.length}`);
          const reference = clean.references.get(photo.id);
          let blob = blobs.get(photo.sha256);
          if (!blob) {
            const response = await this.request(connection, `/sync/blobs/${photo.sha256}`);
            if (response.headers.get('Content-Type')?.split(';')[0].trim() !== reference.type) throw new Error('PC 사진의 이미지 형식이 일치하지 않습니다.');
            blob = await response.blob();
            if (blob.size !== reference.size) throw new Error('PC 사진의 크기가 일치하지 않습니다.');
            const bytes = new Uint8Array(await blob.arrayBuffer());
            if (await digest(bytes) !== photo.sha256) throw new Error('PC 사진 검증에 실패했습니다. 기기 기록은 바뀌지 않았습니다.');
            validateImage(bytes, reference.type);
            blobs.set(photo.sha256, blob);
          }
          if (blob.size !== reference.size || blob.type !== reference.type) throw new Error('PC 사진과 상담의 연결 정보가 일치하지 않습니다.');
          cards.push({...reference, blob, hash: photo.sha256});
        }
        const recordings = [];
        for (const audio of clean.recordings) {
          const reference = clean.recordingReferences.get(audio.id), parts = [], leaves = [];
          for (let offset = 0; offset < reference.size; offset += AUDIO_CHUNK_BYTES) {
            this.assertConnection(connection);
            const length = Math.min(AUDIO_CHUNK_BYTES,reference.size - offset);
            this.status(`PC 녹음 복원 · 남은 ${bytesLabel(reference.size - offset)}`);
            const response = await this.request(connection,`/sync/blobs/${audio.sha256}?offset=${offset}&length=${length}`);
            if (response.headers.get('Content-Type')?.split(';')[0].trim() !== reference.type) throw new Error('PC 녹음 형식이 일치하지 않습니다.');
            const part = await response.blob();
            if (part.size !== length) throw new Error('PC 녹음 조각의 크기가 일치하지 않습니다.');
            const bytes = new Uint8Array(await part.arrayBuffer());
            if (!offset) validateRecordingHeader(bytes,reference.type);
            leaves.push(await sha256(bytes));parts.push(part);
          }
          if (await recordingTreeDigest(reference.size,reference.type,leaves) !== audio.sha256) throw new Error('PC 녹음 검증에 실패했습니다. 기기 기록은 바뀌지 않았습니다.');
          recordings.push({...reference,blob:new Blob(parts,{type:reference.type}),hash:audio.sha256});
        }
        bundle = {records:clean.records,cards,...(manifest.schemaVersion === 3 ? {recordings} : {})};
      }
      this.assertConnection(connection);
      this.pendingRestore = {bundle, connection, revision: manifest?.revision ?? null};
      this.status('PC 백업 확인 완료 · 기기 복원 확인 대기');
      return bundle;
    } catch (error) {
      if (this.config === connection) { this.restoring = false; this.status(`PC 복원 대기 · ${error.message} · 기기 자료 유지`); this.schedule(30000); }
      throw error;
    }
  }
  acknowledgeRestore(bundle) {
    const pending = this.pendingRestore;
    if (!pending || pending.bundle !== bundle) throw new Error('PC 백업 복원 확인 정보가 없습니다.');
    this.assertConnection(pending.connection);
    if (pending.revision === null) { localStorage.removeItem(progressKey(pending.connection)); this.progress = null; }
    else this.saveProgress(pending.connection, {revision: pending.revision});
    this.signature = null;
    this.cancelRestore(bundle);
    this.status('PC 백업 복원 완료 · 기기에 저장됨');
  }
  cancelRestore(bundle) {
    if (this.pendingRestore?.bundle !== bundle) return;
    this.pendingRestore = null; this.restoring = false;
    this.status('PC 복원 취소 · 기기 자료 유지'); this.schedule(30000);
  }
}
