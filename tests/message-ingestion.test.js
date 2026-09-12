import {test} from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../chat.js',import.meta.url),'utf8');const code=source.slice(source.indexOf('const ingestMessageBatch ='),source.indexOf('const queueMessages ='));
function fixture({diskFail=false,ackFail=false}={}){
 const histories=new Map(),writes=[],acks=[],renders=[];
 const ctx=vm.createContext({Promise,Set,Map,console:{warn(){}}, state:{priv:{}},openUid:'friend',convBox:null,
 decryptText:async(_,e,i,body)=>{if(body==='bad')throw Error('decrypt');return body;},storyReplyFromPayload:async()=>null,replyFromPayload:()=>null,gifFromPayload:()=>null,clipFromPayload:()=>null,
 reactionFromPayload:text=>text.startsWith('reaction:')?{targetId:text.slice(9),reaction:'♥'}:null,pendingReactions:new Map(),isAfterClear:(_,at)=>at>10,
 histUpdate:async(uid,change)=>{if(diskFail)throw Error('disk');const h=structuredClone(histories.get(uid)||[]);change(h);histories.set(uid,h);writes.push(uid);},
 unreadMsg:new Set(),db:{delMessages:async ids=>{acks.push(Array.from(ids));return {error:ackFail?Error('network'):null};}},renderThreadBody:async uid=>renders.push(uid),renderConvs:async()=>{},browserNotificationsEnabled:()=>false,onChange:()=>{}});
 vm.runInContext(code,ctx);return {histories,writes,acks,renders,run:rows=>{ctx.rows=rows;return vm.runInContext('ingestMessageBatch(rows)',ctx);}};
}
const row=(id,body=id,at=20)=>({id,body,sender_id:'friend',created_at:new Date(at).toISOString()});
test('one history write, acknowledgement, and render for multiple ordered messages',async()=>{const f=fixture();await f.run([row('2','second',30),row('1','first',20)]);assert.equal(f.writes.length,1);assert.equal(f.acks.length,1);assert.equal(f.renders.length,1);assert.deepEqual(f.histories.get('friend').map(e=>e.text),['first','second']);});
test('bad envelopes do not block good ones, and saved rows deduplicate on retry',async()=>{const f=fixture();await f.run([row('1'),row('2','bad')]);assert.deepEqual(f.acks[0],['1']);await f.run([row('1')]);assert.equal(f.histories.get('friend').length,1);});
test('unsaved messages are never acknowledged',async()=>{const f=fixture({diskFail:true});const result=await f.run([row('1')]);assert.equal(result.size,0);assert.equal(f.acks.length,0);});
test('acknowledgement failure keeps delivery retryable after saving',async()=>{const f=fixture({ackFail:true});const result=await f.run([row('1')]);assert.equal(result.size,0);assert.equal(f.histories.get('friend').length,1);});
test('cleared messages stay cleared and a reaction before its target is attached',async()=>{const f=fixture();await f.run([row('old','old',5),row('reaction','reaction:target',20),row('target','hello',30)]);const h=f.histories.get('friend');assert.equal(h.length,1);assert.equal(h[0].reaction,'♥');assert.equal(f.acks[0].length,3);});
