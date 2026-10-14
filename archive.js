export const MAX_BUNDLE_BYTES = 256 * 1024 * 1024;
const MAX_ENTRIES = 5000;
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const extensions = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  return value >>> 0;
});

function fail(message) {
  throw new Error(message);
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} 형식이 올바르지 않습니다.`);
}

function text(value, max, label) {
  if (typeof value !== 'string' || value.length > max) fail(`${label}은 ${max}자 이내의 글자여야 합니다.`);
  return value;
}

function uuid(value) {
  if (typeof value !== 'string' || !uuidPattern.test(value)) fail('기록 또는 명함 ID가 올바르지 않습니다.');
  return value.toLowerCase();
}

function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
      || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    fail('날짜는 유효한 UTC ISO 시각이어야 합니다.');
  }
  return value;
}

function cardMetadata(card) {
  object(card, '명함');
  const id = uuid(card.id);
  if (typeof card.type !== 'string' || !Object.hasOwn(extensions, card.type)) fail('명함은 JPG, PNG, WebP 이미지만 지원합니다.');
  const path = `cards/${id}.${extensions[card.type]}`;
  if (card.path !== path) fail('명함 파일 경로가 올바르지 않습니다.');
  if (!Number.isSafeInteger(card.size) || card.size <= 0 || card.size > MAX_BUNDLE_BYTES) fail('명함 파일 크기가 올바르지 않습니다.');
  const result = { id, name: text(card.name, 255, '명함 이름'), type: card.type, size: card.size, path };
  if (card.kind !== undefined) {
    if (!['card', 'badge', 'product', 'booth', 'other'].includes(card.kind)) fail('사진 용도가 올바르지 않습니다.');
    result.kind = card.kind;
  }
  if (card.caption !== undefined) result.caption = text(card.caption, 2000, '사진 설명');
  return result;
}

export function validateRecord(record) {
  object(record, '상담 기록');
  const startAt = timestamp(record.startAt);
  const endAt = record.endAt === null ? null : timestamp(record.endAt);
  if (endAt !== null && endAt < startAt) fail('상담 종료 시각은 시작 시각보다 빠를 수 없습니다.');
  if (!['booth', 'visit'].includes(record.visitType)) fail('상담 구분이 올바르지 않습니다.');
  if (!Array.isArray(record.cards) || record.cards.length >= MAX_ENTRIES) fail('명함 목록이 올바르지 않습니다.');
  const cards = record.cards.map(cardMetadata);
  if (new Set(cards.map(card => card.id)).size !== cards.length) fail('명함 ID가 중복되었습니다.');
  return {
    id: uuid(record.id), createdAt: timestamp(record.createdAt), updatedAt: timestamp(record.updatedAt),
    startAt, endAt, company: text(record.company, 200, '회사명').trim(),
    memo: text(record.memo, 5000, '메모'), team: text(record.team === undefined ? '' : record.team, 40, '기록 구분').trim(),
    visitType: record.visitType, cards,
  };
}

function validateRecords(records) {
  if (!Array.isArray(records) || records.length > MAX_ENTRIES) fail('상담 목록이 올바르지 않거나 너무 큽니다.');
  const clean = records.map(validateRecord);
  if (new Set(clean.map(record => record.id)).size !== clean.length) fail('상담 ID가 중복되었습니다.');
  const references = new Map();
  for (const record of clean) {
    for (const card of record.cards) {
      if (references.has(card.id)) fail('명함이 여러 상담에 중복 연결되었습니다.');
      references.set(card.id, { ...card, recordId: record.id });
    }
  }
  if (references.size + 1 > MAX_ENTRIES) fail('한 파일에는 최대 4,999장의 명함을 넣을 수 있습니다.');
  return { records: clean, references };
}

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = (value >>> 8) ^ crcTable[(value ^ byte) & 255];
  return (value ^ 0xffffffff) >>> 0;
}

function validateImage(bytes, type) {
  const jpg = bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  const png = bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte);
  const webp = bytes.length >= 12 && String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF'
    && String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP';
  if (!(type === 'image/jpeg' ? jpg : type === 'image/png' ? png : webp)) fail('명함 파일 내용과 이미지 형식이 일치하지 않습니다.');
}

function header(length) {
  const bytes = new Uint8Array(length);
  return { bytes, view: new DataView(bytes.buffer) };
}

// shortcut: 이 앱의 비압축 ZIP 형식만 읽습니다. 외부 ZIP 가져오기가 필요하면 지원 범위를 넓힙니다.
function zip(entries) {
  const local = [];
  const central = [];
  let offset = 0;
  let centralSize = 0;
  for (const { name, bytes } of entries) {
    const filename = encoder.encode(name);
    const crc = crc32(bytes);
    const entry = header(30 + filename.length);
    entry.view.setUint32(0, 0x04034b50, true);
    entry.view.setUint16(4, 20, true);
    entry.view.setUint16(6, 0x0800, true);
    entry.view.setUint16(12, 0x0021, true);
    entry.view.setUint32(14, crc, true);
    entry.view.setUint32(18, bytes.length, true);
    entry.view.setUint32(22, bytes.length, true);
    entry.view.setUint16(26, filename.length, true);
    entry.bytes.set(filename, 30);
    local.push(entry.bytes, bytes);
    const index = header(46 + filename.length);
    index.view.setUint32(0, 0x02014b50, true);
    index.view.setUint16(4, 20, true);
    index.view.setUint16(6, 20, true);
    index.view.setUint16(8, 0x0800, true);
    index.view.setUint16(14, 0x0021, true);
    index.view.setUint32(16, crc, true);
    index.view.setUint32(20, bytes.length, true);
    index.view.setUint32(24, bytes.length, true);
    index.view.setUint16(28, filename.length, true);
    index.view.setUint32(42, offset, true);
    index.bytes.set(filename, 46);
    central.push(index.bytes);
    offset += entry.bytes.length + bytes.length;
    centralSize += index.bytes.length;
  }
  const end = header(22);
  end.view.setUint32(0, 0x06054b50, true);
  end.view.setUint16(8, entries.length, true);
  end.view.setUint16(10, entries.length, true);
  end.view.setUint32(12, centralSize, true);
  end.view.setUint32(16, offset, true);
  if (offset + centralSize + 22 > MAX_BUNDLE_BYTES) fail('기록 묶음은 256MB를 넘을 수 없습니다. 날짜를 나눠 내보내세요.');
  return new Blob([...local, ...central, end.bytes], { type: 'application/zip' });
}

export async function createBundle(records, cards) {
  const validated = validateRecords(records);
  if (!Array.isArray(cards) || cards.length !== validated.references.size) fail('상담에 연결된 명함 파일이 누락되었거나 불필요한 명함이 있습니다.');
  const manifest = encoder.encode(JSON.stringify({ schemaVersion: 1, exportedAt: new Date().toISOString(), records: validated.records }));
  if (manifest.length > MAX_MANIFEST_BYTES) fail('상담 기록이 너무 큽니다. 날짜를 나눠 내보내세요.');
  let totalSize = manifest.length;
  const ids = new Set();
  for (const card of cards) {
    const metadata = cardMetadata(card);
    const reference = validated.references.get(metadata.id);
    if (!reference || ids.has(metadata.id) || reference.recordId !== card.recordId
        || ['name', 'type', 'size', 'path', 'kind', 'caption'].some(key => reference[key] !== metadata[key])) {
      fail('명함 파일과 상담의 연결 정보가 일치하지 않습니다.');
    }
    if (!(card.blob instanceof Blob) || card.blob.size !== metadata.size || card.blob.type !== metadata.type) fail('명함 파일의 크기 또는 형식이 일치하지 않습니다.');
    ids.add(metadata.id);
    totalSize += card.blob.size + encoder.encode(metadata.path).length * 2 + 76;
    if (totalSize + 124 > MAX_BUNDLE_BYTES) fail('기록 묶음은 256MB를 넘을 수 없습니다. 날짜를 나눠 내보내세요.');
  }
  const entries = [{ name: 'manifest.json', bytes: manifest }];
  for (const card of cards) {
    const bytes = new Uint8Array(await card.blob.arrayBuffer());
    validateImage(bytes, card.type);
    entries.push({ name: card.path, bytes });
  }
  return zip(entries);
}

function unzip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  function range(offset, length) {
    if (!Number.isSafeInteger(offset) || offset < 0 || length < 0 || offset + length > bytes.length) fail('기록 파일이 잘렸거나 손상되었습니다.');
  }
  function u16(offset) { range(offset, 2); return view.getUint16(offset, true); }
  function u32(offset) { range(offset, 4); return view.getUint32(offset, true); }
  const end = bytes.length - 22;
  if (end < 0 || u32(end) !== 0x06054b50 || u16(end + 4) || u16(end + 6) || u16(end + 20)) fail('이 앱에서 내보낸 ZIP 기록 파일이 아닙니다.');
  const count = u16(end + 10);
  const centralSize = u32(end + 12);
  const centralStart = u32(end + 16);
  if (!count || count > MAX_ENTRIES || count !== u16(end + 8) || centralStart + centralSize !== end) fail('ZIP 파일 목록이 올바르지 않습니다.');
  let cursor = centralStart;
  let localEnd = 0;
  const entries = new Map();
  for (let entry = 0; entry < count; entry++) {
    range(cursor, 46);
    if (u32(cursor) !== 0x02014b50 || u16(cursor + 6) !== 20 || u16(cursor + 8) !== 0x0800 || u16(cursor + 10) !== 0
        || u16(cursor + 30) || u16(cursor + 32) || u16(cursor + 34)) fail('지원하지 않는 ZIP 형식입니다. 앱에서 내보낸 파일을 선택하세요.');
    const size = u32(cursor + 24);
    const checksum = u32(cursor + 16);
    const nameLength = u16(cursor + 28);
    range(cursor + 46, nameLength);
    const name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    if (name !== 'manifest.json' && !/^cards\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)$/.test(name)) fail('ZIP 안에 허용되지 않는 파일 경로가 있습니다.');
    if (entries.has(name)) fail('ZIP 안에 중복된 파일이 있습니다.');
    if (size !== u32(cursor + 20)) fail('압축된 ZIP 파일은 지원하지 않습니다.');
    const start = u32(cursor + 42);
    range(start, 30);
    if (start !== localEnd || u32(start) !== 0x04034b50 || u16(start + 4) !== 20 || u16(start + 6) !== 0x0800
        || u16(start + 8) !== 0 || u32(start + 14) !== checksum || u32(start + 18) !== size || u32(start + 22) !== size
        || u16(start + 26) !== nameLength || u16(start + 28)) fail('ZIP 파일 정보가 일치하지 않습니다.');
    range(start + 30, nameLength);
    if (decoder.decode(bytes.subarray(start + 30, start + 30 + nameLength)) !== name) fail('ZIP 파일 이름이 일치하지 않습니다.');
    const contentStart = start + 30 + nameLength;
    range(contentStart, size);
    localEnd = contentStart + size;
    if (localEnd > centralStart) fail('ZIP 파일의 데이터 구간이 올바르지 않습니다.');
    const content = bytes.subarray(contentStart, localEnd);
    if (crc32(content) !== checksum) fail('기록 파일이 손상되었습니다. 원본 파일을 다시 가져오세요.');
    entries.set(name, content);
    cursor += 46 + nameLength;
  }
  if (cursor !== end || localEnd !== centralStart) fail('ZIP 파일 크기가 일치하지 않습니다.');
  return entries;
}

export async function readBundle(file) {
  if (!(file instanceof Blob) || file.size > MAX_BUNDLE_BYTES) fail('256MB 이하의 기록 ZIP 파일을 선택하세요.');
  const entries = unzip(new Uint8Array(await file.arrayBuffer()));
  const manifestBytes = entries.get('manifest.json');
  if (!manifestBytes || manifestBytes.length > MAX_MANIFEST_BYTES) fail('상담 목록 파일이 없거나 너무 큽니다.');
  let manifest;
  try { manifest = JSON.parse(decoder.decode(manifestBytes)); }
  catch { fail('상담 목록 JSON을 읽을 수 없습니다.'); }
  object(manifest, '상담 목록');
  if (manifest.schemaVersion !== 1) fail('지원하지 않는 기록 파일 버전입니다.');
  timestamp(manifest.exportedAt);
  const { records, references } = validateRecords(manifest.records);
  if (entries.size !== references.size + 1) fail('ZIP의 명함 목록과 상담 기록이 일치하지 않습니다.');
  const cards = [];
  for (const metadata of references.values()) {
    const bytes = entries.get(metadata.path);
    if (!bytes || bytes.length !== metadata.size) fail('명함 파일이 누락되었거나 크기가 일치하지 않습니다.');
    validateImage(bytes, metadata.type);
    cards.push({ ...metadata, blob: new Blob([bytes], { type: metadata.type }) });
  }
  return { records, cards };
}
