import { createBundle, readBundle, validateRecord } from './archive.js';
import { openStorage, getRecords, getCards, saveRecord, saveCard, deleteCard, deleteRecords, importRecords } from './storage.js';
import {FieldSync, backupConfig} from './field-sync.js';

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
let pendingDelete = null;
const PHOTO_KINDS = {card: '명함', badge: '명찰', product: '제품', booth: '부스·현장', other: '기타'};
const pcBackup = new FieldSync(async () => {
  const [savedRecords, savedCards] = await Promise.all([getRecords(), getCards()]);
  savedRecords.sort((a, b) => a.id.localeCompare(b.id));
  return {records: savedRecords, cards: savedCards};
}, text => { $('pc-backup-status').textContent = text; });

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
function setView(view) {
  document.body.dataset.view = view;
  for (const name of ['records', 'editor', 'transfer']) {
    const button = $(`show-${name}`);
    if (name === view) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  if (matchMedia('(max-width: 640px)').matches) window.scrollTo({ top: 0, behavior: 'instant' });
}
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
  for (const id of ['company', 'memo', 'manual-start', 'manual-end', 'card-file', 'gallery-file', 'photo-kind', 'photo-caption', 'toggle-times', 'save-times', 'end-record', 'next-record', 'new-record', 'add-consultation', 'show-records', 'show-editor', 'show-transfer', 'retry-save', 'import-file']) $(id).disabled = locked;
  $('delete-record').disabled = locked || !current();
  $('delete-confirm').disabled = locked || !pendingDelete;
  $('delete-cancel').disabled = busy;
  $('start-record').disabled = locked;
  $('export-date').disabled = locked || !records.size;
  $('export-all').disabled = locked || !records.size;
  for (const button of document.querySelectorAll('.card-remove, .record-item, .other-session')) button.disabled = locked;
  for (const id of ['card-upload', 'gallery-upload', 'import-label']) {
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
    pcBackup.schedule();
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
    pcBackup.schedule();
  }
}

export function overlappingRecords(selected, candidates) {
  if (!selected) return [];
  const start = Date.parse(selected.startAt);
  const end = selected.endAt === null ? Infinity : Date.parse(selected.endAt);
  return [...candidates].filter(record => record.id !== selected.id
    && Math.max(start, Date.parse(record.startAt)) < Math.min(end, record.endAt === null ? Infinity : Date.parse(record.endAt)));
}
function renderOverlap() {
  const overlapping = overlappingRecords(current(), records.values());
  const warning = $('overlap-warning');
  warning.hidden = !overlapping.length;
  const companies = overlapping.slice(0, 2).map(record => record.company.trim() || '회사명 미입력').join(', ');
  warning.textContent = overlapping.length ? `${companies}${overlapping.length > 2 ? ` 외 ${overlapping.length - 2}곳` : ''} 상담과 시간이 겹칩니다. 각 회사의 발언을 메모로 구분해 주세요. 녹음 분석 시 확인이 필요합니다.` : '';
}
function renderList() {
  const container = $('record-list');
  container.replaceChildren();
  const query = $('search').value.trim().toLocaleLowerCase('ko-KR');
  const day = $('filter-date').value;
  const all = [...records.values()].sort((a, b) => Number(a.endAt !== null) - Number(b.endAt !== null) || b.startAt.localeCompare(a.startAt));
  const dated = all.filter(record => !day || kstDate(record.startAt) === day);
  const visible = dated.filter(record => !query || `${record.company} ${record.memo}`.toLocaleLowerCase('ko-KR').includes(query));
  $('record-count').textContent = visible.length;
  const activeCount = all.filter(record => record.endAt === null).length;
  $('active-count').textContent = `진행 중 ${activeCount}건`;
  $('new-record').textContent = activeCount ? '+ 다른 상담 추가' : '+ 새 상담';
  $('export-summary').textContent = `${day || '모든 날짜'} · 상담 ${dated.length}건 · 진행 중 ${dated.filter(record => record.endAt === null).length}건 포함 · 사진 ${dated.reduce((count, record) => count + record.cards.length, 0)}장`;
  $('active-sessions').replaceChildren();
  if (current()) {
    for (const record of all.filter(record => record.id !== selectedId && record.endAt === null)) {
      const button = node('button', 'other-session', `${record.company || '회사명 미입력'} · ${kstTime(record.startAt, true)}부터 · 기록 전환`);
      button.type = 'button';
      button.dataset.id = record.id;
      button.disabled = !ready || busy;
      button.addEventListener('click', () => action(async () => { selectedId = record.id; renderSelected(); setView('editor'); }));
      $('active-sessions').append(button);
    }
  }
  renderOverlap();
  $('export-date').textContent = day ? '선택 날짜 ZIP 다운로드' : '모든 날짜 ZIP 다운로드';
  if (!visible.length) {
    const empty = node('div', 'empty-state');
    empty.append(node('div', 'empty-symbol', '＋'), node('strong', '', all.length ? '조건에 맞는 기록이 없습니다.' : '아직 기록된 상담이 없습니다.'));
    empty.append(node('p', '', all.length ? '검색어나 날짜를 바꾸어 확인해 주세요.' : '새 상담에서 시작 시각을 기록하세요.'));
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
    const time = `${!day ? `${kstDate(record.startAt)} · ` : ''}${kstTime(record.startAt)} — ${record.endAt ? kstTime(record.endAt) : '진행 중'} · 사진 ${record.cards.length}장`;
    button.append(row, node('div', 'record-time', time), node('div', 'record-memo', `${record.visitType === 'visit' ? '이전 기록' : '우리 부스 상담'}${record.memo ? ` · ${record.memo.replace(/\s+/g, ' ')}` : ''}`));
    button.addEventListener('click', () => action(async () => { selectedId = record.id; renderSelected(); setView('editor'); }));
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
      if (!confirm('이 상담에서 사진을 삭제할까요? 내보내지 않은 사진은 복구할 수 없습니다.')) return;
      action(async () => {
        const latest = current();
        const next = { ...latest, updatedAt: revision(latest), cards: latest.cards.filter(item => item.id !== metadata.id) };
        await deleteCard(next, metadata.id, persistedRevision.get(next.id) ?? null);
        persistedRevision.set(next.id, next.updatedAt);
        records.set(next.id, next);
        cards.delete(metadata.id);
        renderCards();
        renderList();
        message('사진을 삭제했습니다.');
      });
    });
    const details = node('details', 'photo-details');
    details.append(node('summary', '', `${PHOTO_KINDS[metadata.kind || 'card']} · 설명 수정`));
    const kindLabel = node('label', '', '사진 용도'), kind = node('select');
    for (const [value, label] of Object.entries(PHOTO_KINDS)) kind.append(new Option(label, value));
    kind.value = metadata.kind || 'card'; kindLabel.append(kind);
    const captionLabel = node('label', '', '사진 설명'), caption = node('textarea');
    caption.rows = 2; caption.maxLength = 2000; caption.value = metadata.caption || ''; captionLabel.append(caption);
    const save = node('button', 'button button-small button-outline', '사진 정보 저장'); save.type = 'button';
    save.addEventListener('click', () => action(async () => {
      const latest = current(), previous = cards.get(metadata.id);
      const updated = {...latest.cards.find(item => item.id === metadata.id), kind: kind.value, caption: caption.value.trim()};
      const next = {...latest, updatedAt: revision(latest), cards: latest.cards.map(item => item.id === metadata.id ? updated : item)};
      await saveCard(next, {...previous, ...updated}, persistedRevision.get(next.id) ?? null);
      persistedRevision.set(next.id, next.updatedAt); records.set(next.id, next); cards.set(metadata.id, {...previous, ...updated});
      renderCards(); renderList(); message('사진 용도와 설명을 저장했습니다.');
    }));
    details.append(kindLabel, captionLabel, save);
    tile.append(open, node('span', 'card-name', metadata.name), details, remove);
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
  $('editor-heading').textContent = record ? record.company || '회사명 미입력' : '새 상담';
  if (record) {
    $('company').value = record.company;
    $('memo').value = record.memo;
    $('memo-count').textContent = `${record.memo.length.toLocaleString('ko-KR')} / 5,000`;
    $('session-state').textContent = record.endAt ? '상담 기록 저장됨' : '상담 진행 중';
    $('session-banner').classList.toggle('ended', Boolean(record.endAt));
    $('end-record').hidden = Boolean(record.endAt);
    $('next-record').hidden = !record.endAt;
    $('add-consultation').hidden = Boolean(record.endAt);
    $('next-record').textContent = [...records.values()].some(other => other.id !== record.id && other.endAt === null) ? '진행 중 상담으로 돌아가기' : '다음 상담 준비';
    $('manual-start').value = kstInput(record.startAt);
    $('manual-end').value = kstInput(record.endAt);
    updateDuration();
  }
  renderCards();
  renderList();
  syncControls();
}

$('filter-date').value = kstDate();
setView('records');
for (const view of ['records', 'editor', 'transfer']) {
  $(`show-${view}`).addEventListener('click', () => action(async () => { setView(view); }));
}
$('search').addEventListener('input', renderList);
$('filter-date').addEventListener('change', renderList);
$('all-dates').addEventListener('click', () => { $('filter-date').value = ''; renderList(); });
$('record-form').addEventListener('submit', event => event.preventDefault());
$('company').addEventListener('input', () => { edit({ company: $('company').value }); $('editor-heading').textContent = $('company').value || '회사명 미입력'; });
$('memo').addEventListener('input', () => edit({ memo: $('memo').value }));
function startConsultation() {
  const clickedAt = new Date().toISOString();
  action(async () => {
    const record = { id: crypto.randomUUID(), createdAt: clickedAt, updatedAt: clickedAt, startAt: clickedAt, endAt: null, company: '', memo: '', team: '', visitType: 'booth', cards: [] };
    await saveRecord(record, null);
    persistedRevision.set(record.id, record.updatedAt);
    records.set(record.id, record);
    selectedId = record.id;
    $('filter-date').value = kstDate(record.startAt);
    $('search').value = '';
    renderSelected();
    setView('editor');
    message('상담 시작 시각을 기록했습니다. 녹음은 별도 녹음기에서 진행해 주세요.');
    setTimeout(() => $('company').focus(), 0);
  });
}
$('start-record').addEventListener('click', startConsultation);
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
    const active = [...records.values()].filter(record => record.endAt === null).sort((a, b) => b.startAt.localeCompare(a.startAt))[0];
    if (active) {
      selectedId = active.id;
      renderSelected();
      message('진행 중인 상담으로 돌아왔습니다. 각 상담의 종료 시각을 따로 기록해 주세요.');
    } else {
      selectedId = null;
      renderSelected();
    }
    setView('editor');
    if (!active) $('start-record').focus();
    if (matchMedia('(max-width: 640px)').matches) $('editor-heading').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}
$('new-record').addEventListener('click', () => {
  if ([...records.values()].some(record => record.endAt === null)) startConsultation();
  else prepareNew();
});
$('add-consultation').addEventListener('click', startConsultation);
$('next-record').addEventListener('click', prepareNew);
$('retry-save').addEventListener('click', () => action(async () => { message('입력한 내용을 기기에 저장했습니다.'); }));
$('delete-record').addEventListener('click', () => {
  const record = current();
  if (!record || busy || !ready) return;
  if (!$('time-editor').hidden && ($('manual-start').value !== kstInput(record.startAt) || $('manual-end').value !== kstInput(record.endAt))) {
    message('수정 중인 상담 시각을 먼저 적용하거나 시각 수정을 닫은 뒤 삭제해 주세요.', 'error');
    $('save-times').focus();
    return;
  }
  action(async () => {
    const saved = current();
    pendingDelete = { id: saved.id, updatedAt: persistedRevision.get(saved.id) };
    $('delete-name').textContent = `${saved.company || '회사명 미입력'} · ${kstTime(saved.startAt, true)}`;
    $('delete-counts').textContent = `상담 기록 1건 · 첨부 사진 ${[...cards.values()].filter(card => card.recordId === saved.id).length}장${saved.endAt === null ? ' · 진행 중인 상담' : ''}`;
    $('delete-error').hidden = true;
    $('delete-dialog').showModal();
  }).then(() => { if ($('delete-dialog').open) $('delete-cancel').focus(); });
});
$('delete-cancel').addEventListener('click', () => { if (!busy) $('delete-dialog').close(); });
$('delete-dialog').addEventListener('cancel', event => { if (busy) event.preventDefault(); });
$('delete-dialog').addEventListener('close', () => { if (!$('delete-dialog').open) pendingDelete = null; syncControls(); });
$('delete-confirm').addEventListener('click', async () => {
  if (!pendingDelete) return;
  await action(async () => {
    const target = pendingDelete;
    await deleteRecords([target]);
    records.delete(target.id);
    persistedRevision.delete(target.id);
    dirty.delete(target.id);
    for (const [id, card] of cards) if (card.recordId === target.id) cards.delete(id);
    selectedId = [...records.values()].sort((a, b) => Number(a.endAt !== null) - Number(b.endAt !== null) || b.startAt.localeCompare(a.startAt))[0]?.id || null;
    $('delete-dialog').close();
    renderSelected();
    setView('records');
    message('상담 1건과 연결된 명함·명찰 사진을 이 브라우저에서 삭제했습니다. 내려받은 ZIP 파일은 그대로 남습니다.');
  });
  if ($('delete-dialog').open) {
    $('delete-error').textContent = $('message').textContent;
    $('delete-error').hidden = false;
  } else (document.querySelector('.record-item.selected') || $('new-record')).focus();
});
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
for (const [labelId, inputId] of [['card-upload', 'card-file'], ['gallery-upload', 'gallery-file'], ['import-label', 'import-file']]) {
  $(labelId).addEventListener('keydown', event => {
    if ((event.key === 'Enter' || event.key === ' ') && !$(inputId).disabled) {
      event.preventDefault();
      $(inputId).click();
    }
  });
}
for (const inputId of ['card-file', 'gallery-file']) $(inputId).addEventListener('change', () => {
  const input = $(inputId);
  const files = [...input.files];
  if (!files.length) return;
  action(async () => {
    let count = 0;
    for (const file of files) {
      const blob = await compressedImage(file);
      const id = crypto.randomUUID();
      const metadata = { id, name: file.name.slice(0, 255), type: blob.type, size: blob.size, path: `cards/${id}.jpg`, kind: $('photo-kind').value, caption: $('photo-caption').value.trim() };
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
      message(`사진 ${count}장을 기기에 저장했습니다. 확대해서 내용을 확인해 주세요.`);
    }
  }).finally(() => { input.value = ''; });
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
    const attached = selected.flatMap(record => record.cards.map(card => cards.get(card.id)));
    const blob = await createBundle(selected, attached);
    const stamp = kstInput(new Date().toISOString()).replace(/[:T]/g, '-');
    const filename = `tisc-notes-${day || 'all'}-${stamp}.zip`;
    download(blob, filename);
    message(`${selected.length}건과 사진 ${attached.length}장의 다운로드를 요청했습니다.${dirty.size ? ' 기기 저장에 실패한 수정본이 포함되어 있습니다.' : ''} 파일이 실제로 저장되었는지 확인한 뒤 분석 PC나 별도 보관 위치로 옮겨 주세요.`, 'warning');
  }, true);
}
$('export-date').addEventListener('click', () => exportRecords(false));
$('export-all').addEventListener('click', () => exportRecords(true));
$('import-file').addEventListener('change', () => {
  const file = $('import-file').files[0];
  if (!file) return;
  action(async () => {
    const bundle = await readBundle(file);
    if (!confirm(`상담 ${bundle.records.length}건과 사진 ${bundle.cards.length}장을 가져올까요? 같은 상담은 최신 수정본을 사용하며, 같은 수정 시각의 충돌은 가져오지 않습니다.`)) return;
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
function showBackupConfig(config) {
  if (!config) return;
  $('backup-url').value = config.url; $('backup-label').value = config.label;
  $('backup-token').value = config.token; $('backup-device').value = config.deviceId;
}
showBackupConfig(pcBackup.config);
try {
  const paired = new URLSearchParams(location.hash.slice(1)).get('backup');
  if (paired) {
    showBackupConfig(backupConfig(JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(paired), char => char.charCodeAt(0))))));
    history.replaceState(null, '', location.pathname + location.search);
    $('backup-message').textContent = 'PC 주소를 확인한 뒤 백업 연결을 눌러 주세요.';
    setView('transfer'); document.querySelector('.backup-setup').scrollIntoView();
  }
} catch { $('backup-message').textContent = '연결 링크가 올바르지 않습니다. PC에서 다시 받아 주세요.'; }
$('pc-backup-form').addEventListener('submit', event => {
  event.preventDefault();
  try {
    pcBackup.connect({url: $('backup-url').value.trim(), token: $('backup-token').value.trim(),
      label: $('backup-label').value.trim(), deviceId: $('backup-device').value || crypto.randomUUID()});
    showBackupConfig(pcBackup.config); $('backup-message').textContent = 'PC 자동 백업을 연결했습니다. 전송 완료 여부는 상단에서 확인하세요.';
  } catch (error) { $('backup-message').textContent = error.message; }
});
$('backup-disconnect').addEventListener('click', () => { pcBackup.disconnect(); $('backup-message').textContent = 'PC의 기존 백업은 남겨 두고 이 기기의 자동 전송만 중지했습니다.'; });
$('backup-restore').addEventListener('click', () => action(async () => {
  const bundle = await pcBackup.restore();
  if (!confirm(`PC에 보관한 상담 ${bundle.records.length}건과 사진 ${bundle.cards.length}장을 복원할까요? 같은 기록은 최신 수정본을 유지합니다.`)) return;
  await importRecords(bundle); await reloadData(); selectedId = null; renderSelected();
  $('backup-message').textContent = 'PC 백업을 이 브라우저에 복원했습니다.';
}));
window.addEventListener('online', () => pcBackup.schedule(0));
if (ready) pcBackup.schedule();
offlineSetup();
