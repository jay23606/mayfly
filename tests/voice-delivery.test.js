import {test} from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../chat.js',import.meta.url),'utf8');
const extract=(a,b)=>source.slice(source.indexOf(a),source.indexOf(b)).replaceAll('export ','');
for(const streamed of [true,false])test(`relay downloads without progress callback (${streamed?'stream':'blob'} response)`,async()=>{
 const bytes=new Uint8Array([1,2,3]);let done=false;
 const response=streamed?{ok:true,headers:{get:()=>3},body:{getReader:()=>({read:async()=>{if(done)return {done:true};done=true;return {done:false,value:bytes};}})}}:{ok:true,headers:{get:()=>3},body:null,blob:async()=>new Blob([bytes])};
 const ctx=vm.createContext({Blob,SNAP_BUCKET:'bucket',sb:{storage:{from:()=>({createSignedUrl:async()=>({data:{signedUrl:'https://test'}})})}},fetch:async()=>response});
 vm.runInContext(extract('const relayDownload =','const relayTransferJobs'),ctx);const blob=await vm.runInContext("relayDownload('clip')",ctx);assert.equal(blob.size,3);
});
function receiver({failAck=false,failSave=false}={}){
 const history=[],events=[];let downloads=0;
 const row={id:'clip',sender_id:'friend',recipient_id:'me',recipient_device_id:'phone',relay_id:'payload',mime:'audio/mp4',media_kind:'audio',created_at:new Date(20).toISOString()};
 const ctx=vm.createContext({Map,Promise,Blob,console:{error(){}},state:{me:{id:'me'},deviceId:'phone',priv:{}},histGet:async()=>history,
 db:{relayPayload:async()=>({data:{content_iv:'iv'}}),completeTransfer:async()=>{events.push('ack');return {data:!failAck,error:failAck?Error('network'):null};}},relayDownload:async()=>{downloads++;return new Blob(['audio']);},decryptSharedRelay:async()=>new Uint8Array([1,2,3]),blobToDataURL:async()=> 'data:audio/mp4;base64,AQID',isAfterClear:()=>true,
 histUpdate:async(uid,change)=>{if(failSave)throw Error('disk');change(history);events.push('save');},openUid:'friend',convBox:null,renderThreadBody:async()=>events.push('render'),unreadMsg:new Set(),onChange:()=>{}});
 vm.runInContext(extract('const relayTransferJobs','const formatSnapProgress'),ctx);
 return {history,events,downloads:()=>downloads,receive:r=>{ctx.row=r||row;return vm.runInContext('receiveRelayTransfer(row)',ctx);}};
}
test('overlapping realtime and catch-up save a clip once, before completion',async()=>{const f=receiver();assert.deepEqual(await Promise.all([f.receive(),f.receive()]),[true,true]);assert.equal(f.history.length,1);assert.equal(f.downloads(),1);assert.deepEqual(f.events,['save','render','ack']);});
test('failed acknowledgement still displays clip and retry does not duplicate it',async()=>{const f=receiver({failAck:true});assert.equal(await f.receive(),false);assert.equal(await f.receive(),false);assert.equal(f.history.length,1);assert.equal(f.downloads(),1);assert.ok(f.events.indexOf('render')<f.events.indexOf('ack'));});
test('storage failure never acknowledges clip',async()=>{const f=receiver({failSave:true});assert.equal(await f.receive(),false);assert.ok(!f.events.includes('ack'));});
test('wrong device cannot ingest the phone envelope',async()=>{const f=receiver();assert.equal(await f.receive({id:'wrong',recipient_id:'me',recipient_device_id:'laptop'}),false);assert.equal(f.downloads(),0);});
test('voice uses durable relay even with a live peer',async()=>{let relay=0,p2p=0;const ctx=vm.createContext({rand:()=> 'id',blobToDataURL:async()=> 'data',relayFile:async()=>{relay++;return true;},sendP2PTransfer:async()=>{p2p++;},conns:new Map([['friend',{open:true}]]),histPush:async()=>{},toast:()=>{}});vm.runInContext(extract('const sendFile =','const wireMic'),ctx);ctx.file={name:'voice',type:'audio/mp4'};assert.equal(await vm.runInContext("sendFile('friend',file,'audio')",ctx),true);assert.equal(relay,1);assert.equal(p2p,0);});
