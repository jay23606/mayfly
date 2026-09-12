import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source = readFileSync(new URL('../chat.js', import.meta.url), 'utf8');
function block(start, end) { return source.slice(source.indexOf(start), source.indexOf(end)).replaceAll('export ', ''); }
test('device lookup includes newly registered phone on the next send', async () => {
    let devices = [{ id: 'laptop', pubkey: '{"kty":"EC"}' }];
    const ctx = vm.createContext({ db: { devicesForUser: async () => ({ data: devices }) } });
    vm.runInContext(block('const deviceKeysOf =', '// ---- pull any messages'), ctx);
    assert.equal((await vm.runInContext("deviceKeysOf('friend')", ctx)).length, 1);
    devices.push({ id: 'phone', pubkey: '{"kty":"EC"}' });
    assert.equal((await vm.runInContext("deviceKeysOf('friend')", ctx)).length, 2);
});
for (const all of [false, true]) test(`${all ? 'all chats' : 'one chat'} clear preserves a concurrent new message`, async () => {
    const stored = new Map([['thread:friend', [{at: 10}, {at: 30}]]]);
    let cutoff = 0;
    const ctx = vm.createContext({
        idb: { get: async k => structuredClone(stored.get(k)), set: async (k,v) => stored.set(k, structuredClone(v)), keys: async () => [...stored.keys()], del: async k => stored.delete(k) },
        markCleared: () => {cutoff=20;}, isAfterClear: (_, at) => at > cutoff,
        clearMarks: () => ({}), Date: {now: () => 20}, THREAD_CLEAR_KEY: 'clear',
        localStorage: {setItem: () => {cutoff=20;}}, unreadMsg: new Set(), openUid: null, convBox: null, onChange: () => {},
    });
    vm.runInContext("const histGet = uid => idb.get('thread:' + uid).then(h => h || []);\n" + block('const histWrites =', 'const lastLine =') + block('const clearReceiptsFor =', 'export const hideConversation'),ctx);
    await vm.runInContext(all ? 'clearAllLocalConversations()' : "clearConversation('friend')",ctx);
    assert.deepEqual(stored.get('thread:friend'), [{at:30}]);
});
