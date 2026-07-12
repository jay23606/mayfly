// Deliberately transformative camera effects. Each one is rendered on Canvas so
// the live preview and the saved photo use the same underlying effect.
export const FILTERS = [
    { id: 'normal', label: '— Filters —', css: 'none' },
    { id: 'kaleidoscope', label: 'Kaleidoscope', css: 'none' },
    { id: 'fisheye', label: 'Fisheye', css: 'none' },
    { id: 'pixel', label: 'Pixel Art', css: 'none' },
    { id: 'ascii', label: 'ASCII', css: 'none' },
    { id: 'halftone', label: 'Halftone', css: 'none' },
    { id: 'glitch', label: 'Glitch Slice', css: 'none' },
    { id: 'crt', label: 'CRT Broadcast', css: 'none' },
    { id: 'sketch', label: 'Sketch', css: 'none' },
    { id: 'thermal', label: 'Thermal Vision', css: 'none' },
    { id: 'tunnel', label: 'Mirror Tunnel', css: 'none' },
];

export const filterCss = (id) => FILTERS.find(f => f.id === id)?.css || 'none';
const scratch = (width, height) => Object.assign(document.createElement('canvas'), { width, height });
const drawBase = (ctx, source) => ctx.drawImage(source, 0, 0, ctx.canvas.width, ctx.canvas.height);

const sourcePixels = (ctx, source) => {
    const base = scratch(ctx.canvas.width, ctx.canvas.height), baseCtx = base.getContext('2d');
    drawBase(baseCtx, source);
    return baseCtx.getImageData(0, 0, base.width, base.height);
};
const putPixels = (ctx, image) => {
    const out = scratch(ctx.canvas.width, ctx.canvas.height);
    out.getContext('2d').putImageData(image, 0, 0);
    ctx.drawImage(out, 0, 0);
};
const brightness = (data, at) => data[at] * .2126 + data[at + 1] * .7152 + data[at + 2] * .0722;

const fisheye = (ctx, source) => {
    const input = sourcePixels(ctx, source), { width, height } = input, src = input.data, output = new ImageData(width, height), dst = output.data;
    const cx = width / 2, cy = height / 2, radius = Math.min(cx, cy);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const nx = (x - cx) / radius, ny = (y - cy) / radius, r = Math.hypot(nx, ny), at = (y * width + x) * 4;
        if (r > 1) { dst[at + 3] = 255; continue; }
        const scale = r ? Math.pow(r, 1.7) / r : 0;
        const sx = Math.max(0, Math.min(width - 1, Math.round(cx + nx * scale * radius)));
        const sy = Math.max(0, Math.min(height - 1, Math.round(cy + ny * scale * radius))), from = (sy * width + sx) * 4;
        dst[at] = src[from]; dst[at + 1] = src[from + 1]; dst[at + 2] = src[from + 2]; dst[at + 3] = 255;
    }
    putPixels(ctx, output);
};

const kaleidoscope = (ctx, source) => {
    const input = sourcePixels(ctx, source), { width, height } = input, src = input.data, output = new ImageData(width, height), dst = output.data;
    const cx = width / 2, cy = height / 2, sector = Math.PI / 3;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const dx = x - cx, dy = y - cy, radius = Math.hypot(dx, dy);
        const angle = Math.atan2(dy, dx), wrapped = ((angle % sector) + sector) % sector;
        const folded = Math.abs(wrapped - sector / 2) - sector / 2;
        const sx = Math.max(0, Math.min(width - 1, Math.round(cx + Math.cos(folded) * radius)));
        const sy = Math.max(0, Math.min(height - 1, Math.round(cy + Math.sin(folded) * radius)));
        const at = (y * width + x) * 4, from = (sy * width + sx) * 4;
        dst[at] = src[from]; dst[at + 1] = src[from + 1]; dst[at + 2] = src[from + 2]; dst[at + 3] = 255;
    }
    putPixels(ctx, output);
};

const pixel = (ctx, source) => {
    const { width, height } = ctx.canvas;
    const small = scratch(Math.max(18, Math.round(width / 26)), Math.max(18, Math.round(height / 26)));
    const smallCtx = small.getContext('2d'); drawBase(smallCtx, source);
    const image = smallCtx.getImageData(0, 0, small.width, small.height), data = image.data;
    for (let i = 0; i < data.length; i += 4) for (let c = 0; c < 3; c++) data[i + c] = Math.round(data[i + c] / 51) * 51;
    smallCtx.putImageData(image, 0, 0);
    ctx.save(); ctx.imageSmoothingEnabled = false; ctx.drawImage(small, 0, 0, width, height); ctx.restore();
};

const ascii = (ctx, source) => {
    const input = sourcePixels(ctx, source), { width, height } = input, data = input.data;
    const cell = Math.max(7, Math.round(Math.min(width, height) / 55)), chars = ' .:-=+*#%@';
    ctx.save(); ctx.fillStyle = '#06090d'; ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = '#bff6ff'; ctx.font = `${cell}px ui-monospace, SFMono-Regular, Consolas, monospace`; ctx.textBaseline = 'top';
    for (let y = 0; y < height; y += cell) for (let x = 0; x < width; x += cell) {
        const sx = Math.min(width - 1, x + (cell >> 1)), sy = Math.min(height - 1, y + (cell >> 1));
        const shade = brightness(data, (sy * width + sx) * 4) / 255;
        ctx.globalAlpha = .35 + shade * .65;
        ctx.fillText(chars[Math.min(chars.length - 1, Math.round(shade * (chars.length - 1)))], x, y);
    }
    ctx.restore();
};

const halftone = (ctx, source) => {
    const input = sourcePixels(ctx, source), { width, height } = input, data = input.data;
    const cell = Math.max(5, Math.round(Math.min(width, height) / 72));
    ctx.save(); ctx.fillStyle = '#fff7df'; ctx.fillRect(0, 0, width, height); ctx.fillStyle = '#241739';
    for (let y = cell / 2; y < height; y += cell) for (let x = cell / 2; x < width; x += cell) {
        const sx = Math.min(width - 1, x | 0), sy = Math.min(height - 1, y | 0);
        const radius = (1 - brightness(data, (sy * width + sx) * 4) / 255) * cell * .48;
        ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
};

const glitch = (ctx, source) => {
    const { width, height } = ctx.canvas, base = scratch(width, height), baseCtx = base.getContext('2d');
    drawBase(baseCtx, source); ctx.fillStyle = '#05000b'; ctx.fillRect(0, 0, width, height);
    ctx.save(); ctx.globalAlpha = .7; ctx.drawImage(base, -9, 0); ctx.globalCompositeOperation = 'screen'; ctx.globalAlpha = .45; ctx.drawImage(base, 9, 0); ctx.restore();
    for (let i = 0; i < 15; i++) {
        const y = Math.floor(Math.random() * height), h = Math.max(2, Math.floor(height * (.008 + Math.random() * .035)));
        const shift = Math.floor((Math.random() - .5) * width * .18);
        ctx.drawImage(base, 0, y, width, h, shift, y, width, h);
    }
    ctx.save(); ctx.fillStyle = '#fff'; ctx.globalAlpha = .15;
    for (let y = 0; y < height; y += 6) ctx.fillRect(0, y, width, 1);
    ctx.restore();
};

const crt = (ctx, source) => {
    const { width, height } = ctx.canvas, base = scratch(width, height), baseCtx = base.getContext('2d');
    baseCtx.filter = 'saturate(1.45) contrast(1.18)'; drawBase(baseCtx, source); ctx.drawImage(base, 0, 0);
    ctx.save(); ctx.globalCompositeOperation = 'screen'; ctx.globalAlpha = .18; ctx.filter = 'sepia(1) saturate(3) hue-rotate(155deg)'; ctx.drawImage(base, -3, 0); ctx.restore();
    ctx.save(); ctx.fillStyle = '#000'; ctx.globalAlpha = .27;
    for (let y = 0; y < height; y += 4) ctx.fillRect(0, y, width, 1);
    const vignette = ctx.createRadialGradient(width / 2, height / 2, Math.min(width, height) * .18, width / 2, height / 2, Math.max(width, height) * .72);
    vignette.addColorStop(0, '#0000'); vignette.addColorStop(1, '#000b'); ctx.fillStyle = vignette; ctx.globalAlpha = 1; ctx.fillRect(0, 0, width, height); ctx.restore();
};

const sketch = (ctx, source) => {
    const input = sourcePixels(ctx, source), { width, height } = input, src = input.data, output = new ImageData(width, height), dst = output.data;
    for (let i = 0; i < dst.length; i += 4) dst[i] = dst[i + 1] = dst[i + 2] = dst[i + 3] = 255;
    const light = (x, y) => brightness(src, (y * width + x) * 4);
    for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
        const gx = -light(x - 1, y - 1) + light(x + 1, y - 1) - 2 * light(x - 1, y) + 2 * light(x + 1, y) - light(x - 1, y + 1) + light(x + 1, y + 1);
        const gy = -light(x - 1, y - 1) - 2 * light(x, y - 1) - light(x + 1, y - 1) + light(x - 1, y + 1) + 2 * light(x, y + 1) + light(x + 1, y + 1);
        const value = Math.max(0, 255 - Math.min(255, Math.hypot(gx, gy) * .9)), at = (y * width + x) * 4;
        dst[at] = dst[at + 1] = dst[at + 2] = value; dst[at + 3] = 255;
    }
    putPixels(ctx, output);
};

const thermal = (ctx, source) => {
    const input = sourcePixels(ctx, source), { width, height } = input, src = input.data, output = new ImageData(width, height), dst = output.data;
    const stops = [[25, 12, 92], [0, 110, 255], [0, 232, 165], [255, 224, 0], [255, 42, 0]];
    for (let i = 0; i < src.length; i += 4) {
        const point = brightness(src, i) / 255 * (stops.length - 1), lo = Math.floor(point), hi = Math.min(stops.length - 1, lo + 1), mix = point - lo;
        dst[i] = stops[lo][0] + (stops[hi][0] - stops[lo][0]) * mix;
        dst[i + 1] = stops[lo][1] + (stops[hi][1] - stops[lo][1]) * mix;
        dst[i + 2] = stops[lo][2] + (stops[hi][2] - stops[lo][2]) * mix; dst[i + 3] = 255;
    }
    putPixels(ctx, output);
};

const tunnel = (ctx, source) => {
    const { width, height } = ctx.canvas;
    ctx.fillStyle = '#030008'; ctx.fillRect(0, 0, width, height);
    for (let layer = 0; layer < 12; layer++) {
        const scale = 1 - layer * .072, alpha = 1 - layer * .065;
        ctx.save(); ctx.translate(width / 2, height / 2); if (layer % 2) ctx.scale(-1, 1);
        ctx.rotate((layer % 2 ? -1 : 1) * layer * .018); ctx.globalAlpha = Math.max(.14, alpha);
        ctx.drawImage(source, -width * scale / 2, -height * scale / 2, width * scale, height * scale); ctx.restore();
    }
};

export const drawFiltered = (ctx, source, filter = 'normal') => {
    if (filter === 'kaleidoscope') return kaleidoscope(ctx, source);
    if (filter === 'fisheye') return fisheye(ctx, source);
    if (filter === 'pixel') return pixel(ctx, source);
    if (filter === 'ascii') return ascii(ctx, source);
    if (filter === 'halftone') return halftone(ctx, source);
    if (filter === 'glitch') return glitch(ctx, source);
    if (filter === 'crt') return crt(ctx, source);
    if (filter === 'sketch') return sketch(ctx, source);
    if (filter === 'thermal') return thermal(ctx, source);
    if (filter === 'tunnel') return tunnel(ctx, source);
    drawBase(ctx, source);
};

const loadImage = (src) => new Promise((resolve, reject) => {
    const image = new Image(); image.onload = () => resolve(image); image.onerror = reject; image.src = src;
});

// Normal photos retain their original bytes; selected effects are baked into a JPEG.
export const filterImageBlob = async (blob, filter) => {
    if (filter === 'normal') return blob;
    const source = await ('createImageBitmap' in window
        ? createImageBitmap(blob, { imageOrientation: 'from-image' }).catch(() => loadImage(URL.createObjectURL(blob)))
        : loadImage(URL.createObjectURL(blob)));
    const canvas = Object.assign(document.createElement('canvas'), { width: source.width, height: source.height });
    drawFiltered(canvas.getContext('2d'), source, filter);
    source.close?.();
    return new Promise((resolve, reject) => canvas.toBlob(
        out => out ? resolve(out) : reject(new Error('Could not apply filter')), 'image/jpeg', .92,
    ));
};
