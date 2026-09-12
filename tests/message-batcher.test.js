import {test} from 'node:test';import assert from 'node:assert/strict';import {createMessageBatcher} from '../message-batcher.js';
test('bursts and catch-up are merged into bounded chunks with duplicate protection',async()=>{
 const batches=[];const queue=createMessageBatcher(async rows=>{batches.push(rows.map(r=>r.id));return new Set(rows.map(r=>r.id));},{size:3,delay:1});
 const one=queue([{id:'1'},{id:'2'}]),two=queue([{id:'2'},{id:'3'},{id:'4'}]);await Promise.all([one,two]);assert.deepEqual(batches,[['1','2','3'],['4']]);assert.deepEqual(await queue([{id:'1'}]),[false]);
});
test('failed processing is retryable and later chunks still run',async()=>{
 let failed=true;const queue=createMessageBatcher(async rows=>{if(failed){failed=false;throw Error('disk');}return new Set(rows.map(r=>r.id));},{size:1,delay:1});
 const result=await Promise.allSettled([queue([{id:'1'}]),queue([{id:'2'}])]);assert.equal(result[0].status,'rejected');assert.equal(result[1].status,'fulfilled');assert.deepEqual(await queue([{id:'1'}]),[true]);
});
test('unsaved envelopes remain retryable',async()=>{let count=0;const queue=createMessageBatcher(async rows=>++count===1?new Set():new Set(rows.map(r=>r.id)),{delay:1});assert.deepEqual(await queue([{id:'1'}]),[false]);assert.deepEqual(await queue([{id:'1'}]),[true]);});
