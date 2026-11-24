const BASE = 'http://127.0.0.1:8024';
const targets = await fetch('http://127.0.0.1:9333/json/list').then((r) => r.json());
const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });

let seq = 0;
const waiting = new Map();
const eventWaiters = [];
ws.addEventListener('message', (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id) { const w = waiting.get(msg.id); waiting.delete(msg.id); msg.error ? w.rej(new Error(msg.error.message)) : w.res(msg.result); return; }
  for (let i = eventWaiters.length - 1; i >= 0; i -= 1) if (eventWaiters[i].method === msg.method) { const w = eventWaiters[i]; eventWaiters.splice(i, 1); clearTimeout(w.timer); w.res(); }
});
const send = (method, params = {}) => new Promise((res, rej) => { const id = ++seq; waiting.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
const waitForEvent = (method) => new Promise((res, rej) => { const w = { method, res, timer: setTimeout(() => rej(new Error('timeout')), 30000) }; eventWaiters.push(w); });
const ev = async (expression) => { const r = await send('Runtime.evaluate', { expression, returnByValue: true }); return r.result.value; };

await send('Page.enable');
await send('Runtime.enable');
await send('Browser.grantPermissions', { origin: BASE, permissions: ['geolocation'] });
await send('Emulation.setGeolocationOverride', { latitude: 39.9025, longitude: 116.4218, accuracy: 25 });
await send('Emulation.setDeviceMetricsOverride', { width: 430, height: 932, deviceScaleFactor: 2, mobile: true });
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }, { name: 'prefers-reduced-motion', value: 'reduce' }] });

const probe = `(() => {
  const cs = (s, p) => { const el = document.querySelector(s); return el ? getComputedStyle(el)[p] : 'MISSING'; };
  const ping = (() => { const el = document.querySelector('.zen-marker-dot'); return el ? getComputedStyle(el, '::after').animationName : 'MISSING'; })();
  return {
    ctaDuration: cs('#start-btn', 'transitionDuration'),
    rowDuration: cs('.zen-row', 'transitionDuration'),
    panelDuration: cs('#sheet', 'transitionDuration'),
    leafletBottomDuration: cs('.leaflet-bottom', 'transitionDuration'),
    riseName: cs('.zen-rise', 'animationName'),
    pingName: ping,
    statusDotName: cs('#status-dot', 'animationName'),
    bannerName: cs('#alert-banner', 'animationName'),
  };
})()`;

await send('Page.navigate', { url: `${BASE}/index.html` });
await waitForEvent('Page.loadEventFired');
await new Promise((r) => setTimeout(r, 1500));
const home = await ev(probe);

await send('Page.navigate', { url: `${BASE}/map.html` });
await waitForEvent('Page.loadEventFired');
await new Promise((r) => setTimeout(r, 6000));
const map = await ev(probe);

console.log(JSON.stringify({ home, map }, null, 2));
ws.close();
process.exit(0);
