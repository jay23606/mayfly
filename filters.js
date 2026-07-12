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
    { id: 'plasma', label: 'Plasma Warp', css: 'none' },
    { id: 'copper', label: 'Copper Bars', css: 'none' },
    { id: 'ripple', label: 'Ripple Tank', css: 'none' },
    { id: 'wireframe', label: 'Wireframe', css: 'none' },
    { id: 'databent', label: 'Databent Blocks', css: 'none' },
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
    const cx = width / 2, cy = height / 2;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const nx = (x - cx) / cx, ny = (y - cy) / cy, r = Math.hypot(nx, ny), at = (y * width + x) * 4;
        // Clamp the radial sample at the frame edge, rather than making the
        // corners black. This retains a full rectangular photo with a bulging lens.
        const mappedRadius = Math.min(1, r), scale = r ? Math.pow(mappedRadius, 1.7) / r : 0;
        const sx = Math.max(0, Math.min(width - 1, Math.round(cx + nx * scale * cx)));
        const sy = Math.max(0, Math.min(height - 1, Math.round(cy + ny * scale * cy))), from = (sy * width + sx) * 4;
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
    const small = scratch(Math.max(40, Math.round(width / 11)), Math.max(40, Math.round(height / 11)));
    const smallCtx = small.getContext('2d'); drawBase(smallCtx, source);
    const image = smallCtx.getImageData(0, 0, small.width, small.height), data = image.data;
    for (let i = 0; i < data.length; i += 4) for (let c = 0; c < 3; c++) data[i + c] = Math.round(data[i + c] / 51) * 51;
    smallCtx.putImageData(image, 0, 0);
    ctx.save(); ctx.imageSmoothingEnabled = false; ctx.drawImage(small, 0, 0, width, height); ctx.restore();
};

const ascii = (ctx, source) => {
    const input = sourcePixels(ctx, source), { width, height } = input, data = input.data;
    const cell = Math.max(5, Math.round(Math.min(width, height) / 86)), chars = ' .:-=+*#%@';
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
    const cell = Math.max(4, Math.round(Math.min(width, height) / 112));
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

const plasma = (ctx, source) => {
    const input = sourcePixels(ctx, source), { width, height } = input, src = input.data, output = new ImageData(width, height), dst = output.data;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const warpX = Math.sin(y * .048 + Math.sin(x * .018) * 2) * 12 + Math.sin(y * .014) * 8;
        const warpY = Math.sin(x * .043 + Math.sin(y * .02) * 2) * 9;
        const sx = Math.max(0, Math.min(width - 1, Math.round(x + warpX))), sy = Math.max(0, Math.min(height - 1, Math.round(y + warpY)));
        const from = (sy * width + sx) * 4, at = (y * width + x) * 4;
        const wave = (Math.sin(x * .027) + Math.sin(y * .034) + Math.sin((x + y) * .018) + 3) / 6;
        dst[at] = src[from] * .76 + (50 + wave * 205) * .24;
        dst[at + 1] = src[from + 1] * .76 + (20 + (1 - wave) * 105) * .24;
        dst[at + 2] = src[from + 2] * .76 + (165 + wave * 90) * .24; dst[at + 3] = 255;
    }
    putPixels(ctx, output);
};

const copper = (ctx, source) => {
    const { width, height } = ctx.canvas, base = scratch(width, height), baseCtx = base.getContext('2d');
    drawBase(baseCtx, source); ctx.drawImage(base, 0, 0);
    for (let y = 0; y < height; y += Math.max(10, Math.round(height / 32))) {
        const bandHeight = Math.max(4, Math.round(height / 56)), shift = Math.round(Math.sin(y * .072) * width * .075);
        ctx.drawImage(base, 0, y, width, bandHeight, shift, y, width, bandHeight);
        const hue = (y / height * 320 + 190) % 360;
        ctx.save(); ctx.globalCompositeOperation = 'screen'; ctx.globalAlpha = .38;
        ctx.fillStyle = `hsl(${hue} 100% 60%)`; ctx.fillRect(0, y, width, Math.max(2, bandHeight / 3)); ctx.restore();
    }
};

const ripple = (ctx, source) => {
    const input = sourcePixels(ctx, source), { width, height } = input, src = input.data, output = new ImageData(width, height), dst = output.data;
    const cx = width * .52, cy = height * .46, max = Math.hypot(Math.max(cx, width - cx), Math.max(cy, height - cy));
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const dx = x - cx, dy = y - cy, radius = Math.hypot(dx, dy) || 1;
        const amount = Math.sin(radius * .105) * 15 * Math.max(0, 1 - radius / (max * 1.15));
        const sx = Math.max(0, Math.min(width - 1, Math.round(x + dx / radius * amount)));
        const sy = Math.max(0, Math.min(height - 1, Math.round(y + dy / radius * amount)));
        const at = (y * width + x) * 4, from = (sy * width + sx) * 4;
        dst[at] = src[from]; dst[at + 1] = src[from + 1]; dst[at + 2] = src[from + 2]; dst[at + 3] = 255;
    }
    putPixels(ctx, output);
};

const wireframe = (ctx, source) => {
    const input = sourcePixels(ctx, source), { width, height } = input, src = input.data, output = new ImageData(width, height), dst = output.data;
    const light = (x, y) => brightness(src, (y * width + x) * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const at = (y * width + x) * 4, original = brightness(src, at);
        let edge = 0;
        if (x && y && x < width - 1 && y < height - 1) {
            const gx = -light(x - 1, y) + light(x + 1, y), gy = -light(x, y - 1) + light(x, y + 1);
            edge = Math.min(255, Math.hypot(gx, gy) * 1.35);
        }
        dst[at] = src[at] * .11 + edge * .18;
        dst[at + 1] = src[at + 1] * .16 + edge * .9;
        dst[at + 2] = src[at + 2] * .24 + edge; dst[at + 3] = 255;
        if (original < 16) dst[at + 3] = 255;
    }
    putPixels(ctx, output);
};

const databent = (ctx, source) => {
    const { width, height } = ctx.canvas, base = scratch(width, height), baseCtx = base.getContext('2d');
    drawBase(baseCtx, source); ctx.drawImage(base, 0, 0);
    for (let i = 0; i < 24; i++) {
        const w = Math.max(12, Math.round(width * (.025 + Math.random() * .16))), h = Math.max(4, Math.round(height * (.008 + Math.random() * .09)));
        const x = Math.floor(Math.random() * Math.max(1, width - w)), y = Math.floor(Math.random() * Math.max(1, height - h));
        const dx = Math.max(-x, Math.min(width - x - w, Math.round((Math.random() - .5) * width * .28)));
        const dy = Math.round((Math.random() - .5) * height * .05);
        ctx.save(); ctx.globalAlpha = .72 + Math.random() * .28; ctx.drawImage(base, x, y, w, h, x + dx, y + dy, w, h); ctx.restore();
    }
    ctx.save(); ctx.globalCompositeOperation = 'screen'; ctx.globalAlpha = .14; ctx.fillStyle = '#3ff'; ctx.fillRect(3, 0, width, height); ctx.restore();
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
    if (filter === 'plasma') return plasma(ctx, source);
    if (filter === 'copper') return copper(ctx, source);
    if (filter === 'ripple') return ripple(ctx, source);
    if (filter === 'wireframe') return wireframe(ctx, source);
    if (filter === 'databent') return databent(ctx, source);
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
