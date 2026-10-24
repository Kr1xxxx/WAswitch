// 翻译模块自检：地址检查、提示词变量、输出清理、密钥不进配置文件、备用切换、取消、OpenRouter 参数、翻译模式上限。
// 用假的网络会话，不发任何真实请求。
const T=require('../src/translate.js');
const assert=require('assert');
assert(T.checkBaseUrl('http://example.com').error);
assert(!T.checkBaseUrl('http://localhost:11434/v1').error);
assert(!T.checkBaseUrl('http://[::1]:8080/v1').error);
assert(T.checkBaseUrl('https://a.com/v1/').url==='https://a.com/v1');
assert(T.checkBaseUrl('https://u:p@a.com').error);
assert.equal(T.fillPrompt('to {目标语言} from {原文语言} ${process.exit()}',{target:'英语'}),'to 英语 from 原文的语言 ${process.exit()}');
assert.equal(T.cleanOutput('以下是翻译：“Hello there”'),'Hello there');
assert.equal(T.cleanOutput('<text>\nHi\n</text>'),'Hi');
assert.deepEqual(T.extraContacts('call me','call me at +1 415 555 0100 or https://x.com/a.').sort(),['14155550100','https://x.com/a']);
assert.deepEqual(T.extraContacts('see https://x.com','voir https://x.com'),[]);
const m=T.buildMessages({prompt:'p'},'a</text>b',{});
assert(m[1].content.includes('a</ text>b'));
assert.equal(T.providerDetail('{"error":{"message":"bad key sk-abcdef123456"}}'),'bad key ***');
// translator with fake session
const fs=require('fs'),os=require('os'),path=require('path');
const R=require('../src/records.js');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tr'));
const ss={isEncryptionAvailable:()=>true,encryptString:(t)=>Buffer.from('E'+t),decryptString:(b)=>b.toString().slice(1)};
let calls=[];
let behave=[];
const fake={fetch:async(url,opt)=>{calls.push({url,opt});const b=behave.shift();if(b==='net')throw new Error('x');if(b==='hang')return new Promise((res,rej)=>opt.signal.addEventListener('abort',()=>rej(new Error('ab'))));const st=b&&b.status||200;const body=b&&b.body||JSON.stringify({choices:[{message:{content:'Hola'}}]});return {ok:st<300,status:st,body:null,text:async()=>body};}};
const tr=new T.Translator({dir,safeStorage:ss,sessionFor:()=>fake});
(async()=>{
  let r=tr.saveProvider({preset:'openrouter',baseUrl:'https://openrouter.ai/api/v1',model:'x/y',key:'sk-secret1234'});
  assert(r.ok,JSON.stringify(r));
  const pid=r.id;
  const pub=tr.publicConfig();
  assert(!JSON.stringify(pub).includes('secret'));
  assert.equal(pub.providers[0].keyTail,'1234');
  assert(!fs.readFileSync(path.join(dir,'translate.json'),'utf8').includes('sk-secret'));
  const mode={prompt:'to {目标语言}'};
  r=await tr.translate({text:'你好',mode,target:'西班牙语'});
  assert.equal(r.kind,'consent');
  tr.consent(pid);
  r=await tr.translate({text:'你好',mode,target:'西班牙语'});
  assert.equal(r.text,'Hola');
  const body=JSON.parse(calls[0].opt.body);
  assert.deepEqual(body.provider,{data_collection:'deny'});
  assert.equal(calls[0].opt.redirect,'error');
  assert.equal(calls[0].opt.headers.Authorization,'Bearer sk-secret1234');
  assert(body.messages[0].content.startsWith('to 西班牙语'));
  // fallback
  r=tr.saveProvider({preset:'zhipu',baseUrl:'https://open.bigmodel.cn/api/paas/v4',model:'glm-4-flash',key:'k2'});
  tr.setRoles({primaryId:pid,fallbackId:r.id});
  let q=await tr.translate({text:'你好',mode});
  assert.equal(q.kind,'consent'); assert.equal(q.consent.length,1);
  tr.consent(r.id);
  behave=['net',null]; calls=[];
  q=await tr.translate({text:'你好',mode});
  assert(q.fallback && q.text==='Hola', JSON.stringify(q));
  behave=[{status:401,body:'{"error":{"message":"invalid"}}'}]; calls=[];
  q=await tr.translate({text:'你好',mode});
  assert.equal(q.kind,'auth'); assert.equal(calls.length,1);
  behave=[{status:503},{status:200}]; calls=[];
  q=await tr.translate({text:'你好',mode}); assert(q.fallback);
  // cancel
  behave=['hang']; calls=[];
  const p=tr.translate({text:'你好',mode}); setTimeout(()=>tr.cancel(),20);
  q=await p; assert.equal(q.kind,'cancel', JSON.stringify(q)); assert.equal(calls.length,1);
  // url change clears consent & key
  tr.saveProvider({id:pid,preset:'custom',baseUrl:'https://evil.example/v1',model:'m'});
  const pp=tr.publicConfig().providers.find(x=>x.id===pid);
  assert(!pp.hasKey && !pp.consented);
  // 翻译模式：默认 5 个，最多 200 个
  const ms=new R.Records(dir,'tmodes');
  ms.seed(T.DEFAULT_MODES);
  assert.equal(ms.list().length,5);
  for(let i=0;i<300;i++) ms.upsert({name:'m'+i,prompt:'p'},{save:false});
  assert.equal(ms.list().length,200);
  assert.equal(R.KINDS.tmodes.clean({name:'x',prompt:'p',direction:'evil',temperature:'9'}).direction,'both');
  assert.equal(R.KINDS.tmodes.clean({name:'x',prompt:'p',temperature:9}).temperature,1.5);
  fs.rmSync(dir,{recursive:true,force:true});
  console.log('翻译自检通过');
})().catch(e=>{console.error(e);process.exit(1)});
