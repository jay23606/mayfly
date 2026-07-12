// Small, browser-native photo filters. They deliberately use CanvasFilter syntax so
// the camera preview and the pixels saved into a photo always match.
export const FILTERS = [
    { id: 'normal', label: '— Filters —', css: 'none' },
    { id: 'mono', label: 'Mono', css: 'grayscale(1) contrast(1.12)' },
    { id: 'warm', label: 'Warm', css: 'sepia(.3) saturate(1.35) contrast(1.05)' },
    { id: 'cool', label: 'Cool', css: 'hue-rotate(165deg) saturate(1.12) brightness(1.04)' },
    { id: 'vivid', label: 'Vivid', css: 'saturate(1.55) contrast(1.14)' },
    { id: 'noir', label: 'Noir', css: 'grayscale(1) contrast(1.45) brightness(.88)' },
    { id: 'fade', label: 'Fade', css: 'saturate(.68) contrast(.78) brightness(1.12)' },
    { id: 'dream', label: 'Dream', css: 'brightness(1.16) saturate(1.18) contrast(.86)' },
    { id: 'film', label: 'Film', css: 'sepia(.12) grayscale(.18) contrast(1.22) brightness(.96)' },
    { id: 'neon', label: 'Neon', css: 'hue-rotate(210deg) saturate(2.05) contrast(1.18)' },
    { id: 'invert', label: 'Invert', css: 'invert(1) hue-rotate(180deg)' },
    { id: 'disposable', label: 'Disposable', css: 'sepia(.28) saturate(1.32) contrast(1.08)' },
    { id: 'duotone', label: 'Duotone', css: 'grayscale(1) contrast(1.15)' },
    { id: 'vhs', label: 'VHS', css: 'sepia(.12) saturate(1.5) contrast(1.18)' },
    { id: 'pixel', label: 'Pixel', css: 'saturate(1.2) contrast(1.12)' },
    { id: 'glitch', label: 'Glitch', css: 'hue-rotate(24deg) saturate(1.5) contrast(1.14)' },
    { id: 'fisheye', label: 'Fisheye', css: 'saturate(1.15) contrast(1.08)' },
    { id: 'kaleidoscope', label: 'Kaleidoscope', css: 'saturate(1.35) contrast(1.08)' },
    { id: 'halftone', label: 'Halftone', css: 'grayscale(.25) contrast(1.2)' },
    { id: 'thermal', label: 'Thermal', css: 'hue-rotate(190deg) saturate(2) contrast(1.2)' },
    { id: 'sketch', label: 'Sketch', css: 'grayscale(1) contrast(1.35)' },
];

export const filterCss = (id) => FILTERS.find(f => f.id === id)?.css || 'none';

const drawBase = (ctx, source, filter = 'normal') => {
    ctx.save();
    ctx.filter = filterCss(filter);
    ctx.drawImage(source, 0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.restore();
};

const scratch = (width, height) => Object.assign(document.createElement('canvas'), { width, height });

const disposable = (ctx, source) => {
    drawBase(ctx, source, 'disposable');
    const { width, height } = ctx.canvas;
    const vignette = ctx.createRadialGradient(width / 2, height / 2, Math.min(width, height) * .18, width / 2, height / 2, Math.max(width, height) * .72);
    vignette.addColorStop(0, '#0000'); vignette.addColorStop(1, '#3a190055');
    ctx.save(); ctx.fillStyle = vignette; ctx.fillRect(0, 0, width, height);
    ctx.globalAlpha = .10; ctx.fillStyle = '#fff';
    for (let i = 0; i < 420; i++) ctx.fillRect(Math.random() * width, Math.random() * height, 1, 1);
    ctx.restore();
};

const duotone = (ctx, source) => {
    const base = scratch(ctx.canvas.width, ctx.canvas.height), bctx = base.getContext('2d');
    bctx.drawImage(source, 0, 0, base.width, base.height);
    const image = bctx.getImageData(0, 0, base.width, base.height), px = image.data;
    const low = [34, 24, 78], high = [255, 151, 72];
    for (let i = 0; i < px.length; i += 4) {
        const light = (px[i] * .2126 + px[i + 1] * .7152 + px[i + 2] * .0722) / 255;
        px[i] = low[0] + (high[0] - low[0]) * light;
        px[i + 1] = low[1] + (high[1] - low[1]) * light;
        px[i + 2] = low[2] + (high[2] - low[2]) * light;
    }
    bctx.putImageData(image, 0, 0); ctx.drawImage(base, 0, 0);
};

const vhs = (ctx, source) => {
    const base = scratch(ctx.canvas.width, ctx.canvas.height), bctx = base.getContext('2d');
    drawBase(bctx, source, 'vhs'); ctx.drawImage(base, 0, 0);
    const { width, height } = ctx.canvas;
    ctx.save(); ctx.fillStyle = '#1118';
    for (let y = 0; y < height; y += 4) ctx.fillRect(0, y, width, 1);
    ctx.globalAlpha = .28;
    for (let y = 16; y < height; y += 47) ctx.drawImage(base, 0, y, width, 3, (y / 47 % 2 ? 3 : -3), y, width, 3);
    ctx.restore();
};

const pixel = (ctx, source) => {
    const { width, height } = ctx.canvas, small = scratch(Math.max(16, Math.floor(width / 24)), Math.max(16, Math.floor(height / 24)));
    drawBase(small.getContext('2d'), source, 'pixel');
    ctx.save(); ctx.imageSmoothingEnabled = false; ctx.drawImage(small, 0, 0, width, height); ctx.restore();
};

const glitch = (ctx, source) => {
    const base = scratch(ctx.canvas.width, ctx.canvas.height), bctx = base.getContext('2d');
    drawBase(bctx, source, 'glitch'); ctx.drawImage(base, 0, 0);
    const { width, height } = ctx.canvas;
    ctx.save(); ctx.globalAlpha = .42;
    for (let i = 0; i < 11; i++) {
        const y = Math.floor(Math.random() * height), h = Math.max(2, Math.floor(height * (.008 + Math.random() * .025)));
        const shift = Math.floor((Math.random() - .5) * width * .1);
        ctx.drawImage(base, 0, y, width, h, shift, y, width, h);
    }
    ctx.restore();
};

const sourcePixels = (ctx, source) => {
    const base = scratch(ctx.canvas.width, ctx.canvas.height), bctx = base.getContext('2d');
    bctx.drawImage(source, 0, 0, base.width, base.height);
    return { base, bctx, pixels: bctx.getImageData(0, 0, base.width, base.height) };
};
const putPixels = (ctx, image) => {
    const out = scratch(ctx.canvas.width, ctx.canvas.height);
    out.getContext('2d').putImageData(image, 0, 0);
    ctx.drawImage(out, 0, 0);
};

const fisheye = (ctx, source) => {
    const { pixels: input } = sourcePixels(ctx, source), { width, height } = input;
    const output = new ImageData(width, height), src = input.data, dst = output.data, cx = width / 2, cy = height / 2, radius = Math.min(cx, cy);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const nx = (x - cx) / radius, ny = (y - cy) / radius, r = Math.hypot(nx, ny), at = (y * width + x) * 4;
        if (r > 1) { dst[at + 3] = 255; continue; }
        const scale = r ? Math.pow(r, 1.65) / r : 0, sx = Math.max(0, Math.min(width - 1, Math.round(cx + nx * scale * radius))), sy = Math.max(0, Math.min(height - 1, Math.round(cy + ny * scale * radius))), from = (sy * width + sx) * 4;
        dst[at] = src[from]; dst[at + 1] = src[from + 1]; dst[at + 2] = src[from + 2]; dst[at + 3] = 255;
    }
    putPixels(ctx, output);
};

const kaleidoscope = (ctx, source) => {
    const { pixels: input } = sourcePixels(ctx, source), { width, height } = input;
    const output = new ImageData(width, height), src = input.data, dst = output.data, cx = width / 2, cy = height / 2, sector = (Math.PI * 2) / 6;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const dx = x - cx, dy = y - cy, radius = Math.hypot(dx, dy);
        const angle = Math.atan2(dy, dx), wrapped = ((angle % sector) + sector) % sector, folded = Math.abs(wrapped - sector / 2);
        const sx = Math.max(0, Math.min(width - 1, Math.round(cx + Math.cos(folded) * radius))), sy = Math.max(0, Math.min(height - 1, Math.round(cy + Math.sin(folded) * radius)));
        const at = (y * width + x) * 4, from = (sy * width + sx) * 4;
        dst[at] = src[from]; dst[at + 1] = src[from + 1]; dst[at + 2] = src[from + 2]; dst[at + 3] = 255;
    }
    putPixels(ctx, output);
};

const halftone = (ctx, source) => {
    const { pixels } = sourcePixels(ctx, source), { width, height } = ctx.canvas, cell = Math.max(5, Math.round(Math.min(width, height) / 72)), data = pixels.data;
    ctx.save(); ctx.fillStyle = '#f7f0df'; ctx.fillRect(0, 0, width, height); ctx.fillStyle = '#251b36';
    for (let y = cell / 2; y < height; y += cell) for (let x = cell / 2; x < width; x += cell) {
        const at = (Math.min(height - 1, y | 0) * width + Math.min(width - 1, x | 0)) * 4, sample = [data[at], data[at + 1], data[at + 2]];
        const light = (sample[0] * .2126 + sample[1] * .7152 + sample[2] * .0722) / 255, radius = (1 - light) * cell * .48;
        ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
};

const thermal = (ctx, source) => {
    const { pixels: input } = sourcePixels(ctx, source), { width, height } = input, output = new ImageData(width, height), src = input.data, dst = output.data;
    const stops = [[24, 18, 92], [0, 124, 255], [0, 232, 170], [255, 224, 0], [255, 47, 0]];
    for (let i = 0; i < src.length; i += 4) {
        const light = (src[i] * .2126 + src[i + 1] * .7152 + src[i + 2] * .0722) / 255, point = light * (stops.length - 1), lo = Math.floor(point), hi = Math.min(stops.length - 1, lo + 1), mix = point - lo;
        dst[i] = stops[lo][0] + (stops[hi][0] - stops[lo][0]) * mix;
        dst[i + 1] = stops[lo][1] + (stops[hi][1] - stops[lo][1]) * mix;
        dst[i + 2] = stops[lo][2] + (stops[hi][2] - stops[lo][2]) * mix; dst[i + 3] = 255;
    }
    putPixels(ctx, output);
};

const sketch = (ctx, source) => {
    const { pixels: input } = sourcePixels(ctx, source), { width, height } = input, src = input.data, output = new ImageData(width, height), dst = output.data;
    for (let i = 0; i < dst.length; i += 4) { dst[i] = dst[i + 1] = dst[i + 2] = dst[i + 3] = 255; }
    const light = (x, y) => { const i = (y * width + x) * 4; return src[i] * .2126 + src[i + 1] * .7152 + src[i + 2] * .0722; };
    for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
        const gx = -light(x - 1, y - 1) + light(x + 1, y - 1) - 2 * light(x - 1, y) + 2 * light(x + 1, y) - light(x - 1, y + 1) + light(x + 1, y + 1);
        const gy = -light(x - 1, y - 1) - 2 * light(x, y - 1) - light(x + 1, y - 1) + light(x - 1, y + 1) + 2 * light(x, y + 1) + light(x + 1, y + 1);
        const value = Math.max(0, 255 - Math.min(255, Math.hypot(gx, gy) * .9)), at = (y * width + x) * 4;
        dst[at] = dst[at + 1] = dst[at + 2] = value; dst[at + 3] = 255;
    }
    putPixels(ctx, output);
};

export const drawFiltered = (ctx, source, filter = 'normal') => {
    if (filter === 'disposable') return disposable(ctx, source);
    if (filter === 'duotone') return duotone(ctx, source);
    if (filter === 'vhs') return vhs(ctx, source);
    if (filter === 'pixel') return pixel(ctx, source);
    if (filter === 'glitch') return glitch(ctx, source);
    if (filter === 'fisheye') return fisheye(ctx, source);
    if (filter === 'kaleidoscope') return kaleidoscope(ctx, source);
    if (filter === 'halftone') return halftone(ctx, source);
    if (filter === 'thermal') return thermal(ctx, source);
    if (filter === 'sketch') return sketch(ctx, source);
    drawBase(ctx, source, filter);
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
