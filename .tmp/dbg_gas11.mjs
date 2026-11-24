import { appendFileSync } from 'node:fs';

const BASE = 'http://127.0.0.1:8024';
const targets = await fetch('http://127.0.0.1:9333/json/list').then((r) => r.json());
const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true });
  ws.addEventListener('error', rej, { once: true });
});

let seq = 0;
const waiting = new Map();
const requests = [];
ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id) {
    const entry = waiting.get(msg.id);
    waiting.delete(msg.id);
    if (msg.error) entry.reject(new Error(msg.error.message));
    else entry.resolve(msg.result);
    return;
  }
  if (msg.method === 'Network.requestWillBeSent' && !msg.params.request.url.startsWith(BASE)) {
    requests.push(msg.params.request.url.slice(0, 90));
  }
});
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    waiting.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result.value;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

await send('Page.enable');
await send('Runtime.enable');
await send('Network.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 430, height: 932, deviceScaleFactor: 2, mobile: true });
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
await send('Browser.grantPermissions', { origin: BASE, permissions: ['geolocation'] });
await send('Emulation.setGeolocationOverride', { latitude: 39.9025, longitude: 116.4218, accuracy: 25 });

const out = [];
const log = (label, value) => out.push(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);

await send('Page.navigate', { url: `${BASE}/index.html` });
await wait(1200);
await evaluate(`sessionStorage.setItem('zenmap:trip', JSON.stringify({ destination: '北京西站', mode: 'drive' }))`);
await send('Page.navigate', { url: `${BASE}/map.html` });
await wait(4000);
log('routeTag', await evaluate(`document.querySelector('#route-tag').textContent`));
log('gasBtnHidden', await evaluate(`document.querySelector('#gas-btn').hidden`));

const box = await evaluate(`(() => {
  const r = document.querySelector('#gas-btn').getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
})()`);
for (const type of ['mousePressed', 'mouseReleased']) {
  await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0 });
}
for (const ms of [2000, 4000, 6000, 8000]) {
  await wait(ms === 2000 ? 2000 : 2000);
  const snap = await evaluate(`(() => ({
    panelHidden: document.querySelector('#gas-panel').hidden,
    rows: document.querySelectorAll('.gas-row').length,
    status: document.querySelector('#gas-status').textContent.trim(),
    cache: Object.keys(sessionStorage).filter((k) => k.startsWith('zenmap:fuel')).length,
  }))()`);
  log(`after${ms}ms`, snap);
  if (snap.rows > 0) break;
}
log('requests', requests.slice(-6));
await appendFileSync('.tmp/dbg_gas11.log', out.join('\n') + '\n');
console.log(out.join('\n'));
ws.close();
