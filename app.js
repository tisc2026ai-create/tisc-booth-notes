import { createBundle, readBundle, validateRecord } from './archive.js';
import { openStorage, getRecords, getCards, saveRecord, saveCard, deleteCard, importRecords } from './storage.js';

const $ = id => document.getElementById(id);
const records = new Map();
const cards = new Map();
const dirty = new Set();
const persistedRevision = new Map();
const thumbnailUrls = [];
const KST = 9 * 60 * 60 * 1000;
let selectedId = null;
let ready = false;
let busy = false;
let saving = null;
let saveTimer;
let saveError = null;
let dialogUrl = null;
let defaultTeam = '1조';
let defaultVisit = 'booth';
try {
  defaultTeam = localStorage.getItem('tisc-team') || '1조';
  defaultVisit = localStorage.getItem('tisc-visit') === 'visit' ? 'visit' : 'booth';
} catch { /* 설정 저장이 차단되어도 상담은 IndexedDB에 저장합니다. */ }

function kstDate(value = new Date()) {
  return new Date(new Date(value).getTime() + KST).toISOString().slice(0, 10);
}
function kstInput(value) {
  return value ? new Date(Date.parse(value) + KST).toISOString().slice(0, 19) : '';
}
function kstTime(value, includeDate = false) {
  if (!value) return '—';
  const shifted = kstInput(value);
  return includeDate ? `${shifted.slice(5, 10).replace('-', '.')} ${shifted.slice(11)}` : shifted.slice(11);
}
function parseKst(value) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(value)) throw new Error('날짜와 시각을 초 단위까지 확인해 주세요.');
  const full = value.length === 16 ? `${value}:00` : value;
  const date = new Date(`${full}+09:00`);
  if (!Number.isFinite(date.getTime()) || kstInput(date.toISOString()) !== full) throw new Error('유효한 날짜와 시각을 입력해 주세요.');
  return date.toISOString();
}
function duration(record) {
  const seconds = Math.max(0, Math.floor(((record.endAt ? Date.parse(record.endAt) : Date.now()) - Date.parse(record.startAt)) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds / 60) % 60;
  return `${hours ? `${String(hours).padStart(2, '0')}:` : ''}${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}
function revision(record) {
  return new Date(Math.max(Date.now(), Date.parse(record.updatedAt) + 1)).toISOString();
}
function current() { return records.get(selectedId); }
function node(tag, className, content) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (content !== undefined) element.textContent = content;
  return element;
}
function message(content, kind = 'success') {
  $('message').textContent = content;
  $('message').className = `message ${kind}`;
  $('message').hidden = false;
}
function updateStatus() {
  const status = $('save-status');
  status.className = 'save-status';
  if (!ready) status.textContent = '저장소 준비 중';
  else if (saveError) { status.textContent = '저장 실패 · 다시 시도'; status.classList.add('error'); }
  else if (dirty.size || saving) status.textContent = '저장 중…';
  else if (current()) { status.textContent = '✓ 기기에 저장됨'; status.classList.add('saved'); }
  else status.textContent = '시작할 준비 완료';
  $('retry-save').hidden = !saveError;
}
function syncControls() {
  const locked = !ready || busy;
  for (const id of ['team', 'visit-type', 'company', 'memo', 'manual-start', 'manual-end', 'card-file', 'toggle-times', 'save-times', 'end-record', 'next-record', 'new-record', 'retry-save', 'import-file']) $(id).disabled = locked;
  $('start-record').disabled = locked || [...records.values()].some(record => record.endAt === null);
  $('export-date').disabled = locked || !records.size;
  $('export-all').disabled = locked || !records.size;
  for (const button of document.querySelectorAll('.card-remove, .record-item')) button.disabled = locked;
  for (const id of ['card-upload', 'import-label']) {
    $(id).setAttribute('aria-disabled', String(locked));
    $(id).tabIndex = locked ? -1 : 0;
  }
  updateStatus();
}

async function flushPending() {
  clearTimeout(saveTimer);
  if (saving) return saving;
  if (!dirty.size) return;
  saveError = null;
  saving = (async () => {
    while (dirty.size) {
      const id = dirty.values().next().value;
      const snapshot = validateRecord(records.get(id));
      await saveRecord(snapshot, persistedRevision.get(id) ?? null);
      persistedRevision.set(id, snapshot.updatedAt);
      if (records.get(id).updatedAt === snapshot.updatedAt) dirty.delete(id);
    }
  })();
  updateStatus();
  try {
    await saving;
    renderList();
  } catch (error) {
    saveError = error;
    message(`기기에 저장하지 못했습니다. 입력한 내용은 화면에 남아 있습니다. 이 탭을 닫지 말고 저장을 다시 시도해 주세요. ${error.message}`, 'error');
    throw error;
  } finally {
    saving = null;
    updateStatus();
  }
}
function edit(fields) {
  const record = current();
  if (!record) return;
  const next = { ...record, ...fields, updatedAt: revision(record) };
  records.set(next.id, next);
  dirty.add(next.id);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => flushPending().catch(() => {}), 300);
  $('memo-count').textContent = `${next.memo.length.toLocaleString('ko-KR')} / 5,000`;
  updateStatus();
  renderList();
}
async function action(task, allowDraftExport = false) {
  if (busy || !ready) return;
  busy = true;
  syncControls();
  try {
    try { await flushPending(); }
    catch (error) {
      if (!allowDraftExport || !confirm('기기 저장에 실패한 수정본이 있습니다. 현재 화면의 수정본을 ZIP으로 내보내 보관할까요? 기기의 기존 기록은 바뀌지 않습니다.')) throw error;
    }
    await task();
  } catch (error) {
    if (error !== saveError) message(error.message || '처리하지 못했습니다. 다시 시도해 주세요.', 'error');
  } finally {
    busy = false;
    syncControls();
  }
}

function renderList() {
  const container = $('record-list');
  container.replaceChildren();
  const query = $('search').value.trim().toLocaleLowerCase('ko-KR');
  const day = $('filter-date').value;
  const all = [...records.values()].sort((a, b) => b.startAt.localeCompare(a.startAt));
  const visible = all.filter(record => (!day || kstDate(record.startAt) === day) && (!query || `${record.company} ${record.memo} ${record.team}`.toLocaleLowerCase('ko-KR').includes(query)));
  $('record-count').textContent = visible.length;
  $('export-date').textContent = day ? '↓ 선택 날짜 내보내기' : '↓ 모든 날짜 내보내기';
  if (!visible.length) {
    const empty = node('div', 'empty-state');
    empty.append(node('div', 'empty-symbol', '＋'), node('strong', '', all.length ? '조건에 맞는 기록이 없습니다.' : '첫 번째 상담을 기다리고 있어요.'));
    empty.append(node('p', '', all.length ? '검색어나 날짜를 바꾸어 확인해 주세요.' : '상담 시작을 누르면\n이곳에 기록이 차곡차곡 쌓입니다.'));
    container.append(empty);
    return;
  }
  for (const record of visible) {
    const button = node('button', `record-item${record.id === selectedId ? ' selected' : ''}`);
    button.type = 'button';
    button.dataset.id = record.id;
    button.disabled = !ready || busy;
    button.setAttribute('aria-pressed', String(record.id === selectedId));
    const row = node('div', 'record-row');
    row.append(node('span', 'record-company', record.company || '회사명 미입력'));
    row.append(node('span', `record-state${record.endAt === null ? ' active' : ''}`, dirty.has(record.id) ? '저장 대기' : record.endAt === null ? '진행 중' : '기록 완료'));
    const time = `${!day ? `${kstDate(record.startAt)} · ` : ''}${kstTime(record.startAt)} — ${record.endAt ? kstTime(record.endAt) : '진행 중'} · ${record.team || '조 미지정'} · 명함 ${record.cards.length}장`;
    button.append(row, node('div', 'record-time', time), node('div', 'record-memo', `${record.visitType === 'visit' ? '다른 부스 방문' : '우리 부스 상담'}${record.memo ? ` · ${record.memo.replace(/\s+/g, ' ')}` : ''}`));
    button.addEventListener('click', () => action(async () => { selectedId = record.id; renderSelected(); }));
    container.append(button);
  }
}
function renderCards() {
  thumbnailUrls.forEach(url => URL.revokeObjectURL(url));
  thumbnailUrls.length = 0;
  $('cards').replaceChildren();
  const record = current();
  $('card-count').textContent = `${record?.cards.length || 0}장`;
  for (const metadata of record?.cards || []) {
    const card = cards.get(metadata.id);
    if (!card) continue;
    const tile = node('div', 'card-tile');
    const open = node('button', 'card-open');
    open.type = 'button';
    open.setAttribute('aria-label', `${metadata.name} 확대 보기`);
    const image = node('img');
    const url = URL.createObjectURL(card.blob);
    thumbnailUrls.push(url);
    image.src = url;
    image.alt = metadata.name;
    open.append(image);
    open.addEventListener('click', () => {
      if (dialogUrl) URL.revokeObjectURL(dialogUrl);
      dialogUrl = URL.createObjectURL(card.blob);
      $('large-image').src = dialogUrl;
      $('image-name').textContent = metadata.name;
      $('image-dialog').showModal();
    });
    const remove = node('button', 'card-remove', '×');
    remove.type = 'button';
    remove.disabled = busy;
    remove.setAttribute('aria-label', `${metadata.name} 삭제`);
    remove.addEventListener('click', () => {
      if (!confirm('이 상담에서 명함 사진을 삭제할까요? 내보내지 않은 사진은 복구할 수 없습니다.')) return;
      action(async () => {
        const latest = current();
        const next = { ...latest, updatedAt: revision(latest), cards: latest.cards.filter(item => item.id !== metadata.id) };
        await deleteCard(next, metadata.id, persistedRevision.get(next.id) ?? null);
        persistedRevision.set(next.id, next.updatedAt);
        records.set(next.id, next);
        cards.delete(metadata.id);
        renderCards();
        renderList();
        message('명함 사진을 삭제했습니다.');
      });
    });
    tile.append(open, node('span', 'card-name', metadata.name), remove);
    $('cards').append(tile);
  }
}
function updateDuration() {
  const record = current();
  if (!record) return;
  $('duration').textContent = duration(record);
  $('start-label').textContent = kstTime(record.startAt, true);
  $('end-label').textContent = record.endAt ? kstTime(record.endAt, true) : '진행 중';
}
function renderSelected() {
  const record = current();
  $('start-panel').hidden = Boolean(record);
  $('record-form').hidden = !record;
  $('time-editor').hidden = true;
  $('toggle-times').setAttribute('aria-expanded', 'false');
  $('editor-heading').textContent = record ? record.company || '회사명 미입력' : '새로운 상담';
  $('team').value = record ? record.team : defaultTeam;
  $('visit-type').value = record ? record.visitType : defaultVisit;
  if (record) {
    $('company').value = record.company;
    $('memo').value = record.memo;
    $('memo-count').textContent = `${record.memo.length.toLocaleString('ko-KR')} / 5,000`;
    $('session-state').textContent = record.endAt ? '상담 기록 저장됨' : '상담 진행 중';
    $('session-banner').classList.toggle('ended', Boolean(record.endAt));
    $('end-record').hidden = Boolean(record.endAt);
    $('next-record').hidden = !record.endAt;
    $('manual-start').value = kstInput(record.startAt);
    $('manual-end').value = kstInput(record.endAt);
    updateDuration();
  }
  renderCards();
  renderList();
  syncControls();
}

$('filter-date').value = kstDate();
$('team').value = defaultTeam;
$('visit-type').value = defaultVisit;
$('search').addEventListener('input', renderList);
$('filter-date').addEventListener('change', renderList);
$('all-dates').addEventListener('click', () => { $('filter-date').value = ''; renderList(); });
$('record-form').addEventListener('submit', event => event.preventDefault());
$('company').addEventListener('input', () => { edit({ company: $('company').value }); $('editor-heading').textContent = $('company').value || '회사명 미입력'; });
$('memo').addEventListener('input', () => edit({ memo: $('memo').value }));
$('team').addEventListener('input', () => {
  defaultTeam = $('team').value;
  try { localStorage.setItem('tisc-team', defaultTeam); } catch { /* 기기 설정만 선택적으로 보관합니다. */ }
  edit({ team: defaultTeam });
});
$('visit-type').addEventListener('change', () => {
  defaultVisit = $('visit-type').value;
  try { localStorage.setItem('tisc-visit', defaultVisit); } catch { /* 기기 설정만 선택적으로 보관합니다. */ }
  edit({ visitType: defaultVisit });
});
$('start-record').addEventListener('click', () => {
  const clickedAt = new Date().toISOString();
  action(async () => {
  const active = [...records.values()].filter(record => record.endAt === null);
  if (active.length) throw new Error('진행 중인 상담을 먼저 종료해 주세요. 목록에서 해당 상담을 선택할 수 있습니다.');
  const now = clickedAt;
  const record = { id: crypto.randomUUID(), createdAt: now, updatedAt: now, startAt: now, endAt: null, company: '', memo: '', team: $('team').value, visitType: $('visit-type').value, cards: [] };
  await saveRecord(record, null);
  persistedRevision.set(record.id, record.updatedAt);
  records.set(record.id, record);
  selectedId = record.id;
  $('filter-date').value = kstDate(record.startAt);
  $('search').value = '';
  renderSelected();
  message('상담 시작 시각을 기록했습니다. 녹음은 별도 녹음기에서 진행해 주세요.');
  setTimeout(() => $('company').focus(), 0);
  });
});
$('end-record').addEventListener('click', () => {
  const clickedAt = new Date().toISOString();
  action(async () => {
  const record = current();
  if (Date.parse(clickedAt) < Date.parse(record.startAt)) throw new Error('기기 시각이 상담 시작보다 빠릅니다. 시각 수정을 통해 시작·종료 시각을 확인해 주세요.');
  edit({ endAt: clickedAt });
  await flushPending();
  renderSelected();
  message('상담 기록이 기기에 저장되었습니다. 쉬는 시간에 기록을 내보내 주세요.');
  });
});
function prepareNew() {
  action(async () => {
    const active = [...records.values()].find(record => record.endAt === null);
    if (active) {
      selectedId = active.id;
      renderSelected();
      message('진행 중인 상담을 표시했습니다. 새 상담을 시작하려면 먼저 종료해 주세요.', 'warning');
    } else {
      selectedId = null;
      renderSelected();
      $('start-record').focus();
    }
    if (matchMedia('(max-width: 640px)').matches) $('editor-heading').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}
$('new-record').addEventListener('click', prepareNew);
$('next-record').addEventListener('click', prepareNew);
$('retry-save').addEventListener('click', () => action(async () => { message('입력한 내용을 기기에 저장했습니다.'); }));
$('toggle-times').addEventListener('click', () => {
  const visible = $('time-editor').hidden;
  $('time-editor').hidden = !visible;
  $('toggle-times').setAttribute('aria-expanded', String(visible));
  if (visible) {
    $('manual-start').value = kstInput(current().startAt);
    $('manual-end').value = kstInput(current().endAt);
  }
});
$('save-times').addEventListener('click', () => action(async () => {
  if (!$('manual-start').reportValidity() || !$('manual-end').reportValidity()) return;
  const startAt = parseKst($('manual-start').value);
  const endAt = $('manual-end').value ? parseKst($('manual-end').value) : null;
  if (endAt && endAt < startAt) throw new Error('종료 시각은 시작 시각보다 빠를 수 없습니다.');
  if (!endAt && [...records.values()].some(record => record.id !== selectedId && record.endAt === null)) throw new Error('다른 진행 중인 상담이 있습니다. 그 상담을 종료한 뒤 변경해 주세요.');
  edit({ startAt, endAt });
  await flushPending();
  $('filter-date').value = kstDate(startAt);
  renderSelected();
  message('상담 시각을 수정해 저장했습니다. 녹음기의 실제 시각과 일치하는지 확인해 주세요.');
}));

async function compressedImage(file) {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw new Error(`${file.name}: JPG, PNG, WebP 사진만 첨부할 수 있습니다.`);
  if (file.size > 25 * 1024 * 1024) throw new Error(`${file.name}: 사진 한 장은 25MiB 이내로 선택해 주세요.`);
  const url = URL.createObjectURL(file);
  const image = new Image();
  try {
    image.src = url;
    await image.decode();
    if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth * image.naturalHeight > 60_000_000) throw new Error('사진 해상도가 너무 크거나 이미지가 손상되었습니다.');
    const scale = Math.min(1, 1600 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('이 브라우저에서 사진을 처리할 수 없습니다.');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.88));
    if (!blob) throw new Error('명함 사진 변환에 실패했습니다.');
    return blob;
  } catch (error) {
    throw new Error(`${file.name}: ${error.message || '사진을 읽지 못했습니다.'}`);
  } finally { URL.revokeObjectURL(url); }
}
for (const [labelId, inputId] of [['card-upload', 'card-file'], ['import-label', 'import-file']]) {
  $(labelId).addEventListener('keydown', event => {
    if ((event.key === 'Enter' || event.key === ' ') && !$(inputId).disabled) {
      event.preventDefault();
      $(inputId).click();
    }
  });
}
$('card-file').addEventListener('change', () => {
  const files = [...$('card-file').files];
  if (!files.length) return;
  action(async () => {
    let count = 0;
    for (const file of files) {
      const blob = await compressedImage(file);
      const id = crypto.randomUUID();
      const metadata = { id, name: file.name.slice(0, 255), type: blob.type, size: blob.size, path: `cards/${id}.jpg` };
      const record = current();
      const next = { ...record, updatedAt: revision(record), cards: [...record.cards, metadata] };
      const card = { ...metadata, recordId: record.id, blob };
      await saveCard(next, card, persistedRevision.get(next.id) ?? null);
      persistedRevision.set(next.id, next.updatedAt);
      records.set(next.id, next);
      cards.set(id, card);
      count++;
      renderCards();
      renderList();
      message(`명함 ${count}장을 기기에 저장했습니다. 확대해서 글씨를 확인해 주세요.`);
    }
  }).finally(() => { $('card-file').value = ''; });
});
$('close-image').addEventListener('click', () => $('image-dialog').close());
$('image-dialog').addEventListener('close', () => {
  $('large-image').removeAttribute('src');
  if (dialogUrl) URL.revokeObjectURL(dialogUrl);
  dialogUrl = null;
});

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
function exportRecords(allDates) {
  action(async () => {
    const day = allDates ? '' : $('filter-date').value;
    const selected = [...records.values()].filter(record => !day || kstDate(record.startAt) === day).sort((a, b) => a.startAt.localeCompare(b.startAt));
    if (!selected.length) throw new Error('내보낼 상담 기록이 없습니다. 날짜를 확인해 주세요.');
    if (selected.some(record => record.endAt === null) && !confirm('진행 중인 상담도 포함되어 있습니다. 종료 시각 없이 현재까지의 기록을 내보낼까요?')) return;
    const attached = selected.flatMap(record => record.cards.map(card => cards.get(card.id)));
    const blob = await createBundle(selected, attached);
    const stamp = kstInput(new Date().toISOString()).replace(/[:T]/g, '-');
    const filename = `tisc-notes-${day || 'all'}-${stamp}.zip`;
    download(blob, filename);
    message(`${selected.length}건과 명함 ${attached.length}장의 다운로드를 요청했습니다.${dirty.size ? ' 기기 저장에 실패한 수정본이 포함되어 있습니다.' : ''} 파일이 실제로 저장되었는지 확인한 뒤 분석 PC나 별도 보관 위치로 옮겨 주세요.`, 'warning');
  }, true);
}
$('export-date').addEventListener('click', () => exportRecords(false));
$('export-all').addEventListener('click', () => exportRecords(true));
$('import-file').addEventListener('change', () => {
  const file = $('import-file').files[0];
  if (!file) return;
  action(async () => {
    const bundle = await readBundle(file);
    if (!confirm(`상담 ${bundle.records.length}건과 명함 ${bundle.cards.length}장을 가져올까요? 같은 상담은 최신 수정본을 사용하며, 같은 수정 시각의 충돌은 가져오지 않습니다.`)) return;
    const result = await importRecords(bundle);
    await reloadData();
    $('filter-date').value = '';
    $('search').value = '';
    if (!records.has(selectedId)) selectedId = null;
    renderSelected();
    const activeCount = [...records.values()].filter(record => record.endAt === null).length;
    message(`기록 가져오기 완료: 추가 ${result.added}건 · 갱신 ${result.updated}건 · 기존 유지 ${result.skipped}건.${activeCount > 1 ? ' 진행 중인 상담이 여러 건입니다. 각 기록의 종료 시각을 확인해 주세요.' : ''}`);
  }).finally(() => { $('import-file').value = ''; });
});

async function reloadData() {
  const [savedRecords, savedCards] = await Promise.all([getRecords(), getCards()]);
  records.clear();
  cards.clear();
  persistedRevision.clear();
  savedRecords.forEach(record => { records.set(record.id, record); persistedRevision.set(record.id, record.updatedAt); });
  savedCards.forEach(card => cards.set(card.id, card));
}
window.addEventListener('beforeunload', event => {
  if (dirty.size || saving || busy) { event.preventDefault(); event.returnValue = ''; }
});
document.addEventListener('visibilitychange', () => { if (document.hidden && dirty.size) flushPending().catch(() => {}); });
setInterval(() => {
  const now = new Date();
  $('clock').textContent = `${kstDate(now).replace(/-/g, '.')} ${kstTime(now.toISOString())} KST`;
  updateDuration();
}, 1000);
async function offlineSetup() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) {
    $('offline-status').textContent = '오프라인 준비 불가 · HTTPS 필요';
    return;
  }
  try {
    await navigator.serviceWorker.register('./sw.js');
    await navigator.serviceWorker.ready;
    $('offline-status').textContent = '✓ 오프라인 화면 준비됨';
  } catch {
    $('offline-status').textContent = '오프라인 준비 실패 · 연결 유지 필요';
  }
}
try {
  await openStorage();
  await reloadData();
  ready = true;
  const active = [...records.values()].filter(record => record.endAt === null).sort((a, b) => b.startAt.localeCompare(a.startAt));
  selectedId = active[0]?.id || null;
  if (selectedId) $('filter-date').value = kstDate(records.get(selectedId).startAt);
  renderSelected();
  if (active.length > 1) message('진행 중인 상담이 여러 건 있습니다. 목록에서 각 상담의 종료 시각을 확인해 주세요.', 'warning');
  // shortcut: 영구 보관은 브라우저 정책에 따릅니다. 마감 ZIP 백업으로 별도 보관합니다.
  navigator.storage?.persist?.().catch(() => {});
} catch (error) {
  $('storage-error').hidden = false;
  $('storage-error').textContent = `저장소를 열지 못해 기록을 시작할 수 없습니다. 일반 브라우저에서 다시 열고 기기 저장 공간을 확인해 주세요. ${error.message}`;
  syncControls();
  renderList();
}
offlineSetup();
