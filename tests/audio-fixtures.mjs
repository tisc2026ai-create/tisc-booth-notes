import {recordingDigest} from '../assets.js';
export function wavBytes(size=64){
  const bytes=new Uint8Array(size),view=new DataView(bytes.buffer),text=(at,value)=>bytes.set(new TextEncoder().encode(value),at);
  text(0,'RIFF');view.setUint32(4,size-8,true);text(8,'WAVE');text(12,'fmt ');view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);
  view.setUint32(24,8000,true);view.setUint32(28,16000,true);view.setUint16(32,2,true);view.setUint16(34,16,true);text(36,'data');view.setUint32(40,size-44,true);return bytes;
}
export async function audioFixture(size=64){
  const id=crypto.randomUUID(),recordId=crypto.randomUUID(),now='2026-10-19T01:00:00.000Z',blob=new Blob([wavBytes(size)],{type:'audio/wav'});
  const metadata={id,name:'방문 녹음.wav',type:blob.type,size:blob.size,path:`recordings/${id}.wav`};
  const record={id:recordId,createdAt:now,updatedAt:now,startAt:now,endAt:null,company:'방문 회사',memo:'방문 제품 메모',team:'',visitType:'visit',timeBasis:'registered',cards:[],recordings:[metadata]};
  return {records:[record],cards:[],recordings:[{...metadata,recordId,blob,hash:await recordingDigest(blob)}]};
}
