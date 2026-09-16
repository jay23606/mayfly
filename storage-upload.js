const TUS_VERSION = '1.0.0';
export const RESUMABLE_THRESHOLD = 6 * 1024 * 1024;
export const RESUMABLE_CHUNK = 6 * 1024 * 1024;
const metadata = values => Object.entries(values).map(([key,value]) => `${key} ${btoa(unescape(encodeURIComponent(String(value))))}`).join(',');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const storageEndpoint = projectUrl => `${projectUrl.replace(/\.supabase\.co\/?$/, '.storage.supabase.co')}/storage/v1/upload/resumable`;
const requestWithRetry = async (makeRequest, retries=[0,1000,3000,5000,10000]) => {
    let last;
    for (const delay of retries) {
        if (delay) await wait(delay);
        try { const response = await makeRequest(); if (response.ok) return response; if (response.status < 500 && response.status !== 408 && response.status !== 429) return response; last = new Error(`Upload failed (${response.status})`); }
        catch (error) { last = error; }
    }
    throw last || new Error('Upload failed');
};
const failure = async response => {
    let message = ''; try { message = await response.text(); } catch {}
    if (response.status === 413) return new Error('This video exceeds the current Storage file-size limit. Increase the mf-snaps bucket/global limit in Supabase.');
    return new Error(message ? `Upload failed (${response.status}): ${message.slice(0,180)}` : `Upload failed (${response.status})`);
};
export async function resumableUpload({projectUrl, publishableKey, accessToken, bucket, path, blob, onProgress=()=>{}, fetcher=fetch}) {
    const headers = {authorization:`Bearer ${accessToken}`,apikey:publishableKey,'tus-resumable':TUS_VERSION,'upload-length':String(blob.size),'upload-metadata':metadata({bucketName:bucket,objectName:path,contentType:blob.type||'application/octet-stream',cacheControl:'3600'}),'x-upsert':'false'};
    const created = await requestWithRetry(() => fetcher(storageEndpoint(projectUrl), {method:'POST',headers}));
    if (!created.ok) throw await failure(created);
    const locationHeader = created.headers.get('location');
    if (!locationHeader) throw new Error('Storage did not return a resumable upload URL.');
    const location = new URL(locationHeader, storageEndpoint(projectUrl)).href;
    let offset = Number(created.headers.get('upload-offset')) || 0;
    while (offset < blob.size) {
        const chunk = blob.slice(offset, Math.min(offset + RESUMABLE_CHUNK, blob.size));
        let patched = null, lastError = null;
        for (const delay of [0,1000,3000,5000,10000]) {
            if (delay) await wait(delay);
            try {
                patched = await fetcher(location, {method:'PATCH',headers:{authorization:`Bearer ${accessToken}`,apikey:publishableKey,'tus-resumable':TUS_VERSION,'upload-offset':String(offset),'content-type':'application/offset+octet-stream'},body:chunk});
                if (patched.ok) break;
                if (patched.status < 500 && patched.status !== 408 && patched.status !== 409 && patched.status !== 429) throw await failure(patched);
                lastError = await failure(patched);
            } catch (error) { lastError = error; }
            // The server may have committed the chunk even though its response was lost.
            try {
                const head = await fetcher(location, {method:'HEAD',headers:{authorization:`Bearer ${accessToken}`,apikey:publishableKey,'tus-resumable':TUS_VERSION}});
                const remoteOffset = Number(head.headers.get('upload-offset'));
                if (head.ok && remoteOffset > offset) { offset = remoteOffset; patched = null; break; }
            } catch {}
        }
        if (patched?.ok) {
            const next = Number(patched.headers.get('upload-offset'));
            if (!Number.isFinite(next) || next <= offset) throw new Error('Storage returned an invalid resumable upload offset.');
            offset = next;
        } else if (offset < blob.size && lastError) throw lastError;
        onProgress(offset, blob.size);
    }
}
export async function uploadRelay({sb, projectUrl, publishableKey, bucket, path, body, onProgress}) {
    const blob = body instanceof Blob ? body : new Blob([body], {type:'application/octet-stream'});
    if (blob.size <= RESUMABLE_THRESHOLD) {
        const result = await sb.storage.from(bucket).upload(path, blob, {contentType:'application/octet-stream',upsert:false});
        if (!result.error) onProgress?.(blob.size,blob.size);
        return result;
    }
    const {data:{session},error} = await sb.auth.getSession();
    if (error || !session?.access_token) return {error:error || new Error('Your session expired. Sign in again and retry the upload.')};
    try { await resumableUpload({projectUrl,publishableKey,accessToken:session.access_token,bucket,path,blob,onProgress}); return {data:{path},error:null}; }
    catch (uploadError) { return {data:null,error:uploadError}; }
}
