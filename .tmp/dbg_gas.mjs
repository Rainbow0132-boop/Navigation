const BASE='http://127.0.0.1:8024';
const t=await fetch('http://127.0.0.1:9333/json/list').then(r=>r.json());
const page=t.find(x=>x.type==='page'&&x.webSocketDebuggerUrl);
const ws=new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res,rej)=>{ws.addEventListener('open',res,{once:true});ws.addEventListener('error',rej,{once:true});});
let seq=0;const wait=new Map();const evs=[];
ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id){const w=wait.get(m.id);wait.delete(m.id);m.error?w.rej(new Error(m.error.message)):w.res(m.result);return;}for(let i=evs.length-1;i>=0;i--)if(evs[i].m===m.method){const w=evs[i];evs.splice(i,1);clearTimeout(w.t);w.res(m.params);}});
const send=(method,params={})=>new Promise((res,rej)=>{const id=++seq;wait.set(id,{res,rej});ws.send(JSON.stringify({id,method,params}));});
const ev=(m,to=30000)=>new Promise((res,rej)=>{const o={m,res,t:setTimeout(()=>rej(new Error('timeout '+m)),to)};evs.push(o);});
const run=async(expression)=>{const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
await send('Page.enable');await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride',{width:430,height:932,deviceScaleFactor:2,mobile:true});
await send('Browser.grantPermissions',{origin:BASE,permissions:['geolocation']});
await send('Emulation.setGeolocationOverride',{latitude:39.9025,longitude:116.4218,accuracy:25});
await send('Page.navigate',{url:`${BASE}/index.html`});await ev('Page.loadEventFired');
await run(`(() => { sessionStorage.clear(); sessionStorage.setItem('zenmap:trip', JSON.stringify({destination:'北京西站',mode:'drive'})); return true; })()`);
await send('Page.navigate',{url:`${BASE}/map.html`});await ev('Page.loadEventFired');
await new Promise(r=>setTimeout(r,9000));
await run(`(() => {
  const stations=[{id:'node/1001',name:'中石化广莲桥加油站',brand:'中国石化',lat:39.9052,lng:116.4165},{id:'node/1002',name:'壳牌东单加油站',brand:'Shell',lat:39.9088,lng:116.4251},{id:'node/1003',name:'中石油前门加油站',brand:'中国石油',lat:39.8975,lng:116.4032}];
  const key='zenmap:fuel:v1:'+state.origin.lat.toFixed(3)+','+state.origin.lng.toFixed(3);
  sessionStorage.setItem(key, JSON.stringify({time:Date.now(),value:stations}));
  return key;
})()`);
await run(`document.querySelector('#gas-btn').click()`);
await new Promise(r=>setTimeout(r,1500));
console.log(JSON.stringify(await run(`(() => ({
  status: document.querySelector('#gas-status').textContent,
  rows: document.querySelectorAll('.gas-row').length,
  keys: Object.keys(sessionStorage),
  originKey: 'zenmap:fuel:v1:' + state.origin.lat.toFixed(3) + ',' + state.origin.lng.toFixed(3),
  origin: state.origin,
  mode: JSON.parse(sessionStorage.getItem('zenmap:trip') || 'null'),
  panelHidden: document.querySelector('#gas-panel').hidden,
}))()`),null,2));
ws.close();process.exit(0);
