// Small, browser-native photo filters. They deliberately use CanvasFilter syntax so
// the camera preview and the pixels saved into a photo always match.
export const FILTERS = [
    { id: 'normal', label: '— Filters —', css: 'none' },
    { id: 'mono', label: 'Mono', css: 'grayscale(1) contrast(1.12)' },
    { id: 'warm', label: 'Warm', css: 'sepia(.3) saturate(1.35) contrast(1.05)' },
    { id: 'cool', label: 'Cool', css: 'hue-rotate(165deg) saturate(1.12) brightness(1.04)' },
    { id: 'vivid', label: 'Vivid', css: 'saturate(1.55) contrast(1.14)' },
    { id: 'noir', label: 'Noir', css: 'grayscale(1) contrast(1.45) brightness(.88)' },
];

export const filterCss = (id) => FILTERS.find(f => f.id === id)?.css || 'none';

export const drawFiltered = (ctx, source, filter = 'normal') => {
    ctx.save();
    ctx.filter = filterCss(filter);
    ctx.drawImage(source, 0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.restore();
};

const loadImage = (src) => new Promise((resolve, reject) => {
    const image = new Image(); image.onload = () => resolve(image); image.onerror = reject; image.src = src;
});

// Re-encode an imported image only when an effect is selected. Normal images retain
// their original bytes and MIME type for Mayfly's full-quality live delivery.
export const filterImageBlob = async (blob, filter) => {
    if (filter === 'normal') return blob;
    const source = await ('createImageBitmap' in window
        ? createImageBitmap(blob, { imageOrientation: 'from-image' }).catch(() => loadImage(URL.createObjectURL(blob)))
        : loadImage(URL.createObjectURL(blob)));
    const canvas = Object.assign(document.createElement('canvas'), { width: source.width, height: source.height });
    drawFiltered(canvas.getContext('2d'), source, filter);
    source.close?.();
    return new Promise((resolve, reject) => canvas.toBlob(
        out => out ? resolve(out) : reject(new Error('Could not apply filter')), 'image/jpeg', 0.92,
    ));
};
