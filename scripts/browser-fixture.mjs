import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
// Local-only manual browser harness: every account, provider, mic and input is a fixture.
const root=fileURLToPath(new URL('../', import.meta.url));
function installFixtures() {
  localStorage.setItem('voicebridge_locale','zh-CN');
  window.__VB_CONFIG={voicebridgeMode:'cloud',nativeApp:true,supabaseUrl:'https://fixture.invalid',supabaseAnonKey:'public-fixture'};
  const channels=new Set();const listeners=[];let session=null;const devices=new Map();let pendingAsr=[];let micCalls=0;let activeTracks=0;let delivered=[];let paired=true;
  function status(){const panel=document.querySelector('#fixtureStatus');if(panel)panel.textContent=`账号 ${session?.user.id||'未登录'} | mic申请 ${micCalls} / 活跃 ${activeTracks} | 待识别 ${pendingAsr.length} | 已发送 ${delivered.length}`;}
  function result(data){return new Response(JSON.stringify(data),{headers:{'content-type':'application/json'}});}
  function setUser(id){session=id?{access_token:`fixture-${id}`,user:{id,email:`${id}@fixture.invalid`,app_metadata:{providers:['email']},user_metadata:{}}}:null;for(const cb of listeners)cb(id?'SIGNED_IN':'SIGNED_OUT',session);status();}
  class Channel {
    constructor(topic){this.topic=topic;this.handlers=[];channels.add(this);}
    on(kind,filter,callback){this.handlers.push({kind,filter,callback});return this;}
    subscribe(callback){this.callback=callback;queueMicrotask(()=>{if(channels.has(this))callback('SUBSCRIBED');});return this;}
    presenceState(){const id=session?.user.id||'A';return {desktops:[0,1].map((n)=>({deviceId:`${id}-desktop-${n+1}`,name:`${id} 电脑 ${n+1}`,platform:'darwin',protocolVersion:2,lanEndpoints:[{host:`192.168.1.${10+n}`,port:3000,httpPort:3001}],windows:[]}))};}
    async track(){for(const h of this.handlers)if(h.kind==='presence')h.callback();return 'ok';}
    async untrack(){return 'ok';}
    async unsubscribe(){channels.delete(this);return 'ok';}
    async send(message){const p=message.payload;delivered.push({channel:this.topic,payload:p});status();setTimeout(()=>{for(const c of channels)for(const h of c.handlers)if(h.kind==='broadcast'&&h.filter.event==='ack')h.callback({payload:{type:'ack',request_id:p.request_id,target_device_id:p.source_device_id,source_device_id:p.target_device_id,status:'success'}});},30);return 'ok';}
  }
  const client={supabaseUrl:'https://fixture.invalid',supabaseKey:'public-fixture',auth:{async getSession(){return {data:{session},error:null};},onAuthStateChange(cb){listeners.push(cb);return {data:{subscription:{unsubscribe(){}}}};},async signInWithPassword({email}){setUser(email.toLowerCase().startsWith('b')?'B':'A');return {data:{session},error:null};},async signOut(){setUser(null);return {error:null};},async signUp(){return {data:{session:null},error:null};}},
    channel(topic){return new Channel(topic);},async removeChannel(channel){return channel.unsubscribe();},
    from(table){let filters={};let action='select';let payload;const q={select(){return this;},eq(k,v){filters[k]=v;return this;},gte(){return this;},order(){return this;},limit(){return this;},range(){return this;},update(data){action='update';payload=data;return this;},insert(data){action='insert';payload=data;return this;},delete(){action='delete';return this;},maybeSingle(){return this.execute(true);},single(){return this.execute(true);},async execute(one=false){const id=session?.user.id;if(table==='devices'){if(action==='insert')devices.set(payload.id,payload);if(action==='delete')devices.delete(filters.id);const rows=[...devices.values()].filter(r=>r.user_id===id&&(!filters.id||r.id===filters.id));return {data:one?rows[0]||null:rows,error:null};}if(table==='subscriptions')return {data:{plan:'pro',status:'active'},error:null};if(table==='usage_events')return {data:[],error:null};if(table==='user_commands')return {data:[{id:`phrase-${id}`,user_id:id,text:`${id} 私人短语`,label:`${id} 私人短语`,category:'我的指令'}],error:null};return {data:[],error:null};},then(resolve,reject){return this.execute().then(resolve,reject);}};return q;}};
  window.supabase={createClient:()=>client};
  window.fetch=async (url,options={})=>{
    if(String(url).includes('/functions/v1/transcribe')||String(url).endsWith('/api/upload'))return new Promise((resolve,reject)=>{const job={resolve,reject,options};pendingAsr.push(job);options.signal?.addEventListener('abort',()=>{pendingAsr=pendingAsr.filter(x=>x!==job);reject(new DOMException('fixture cancelled','AbortError'));status();},{once:true});status();});
    if(String(url).includes('/api/lan/pair')){if(options.method==='DELETE'){paired=false;return result({ok:true});}if(options.method==='POST'){paired=true;return result({ok:true,token:'fixture-lan-token'});}return result({ok:true,paired});}
    if(String(url).includes('/api/health'))return result({ok:true});
    if(String(url).includes('/api/windows'))return result({ok:true,windows:[]});
    return result({ok:true});
  };
  class Socket {
    static OPEN=1;
    constructor(url){this.url=url;this.readyState=0;this.handlers={};setTimeout(()=>{if(this.readyState!==3){this.readyState=1;this.handlers.open?.({});}},20);}
    addEventListener(event,callback){this.handlers[event]=callback;}
    close(code=1000){this.readyState=3;this.handlers.close?.({code});}
    send(raw){delivered.push({socket:this.url,payload:JSON.parse(raw)});status();}
  }
  window.WebSocket=Socket;
  Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{async getUserMedia(){micCalls++;status();await new Promise(r=>setTimeout(r,250));activeTracks++;status();let stopped=false;return {getTracks:()=>[{stop(){if(!stopped){stopped=true;activeTracks--;status();}}}]};}}});
  window.AudioContext=class {constructor(){this.sampleRate=16000;this.destination={};this.state='running';}createMediaStreamSource(){return {connect(){},disconnect(){}};}createScriptProcessor(){const node={connect(){},disconnect(){},onaudioprocess:null};this.timer=setInterval(()=>node.onaudioprocess?.({inputBuffer:{getChannelData:()=>new Float32Array(512)}}),32);return node;}async close(){clearInterval(this.timer);this.state='closed';}};
  document.addEventListener('DOMContentLoaded',()=>{const tools=document.createElement('div');tools.id='fixtureTools';tools.style.cssText='position:fixed;left:6px;bottom:6px;z-index:99999;background:#fff;color:#111;border:1px solid #444;padding:6px;font-size:11px;max-width:95vw';tools.innerHTML='<strong>离线模拟验收</strong> <button id="fixtureA">账号 A</button> <button id="fixtureB">账号 B</button> <button id="fixtureLogout">退出</button> <button id="fixtureResolve">完成识别</button> <span id="fixtureStatus"></span><pre id="fixtureDelivery" style="max-height:80px;overflow:auto;margin:2px"></pre>';document.body.appendChild(tools);document.querySelector('#fixtureA').onclick=()=>setUser('A');document.querySelector('#fixtureB').onclick=()=>setUser('B');document.querySelector('#fixtureLogout').onclick=()=>setUser(null);document.querySelector('#fixtureResolve').onclick=()=>{for(const job of pendingAsr.splice(0))job.resolve(result({ok:true,text:'模拟语音识别文字'}));status();document.querySelector('#fixtureDelivery').textContent=JSON.stringify(delivered);};status();setInterval(()=>{document.querySelector('#fixtureDelivery').textContent=JSON.stringify(delivered);},200);});
}
const script=`(${installFixtures.toString()})();`;
const mime={'.js':'application/javascript','.css':'text/css','.html':'text/html','.json':'application/json','.woff2':'font/woff2','.svg':'image/svg+xml'};
const server=http.createServer(async(req,res)=>{try{let route=new URL(req.url,'http://localhost').pathname;if(route==='/fixture.js'){res.writeHead(200,{'content-type':'application/javascript'});return res.end(script);}if(route==='/'||route==='/app'||route==='/app.html'){let html=await readFile(path.join(root,'src/public/index.html'),'utf8');html=html.replace(/<script src="\/config\.js"><\/script>/,'<script src="/fixture.js"></script>').replace(/<script src="\/vendor\/supabase\.js"><\/script>/,'');res.writeHead(200,{'content-type':'text/html'});return res.end(html);}const base=path.join(root,'src',route.startsWith('/shared/')?'shared':'public');const relative=route.startsWith('/shared/')?route.slice('/shared/'.length):route.slice(1);const file=path.resolve(base,relative);if(!file.startsWith(base+path.sep)){res.writeHead(403);return res.end('Forbidden');}const data=await readFile(file);res.writeHead(200,{'content-type':mime[path.extname(file)]||'application/octet-stream'});res.end(data);}catch(error){res.writeHead(404);res.end(String(error.message));}});
server.listen(Number(process.env.FIXTURE_PORT||3123),'127.0.0.1',()=>console.log('Offline VoiceBridge fixture http://127.0.0.1:'+server.address().port+'/app'));
