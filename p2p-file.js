export const P2P_FRAME_SIZE = 16 * 1024;
export const P2P_READ_SIZE = 256 * 1024;

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const drain = async (dataChannel, isCancelled) => {
    while (dataChannel.bufferedAmount > 4 * 1024 * 1024) {
        if (isCancelled()) throw new Error('transfer cancelled');
        if (dataChannel.readyState !== 'open') throw new Error('connection closed');
        await wait(30);
    }
};

// Read bounded slices from the original Blob/File. The browser never creates a
// whole-file ArrayBuffer, while the existing receiver can still resume at any byte.
export async function sendBlobSlices(conn, blob, offset = 0, options = {}) {
    const dataChannel = conn?.dataChannel;
    if (!dataChannel) throw new Error('connection unavailable');
    const readSize = options.readSize || P2P_READ_SIZE;
    const frameSize = options.frameSize || P2P_FRAME_SIZE;
    const isCancelled = options.isCancelled || (() => false);
    const onProgress = options.onProgress || (() => {});
    let sent = Math.max(0, Math.min(blob.size, Number(offset) || 0));
    while (sent < blob.size) {
        if (isCancelled()) throw new Error('transfer cancelled');
        if (!conn.open || dataChannel.readyState !== 'open') throw new Error('connection closed');
        const sliceStart = sent;
        const buffer = await blob.slice(sliceStart, Math.min(sliceStart + readSize, blob.size)).arrayBuffer();
        for (let inner = 0; inner < buffer.byteLength; inner += frameSize) {
            if (isCancelled()) throw new Error('transfer cancelled');
            if (!conn.open || dataChannel.readyState !== 'open') throw new Error('connection closed');
            dataChannel.send(buffer.slice(inner, Math.min(inner + frameSize, buffer.byteLength)));
            sent = sliceStart + Math.min(inner + frameSize, buffer.byteLength);
            onProgress(sent, blob.size);
            await drain(dataChannel, isCancelled);
        }
    }
    return sent;
}
