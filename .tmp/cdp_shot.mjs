import { writeFile } from 'node:fs/promises';

const [,, OUT, SCENARIO, MODE = 'drive', ORIGIN = '北京站', DEST = '北京西站'] = process.argv;

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
const onEvent = (method, fn) => handlers.push({ method, fn });

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

const osrmHits = [];
const consoleErrors = [];
const externalHosts = new Set();
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
  if (url.includes('router.project-osrm.org')) osrmHits.push(params.response.status);
  if (!url.startsWith(BASE) && !url.startsWith('data:')) {
    try {
      externalHosts.add(new URL(url).host);
    } catch {}
  }
});

await send('Page.enable');
await send('Runtime.enable');
await send('Network.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 430, height: 932, deviceScaleFactor: 2, mobile: true });
await send('Browser.grantPermissions', { origin: 'http://127.0.0.1:8024', permissions: ['geolocation'] });
await send('Emulation.setGeolocationOverride', { latitude: 39.9025, longitude: 116.4218, accuracy: 25 });

const setTrip = () =>
  evaluate(`(() => {
    sessionStorage.clear();
    sessionStorage.setItem('zenmap:trip', JSON.stringify({ destination: ${JSON.stringify(DEST)}, mode: ${JSON.stringify(MODE)} }));
    return true;
  })()`);

const runOrigin = () =>
  evaluate(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 30; i += 1) {
      await wait(250);
      if (!document.querySelector('#origin-form').hidden) break;
    }
    if (!document.querySelector('#origin-form').hidden) {
      document.querySelector('#origin-input').value = ${JSON.stringify(ORIGIN)};
      document.querySelector('#origin-form').requestSubmit();
    }
    return document.querySelector('#status-text').textContent;
  })()`);

const waitRoute = () =>
  evaluate(`(() => new Promise((resolve) => {
    const deadline = Date.now() + 45000;
    const timer = setInterval(() => {
      const panel = document.querySelector('#route-panel');
      const summary = document.querySelector('#route-summary')?.textContent || '';
      const ready = panel && !panel.hidden && summary && summary !== '正在规划路线…';
      if (ready || Date.now() > deadline) {
        clearInterval(timer);
        resolve({
          ready,
          tag: document.querySelector('#route-tag')?.textContent,
          summary,
          note: document.querySelector('#route-note')?.hidden ? '' : document.querySelector('#route-note')?.textContent,
          status: document.querySelector('#status-text')?.textContent,
          destNote: document.querySelector('#dest-note')?.hidden ? '' : document.querySelector('#dest-note')?.textContent,
          offline: !document.querySelector('#offline-note')?.hidden,
          stopsVisible: !document.querySelector('#route-stops')?.hidden,
          remindVisible: !document.querySelector('#route-remind')?.hidden,
          polylines: document.querySelectorAll('.leaflet-overlay-pane path').length,
          tiles: document.querySelectorAll('.leaflet-tile-loaded').length,
          mapPosition: getComputedStyle(document.querySelector('#map')).position,
          sheets: document.styleSheets.length,
        });
      }
    }, 250);
  }))()`);

const shoot = async (path = OUT) => {
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  await writeFile(path, Buffer.from(shot.data, 'base64'));
};

const openMap = async () => {
  await send('Page.navigate', { url: `${BASE}/map.html` });
  await waitForEvent('Page.loadEventFired');
  const status = await runOrigin();
  const info = await waitRoute();
  return { status, ...info };
};

const manualOrigin = (name) =>
  evaluate(`(async () => {
    document.querySelector('#manual-link').click();
    document.querySelector('#origin-input').value = ${JSON.stringify(name)};
    document.querySelector('#origin-form').requestSubmit();
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 40; i += 1) {
      await wait(250);
      if (document.querySelector('#origin-form').hidden) break;
    }
    return document.querySelector('#status-text').textContent;
  })()`);

let result;

if (SCENARIO === 'options') {
  await send('Page.navigate', { url: `${BASE}/index.html` });
  await waitForEvent('Page.loadEventFired');
  await setTrip();
  await openMap();

  const readOut = () =>
    evaluate(`(() => ({
      tag: document.querySelector('#route-tag').textContent,
      summary: document.querySelector('#route-summary').textContent,
      note: document.querySelector('#route-note').textContent,
      options: [...document.querySelectorAll('#route-options button')].map((b) => ({
        pressed: b.getAttribute('aria-pressed'),
        text: b.textContent.replace(/\\s+/g, ' ').trim(),
        gradeClass: b.querySelector('span:last-child').className.trim(),
      })),
      safety: document.querySelector('#route-safety').textContent.replace(/\\s+/g, ' ').trim(),
      safetyGradeClass: document.querySelector('#route-safety span').className.trim(),
      paths: [...document.querySelectorAll('.leaflet-overlay-pane path')].map((p) => [p.getAttribute('stroke'), p.getAttribute('stroke-width'), p.getAttribute('stroke-opacity'), (p.getAttribute('stroke-dasharray') || 'solid').slice(0, 6)].join('|')),
    }))()`);

  const first = await readOut();
  await new Promise((r) => setTimeout(r, 1200));
  await shoot();

  await evaluate(`document.querySelectorAll('#route-options button')[1].click()`);
  await new Promise((r) => setTimeout(r, 1200));
  const second = await readOut();
  await shoot(OUT.replace(/\.png$/, '-alt.png'));

  result = { phase: 'options', first, second };
} else if (SCENARIO === 'ask') {
  await send('Page.navigate', { url: `${BASE}/index.html` });
  await waitForEvent('Page.loadEventFired');
  result = await evaluate(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    sessionStorage.clear();
    document.querySelector('#start-btn').click();
    await wait(500);
    document.querySelector('#restart-btn')?.click();
    await wait(400);
    return {
      step: document.querySelector('#step-label').textContent,
      examples: [...document.querySelectorAll('[data-example]')].map((b) => b.dataset.example),
      askHidden: document.querySelector('#ask-form').hidden,
    };
  })()`);
  await new Promise((r) => setTimeout(r, 600));
  await shoot();
} else if (SCENARIO === 'examples') {
  await send('Page.navigate', { url: `${BASE}/index.html` });
  await waitForEvent('Page.loadEventFired');
  result = await evaluate(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    document.querySelector('#start-btn').click();
    await wait(400);
    const before = document.querySelector('#step-label').textContent;
    document.querySelector('[data-example="虹桥火车站"]').click();
    await wait(400);
    return {
      before,
      after: document.querySelector('#step-label').textContent,
      shown: document.querySelector('#step-value').textContent,
      input: document.querySelector('#destination').value,
      modes: [...document.querySelectorAll('[data-mode]')].map((b) => b.dataset.mode),
    };
  })()`);
  await new Promise((r) => setTimeout(r, 800));
  await shoot();
} else if (SCENARIO === 'table') {
  await send('Page.navigate', { url: `${BASE}/index.html` });
  await waitForEvent('Page.loadEventFired');
  await setTrip();
  await openMap();
  await send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
  const originStatus = await manualOrigin('西安北站');
  result = { phase: 'table', originStatus, ...(await waitRoute()) };
} else if (SCENARIO === 'home') {
  await send('Page.navigate', { url: `${BASE}/index.html` });
  await waitForEvent('Page.loadEventFired');
  await new Promise((r) => setTimeout(r, 1500));
  result = {
    phase: 'home',
    sheets: await evaluate('document.styleSheets.length'),
    heroPosition: await evaluate(`getComputedStyle(document.querySelector('body')).backgroundColor`),
    external: [...externalHosts],
  };
  await shoot();
} else if (SCENARIO === 'offline') {
  await send('Page.navigate', { url: `${BASE}/index.html` });
  await waitForEvent('Page.loadEventFired');
  await setTrip();
  const online = await openMap();
  await evaluate(`(() => {
    const value = { lat: 39.8646, lng: 116.3709, label: '北京南站', city: '北京市' };
    sessionStorage.setItem('zenmap:geo:v1:北京南站', JSON.stringify({ time: Date.now(), value }));
    return true;
  })()`);
  await send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
  const originStatus = await manualOrigin('北京南站');
  const optionTexts = await evaluate(
    `(() => [...document.querySelectorAll('#route-options button')].map((b) => b.textContent.replace(/\\s+/g, ' ').trim()).join(' || '))()`
  );
  result = { phase: 'offline', online, originStatus, optionTexts, ...(await waitRoute()) };
} else if (SCENARIO === 'cache') {
  await send('Page.navigate', { url: `${BASE}/index.html` });
  await waitForEvent('Page.loadEventFired');
  await setTrip();
  const first = await openMap();
  const hitsAfterFirst = osrmHits.length;
  const second = await openMap();
  result = { phase: 'cache', first, second, osrmOnFirst: hitsAfterFirst, osrmOnSecond: osrmHits.length - hitsAfterFirst };
} else if (SCENARIO === 'osrmfail') {
  await send('Page.navigate', { url: `${BASE}/index.html` });
  await waitForEvent('Page.loadEventFired');
  await setTrip();
  onEvent('Fetch.requestPaused', (params) => {
    send('Fetch.failRequest', { requestId: params.requestId, errorReason: 'ConnectionRefused' }).catch(() => {});
  });
  await send('Fetch.enable', { patterns: [{ urlPattern: '*project-osrm.org*', requestStage: 'Request' }] });
  const optionRead = () =>
    evaluate(`(() => ({
      optionTexts: [...document.querySelectorAll('#route-options button')].map((b) => b.textContent.replace(/\\s+/g, ' ').trim()).join(' || '),
      safety: document.querySelector('#route-safety')?.textContent.replace(/\\s+/g, ' ').trim(),
    }))()`);
  result = { phase: 'osrmfail', ...(await openMap()), ...(await optionRead()) };
} else {
  await send('Page.navigate', { url: `${BASE}/index.html` });
  await waitForEvent('Page.loadEventFired');
  await setTrip();
  result = { phase: SCENARIO, ...(await openMap()) };
}

await new Promise((r) => setTimeout(r, 1500));
if (SCENARIO !== 'options') await shoot();
console.log(JSON.stringify({ out: OUT, osrmTotal: osrmHits.length, consoleErrors, externalHosts: [...externalHosts], ...result }, null, 2));

ws.close();
process.exit(0);
