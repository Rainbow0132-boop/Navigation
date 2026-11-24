import { writeFile } from 'node:fs/promises';

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
ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id) {
    const entry = waiting.get(msg.id);
    waiting.delete(msg.id);
    if (msg.error) entry.reject(new Error(msg.error.message));
    else entry.resolve(msg.result);
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
await send('Emulation.setDeviceMetricsOverride', { width: 430, height: 932, deviceScaleFactor: 2, mobile: true });
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
await send('Browser.grantPermissions', { origin: BASE, permissions: ['geolocation'] });
await send('Emulation.setGeolocationOverride', { latitude: 39.9025, longitude: 116.4218, accuracy: 25 });

await send('Page.navigate', { url: `${BASE}/index.html` });
await wait(1200);
await evaluate(`sessionStorage.setItem('zenmap:trip', JSON.stringify({ destination: '北京西站', mode: 'drive' }))`);
await send('Page.navigate', { url: `${BASE}/map.html` });
await wait(3500);

const stations = [
  { id: 'node/1', name: '中石化莲花池加油站', brand: '中石化', lat: 39.905, lng: 116.417 },
  { id: 'node/2', name: '壳牌丽泽路加油站', brand: '壳牌', lat: 39.9, lng: 116.43 },
  { id: 'node/3', name: '中石油西三环加油站', brand: '中石油', lat: 39.897, lng: 116.412 },
];
const seeded = await evaluate(`(() => {
  const entry = JSON.stringify({ time: Date.now(), value: ${JSON.stringify(stations)} });
  const keys = [];
  for (const lat of ['39.901', '39.902', '39.903', '39.904']) {
    for (const lng of ['116.420', '116.421', '116.422', '116.423']) {
      const k = 'zenmap:fuel:v1:' + lat + ',' + lng;
      sessionStorage.setItem(k, entry);
      keys.push(k);
    }
  }
  return keys.length;
})()`);

const box = await evaluate(`(() => {
  const r = document.querySelector('#gas-btn').getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
})()`);
const clickAt = async (x, y) => {
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0 });
  }
};
await clickAt(box.x, box.y);
await wait(1500);

const report = { seededKeys: seeded };
report.panel = await evaluate(`(() => ({
  hidden: document.querySelector('#gas-panel').hidden,
  rows: document.querySelectorAll('.gas-row').length,
  status: document.querySelector('#gas-status').textContent.trim(),
  icon: (() => {
    const svg = document.querySelector('#gas-btn svg');
    return svg ? svg.getAttribute('class') + ' ' + Math.round(svg.getBoundingClientRect().width) + 'px sw' + svg.getAttribute('stroke-width') : 'NONE';
  })(),
}))()`);

const rowBox = await evaluate(`(() => {
  const r = document.querySelectorAll('.gas-row')[1].getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
})()`);
await clickAt(rowBox.x, rowBox.y);
await wait(1200);

report.selected = await evaluate(`(() => {
  const el = document.querySelector('.gas-row[aria-pressed="true"]');
  if (!el) return 'MISSING';
  const cs = getComputedStyle(el);
  const meta = el.querySelector('.gas-meta');
  return {
    name: el.textContent.slice(0, 20),
    bg: cs.backgroundColor,
    color: cs.color,
    metaColor: meta ? getComputedStyle(meta).color : 'NO_META',
    metaOpacity: meta ? getComputedStyle(meta).opacity : null,
    chipHidden: document.querySelector('#gas-chip').hidden,
    chipBg: getComputedStyle(document.querySelector('#gas-chip')).backgroundColor,
    chipColor: getComputedStyle(document.querySelector('#gas-chip')).color,
    chipIcon: document.querySelector('#gas-chip svg') ? 'svg' : 'NONE',
    waypoint: document.querySelector('#gas-waypoint').hidden ? 'hidden' : document.querySelector('#gas-waypoint').textContent.trim(),
  };
})()`);

const shot = await send('Page.captureScreenshot', { format: 'png' });
await writeFile('screenshots/step11-gas-cache-selected.png', Buffer.from(shot.data, 'base64'));
console.log(JSON.stringify(report, null, 2));
ws.close();
