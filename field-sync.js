import {createBundle, readBundle} from './archive.js';

const KEY = 'tisc-pc-backup';
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
    this.signature = null; this.lastRevision = 0;
  }
  connect(value) {
    this.config = backupConfig(value);
    localStorage.setItem(KEY, JSON.stringify(this.config));
    this.signature = null; this.schedule();
  }
  disconnect() {
    this.config = null; localStorage.removeItem(KEY); clearTimeout(this.timer);
    this.status('PC 자동 백업 연결 안 됨');
  }
  schedule(delay = 2000) {
    clearTimeout(this.timer);
    if (!this.config) { this.status('PC 자동 백업 연결 안 됨'); return; }
    this.timer = setTimeout(() => this.send(), delay);
  }
  async request(method, body, revision) {
    const config = this.config;
    if (!config) throw new Error('PC 백업을 먼저 연결해 주세요.');
    const label = [...new TextEncoder().encode(config.label)].map(byte => byte.toString(16).padStart(2, '0')).join('');
    const response = await fetch(`${config.url}/api/field-backups/${config.deviceId}`, {
      method, body, mode: 'cors', credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(120000),
      headers: {Authorization: `Bearer ${config.token}`, ...(body ? {'Content-Type': 'application/zip', 'X-Device-Name': label, 'X-Backup-Revision': String(revision)} : {})},
    });
    if (!response.ok) {
      let message = 'PC 백업에 연결하지 못했습니다.';
      try { const error = await response.json(); message = error.error || message; if (Number.isSafeInteger(error.revision)) this.lastRevision = Math.max(this.lastRevision, error.revision); } catch {}
      throw new Error(message);
    }
    return response;
  }
  async send() {
    if (this.running || !this.config) return;
    if (!navigator.onLine) { this.status('PC 백업 대기 · 기기에 저장됨'); this.schedule(30000); return; }
    this.running = true;
    try {
      this.lastRevision = Math.max(Date.now(), this.lastRevision + 1);
      const revision = this.lastRevision;
      const snapshot = await this.snapshot();
      const signature = JSON.stringify(snapshot.records);
      if (signature === this.signature) return;
      // An empty browser must restore its existing PC backup before replacing it.
      if (!snapshot.records.length && this.signature === null) { this.status('PC 연결됨 · 기존 백업 복원 가능'); return; }
      this.status('PC로 백업 중…');
      const response = await this.request('POST', await createBundle(snapshot.records, snapshot.cards), revision);
      const result = await response.json();
      this.signature = signature;
      this.status(`PC 백업 완료 · ${result.records}건 · ${new Date(result.savedAt).toLocaleTimeString('ko-KR', {hour:'2-digit', minute:'2-digit'})}`);
    } catch (error) {
      this.status(`PC 백업 대기 · ${error.message || '연결 확인 필요'} · 기기 자료 유지`);
    } finally {
      this.running = false; if (this.config) this.schedule(30000);
    }
  }
  async restore() {
    const response = await this.request('GET');
    return readBundle(await response.blob());
  }
}
