import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendBlobSlices } from '../p2p-file.js';

test('P2P reads bounded slices and resumes at an exact byte offset', async () => {
    const input = Uint8Array.from({length: 1003}, (_, index) => index % 251);
    const source = new Blob([input]), reads = [], frames = [], progress = [];
    const blob = {size:source.size,slice(start,end){reads.push([start,end]);return source.slice(start,end);}};
    const dataChannel = {readyState:'open',bufferedAmount:0,send:frame=>frames.push(new Uint8Array(frame))};
    const sent = await sendBlobSlices({open:true,dataChannel},blob,37,{readSize:128,frameSize:31,onProgress:value=>progress.push(value)});
    assert.equal(sent,input.length);
    assert.ok(reads.every(([start,end])=>end-start<=128));
    assert.deepEqual(new Uint8Array(await new Blob(frames).arrayBuffer()),input.slice(37));
    assert.equal(progress.at(-1),input.length);
});

test('P2P stops reading when the transfer is cancelled', async () => {
    const source = new Blob([new Uint8Array(1000)]); let cancelled=false, sends=0;
    const dataChannel={readyState:'open',bufferedAmount:0,send(){sends++;cancelled=true;}};
    await assert.rejects(sendBlobSlices({open:true,dataChannel},source,0,{readSize:100,frameSize:25,isCancelled:()=>cancelled}),/cancelled/);
    assert.equal(sends,1);
});
