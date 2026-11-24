const BASE = 'http://127.0.0.1:8024';
const targets = await fetch('http://127.0.0.1:9333/json/list').then((r) => r.json());
const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });

let seq = 0;
const waiting = new Map();
const eventWaiters = [];
const handlers = [];
const log = [];
const onEvent = (m, fn) => handlers.push({ m, fn });
ws.addEventListener('message', (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id) { const w = waiting.get(msg.id); waiting.delete(msg.id); msg.error ? w.rej(new Error(msg.error.message)) : w.res(msg.result); return; }
  for (const h of handlers) if (h.m === msg.method) h.fn(msg.params);
  for (let i = eventWaiters.length - 1; i >= 0; i -= 1) if (eventWaiters[i].m === msg.method) { const w = eventWaiters[i]; eventWaiters.splice(i, 1); clearTimeout(w.t); w.res(); }
});
const send = (method, params = {}) => new Promise((res, rej) => { const id = ++seq; waiting.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
const waitForEvent = (m) => new Promise((res, rej) => { const w = { m, res, t: setTimeout(() => rej(new Error('timeout')), 30000) }; eventWaiters.push(w); });
const ev = async (expression) => { const r = await send('Runtime.evaluate', { expression, returnByValue: true }); return r.result.value; };

onEvent('Runtime.consoleAPICalled', (p) => log.push('console:' + p.type + ' ' + p.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 120)));
onEvent('Runtime.exceptionThrown', (p) => log.push('exception:' + (p.exceptionDetails.exception?.description || p.exceptionDetails.text || '').split('\n')[0].slice(0, 160)));
onEvent('Network.responseReceived', (p) => { const u = p.response.url; if (/osrm|photon|nominatim|open-meteo/.test(u)) log.push(`res ${p.response.status} ${u.slice(0, 110)}`); });
onEvent('Loading.failed', (p) => log.push(`fail ${p.errorText} ${p.url?.slice(0, 110)}`));
onEvent('Network.loadingFailed', (p) => log.push(`netfail ${p.errorText} blocked=${p.blockedReason ?? false} id=${p.requestId}`));
const requestUrls = new Map();
onEvent('Network.requestWillBeSent', (p) => { if (/osrm|photon|nominatim|open-meteo/.test(p.request.url)) { requestUrls.set(p.requestId, p.request.url); log.push(`req ${p.request.url.slice(0, 110)}`); } });

await send('Page.enable');
await send('Runtime.enable');
await send('Network.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 430, height: 932, deviceScaleFactor: 2, mobile: true });
await send('Browser.grantPermissions', { origin: BASE, permissions: ['geolocation'] });
await send('Emulation.setGeolocationOverride', { latitude: 39.9025, longitude: 116.4218, accuracy: 25 });
await ev(`(() => { sessionStorage.clear(); sessionStorage.setItem('zenmap:trip', JSON.stringify({ destination: '北京西站', mode: 'walk' })); return true; })()`);
await send('Page.navigate', { url: `${BASE}/map.html` });
await waitForEvent('Page.loadEventFired');

for (let i = 0; i < 12; i += 1) {
  await new Promise((r) => setTimeout(r, 5000));
  const snap = await ev(`(() => ({
    tag: document.querySelector('#route-tag').textContent,
    summary: document.querySelector('#route-summary').textContent,
    note: document.querySelector('#route-note').textContent,
    panelHidden: document.querySelector('#route-panel').hidden,
    dest: document.querySelector('#dest-label').textContent,
    status: document.querySelector('#status-text').textContent,
    paths: document.querySelectorAll('.leaflet-overlay-pane path').length,
  }))()`);
  log.push(`t=${(i + 1) * 5}s ` + JSON.stringify(snap));
  if (snap.tag) break;
}

console.log(log.join('\n'));
ws.close();
process.exit(0);
