import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const code = source.slice(source.indexOf("let stream = null, facing"), source.indexOf('const viewCamera ='));
function setup(call) {
    let stopped = 0, acquisitions = [];
    const video = {isConnected:true, play:async()=>{}};
    const owned = {getTracks:()=>[{stop:()=>stopped++}]};
    const ctx = vm.createContext({window:{addEventListener(){}}, $:id=>id==='#cam'?video:{}, callCapture:()=>call,
        navigator:{mediaDevices:{getUserMedia:async options=>{acquisitions.push(options);return owned;}}}});
    vm.runInContext(code,ctx);
    return {ctx,video,acquisitions,stopped:()=>stopped};
}
test('snap preview borrows call tracks and navigation does not stop them',async()=>{
    let stopped=0;const shared={getTracks:()=>[{stop:()=>stopped++}]};
    const h=setup({active:true,stream:shared,facing:'user'});
    await vm.runInContext('startCamera()',h.ctx);
    assert.equal(h.video.srcObject,shared);assert.equal(h.acquisitions.length,0);
    vm.runInContext('stopStream()',h.ctx);assert.equal(stopped,0);
});
test('voice call snap capture does not request a second microphone',async()=>{
    const h=setup({active:true,stream:null});await vm.runInContext('startCamera()',h.ctx);
    assert.equal(h.acquisitions[0].audio,false);vm.runInContext('stopStream()',h.ctx);assert.equal(h.stopped(),1);
});
test('navigation during camera acquisition releases the late stream',async()=>{
    const h=setup({active:false,stream:null});const pending=vm.runInContext('startCamera()',h.ctx);
    vm.runInContext('stopStream()',h.ctx);await pending;assert.equal(h.stopped(),1);assert.equal(h.video.srcObject,undefined);
});
