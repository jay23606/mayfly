export const isLocationCommand = text => text.trim().toLowerCase() === '/location';
export function currentLocationMessage(geolocation = navigator.geolocation) {
    if (!geolocation) return Promise.reject(new Error('Location is unavailable in this browser.'));
    return new Promise((resolve, reject) => geolocation.getCurrentPosition(position => {
        const { latitude, longitude, accuracy } = position.coords;
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
            reject(new Error('Could not determine your location. Try again.')); return;
        }
        const query = encodeURIComponent(`${latitude.toFixed(6)},${longitude.toFixed(6)}`);
        const detail = Number.isFinite(accuracy) && accuracy > 0 ? ` (within about ${Math.ceil(accuracy)} m)` : '';
        resolve(`My current location${detail}: https://www.google.com/maps/search/?api=1&query=${query}`);
    }, error => reject(new Error(({1:'Location permission denied. Allow location access in your browser settings and try again.',2:'Your location is unavailable. Check that location services are enabled.',3:'Location request timed out. Please try again.'})[error.code] || 'Could not get your location. Please try again.')),
    {enableHighAccuracy:true, maximumAge:0, timeout:20000}));
}
// Escape all message text, and link only the coordinate URLs generated above.
export function locationLinks(text, escape) {
    return String(text || '').split(/(https:\/\/www\.google\.com\/maps\/search\/\?api=1&query=-?\d+(?:\.\d+)?%2C-?\d+(?:\.\d+)?)/g)
        .map((part, i) => i % 2 ? `<a href="${escape(part)}" target="_blank" rel="noopener noreferrer">Open location in Google Maps</a>` : escape(part)).join('');
}
export async function runLocationCommand({ locate = currentLocationMessage, active, send, status }) {
    status('Finding your location…');
    try {
        const text = await locate();
        if (!active()) return false;
        status('Sending location…');
        if (!await send(text)) throw new Error('Location was not sent. Please try /location again.');
        status('Location sent.');
        return true;
    } catch (error) {
        if (active()) status(error.message || 'Could not share your location.');
        return false;
    }
}
