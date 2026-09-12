export function recordingOptions(Recorder = MediaRecorder) {
    const mimeType = ['video/mp4;codecs=avc1,mp4a.40.2','video/mp4','video/webm;codecs=vp8,opus','video/webm'].find(type => Recorder.isTypeSupported(type));
    return mimeType ? {mimeType} : undefined;
}
export function waitForVideo(video, event, ready, action, timeout = 20000) {
    return new Promise((resolve,reject)=>{
        let timer;
        const cleanup=()=>{clearTimeout(timer);video.removeEventListener(event,check);video.removeEventListener('error',fail);};
        const check=()=>{if(ready()){cleanup();resolve();}};
        const fail=()=>{cleanup();reject(new Error('This video could not be decoded. Try recording a new clip or choosing another file.'));};
        video.addEventListener(event,check);video.addEventListener('error',fail);
        timer=setTimeout(()=>{cleanup();reject(new Error('Video loading timed out. Please try again.'));},timeout);
        try {action?.();check();}catch(error){cleanup();reject(error);}
    });
}
export async function loadVideoBlob(blob, doc = document) {
    if (!blob.size) throw new Error('The recording is empty. Please record again.');
    const url=URL.createObjectURL(blob), video=doc.createElement('video');
    video.muted=true;video.playsInline=true;video.preload='auto';
    const release=()=>{video.pause();video.removeAttribute('src');video.load();URL.revokeObjectURL(url);};
    try {
        await waitForVideo(video,'loadeddata',()=>video.readyState>=2&&video.videoWidth>0,()=>{video.src=url;video.load();video.play().catch(()=>{});});
        video.pause();return {video,url,release};
    }catch(error){release();throw error;}
}
