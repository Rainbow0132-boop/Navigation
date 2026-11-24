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
const handlers = [];
const consoleErrors = [];
const externalHosts = new Set();
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

const waitForEvent = (method, timeout = 45000) =>
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

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const shoot = async (path) => {
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  await writeFile(path, Buffer.from(shot.data, 'base64'));
};

const goto = async (url) => {
  const waiter = waitForEvent('Page.loadEventFired');
  await send('Page.navigate', { url });
  await waiter;
};

const gotoVia = async (selector) => {
  const waiter = waitForEvent('Page.loadEventFired');
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  await waiter;
};

const waitRoute = async (timeout = 40000) => {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const ready = await evaluate(`document.querySelector('#route-tag') && document.querySelector('#route-tag').textContent.trim() !== ''`);
    if (ready) return Math.round((Date.now() - started) / 100) / 10;
    await wait(1000);
  }
  return 'timeout';
};

const boxOf = async (selector) =>
  evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return null;
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);

const click = async (selector) => {
  const box = await boxOf(selector);
  if (!box) return 'NOT_VISIBLE';
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0 });
  }
  return `clicked@${box.x},${box.y}`;
};

const AUDIT = `(() => {
  const EMOJI = /[\\u{1F300}-\\u{1FAFF}\\u{2600}-\\u{27BF}\\u{FE0F}\\u{2190}-\\u{2193}\\u{2715}\\u{2716}\\u{27A1}]/u;
  const path = (el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.') : '');
  const rgb = (value) => {
    const m = /rgba?\\(([^)]+)\\)/.exec(value || '');
    if (!m) return null;
    const p = m[1].split(',').map((n) => parseFloat(n));
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const blueHits = [];
  const props = ['color', 'backgroundColor', 'borderTopColor', 'borderRightColor', 'borderBottomColor', 'borderLeftColor', 'outlineColor', 'caretColor', 'fill', 'stroke', 'textDecorationColor', 'boxShadow'];
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    for (const p of props) {
      const c = rgb(cs[p]);
      if (c && c.a > 0.05 && c.b > 120 && c.b > c.r + 45 && c.b > c.g + 30) blueHits.push(path(el) + ' {' + p + ':' + cs[p] + '}');
    }
    if (/007aff|0a84ff|4f46e5|818cf8/i.test(cs.backgroundImage || '')) blueHits.push(path(el) + ' {backgroundImage:' + cs.backgroundImage.slice(0, 60) + '}');
  }
  const emojiHits = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (EMOJI.test(n.nodeValue)) emojiHits.push(path(n.parentElement) + ' "' + n.nodeValue.trim().slice(0, 12) + '"');
  }
  const icons = [...document.querySelectorAll('body svg')].map((svg) => {
    const cs = getComputedStyle(svg);
    const r = svg.getBoundingClientRect();
    return {
      cls: svg.getAttribute('class'),
      size: Math.round(r.width) + 'x' + Math.round(r.height),
      drawn: r.width > 8 && r.height > 8,
      sw: svg.getAttribute('stroke-width'),
      stroke: cs.stroke,
      fill: cs.fill,
      kids: svg.children.length,
      viewBox: svg.getAttribute('viewBox'),
    };
  });
  const tok = (k) => getComputedStyle(document.documentElement).getPropertyValue(k).trim();
  const btn = document.querySelector('.zen-btn-primary');
  return {
    emojiHits,
    blueHits: [...new Set(blueHits)].slice(0, 10),
    iconCount: icons.length,
    icons,
    currentColorStrokes: icons.filter((i) => i.stroke === 'currentColor').length,
    stroke15: icons.filter((i) => i.sw === '1.5').length,
    stroke2: icons.filter((i) => i.sw === '2').length,
    notDrawn: icons.filter((i) => !i.drawn).map((i) => i.cls),
    accentToken: tok('--z-accent') || '(empty)',
    accentSoftToken: tok('--z-accent-soft'),
    grades: ['--z-grade-high', '--z-grade-mid', '--z-grade-low'].map((k) => k + '=' + tok(k)).join(' '),
    primary: btn ? 'bg=' + getComputedStyle(btn).backgroundColor + ' color=' + getComputedStyle(btn).color + ' image=' + getComputedStyle(btn).backgroundImage + ' radius=' + getComputedStyle(btn).borderRadius : 'MISSING',
  };
})()`;

const report = { scheme: SCHEME, motion: REDUCED, viewport: `${WIDTH}x${HEIGHT}`, pages: {}, flow: {}, consoleErrors: [], externalHosts: [] };

await goto(`${BASE}/index.html`);
await wait(800);
await evaluate(`sessionStorage.clear()`);
await goto(`${BASE}/index.html`);
await wait(1200);

report.pages.homeHero = await evaluate(AUDIT);
await shoot(`${OUT}-1-hero.png`);

report.flow.start = await click('#start-btn');
await wait(700);
report.pages.homeAsk = await evaluate(AUDIT);
await shoot(`${OUT}-2-ask.png`);
await evaluate(`document.querySelector('#destination').value = '北京西站'`);
report.flow.submit = await click('#ask-form button[type=submit]');
await wait(900);
report.pages.homeMode = await evaluate(AUDIT);
report.flow.rows = await evaluate(`[...document.querySelectorAll('[data-mode]')].map((b) => b.querySelector('.zen-row-icon svg') ? 'svg' : 'NO_SVG').join(',')`);
report.flow.rowStyle = await evaluate(`(() => {
  const row = document.querySelector('[data-mode=drive]');
  const icon = row.querySelector('.zen-row-icon');
  const arrow = row.querySelector('.zen-row-arrow');
  const div = getComputedStyle(row, '::before');
  return 'iconBox=' + getComputedStyle(icon).display + '/' + getComputedStyle(icon).width + ' arrowColor=' + getComputedStyle(arrow).color + ' dividerLeft=' + div.left + ' dividerBg=' + div.backgroundColor;
})()`);
await shoot(`${OUT}-3-mode.png`);
report.flow.pickDrive = await click('[data-mode=drive]');
await wait(800);
report.flow.summary = await evaluate(`(() => ({
  label: document.querySelector('#step-label').textContent,
  text: document.querySelector('#summary-step').innerText.replace(/\\n+/g, ' / ').slice(0, 60),
}))()`);
await shoot(`${OUT}-4-summary.png`);

await gotoVia('#open-map');
await wait(1500);
report.pages.mapDrive = await evaluate(AUDIT);
report.flow.routeWait = await waitRoute();
report.flow.routeTag = await evaluate(`document.querySelector('#route-tag').textContent`);
report.flow.optionActive = await evaluate(`(() => {
  const el = document.querySelector('#route-options .zen-option-active');
  if (!el) return 'MISSING';
  const cs = getComputedStyle(el);
  return 'bg=' + cs.backgroundColor + ' color=' + cs.color + ' border=' + cs.borderColor;
})()`);
report.flow.gradeTexts = await evaluate(`[...document.querySelectorAll('#route-options [class*=zen-grade]')].map((e) => e.textContent.trim() + ':' + getComputedStyle(e).color).join(' | ')`);
report.flow.destMarker = await evaluate(`(() => {
  const el = document.querySelector('.zen-marker-dest');
  return el ? 'border=' + getComputedStyle(el).borderColor : 'MISSING';
})()`);
await shoot(`${OUT}-5-map-drive.png`);

report.flow.gasOpen = await click('#gas-btn');
await wait(2500);
report.flow.gasIcon = await evaluate(`(() => {
  const btn = document.querySelector('#gas-btn');
  const svg = btn.querySelector('svg');
  return 'svg=' + (svg ? svg.getAttribute('class') + ' ' + Math.round(svg.getBoundingClientRect().width) + 'px' : 'NONE') + ' text=' + btn.innerText.trim();
})()`);
report.flow.gasRows = await evaluate(`document.querySelectorAll('.gas-row').length`);
report.flow.gasPick = await click('.gas-row');
await wait(1200);
report.flow.gasSelected = await evaluate(`(() => {
  const el = document.querySelector('.gas-row[aria-pressed="true"]');
  if (!el) return 'MISSING';
  const cs = getComputedStyle(el);
  const meta = el.querySelector('.gas-meta') || el;
  return 'bg=' + cs.backgroundColor + ' color=' + cs.color + ' meta=' + getComputedStyle(meta).color;
})()`);
report.flow.gasChip = await evaluate(`(() => {
  const el = document.querySelector('#gas-chip');
  const cs = getComputedStyle(el);
  return 'hidden=' + el.hidden + ' bg=' + cs.backgroundColor + ' color=' + cs.color + ' svg=' + (el.querySelector('svg') ? 'yes' : 'NONE');
})()`);
await shoot(`${OUT}-6-gas.png`);
await click('#gas-close');
await wait(400);
report.flow.weather = await evaluate(`(() => {
  const el = document.querySelector('#weather-panel');
  return 'hidden=' + el.hidden + ' text=' + el.innerText.replace(/\\n+/g, ' ').slice(0, 44);
})()`);

await goto(`${BASE}/index.html`);
await wait(600);
await evaluate(`sessionStorage.setItem('zenmap:trip', JSON.stringify({ destination: '北京西站', mode: 'transit' }))`);
await goto(`${BASE}/map.html`);
await wait(1500);
report.flow.transitWait = await waitRoute();
report.pages.mapTransit = await evaluate(AUDIT);
report.flow.transit = await evaluate(`(() => ({
  tag: document.querySelector('#route-tag').textContent,
  summary: document.querySelector('#route-summary').textContent.trim(),
  board: document.querySelector('#board-name').textContent,
  remindHidden: document.querySelector('#route-remind').hidden,
}))()`);
report.flow.alertClick = await click('#test-alert');
await wait(900);
report.flow.banner = await evaluate(`(() => {
  const el = document.querySelector('#alert-banner');
  const cs = getComputedStyle(el);
  return 'hidden=' + el.hidden + ' bg=' + cs.backgroundColor + ' color=' + cs.color;
})()`);
await shoot(`${OUT}-7-transit.png`);
await wait(11000);
report.flow.bannerHiddenAfter11s = await evaluate(`document.querySelector('#alert-banner').hidden`);
report.flow.originLink = await click('#manual-link');
await wait(500);
report.flow.originForm = await evaluate(`(() => {
  const form = document.querySelector('#origin-form');
  const btn = form.querySelector('button[type=submit]');
  const svg = btn.querySelector('svg');
  return 'hidden=' + form.hidden + ' btnBg=' + getComputedStyle(btn).backgroundColor + ' btnColor=' + getComputedStyle(btn).color + ' svg=' + (svg ? svg.getAttribute('class') : 'NONE') + ' caret=' + getComputedStyle(document.querySelector('#origin-input')).caretColor;
})()`);
await shoot(`${OUT}-8-origin.png`);

report.consoleErrors = consoleErrors;
report.externalHosts = [...externalHosts];

const merged = { emojiHits: [], blueHits: [], iconCount: 0, strokes: [], notDrawn: [], viewBoxes: [], fills: [] };
for (const p of Object.values(report.pages)) {
  merged.emojiHits.push(...p.emojiHits);
  merged.blueHits.push(...p.blueHits);
  merged.iconCount += p.iconCount;
  merged.notDrawn.push(...p.notDrawn);
  merged.viewBoxes.push(...p.icons.map((i) => i.viewBox));
  merged.fills.push(...p.icons.map((i) => i.fill));
  merged.strokes.push(...p.icons.map((i) => `${i.cls}|${i.size}|sw${i.sw}|${i.stroke}|kids${i.kids}`));
}
merged.emojiHits = [...new Set(merged.emojiHits)];
merged.blueHits = [...new Set(merged.blueHits)];
merged.strokes = [...new Set(merged.strokes)];
merged.viewBoxes = [...new Set(merged.viewBoxes)];
merged.fills = [...new Set(merged.fills)];
merged.currentColorAll = report.pages.mapDrive.currentColorStrokes;
report.audit = merged;
report.tokens = {
  accent: report.pages.homeHero.accentToken,
  accentSoft: report.pages.homeHero.accentSoftToken,
  grades: report.pages.homeHero.grades,
};
report.primaryButtons = { home: report.pages.homeHero.primary, map: report.pages.mapDrive.primary };
delete report.pages;
console.log(JSON.stringify(report, null, 2));
ws.close();
