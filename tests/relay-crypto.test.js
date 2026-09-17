import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createChunkedRelayEncryptor, decryptSharedRelayChunk, encryptedChunkedSize, importRelayKey } from '../relay-crypto.js';

test('chunked relay encryption round-trips across uneven boundaries', async () => {
    const input = Uint8Array.from({length: 2501}, (_, index) => index % 251);
    const encryptor = await createChunkedRelayEncryptor(new Blob([input]), 1000);
    assert.equal(encryptor.chunkCount, 3);
    assert.equal(encryptor.encryptedSize, encryptedChunkedSize(input.length, 1000));
    const key = await importRelayKey(encryptor.rawKey), output = [];
    for (let index = 0; index < encryptor.chunkCount; index++) {
        const encrypted = await encryptor.encryptChunk(index);
        assert.equal(encrypted.byteLength, Math.min(1000, input.length - index * 1000) + 16);
        output.push(await decryptSharedRelayChunk(key, encryptor.content_iv, index, encrypted));
    }
    assert.deepEqual(new Uint8Array(await new Blob(output).arrayBuffer()), input);
});

test('chunk authentication binds ciphertext to its chunk index', async () => {
    const encryptor = await createChunkedRelayEncryptor(new Blob([new Uint8Array(1500)]), 1000);
    const key = await importRelayKey(encryptor.rawKey);
    await assert.rejects(decryptSharedRelayChunk(key, encryptor.content_iv, 1, await encryptor.encryptChunk(0)));
});
