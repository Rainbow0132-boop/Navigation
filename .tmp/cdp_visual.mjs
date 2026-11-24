import { writeFile } from 'node:fs/promises';

const [,, OUT, SCHEME = 'light', WIDTH = '430', HEIGHT = '932', REDUCED = 'no-preference'] = process.argv;
const BASE = 'http://127.0.0.1:8024';
const DPR = Number(WIDTH) > 700 ? 1 : 2;

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
const consoleErrors = [];
const externalHosts = new Set();
const onEvent = (method, fn) => handlers.push({ method, fn });
const handlers = [];

ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id) {
    const entry = waiting.get(msg.id);
    waiting.delete(msg.id);
    if (msg.error) entry.reject(new Error(msg.error.message));
    else entry.resolve(msg.result);
    return;
  }
  for (const handler of handlers) if (handler.method === msg.method) handler.fn(msg.params);
  for (let i = eventWaiters.length - 1; i >= 0; i -= 1) {
    if (eventWaiters[i].method === msg.method) {
      const waiter = eventWaiters[i];
      eventWaiters.splice(i, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(msg.params);
    }
  }
});

const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    waiting.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

const waitForEvent = (method, timeout = 30000) =>
  new Promise((resolve, reject) => {
    const waiter = { method, resolve, timer: setTimeout(() => reject(new Error(`timeout ${method}`)), timeout) };
    eventWaiters.push(waiter);
  });

const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
};

onEvent('Runtime.consoleAPICalled', (params) => {
  if (params.type === 'error' || params.type === 'warning') {
    consoleErrors.push(params.args.map((a) => a.value ?? a.description ?? a.type).join(' ').slice(0, 160));
  }
});
onEvent('Runtime.exceptionThrown', (params) => {
  consoleErrors.push((params.exceptionDetails.exception?.description || params.exceptionDetails.text || 'exception').split('\n')[0].slice(0, 160));
});
onEvent('Network.responseReceived', (params) => {
  const url = params.response.url;
  if (!url.startsWith(BASE) && !url.startsWith('data:')) {
    try {
      externalHosts.add(new URL(url).host);
    } catch {}
  }
});

await send('Page.enable');
await send('Runtime.enable');
await send('Network.enable');
await send('Emulation.setDeviceMetricsOverride', { width: Number(WIDTH), height: Number(HEIGHT), deviceScaleFactor: DPR, mobile: Number(WIDTH) < 640 });
await send('Emulation.setEmulatedMedia', {
  features: [
    { name: 'prefers-color-scheme', value: SCHEME },
    { name: 'prefers-reduced-motion', value: REDUCED },
  ],
});
await send('Browser.grantPermissions', { origin: BASE, permissions: ['geolocation'] });
await send('Emulation.setGeolocationOverride', { latitude: 39.9025, longitude: 116.4218, accuracy: 25 });

const shoot = async (path) => {
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  await writeFile(path, Buffer.from(shot.data, 'base64'));
};

const styleProbe = (selector, props) =>
  evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return 'MISSING';
    const cs = getComputedStyle(el);
    return ${JSON.stringify(props)}.map((p) => p + '=' + cs[p].slice(0, 46)).join(' | ');
  })()`);

const overflowProbe = () =>
  evaluate(`(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    sheets: document.styleSheets.length,
    tailwindApplied: getComputedStyle(document.querySelector('#sheet')).display,
  }))()`);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const report = { scheme: SCHEME, viewport: `${WIDTH}x${HEIGHT}`, consoleErrors: [], externalHosts: [] };

await send('Page.navigate', { url: `${BASE}/index.html` });
await waitForEvent('Page.loadEventFired');
await wait(1200);

report.hero = {
  startBtn: await styleProbe('#start-btn', ['backgroundImage', 'borderRadius', 'boxShadow', 'color', 'display', 'gap']),
  main: await styleProbe('main', ['backgroundImage']),
  label: await styleProbe('header span', ['letterSpacing', 'textTransform', 'fontSize']),
  h1: await styleProbe('h1', ['fontSize', 'fontWeight', 'letterSpacing']),
  reduced: await styleProbe('.zen-cta', ['transitionDuration']),
};
await shoot(`${OUT}-1-hero.png`);

await evaluate(`document.querySelector('#start-btn').click()`);
await wait(600);
report.sheet = {
  panelOpen: await evaluate(`document.querySelector('#panel').dataset.open`),
  sheet: await styleProbe('#sheet', ['backdropFilter', 'borderRadius', 'boxShadow', 'backgroundColor']),
  input: await styleProbe('#destination', ['borderBottomWidth', 'borderBottomColor']),
  chip: await styleProbe('.zen-chip', ['borderRadius', 'backgroundColor', 'boxShadow', 'color']),
};
await shoot(`${OUT}-2-ask.png`);

report.overflow = await overflowProbe();

await evaluate(`(() => { const el = document.querySelector('#destination'); el.value = '北京西站'; document.querySelector('#ask-form').requestSubmit(); return true; })()`);
await wait(700);
report.modeStep = {
  label: await evaluate(`document.querySelector('#step-label').textContent`),
  hidden: await evaluate(`document.querySelector('#mode-step').hidden`),
  card: await styleProbe('.zen-card', ['borderRadius', 'boxShadow', 'display', 'justifyContent', 'gap']),
  icon: await styleProbe('.zen-card-icon', ['backgroundColor', 'borderRadius', 'width', 'height']),
  grid: await styleProbe('#mode-step div', ['display', 'gridTemplateColumns', 'gap']),
};
await shoot(`${OUT}-3-mode.png`);

await evaluate(`document.querySelector('[data-mode="drive"]').click()`);
await wait(700);
report.summaryStep = {
  hidden: await evaluate(`document.querySelector('#summary-step').hidden`),
  dl: await styleProbe('#summary-step dl', ['borderRadius', 'borderWidth', 'padding']),
  openMap: await styleProbe('#open-map', ['backgroundColor', 'borderRadius', 'boxShadow', 'justifyContent']),
};
await shoot(`${OUT}-4-summary.png`);

await send('Page.navigate', { url: `${BASE}/index.html` });
await waitForEvent('Page.loadEventFired');
await wait(700);
await evaluate(`document.querySelector('#start-btn').click()`);
await wait(500);
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
await wait(400);
report.escape = { panelOpen: await evaluate(`document.querySelector('#panel').dataset.open`) };

await evaluate(`(() => { sessionStorage.setItem('zenmap:trip', JSON.stringify({ destination: '北京西站', mode: 'drive' })); return true; })()`);
await send('Page.navigate', { url: `${BASE}/map.html` });
await waitForEvent('Page.loadEventFired');
await wait(9000);

report.map = {
  topbar: await styleProbe('.zen-topbar', ['backdropFilter', 'borderRadius', 'boxShadow', 'backgroundColor', 'display']),
  icon: await styleProbe('.zen-icon', ['borderRadius', 'width', 'backgroundColor']),
  sheet: await styleProbe('#sheet', ['backdropFilter', 'borderRadius', 'boxShadow']),
  summary: await styleProbe('#route-summary', ['fontSize', 'fontWeight', 'fontVariantNumeric']),
  tag: await styleProbe('#route-tag', ['borderRadius', 'backgroundColor', 'fontSize']),
  optionActive: await styleProbe('.zen-option-active', ['backgroundColor', 'borderRadius', 'color', 'boxShadow']),
  safetyPill: await styleProbe('#route-safety > p:first-child', ['display', 'borderRadius', 'backgroundColor']),
  destMarker: await styleProbe('.zen-marker-dest', ['borderColor', 'boxShadow']),
  gradeOnActive: await styleProbe('.zen-option-active [class*="zen-grade"]', ['color', 'opacity']),
  ping: await evaluate(`(() => {
    const el = document.querySelector('.zen-marker-dot');
    return el ? getComputedStyle(el, '::after').animationName + ' ' + getComputedStyle(el, '::after').animationDuration : 'MISSING';
  })()`),
  tagText: await evaluate(`document.querySelector('#route-tag').textContent`),
  summaryText: await evaluate(`document.querySelector('#route-summary').textContent`),
  overflow: await overflowProbe(),
};
await shoot(`${OUT}-5-map-drive.png`);

await evaluate(`(() => {
  const stations = [
    { id: 'node/1001', name: '中石化广莲桥加油站', brand: '中国石化', lat: 39.9052, lng: 116.4165 },
    { id: 'node/1002', name: '壳牌东单加油站', brand: 'Shell', lat: 39.9088, lng: 116.4251 },
    { id: 'node/1003', name: '中石油前门加油站', brand: '中国石油', lat: 39.8975, lng: 116.4032 }
  ];
  sessionStorage.setItem('zenmap:fuel:v1:' + state.origin.lat.toFixed(3) + ',' + state.origin.lng.toFixed(3), JSON.stringify({ time: Date.now(), value: stations }));
  return true;
})()`);
await evaluate(`document.querySelector('#gas-btn').click()`);
await wait(1200);
report.gas = {
  panel: await styleProbe('#gas-panel', ['borderRadius', 'boxShadow', 'backdropFilter', 'backgroundColor']),
  pill: await styleProbe('#gas-chip', ['borderRadius', 'backgroundColor', 'display']),
  row: await styleProbe('.gas-row', ['padding', 'borderRadius', 'display', 'justifyContent']),
  rows: await evaluate(`document.querySelectorAll('.gas-row').length`),
  status: await evaluate(`document.querySelector('#gas-status').textContent`),
};
await shoot(`${OUT}-6-gas.png`);
await evaluate(`document.querySelectorAll('.gas-row')[1]?.click()`);
await wait(1200);
report.gas.selectedRow = await styleProbe('.gas-row[aria-pressed="true"]', ['backgroundColor', 'color', 'borderRadius', 'fontWeight']);
report.gas.chipAfter = await styleProbe('#gas-chip', ['display', 'backgroundColor', 'borderRadius']);
report.gas.marker = await styleProbe('.zen-marker-gas', ['borderColor', 'width']);
await shoot(`${OUT}-6b-gas-selected.png`);

await evaluate(`(() => {
  sessionStorage.clear();
  sessionStorage.setItem('zenmap:trip', JSON.stringify({ destination: '北京西站', mode: 'transit' }));
  return true;
})()`);
await send('Page.navigate', { url: `${BASE}/map.html` });
await waitForEvent('Page.loadEventFired');
await wait(9000);
report.transit = {
  stops: await styleProbe('#route-stops', ['display', 'gridTemplateColumns']),
  remind: await evaluate(`document.querySelector('#route-remind').hidden`),
  threshold: await styleProbe('#threshold', ['borderRadius']),
  tagText: await evaluate(`document.querySelector('#route-tag').textContent`),
  summaryText: await evaluate(`document.querySelector('#route-summary').textContent`),
};
await shoot(`${OUT}-7-transit.png`);

report.consoleErrors = consoleErrors;
report.externalHosts = [...externalHosts];
console.log(JSON.stringify(report, null, 2));

ws.close();
process.exit(0);
