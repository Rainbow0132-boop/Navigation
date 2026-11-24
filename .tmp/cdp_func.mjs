import { writeFile } from 'node:fs/promises';

const OUT = process.argv[2] ?? 'screenshots/step10-func';
const BASE = 'http://127.0.0.1:8024';

const targets = await fetch('http://127.0.0.1:9333/json/list').then((r) => r.json());
const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
if (!page) throw new Error('no page target');

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', reject, { once: true });
});

let seq = 0;
const waiting = new Map();
const eventWaiters = [];
const handlers = [];
const consoleErrors = [];
const onEvent = (method, fn) => handlers.push({ method, fn });

ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id) {
    const entry = waiting.get(msg.id);
    waiting.delete(msg.id);
    if (msg.error) entry.rej(new Error(msg.error.message));
    else entry.res(msg.result);
    return;
  }
  for (const handler of handlers) if (handler.method === msg.method) handler.fn(msg.params);
  for (let i = eventWaiters.length - 1; i >= 0; i -= 1) {
    if (eventWaiters[i].method === msg.method) {
      const waiter = eventWaiters[i];
      eventWaiters.splice(i, 1);
      clearTimeout(waiter.timer);
      waiter.res();
    }
  }
});

const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const id = ++seq;
    waiting.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
  });

const waitForEvent = (method, timeout = 30000) =>
  new Promise((res, rej) => {
    const waiter = { method, res, timer: setTimeout(() => rej(new Error(`timeout ${method}`)), timeout) };
    eventWaiters.push(waiter);
  });

const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result.value;
};

onEvent('Runtime.consoleAPICalled', (p) => {
  if (p.type === 'error' || p.type === 'warning') consoleErrors.push(p.args.map((a) => a.value ?? a.description ?? a.type).join(' ').slice(0, 140));
});
onEvent('Runtime.exceptionThrown', (p) => {
  consoleErrors.push((p.exceptionDetails.exception?.description || p.exceptionDetails.text || 'exception').split('\n')[0].slice(0, 140));
});

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 430, height: 932, deviceScaleFactor: 2, mobile: true });
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
await send('Browser.grantPermissions', { origin: BASE, permissions: ['geolocation'] });
await send('Emulation.setGeolocationOverride', { latitude: 39.9025, longitude: 116.4218, accuracy: 25 });

const shoot = async (path) => {
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  await writeFile(path, Buffer.from(shot.data, 'base64'));
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const setTrip = (mode) => evaluate(`(() => { sessionStorage.clear(); sessionStorage.setItem('zenmap:trip', JSON.stringify({ destination: '北京西站', mode: ${JSON.stringify(mode)} })); return true; })()`);
const until = async (predicate, timeout = 25000) => {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await evaluate(predicate)) return Math.round((Date.now() - started) / 100) / 10;
    await wait(1000);
  }
  return 'timeout';
};

const report = {};

await setTrip('walk');
await send('Page.navigate', { url: `${BASE}/map.html` });
await waitForEvent('Page.loadEventFired');
report.walkWait = await until(`document.querySelector('#weather-panel').hidden === false && document.querySelector('#weather-temp').textContent !== '—'`, 40000);
report.walk = {
  weatherVisible: await evaluate(`document.querySelector('#weather-panel').hidden === false`),
  routePanelHidden: await evaluate(`document.querySelector('#route-panel').hidden`),
  temp: await evaluate(`document.querySelector('#weather-temp').textContent`),
  text: await evaluate(`document.querySelector('#weather-text').textContent`),
  rain: await evaluate(`document.querySelector('#weather-rain').textContent`),
  summary: await evaluate(`document.querySelector('#route-summary').textContent`),
  tag: await evaluate(`document.querySelector('#route-tag').textContent`),
  paths: await evaluate(`document.querySelectorAll('.leaflet-overlay-pane path').length`),
};
await shoot(`${OUT}-1-walk-weather.png`);

report.locate = {
  before: await evaluate(`document.querySelector('#status-text').textContent`),
  after: await evaluate(`(async () => {
    document.querySelector('#locate-btn').click();
    await new Promise((r) => setTimeout(r, 2500));
    return document.querySelector('#status-text').textContent + ' / ' + document.querySelector('#status-sub').textContent;
  })()`),
};

await setTrip('transit');
await send('Page.navigate', { url: `${BASE}/map.html` });
await waitForEvent('Page.loadEventFired');
report.transitWait = await until(`document.querySelector('#route-tag').textContent.trim() !== ''`);
report.transit = {
  tag: await evaluate(`document.querySelector('#route-tag').textContent`),
  summary: await evaluate(`document.querySelector('#route-summary').textContent`),
  board: await evaluate(`document.querySelector('#board-name').textContent`),
  alight: await evaluate(`document.querySelector('#alight-name').textContent`),
  paths: await evaluate(`document.querySelectorAll('.leaflet-overlay-pane path').length`),
};
await shoot(`${OUT}-3-transit.png`);

report.remind = {
  remindVisible: await evaluate(`document.querySelector('#route-remind').hidden === false`),
  thresholdDefault: await evaluate(`document.querySelector('#threshold').value`),
  bannerHiddenBefore: await evaluate(`document.querySelector('#alert-banner').hidden`),
  bannerAfterTest: await evaluate(`(async () => {
    document.querySelector('#test-alert').click();
    await new Promise((r) => setTimeout(r, 800));
    const b = document.querySelector('#alert-banner');
    return b.hidden + ' | ' + document.querySelector('#alert-title').textContent + ' | ' + document.querySelector('#alert-sub').textContent;
  })()`),
};
await shoot(`${OUT}-2-alert.png`);
report.remind.bannerHiddenAfter = await evaluate(`(async () => { await new Promise((r) => setTimeout(r, 11000)); return document.querySelector('#alert-banner').hidden; })()`);

const click = async (selector) => {
  const box = await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return 'MISSING'; const r = el.getBoundingClientRect(); if (r.width < 2 || r.height < 2) return 'NOT_VISIBLE'; return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
  if (typeof box !== 'object') return box;
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
  }
  return `click ${box.x},${box.y}`;
};

await evaluate(`(() => { sessionStorage.clear(); return true; })()`);
await send('Page.navigate', { url: `${BASE}/index.html` });
await waitForEvent('Page.loadEventFired');
await wait(1600);
report.realClick = {};
report.realClick.startBtn = await click('#start-btn');
await wait(600);
report.realClick.panelOpen = await evaluate(`document.querySelector('#panel').dataset.open`);
report.realClick.example = await click('[data-example="北京西站"]');
await wait(700);
report.realClick.stepLabel = await evaluate(`document.querySelector('#step-label').textContent`);
report.realClick.rows = await evaluate(`document.querySelectorAll('#mode-step .zen-row').length`);
report.realClick.focusRing = await evaluate(`(() => { const el = document.querySelector('.zen-row:focus-visible'); return el ? getComputedStyle(el).boxShadow : 'none'; })()`);
await shoot(`${OUT}-4-home-mode.png`);
report.realClick.pickDrive = await click('#mode-step [data-mode="drive"]');
await wait(700);
report.realClick.summary = await evaluate(`document.querySelector('#summary-step').hidden === false`);
report.realClick.sumText = await evaluate(`document.querySelector('#sum-dest').textContent + ' / ' + document.querySelector('#sum-mode').textContent`);
await shoot(`${OUT}-5-home-summary.png`);
report.realClick.backMode = await click('#back-mode');
await wait(600);
report.realClick.backToMode = await evaluate(`document.querySelector('#mode-step').hidden === false`);
report.realClick.openMap = await click('#restart-btn');
await wait(600);
report.realClick.afterRestart = await evaluate(`document.querySelector('#step-label').textContent + ' | ' + document.querySelector('#panel').dataset.open`);
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
await wait(400);
report.realClick.esc = await evaluate(`document.querySelector('#panel').dataset.open`);

report.consoleErrors = consoleErrors;
console.log(JSON.stringify(report, null, 2));
ws.close();
process.exit(0);
