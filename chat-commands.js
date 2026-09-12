export const FONT_KEY = 'mf_chat_font_css';
export const SHRUG = '¯\\_(ツ)_/¯';
export const HELP = `/help — show these commands
/location — send your current location
/gif <search> — send the first matching GIF · GIPHY
/shrug — send ¯\\_(ツ)_/¯
/font <CSS> — save chat text styling on this browser
Example: /font font-family: Georgia; font-size: 20px; font-weight: 500;
/font reset — restore default styling
Supported: font-family, font-size, font-weight, font-style, font-variant, line-height, letter-spacing. Settings affect your view only.`;
export function parseCommand(text) {
    const match = text.trim().match(/^\/(help|gif|shrug|font)(?:\s+([\s\S]*))?$/i);
    return match ? {name:match[1].toLowerCase(), args:(match[2] || '').trim()} : null;
}
const properties = new Set(['font-family','font-size','font-weight','font-style','font-variant','line-height','letter-spacing']);
export function normalizeFontCSS(css, doc = document) {
    if (!css.trim() || css.length > 1000 || /[{}@]|\/\*|!important|url\s*\(|var\s*\(|expression\s*\(/i.test(css)) throw new Error('Use CSS text declarations, for example: font-family: Georgia; font-size: 20px;');
    const style = doc.createElement('span').style;
    for (const declaration of css.split(';').filter(s=>s.trim())) {
        const colon = declaration.indexOf(':');
        const key = declaration.slice(0,colon).trim().toLowerCase(), value = declaration.slice(colon+1).trim();
        if (colon < 1 || !properties.has(key)) throw new Error(`Unsupported font property: ${key || declaration}. Type /help for supported properties.`);
        style.removeProperty(key);
        style.setProperty(key, value);
        if (!style.getPropertyValue(key)) throw new Error(`Invalid value for ${key}.`);
    }
    return style.cssText;
}
export function applySavedFont(storage = localStorage, doc = document) {
    let css = ''; try { const saved = storage.getItem(FONT_KEY); if (saved) css = normalizeFontCSS(saved, doc); } catch {}
    let sheet = doc.getElementById('chat-font-preference');
    if (!sheet) { sheet = doc.createElement('style'); sheet.id = 'chat-font-preference'; doc.head.appendChild(sheet); }
    sheet.textContent = css ? `.chatbody, .tinput, .storyreplytext { ${css} }` : '';
}
export function saveFont(args, storage = localStorage, doc = document) {
    if (args.toLowerCase() === 'reset') storage.removeItem(FONT_KEY);
    else storage.setItem(FONT_KEY, normalizeFontCSS(args, doc));
    applySavedFont(storage, doc);
}
export async function runChatCommand(command, {active, status, searchGif, sendGif, sendText, font = saveFont}) {
    try {
        if (command.name === 'help') { status(HELP); return true; }
        if (command.name === 'font') { font(command.args); status(command.args.toLowerCase() === 'reset' ? 'Default font restored.' : 'Font saved for this browser.'); return true; }
        if (command.name === 'shrug') {
            if (command.args) throw new Error('Usage: /shrug');
            if (!await sendText(SHRUG)) throw new Error('Could not send shrug. Try again.');
            return true;
        }
        if (!command.args) throw new Error('Usage: /gif <search>, for example /gif happy dance');
        status('Finding a GIF…');
        const {data,error} = await searchGif(command.args);
        if (!active()) return false;
        if (error || data?.error) throw new Error('GIF search failed. Please try again.');
        const gif = data?.items?.[0];
        if (!gif) throw new Error('No GIFs found. Try another search.');
        const url = new URL(gif.url);
        if (url.protocol !== 'https:' || !/^(media\d*|i)\.giphy\.com$/i.test(url.hostname)) throw new Error('GIF search returned an unsupported image.');
        if (!await sendGif({...gif,type:'gif'})) throw new Error('Could not send GIF. Try again.');
        status('GIF sent · GIPHY'); return true;
    } catch (error) { if (active()) status(error.message || 'Command failed. Please try again.'); return false; }
}
