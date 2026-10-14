export const MAX_RECORDING_BYTES = 2 * 1024 ** 3;
export const AUDIO_CHUNK_BYTES = 1024 * 1024;
export const RECORDING_EXTENSIONS = {'audio/mp4':'m4a', 'audio/mpeg':'mp3', 'audio/wav':'wav', 'audio/flac':'flac', 'audio/ogg':'ogg', 'audio/webm':'webm'};
const aliases = {'audio/mp4':['audio/x-m4a','video/mp4'], 'audio/mpeg':['audio/mp3','audio/x-mpeg'], 'audio/wav':['audio/x-wav','audio/wave','audio/vnd.wave'],
  'audio/flac':['audio/x-flac'], 'audio/ogg':['application/ogg'], 'audio/webm':['video/webm']};
const encoder = new TextEncoder();
export const sha256 = async bytes => new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
export const hexDigest = bytes => Array.from(bytes, byte => byte.toString(16).padStart(2,'0')).join('');

export function recordingMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.id !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.id)
      || typeof value.name !== 'string' || value.name.length > 255 || typeof value.type !== 'string' || !Object.hasOwn(RECORDING_EXTENSIONS, value.type)
      || !Number.isSafeInteger(value.size) || value.size < 1 || value.size > MAX_RECORDING_BYTES) throw new Error('녹음 파일 정보가 올바르지 않습니다. 파일 하나는 2GiB 이내여야 합니다.');
  const id = value.id.toLowerCase(), path = `recordings/${id}.${RECORDING_EXTENSIONS[value.type]}`;
  if (value.path !== path) throw new Error('녹음 파일 경로가 올바르지 않습니다.');
  return {id, name:value.name, type:value.type, size:value.size, path};
}

export function validateRecordingHeader(bytes, type) {
  const text = (start, end) => String.fromCharCode(...bytes.subarray(start,end));
  const valid = type === 'audio/mp4' ? bytes.length >= 12 && text(4,8) === 'ftyp'
    : type === 'audio/mpeg' ? bytes.length >= 3 && (text(0,3) === 'ID3' || (bytes[0] === 255 && (bytes[1] & 224) === 224 && (bytes[1] & 6) !== 0))
    : type === 'audio/wav' ? bytes.length >= 12 && text(0,4) === 'RIFF' && text(8,12) === 'WAVE'
    : type === 'audio/flac' ? text(0,4) === 'fLaC'
    : type === 'audio/ogg' ? text(0,4) === 'OggS'
    : type === 'audio/webm' ? bytes.length >= 4 && [26,69,223,163].every((value,index) => bytes[index] === value) : false;
  if (!valid) throw new Error('녹음 파일 내용과 형식이 일치하지 않습니다.');
}

export async function normalizeRecording(file) {
  if (!(file instanceof Blob) || file.size < 1 || file.size > MAX_RECORDING_BYTES) throw new Error('녹음 파일 하나는 2GiB 이내로 선택해 주세요.');
  const extension = (file.name || '').split('.').at(-1).toLowerCase();
  const type = extension === 'mp4' ? 'audio/mp4' : Object.keys(RECORDING_EXTENSIONS).find(key => RECORDING_EXTENSIONS[key] === extension);
  const declared = file.type.split(';')[0].trim().toLowerCase();
  if (!type || (declared && declared !== 'application/octet-stream' && declared !== type && !aliases[type].includes(declared))) throw new Error('M4A, MP4, MP3, WAV, FLAC, OGG, WebM 녹음의 파일명과 형식을 확인해 주세요.');
  validateRecordingHeader(new Uint8Array(await file.slice(0,64).arrayBuffer()), type);
  return file.slice(0,file.size,type);
}

export async function recordingTreeDigest(size, type, leaves) {
  if (!Number.isSafeInteger(size) || size < 1 || size > MAX_RECORDING_BYTES || !Object.hasOwn(RECORDING_EXTENSIONS,type)
      || !Array.isArray(leaves) || leaves.length !== Math.ceil(size / AUDIO_CHUNK_BYTES) || leaves.some(leaf => !(leaf instanceof Uint8Array) || leaf.length !== 32)) throw new Error('녹음 청크 해시 정보가 올바르지 않습니다.');
  const prefix = encoder.encode(`TISC-AUDIO-TREE-SHA256-v1\0${size}\0${type}\0${AUDIO_CHUNK_BYTES}\0`);
  const bytes = new Uint8Array(prefix.length + leaves.length * 32);
  bytes.set(prefix); leaves.forEach((leaf,index) => bytes.set(leaf,prefix.length + index * 32));
  return hexDigest(await sha256(bytes));
}

export async function recordingDigest(blob, onProgress = () => {}) {
  if (!(blob instanceof Blob) || blob.size < 1 || blob.size > MAX_RECORDING_BYTES || !Object.hasOwn(RECORDING_EXTENSIONS,blob.type)) throw new Error('녹음 파일 크기 또는 형식이 올바르지 않습니다.');
  const leaves = [];
  onProgress(0,blob.size);
  for (let offset = 0; offset < blob.size; offset += AUDIO_CHUNK_BYTES) {
    const bytes = new Uint8Array(await blob.slice(offset,offset + AUDIO_CHUNK_BYTES).arrayBuffer());
    if (!offset) validateRecordingHeader(bytes,blob.type);
    leaves.push(await sha256(bytes));
    onProgress(Math.min(blob.size,offset + AUDIO_CHUNK_BYTES),blob.size);
  }
  return recordingTreeDigest(blob.size,blob.type,leaves);
}
