// Keep the original media elements mounted so minimizing never renegotiates a call.
export function initCallWindow({ toast }) {
    const panel = document.querySelector('#callo');
    const minimize = document.querySelector('#cmin');
    const pip = document.querySelector('#cpip');
    const handle = document.querySelector('#cdrag');
    const videos = [...panel.querySelectorAll('video')];
    let drag = null;
    const viewport = () => ({ width: window.visualViewport?.width || innerWidth, height: window.visualViewport?.height || innerHeight, x: window.visualViewport?.offsetLeft || 0, y: window.visualViewport?.offsetTop || 0 });
    const position = (x, y) => {
        const v = viewport(), r = panel.getBoundingClientRect();
        panel.style.left = Math.max(v.x + 8, Math.min(x, v.x + v.width - r.width - 8)) + 'px';
        panel.style.top = Math.max(v.y + 8, Math.min(y, v.y + v.height - r.height - 8)) + 'px';
    };
    const setMini = (mini) => {
        panel.classList.toggle('mini', mini);
        minimize.textContent = mini ? '↗' : '↙';
        minimize.title = mini ? 'Restore call' : 'Minimize call';
        minimize.setAttribute('aria-label', minimize.title);
        if (mini) { const v = viewport(); position(v.x + v.width - 240, v.y + 64); }
        else { panel.style.left = ''; panel.style.top = ''; }
    };
    const exitPiP = () => {
        if (videos.includes(document.pictureInPictureElement)) document.exitPictureInPicture().catch(() => {});
        videos.forEach(v => { if (v.webkitPresentationMode === 'picture-in-picture') { try { v.webkitSetPresentationMode('inline'); } catch {} } });
    };
    minimize.onclick = () => { const mini = !panel.classList.contains('mini'); if (!mini) exitPiP(); setMini(mini); };
    handle.onpointerdown = e => {
        if (!panel.classList.contains('mini')) return;
        const r = panel.getBoundingClientRect(); drag = { x: e.clientX - r.left, y: e.clientY - r.top, id: e.pointerId };
        handle.setPointerCapture(e.pointerId);
    };
    handle.onpointermove = e => { if (drag?.id === e.pointerId) position(e.clientX - drag.x, e.clientY - drag.y); };
    handle.onpointerup = handle.onpointercancel = () => { drag = null; };
    const fit = () => { if (panel.classList.contains('mini')) { const r = panel.getBoundingClientRect(); position(r.left, r.top); } };
    window.addEventListener('resize', fit);
    window.visualViewport?.addEventListener('resize', fit);
    window.visualViewport?.addEventListener('scroll', fit);
    const remoteVideo = () => videos.find(v => !v.muted && v.srcObject?.getVideoTracks().some(t => t.readyState === 'live'));
    const updatePiP = () => {
        const v = remoteVideo();
        pip.hidden = !v || !(document.pictureInPictureEnabled && v.requestPictureInPicture || v.webkitSupportsPresentationMode?.('picture-in-picture'));
    };
    window.addEventListener('call-media-changed', updatePiP);
    videos.forEach(v => v.addEventListener('loadedmetadata', updatePiP));
    pip.onclick = async () => {
        const v = remoteVideo(); if (!v) return;
        try {
            if (document.pictureInPictureEnabled && v.requestPictureInPicture) await v.requestPictureInPicture();
            else v.webkitSetPresentationMode('picture-in-picture');
            if (panel.classList.contains('on')) setMini(true); else exitPiP();
        } catch { toast('Picture-in-picture is unavailable. You can still minimize the call inside Mayfly.'); }
    };
    return { reset() { exitPiP(); setMini(false); drag = null; } };
}
