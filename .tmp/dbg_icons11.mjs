import { writeFile } from 'node:fs/promises';

const BASE = 'http://127.0.0.1:8024';
const [,, SCHEME = 'light', REDUCED = 'reduce', SHOT = ''] = process.argv;

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
  if (!msg.id) return;
  const entry = waiting.get(msg.id);
  waiting.delete(msg.id);
  if (msg.error) entry.reject(new Error(msg.error.message));
  else entry.resolve(msg.result);
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
await send('Emulation.setEmulatedMedia', {
  features: [
    { name: 'prefers-color-scheme', value: SCHEME },
    { name: 'prefers-reduced-motion', value: REDUCED },
  ],
});
await send('Browser.grantPermissions', { origin: BASE, permissions: ['geolocation'] });
await send('Emulation.setGeolocationOverride', { latitude: 39.9025, longitude: 116.4218, accuracy: 25 });

const ICON_PROBE = `(() => {
  const one = (sel) => {
    const svg = document.querySelector(sel);
    if (!svg) return 'MISSING ' + sel;
    const r = svg.getBoundingClientRect();
    const cs = getComputedStyle(svg);
    const parent = svg.parentElement;
    const pcs = getComputedStyle(parent);
    return sel + ' box=' + cs.boxSizing + ' size=' + Math.round(r.width) + 'x' + Math.round(r.height) +
      ' viewBox=' + svg.getAttribute('viewBox') + ' sw=' + svg.getAttribute('stroke-width') +
      ' stroke=' + cs.stroke + ' fill=' + cs.fill + ' cap=' + cs.strokeLinecap + ' join=' + cs.strokeLinejoin +
      ' kids=' + svg.children.length + ' spanTransition=' + pcs.transitionDuration +
      ' baselineShift=' + Math.round(svg.getBoundingClientRect().bottom - parent.getBoundingClientRect().bottom) +
      ' ariaHidden=' + svg.getAttribute('aria-hidden');
  };
  return [
    one('#start-btn span:first-child svg'),
    one('#start-btn span:last-child svg'),
    one('#close-btn svg'),
    one('#ask-form button[type=submit] svg'),
    one('[data-mode=transit] .zen-row-icon svg'),
    one('[data-mode=drive] .zen-row-icon svg'),
    one('[data-mode=walk] .zen-row-icon svg'),
    one('[data-mode=walk] .zen-row-arrow svg'),
    one('#open-map svg'),
  ].join('\\n');
})()`;

const MAP_PROBE = `(() => {
  const one = (sel) => {
    const svg = document.querySelector(sel);
    if (!svg) return 'MISSING ' + sel;
    const r = svg.getBoundingClientRect();
    const cs = getComputedStyle(svg);
    return sel + ' size=' + Math.round(r.width) + 'x' + Math.round(r.height) + ' sw=' + svg.getAttribute('stroke-width') + ' stroke=' + cs.stroke + ' kids=' + svg.children.length;
  };
  const sheet = document.querySelector('#sheet').getBoundingClientRect();
  const bar = document.querySelector('.zen-topbar').getBoundingClientRect();
  const rise = document.querySelector('.zen-rise') || document.querySelector('#sheet');
  return [
    one('.zen-topbar a svg'),
    one('#locate-btn svg'),
    one('#gas-btn svg'),
    one('#origin-form button[type=submit] svg'),
    'fullBleed topbar=' + Math.round(bar.left) + '/' + Math.round(bar.width) + '/' + window.innerWidth + ' sheet=' + Math.round(sheet.left) + '/' + Math.round(sheet.width),
    'primaryTransition=' + getComputedStyle(document.querySelector('.zen-pill-solid') || document.querySelector('#gas-btn')).transitionDuration,
    'miniTransition=' + getComputedStyle(document.querySelector('.zen-mini') || document.querySelector('#retry-btn')).transitionDuration,
  ].join('\\n');
})()`;

const report = { scheme: SCHEME, reduced: REDUCED, home: {}, map: {} };

await send('Page.navigate', { url: `${BASE}/index.html` });
await wait(1000);
await evaluate(`sessionStorage.clear()`);
await send('Page.navigate', { url: `${BASE}/index.html` });
await wait(1500);

report.home.heroIcons = await evaluate(ICON_PROBE);
report.home.heroMotion = await evaluate(`(() => {
  const btn = document.querySelector('#start-btn');
  const rise = document.querySelector('main > div');
  const cs = getComputedStyle(btn);
  return 'primaryTransition=' + cs.transitionDuration + ' timing=' + cs.transitionTimingFunction +
    ' wrapperAnim=' + getComputedStyle(rise).animationName + ' wrapperTransition=' + getComputedStyle(rise).transitionDuration;
})()`);
await evaluate(`document.querySelector('#start-btn').click()`);
await wait(700);
await evaluate(`document.querySelector('#destination').value = '北京西站'`);
await evaluate(`document.querySelector('#ask-form button[type=submit]').click()`);
await wait(900);
report.home.modeIcons = await evaluate(ICON_PROBE);
report.home.rowMotion = await evaluate(`(() => {
  const row = document.querySelector('[data-mode=drive]');
  const cs = getComputedStyle(row);
  const div = getComputedStyle(row, '::before');
  return 'rowTransition=' + cs.transitionDuration + ' dividerLeft=' + div.left + ' dividerBg=' + div.backgroundColor + ' iconColor=' + getComputedStyle(row.querySelector('.zen-row-icon')).color;
})()`);
if (SHOT) {
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  await writeFile(`screenshots/${SHOT}-home.png`, Buffer.from(shot.data, 'base64'));
}

await evaluate(`document.querySelector('[data-mode=drive]').click()`);
await wait(700);
await evaluate(`document.querySelector('#open-map').click()`);
await wait(4000);
report.map.icons = await evaluate(MAP_PROBE);
report.map.gasIcon = await evaluate(`(() => {
  const el = document.querySelector('#gas-btn');
  const cs = getComputedStyle(el);
  const svg = el.querySelector('svg');
  const r = svg.getBoundingClientRect();
  const text = [...el.childNodes].filter((n) => n.nodeType === 3 || (n.tagName === 'SPAN' && !n.querySelector('svg'))).map((n) => n.textContent.trim()).join('/');
  return 'pillTransition=' + cs.transitionDuration + ' gap=' + cs.gap + ' icon=' + Math.round(r.width) + 'px textSpans=' + text;
})()`);
if (SHOT) {
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  await writeFile(`screenshots/${SHOT}-map.png`, Buffer.from(shot.data, 'base64'));
}
console.log(JSON.stringify(report, null, 2));
ws.close();
