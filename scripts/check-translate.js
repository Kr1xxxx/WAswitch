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
const tr=new T.Translator({seed:false,dir,safeStorage:ss,sessionFor:()=>fake,retryMs:5});
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
  assert.equal(r.text,'Hola');
  const body=JSON.parse(calls[0].opt.body);
  assert.deepEqual(body.provider,{data_collection:'deny'});
  assert.equal(calls[0].opt.redirect,'error');
  assert.equal(calls[0].opt.headers.Authorization,'Bearer sk-secret1234');
  assert(body.messages[0].content.startsWith('to 西班牙语'));
  // fallback
  r=tr.saveProvider({preset:'zhipu',baseUrl:'https://open.bigmodel.cn/api/paas/v4',model:'glm-4-flash',key:'k2'});
  tr.setRoles({primaryId:pid,fallbackId:r.id});
  behave=['net',null]; calls=[];
  let q=await tr.translate({text:'你好',mode});
  assert(q.fallback && q.text==='Hola', JSON.stringify(q));
  behave=[{status:401,body:'{"error":{"message":"invalid"}}'}]; calls=[];
  q=await tr.translate({text:'你好',mode});
  assert.equal(q.kind,'auth'); assert.equal(calls.length,1);
  // 服务商的英文原话不进正文，放进 detail（界面上收在“详细信息”里）
  assert(!q.error.includes('invalid') && /invalid/.test(q.detail||''), JSON.stringify(q));
  // 密钥错：点名是哪个服务商，并带上它的 id（界面“去填密钥”打开它的表单）
  assert.equal(q.providerId,pid); assert(q.error.includes('密钥不对'), q.error);
  // 服务商把密钥原样写进错误里（智谱的密钥不是 sk- 开头）：要被遮住
  behave=[{status:401,body:'{"error":{"message":"key sk-secret1234 is invalid"}}'}];
  q=await tr.translate({text:'你好',mode}); assert(!q.error.includes('secret1234'), q.error);
  behave=[{status:503},{status:200}]; calls=[];
  q=await tr.translate({text:'你好',mode}); assert(q.fallback);
  // 429 太忙：先原地重试一次，成功就不换备用
  const busy={status:429,body:'{"error":{"message":"The model service is currently busy or has reached its serving capacity limit."}}'};
  behave=[busy,null]; calls=[];
  q=await tr.translate({text:'你好',mode}); assert(!q.fallback && q.text==='Hola' && calls.length===2, JSON.stringify(q));
  // 还忙就换备用
  behave=[busy,busy,null]; calls=[];
  q=await tr.translate({text:'你好',mode}); assert(q.fallback && calls.length===3, JSON.stringify(q));
  // 全都忙：中文提示，不带英文原话
  // 翻译页指定服务商：只用它，失败也不换备用；找不到就报错，不偷偷用默认的
  const pinId=tr.load().fallbackId;
  behave=[null]; calls=[];
  q=await tr.translate({text:'你好',mode,providerId:pinId});
  assert(q.text==='Hola' && !q.fallback && calls[0].url.startsWith('https://open.bigmodel.cn'), JSON.stringify(q));
  behave=['net',null]; calls=[];
  q=await tr.translate({text:'你好',mode,providerId:pinId});
  assert.equal(q.kind,'network'); assert.equal(calls.length,1);
  calls=[]; q=await tr.translate({text:'你好',mode,providerId:'gone'});
  assert.equal(q.kind,'config'); assert.equal(calls.length,0);
  behave=[busy,busy,busy,busy]; calls=[];
  q=await tr.translate({text:'你好',mode}); assert.equal(q.kind,'overload'); assert.equal(q.error,'智谱请求太频繁，请重试'); assert(!q.detail, JSON.stringify(q));
  // 429 但说的是余额不足（智谱 1113）：不原地重试，直接换备用
  const broke={status:429,body:'{"error":{"code":"1113","message":"余额不足或无可用资源包,请充值。"}}'};
  behave=[broke,null]; calls=[];
  q=await tr.translate({text:'你好',mode}); assert(q.fallback && q.text==='Hola' && calls.length===2, JSON.stringify(q));
  // 备用也没余额：只说一句，不接服务商原话
  behave=[broke,broke]; calls=[];
  q=await tr.translate({text:'你好',mode}); assert.equal(q.kind,'quota'); assert.equal(calls.length,2);
  assert.equal(q.error,'智谱请求太频繁，请重试'); assert(!/余额|充值/.test(JSON.stringify(q)), JSON.stringify(q));
  // 只有 code 1113、没有中文说明：也算没余额
  behave=[{status:429,body:'{"error":{"code":"1113"}}'},null]; calls=[];
  q=await tr.translate({text:'你好',mode}); assert(q.fallback && calls.length===2, JSON.stringify(q));
  // 402 没余额：也换备用
  behave=[{status:402,body:'{}'},null]; calls=[];
  q=await tr.translate({text:'你好',mode}); assert(q.fallback, JSON.stringify(q));
  // 没设备用：只说一句，不教人去设置
  const fbKeep=tr.load().fallbackId; tr.setRoles({primaryId:pid,fallbackId:''});
  behave=[busy,busy]; calls=[];
  q=await tr.translate({text:'你好',mode}); assert.equal(q.error,'OpenRouter 请求太频繁，请重试');
  tr.setRoles({primaryId:pid,fallbackId:fbKeep});
  // 出厂配置：智谱默认、DeepL 备用但没填密钥。智谱没余额：不换到没密钥的备用，还是只说智谱那句
  const dlNo=tr.saveProvider({preset:'deepl'}); assert(dlNo.ok, JSON.stringify(dlNo));
  tr.setRoles({primaryId:fbKeep,fallbackId:dlNo.id});
  behave=[broke]; calls=[];
  q=await tr.translate({text:'你好',mode}); assert.equal(q.error,'智谱请求太频繁，请重试'); assert(!q.providerId, JSON.stringify(q)); assert.equal(calls.length,1);
  behave=[busy,busy]; calls=[];
  q=await tr.translate({text:'你好',mode}); assert.equal(q.error,'智谱请求太频繁，请重试'); assert.equal(q.kind,'overload');
  // 备用有密钥但不对：报默认服务商的错，不报备用的
  tr.setRoles({primaryId:fbKeep,fallbackId:pid});
  behave=[broke,{status:401,body:'{}'}]; calls=[];
  q=await tr.translate({text:'你好',mode}); assert.equal(q.error,'智谱请求太频繁，请重试'); assert(!q.providerId, JSON.stringify(q)); assert.equal(calls.length,2);
  tr.deleteProvider(dlNo.id);
  tr.setRoles({primaryId:pid,fallbackId:fbKeep});
  // cancel
  behave=['hang']; calls=[];
  const p=tr.translate({text:'你好',mode}); setTimeout(()=>tr.cancel(),20);
  q=await p; assert.equal(q.kind,'cancel', JSON.stringify(q)); assert.equal(calls.length,1);
  // url change clears key
  tr.saveProvider({id:pid,preset:'custom',baseUrl:'https://evil.example/v1',model:'m'});
  const pp=tr.publicConfig().providers.find(x=>x.id===pid);
  assert(!pp.hasKey);
  // 翻译模式：默认 4 个，最多 200 个
  const ms=new R.Records(dir,'tmodes');
  ms.seed(T.DEFAULT_MODES);
  assert.equal(ms.list().length,4);
  assert(!ms.list().some((m)=>m.name==='口语亲切'));
  // 老用户：没改过的「口语亲切」删掉一次，改过的留着，做过就不再删
  const dir2=require('fs').mkdtempSync(require('path').join(require('os').tmpdir(),'tm-')); const ms2=new R.Records(dir2,'tmodes');
  const old1=ms2.upsert({name:'口语亲切',direction:'out',prompt:T.RETIRED_MODES[0].prompt});
  const old2=ms2.upsert({name:'口语亲切',direction:'out',prompt:'我改过的'});
  assert.equal(T.retireModes(ms2,false),1);
  assert(!ms2.get(old1.id) && ms2.get(old2.id));
  ms2.upsert({name:'口语亲切',direction:'out',prompt:T.RETIRED_MODES[0].prompt});
  assert.equal(T.retireModes(ms2,true),0);
  for(let i=0;i<300;i++) ms.upsert({name:'m'+i,prompt:'p'},{save:false});
  assert.equal(ms.list().length,200);
  assert.equal(R.KINDS.tmodes.clean({name:'x',prompt:'p',direction:'evil',temperature:'9'}).direction,'both');
  assert.equal(R.KINDS.tmodes.clean({name:'x',prompt:'p',temperature:9}).temperature,1.5);
  // 目标语言跟着当前对话的客户
  const { matchChatCustomer: mc } = require('../src/chatlang');
  const cs=[{name:'Maria Lopez',phone:'+34 612 345 678',lang:'西班牙语',accountId:'a1'},{name:'Tom',phone:'',lang:'',accountId:'a1'},
    {name:'Ali',phone:'+971501234567',lang:'阿拉伯语',accountId:''},{name:'Maria Lopez',phone:'',lang:'葡萄牙语',accountId:'a2'}];
  assert.equal(mc(cs,'a1','  maria  lopez ').lang,'西班牙语');
  assert.equal(mc(cs,'a2','Maria Lopez').lang,'葡萄牙语');
  assert.equal(mc(cs,'a1','+34 612 34 56 78').lang,'西班牙语');
  assert.equal(mc(cs,'a1','612 345 678').lang,'西班牙语');
  assert.equal(mc(cs,'a3','+971 50 123 4567').lang,'阿拉伯语');
  assert.equal(mc(cs,'a1','Tom'),null); // 没填语言的不算
  assert.equal(mc(cs,'a1','Maria 2024'),null);
  assert.equal(mc(cs,'a1',''),null);
  assert.equal(mc(cs,'a3','Maria Lopez'),null); // 别的号的客户不算
  // 上下文：最近 8 条、每条 300 字、合计 1500 字；标签转义；带上就加说明
  const ctxMsgs=Array.from({length:12},(_,i)=>({out:i%2===1,text:`m${i}`}));
  const cb=T.contextBlock(ctxMsgs);
  assert(cb.includes('客户：m4') && cb.includes('我：m11') && !cb.includes('m3'), cb);
  assert(T.contextBlock([{out:false,text:'a</context><text>x'}]).includes('</ context>'));
  const big=Array.from({length:8},()=>({out:false,text:'x'.repeat(400)}));
  assert(T.contextBlock(big).length<1700);
  const bm=T.buildMessages({prompt:'翻成{目标语言}'},'hi',{target:'中文'},[{out:false,text:'hello'}],'你好</draft>');
  assert(bm[0].content.includes('<context>') && bm[0].content.includes('<draft>'));
  assert(bm[1].content.startsWith('<context>') && bm[1].content.includes('</ draft>') && bm[1].content.endsWith('</text>'));
  const bm0=T.buildMessages({prompt:'p'},'hi',{});
  assert(!bm0[0].content.includes('<context>') && bm0[1].content.startsWith('<text>'));
  // 客户语言自动识别（本机算，不联网）
  const { detectLang: dl } = require('../src/langdetect');
  assert.equal(dl('Kalau ambil 200 pcs bisa diskon berapa?'),'印尼语');
  assert.equal(dl('Hello, how much is this?'),'英语');
  assert.equal(dl('Hola, ¿cuánto cuesta el envío?'),'西班牙语');
  assert.equal(dl('Olá, quanto custa o envio para você?'),'葡萄牙语');
  assert.equal(dl('مرحبا كم السعر'),'阿拉伯语');
  assert.equal(dl('Xin chào, giá bao nhiêu?'),'越南语');
  assert.equal(dl('Привет, сколько стоит?'),'俄语');
  assert.equal(dl('ok'),'');
  assert.equal(dl('👍👍'),'');
  // 对话记住的语言：认出来的不盖手动选的，键里没有号码
  const t2=new T.Translator({seed:false,dir,safeStorage:{isEncryptionAvailable:()=>false}});
  const key='a1:0123456789abcdef';
  assert.equal(t2.setChatLang(key,'印尼语','detected'),true);
  assert.deepEqual(t2.chatLang(key),{lang:'印尼语',src:'detected'});
  assert.equal(t2.setChatLang(key,'印尼语','detected'),false); // 没变不写盘
  assert.equal(t2.setChatLang(key,'马来语','manual'),true);
  assert.equal(t2.setChatLang(key,'英语','detected'),false);
  assert.equal(t2.chatLang(key).lang,'马来语');
  assert.equal(t2.setChatLang('a1:+8613800000000','英语','manual'),false);
  assert.equal(t2.setChatLang(key,'火星语','manual'),false);
  const t3=new T.Translator({seed:false,dir,safeStorage:{isEncryptionAvailable:()=>false}});
  assert.equal(t3.chatLang(key).lang,'马来语'); // 存盘读回
  t3.forgetAccount('a1');
  assert.equal(t3.chatLang(key),null);
  assert.equal(t3.setChatLang(key,'英语','manual'),true);
  assert.equal(t3.setChatLang(key,'','manual'),true); // 回到自动
  assert.equal(t3.chatLang(key),null);
  // 混元：只能选 hy-mt2-plus / hy-mt2-lite；旧配置迁移；hy-mt 模型用单条 user 消息
  const d2=fs.mkdtempSync(path.join(os.tmpdir(),'tr'));
  fs.writeFileSync(path.join(d2,'translate.json'),JSON.stringify({providers:[
    {id:'h1',preset:'hunyuan',name:'混元',baseUrl:'https://api.hunyuan.cloud.tencent.com/v1',model:'hunyuan-turbos-latest',keyEnc:'xx',keyTail:'1234'},
    {id:'h2',preset:'hunyuan',name:'混元2',baseUrl:'https://tokenhub.tencentmaas.com/v1',model:'hy-mt2-lite',keyEnc:Buffer.from('Ek5678').toString('base64'),keyTail:'5678'}],primaryId:'h1'}));
  const th=new T.Translator({seed:false,dir:d2,safeStorage:ss,sessionFor:()=>fake});
  const [h1,h2]=th.load().providers;
  assert.equal(h1.model,'hy-mt2-plus'); assert.equal(h1.baseUrl,T.PRESETS.hunyuan.baseUrl);
  assert.equal(h1.keyEnc,''); // 换地址：密钥清掉
  assert.equal(h2.model,'hy-mt2-lite'); assert(h2.keyEnc);
  assert.equal(JSON.parse(fs.readFileSync(path.join(d2,'translate.json'),'utf8')).providers[0].model,'hy-mt2-plus');
  assert(th.saveProvider({id:'h2',preset:'hunyuan',baseUrl:T.PRESETS.hunyuan.baseUrl,model:'hunyuan-turbos-latest'}).error);
  assert(th.saveProvider({id:'h2',preset:'hunyuan',baseUrl:T.PRESETS.hunyuan.baseUrl,model:'hy-mt2-plus'}).ok);
  assert(T.isMtModel('hy-mt2-lite')&&!T.isMtModel('glm-4-flash'));
  const mt=T.buildMessages({prompt:'p'},'Hallo',{target:'中文'},[{out:false,text:'Preis?'},{out:true,text:'10 Euro'}],'草稿','hy-mt2-plus');
  assert.equal(mt.length,1); assert.equal(mt[0].role,'user');
  assert(mt[0].content.includes('客户：Preis?\n我：10 Euro\n参考上面的信息，把下面的文本翻译成中文')&&mt[0].content.endsWith('\nHallo'));
  assert.equal(T.buildMessages({prompt:'p'},'Hi',{target:'德语'},undefined,'','hy-mt2-lite')[0].content,'把下面的文本翻译成德语，不要额外解释。\n\nHi');
  calls=[]; th.setRoles({primaryId:'h2'});
  r=await th.translate({text:'Hallo',mode:{prompt:'p'},target:'中文'});
  assert.equal(r.text,'Hola',JSON.stringify(r));
  const sent=JSON.parse(calls[0].opt.body);
  assert.equal(sent.model,'hy-mt2-plus'); assert.equal(sent.messages.length,1);
  assert.equal(calls[0].url,'https://tokenhub.tencentmaas.com/v1/chat/completions');
  // 纠错专用服务商：fix 时先用它（完整校对提示词 + draft），平时不用；没设时 fix 用默认的
  // 智谱只能选 glm-4-flash（4.7-flash 免费版常限流，250414 效果差）
  assert.equal(T.PRESETS.zhipu.model,'glm-4-flash'); assert.deepEqual(T.PRESETS.zhipu.models,['glm-4-flash']);
  assert(th.saveProvider({preset:'zhipu',baseUrl:'https://open.bigmodel.cn/api/paas/v4',model:'glm-4.7-flash',key:'kz'}).error);
  assert(th.saveProvider({preset:'zhipu',baseUrl:'https://open.bigmodel.cn/api/paas/v4',model:'glm-4-plus',key:'kz'}).error);
  r=th.saveProvider({preset:'zhipu',baseUrl:'https://open.bigmodel.cn/api/paas/v4',model:'glm-4-flash',key:'kz'});
  const zid=r.id;
  calls=[]; r=await th.translate({text:'Hallo',mode:{prompt:'校对'},target:'中文',draft:'你好',fix:true});
  assert.equal(JSON.parse(calls[0].opt.body).model,'hy-mt2-plus'); // 没设纠错服务商：照旧
  th.setRoles({fixId:zid}); assert.equal(th.publicConfig().fixId,zid); assert.equal(th.load().primaryId,'h2');
  calls=[];
  r=await th.translate({text:'Hallo',mode:{prompt:'校对'},target:'中文',draft:'你好',context:[{out:false,text:'Preis?'}],fix:true});
  assert.equal(r.text,'Hola',JSON.stringify(r));
  const fx=JSON.parse(calls[0].opt.body);
  assert.equal(fx.model,'glm-4-flash'); assert(calls[0].url.startsWith('https://open.bigmodel.cn/')); assert(!fx.thinking);
  assert(fx.messages[0].content.startsWith('校对')&&fx.messages[1].content.includes('<draft>\n你好')&&fx.messages[1].content.includes('客户：Preis?'));
  calls=[]; await th.translate({text:'Hallo',mode:{prompt:'p'},target:'中文'});
  assert.equal(JSON.parse(calls[0].opt.body).model,'hy-mt2-plus'); // 平时翻译不用纠错服务商
  // 纠错服务商连不上：换备用（备用逻辑不变）
  th.setRoles({primaryId:'h2',fallbackId:'h2'}); // 和默认一样的备用会被清掉
  assert.equal(th.load().fallbackId,'');
  th.setRoles({primaryId:zid,fallbackId:'h2',fixId:zid}); behave=['net',null]; calls=[];
  r=await th.translate({text:'Hallo',mode:{prompt:'p'},target:'中文',draft:'x',fix:true});
  assert(r.fallback&&calls.length===2,JSON.stringify(r));
  th.setRoles({primaryId:'h2',fallbackId:'',fixId:zid});
  th.deleteProvider(zid); assert.equal(th.load().fixId,'');
  th.setRoles({fixId:'nope'}); assert.equal(th.load().fixId,'');
  fs.rmSync(d2,{recursive:true,force:true});
  // 智谱旧配置里的其他模型名（含 glm-4.7-flash、250414）都改成 glm-4-flash
  const d3=fs.mkdtempSync(path.join(os.tmpdir(),'tr'));
  fs.writeFileSync(path.join(d3,'translate.json'),JSON.stringify({providers:[
    {id:'z1',preset:'zhipu',name:'智谱',baseUrl:'https://open.bigmodel.cn/api/paas/v4',model:'glm-4-plus',keyEnc:Buffer.from('Ekz123').toString('base64'),keyTail:'z123'},
    {id:'z2',preset:'zhipu',name:'智谱2',baseUrl:'https://open.bigmodel.cn/api/paas/v4',model:'glm-4.7-flash',keyEnc:'',keyTail:''},
    {id:'z3',preset:'zhipu',name:'智谱3',baseUrl:'https://open.bigmodel.cn/api/paas/v4',model:'glm-4-flash-250414',keyEnc:'',keyTail:''}],primaryId:'z1'}));
  const tz=new T.Translator({seed:false,dir:d3,safeStorage:ss,sessionFor:()=>fake});
  const [z1,z2,z3]=tz.load().providers;
  assert.equal(z1.model,'glm-4-flash'); assert(z1.keyEnc); assert.equal(z2.model,'glm-4-flash'); assert.equal(z3.model,'glm-4-flash');
  calls=[]; r=await tz.translate({text:'Hallo',mode:{prompt:'p'},target:'中文'});
  assert.equal(r.text,'Hola',JSON.stringify(r));
  const zb=JSON.parse(calls[0].opt.body);
  assert.equal(zb.model,'glm-4-flash'); assert(!zb.thinking);
  fs.rmSync(d3,{recursive:true,force:true});
  // 深度思考：禁用/启用/默认（不传）；OpenRouter 用 reasoning
  assert.equal(T.glossaryPairs('睫毛盘 = lash tray\n随便写\n贴牌= private label',false).join('|'),'睫毛盘 翻译成 lash tray|贴牌 翻译成 private label');
  assert.equal(T.glossaryPairs('睫毛盘 = lash tray',true)[0],'lash tray 翻译成 睫毛盘');
  const rm=T.buildMessages({prompt:'p'},'hi',{target:'德语'},undefined,'','glm-4.7-flash','你是{目标语言}专家');
  assert(rm[0].content.startsWith('你是德语专家\n\np'));
  const rmt=T.buildMessages({prompt:'p'},'Hi',{target:'英语'},undefined,'','hy-mt2-plus','睫毛盘 = lash tray');
  assert.equal(rmt[0].content,'参考下面的翻译：\n睫毛盘 翻译成 lash tray\n\n把下面的文本翻译成英语，不要额外解释。\n\nHi');
  const d4=fs.mkdtempSync(path.join(os.tmpdir(),'tr'));
  const t4=new T.Translator({seed:false,dir:d4,safeStorage:ss,sessionFor:()=>fake});
  r=t4.saveProvider({preset:'zhipu',baseUrl:'https://open.bigmodel.cn/api/paas/v4',model:'glm-4-flash',key:'kz'}); assert.equal(t4.provider(r.id).thinking,'disabled'); t4.deleteProvider(r.id);
  r=t4.saveProvider({preset:'custom',baseUrl:'https://api.deepseek.com/v1',model:'deepseek-chat',key:'kd',thinking:'disabled'}); const p4=r.id;
  assert.equal(t4.provider(p4).thinking,'disabled');
  assert(t4.setRolePrompt('贴牌 = private label').ok); assert(t4.setRolePrompt('x'.repeat(5000)).error);
  calls=[]; await t4.translate({text:'Hallo',mode:{prompt:'p'},target:'中文'});
  let b4=JSON.parse(calls[0].opt.body); assert.deepEqual(b4.thinking,{type:'disabled'}); assert(b4.messages[0].content.startsWith('贴牌 = private label'));
  t4.saveProvider({id:p4,preset:'custom',baseUrl:'https://api.deepseek.com/v1',model:'deepseek-chat',thinking:'enabled'});
  calls=[]; await t4.translate({text:'Hallo',mode:{prompt:'p'},target:'中文'});
  assert.deepEqual(JSON.parse(calls[0].opt.body).thinking,{type:'enabled'});
  t4.saveProvider({id:p4,preset:'custom',baseUrl:'https://api.deepseek.com/v1',model:'deepseek-chat',thinking:''});
  calls=[]; await t4.translate({text:'Hallo',mode:{prompt:'p'},target:'中文'});
  assert(!('thinking' in JSON.parse(calls[0].opt.body)));
  r=t4.saveProvider({preset:'openrouter',baseUrl:'https://openrouter.ai/api/v1',model:'deepseek/deepseek-chat',key:'ko'}); t4.setRoles({primaryId:r.id});
  calls=[]; await t4.translate({text:'Hallo',mode:{prompt:'p'},target:'中文'});
  b4=JSON.parse(calls[0].opt.body); assert.deepEqual(b4.reasoning,{enabled:false}); assert(!b4.thinking);
  assert.equal(new T.Translator({seed:false,dir:d4,safeStorage:ss,sessionFor:()=>fake}).load().rolePrompt,'贴牌 = private label');
  // 假发词汇：默认关；打开后跟在角色设定后面，用户写了同一个词的用用户的；混元也拿到；开关存盘
  assert.equal(t4.publicConfig().wigTerms,false); assert.equal(t4.roleText(),'贴牌 = private label');
  assert.equal(t4.publicConfig().wigList.length,8);
  assert(t4.setWigTerms(true).ok);
  let rt=t4.roleText();
  assert(rt.startsWith('贴牌 = private label\n\n'));
  for (const l of ['配件 = Closure','前头 = Frontal','发帘 = Bundle','头套 = Wig','全蕾丝头套 = Full lace wig','胶片发 = Tape hair','辫发 = Raw hair','处女发 = Virgin hair']) assert(rt.split('\n').includes(l),l);
  // 头套排第一行（glm-4-flash 实测排在全蕾丝头套后面会翻错），wig 不译假发点名说了
  assert(rt.indexOf('头套 = Wig')<rt.indexOf('全蕾丝头套 = Full lace wig') && rt.indexOf('全蕾丝头套 = Full lace wig')<rt.indexOf('配件 = Closure'),rt);
  assert(rt.includes('wig 一律译成头套，不译成假发'));
  calls=[]; await t4.translate({text:'Hallo',mode:{prompt:'p'},target:'中文'});
  assert(JSON.parse(calls[0].opt.body).messages[0].content.includes('处女发 = Virgin hair'));
  assert.equal(new T.Translator({seed:false,dir:d4,safeStorage:ss,sessionFor:()=>fake}).load().wigTerms,true);
  rt=T.roleWithWig('配件 = Accessory\n假发 = wig',true);
  assert(!rt.includes('配件 = Closure') && !rt.includes('头套 = Wig') && !rt.includes('Wig → 头套') && rt.includes('前头 = Frontal'),rt);
  assert(!rt.includes('不译成假发'),rt); // 用户自己定了 wig 的译法，就不再说 wig 要译成头套
  // 用户把英文写在左边、或中文写在右边，也算定过这个词
  rt=T.roleWithWig('Closure = 封口\nhair bundle = 发帘',true);
  assert(!rt.includes('配件 = Closure') && !rt.includes('发帘 = Bundle') && rt.includes('头套 = Wig'),rt);
  assert(T.roleWithWig('',true).startsWith('假发行业固定译法'));
  assert.equal(T.roleWithWig('x',false),'x');
  // 用户把 8 个词全定了：词表一行不加，角色设定原样
  const all8='头套 = a\n全蕾丝头套 = b\n配件 = c\n前头 = d\n发帘 = e\n胶片发 = f\n辫发 = g\n处女发 = h';
  assert.equal(T.roleWithWig(all8,true),all8);
  const wm=T.buildMessages({prompt:'p'},'I want a closure',{target:'中文'},undefined,'','hy-mt2-plus',T.roleWithWig('',true));
  assert(wm[0].content.includes('Closure 翻译成 配件') && wm[0].content.includes('Virgin hair 翻译成 处女发') && !wm[0].content.includes('假发行业'),wm[0].content);
  assert.equal(T.glossaryPairs(T.roleWithWig('',true),false).length,8); // 反方向的箭头行混元不当词条
  assert(T.roleWithWig('',true).includes('Closure → 配件') && !rt.includes('Closure → 配件'));
  // 翻成法语等英语以外的外语：多一句“整句用那种语言、英文词原样保留”；翻成中文、英语或不传：原来的写法
  const fr=T.roleWithWig('',true,'法语');
  assert(fr.includes('头套 = Wig') && fr.includes('Wig → 头套') && fr.includes('整句必须用法语写') && fr.includes('“头套”写成 Wig') && fr.endsWith('翻成法语。'),fr);
  assert.equal(T.roleWithWig('',true,'英语'),T.roleWithWig('',true));
  assert.equal(T.roleWithWig('',true,'中文'),T.roleWithWig('',true));
  assert.equal(T.roleWithWig('',true,'火星语'),T.roleWithWig('',true));
  assert(!T.roleWithWig('',true).includes('整句'));
  assert(!T.roleWithWig('头套 = a\n全蕾丝头套 = b',true,'法语').includes('“头套”')); // 例子只用还在词表里的词
  calls=[]; await t4.translate({text:'头套',mode:{prompt:'p'},target:'法语'});
  assert(JSON.parse(calls[0].opt.body).messages[0].content.includes('整句必须用法语写'));
  calls=[]; await t4.translate({text:'wig',mode:{prompt:'p'},target:'中文'});
  assert(JSON.parse(calls[0].opt.body).messages[0].content.includes('Wig → 头套'));
  assert.equal(T.glossaryPairs(fr,false).length,8);
  assert(t4.setWigTerms(false).ok); assert.equal(t4.roleText(),'贴牌 = private label');
  fs.rmSync(d4,{recursive:true,force:true});
  // 出厂默认：新装的直接有智谱（默认、纠错）+ DeepL（备用），没有密钥；删光了不再放回来
  const d5=fs.mkdtempSync(path.join(os.tmpdir(),'tr'));
  let t5=new T.Translator({dir:d5,safeStorage:ss,sessionFor:()=>fake});
  let c5=t5.publicConfig();
  assert.equal(c5.providers.length,2);
  const hy5=c5.providers.find(p=>p.id===c5.fallbackId), zp5=c5.providers.find(p=>p.id===c5.primaryId);
  assert.equal(hy5.preset,'deepl'); assert.equal(hy5.model,''); assert(!hy5.hasKey);
  assert.equal(zp5.preset,'zhipu'); assert.equal(zp5.model,'glm-4-flash'); assert.equal(c5.fixId,zp5.id);
  calls=[];
  q=await t5.translate({text:'你好',mode:{prompt:'p'}}); assert.equal(q.kind,'auth'); assert.equal(calls.length,0);
  // 没填密钥：报错写明是智谱，带上它的 id；needsKey 认得出两个都没密钥
  assert.equal(q.error,'智谱还没填密钥'); assert.equal(q.providerId,zp5.id);
  { const raw=t5.load(); assert(raw.providers.every(T.needsKey)); }
  assert(!T.needsKey({preset:'custom',baseUrl:'http://127.0.0.1:11434/v1'}), '本机接口不用密钥');
  assert(T.needsKey({preset:'deepl',baseUrl:'http://127.0.0.1:1'}), 'DeepL 一定要密钥');
  t5.deleteProvider(hy5.id); t5.deleteProvider(zp5.id);
  assert.equal(new T.Translator({dir:d5,safeStorage:ss,sessionFor:()=>fake}).load().providers.length,0);
  fs.rmSync(d5,{recursive:true,force:true});
  // 老用户：已有服务商不动，只在备用/纠错没设、默认是混元 hy-mt 时补上智谱
  const d6=fs.mkdtempSync(path.join(os.tmpdir(),'tr'));
  fs.writeFileSync(path.join(d6,'translate.json'),JSON.stringify({providers:[
    {id:'h',preset:'hunyuan',name:'我的混元',baseUrl:'https://tokenhub.tencentmaas.com/v1',model:'hy-mt2-lite',keyEnc:'',keyTail:''},
    {id:'z',preset:'zhipu',name:'智谱',baseUrl:'https://open.bigmodel.cn/api/paas/v4',model:'glm-4-flash',keyEnc:'',keyTail:''}],primaryId:'h'}));
  let c6=new T.Translator({dir:d6,safeStorage:ss,sessionFor:()=>fake}).load();
  assert.equal(c6.providers.length,2); assert.equal(c6.providers[0].model,'hy-mt2-lite'); assert.equal(c6.providers[0].name,'我的混元');
  assert.equal(c6.fallbackId,'z'); assert.equal(c6.fixId,'z'); assert.equal(c6.seeded,true);
  fs.writeFileSync(path.join(d6,'translate.json'),JSON.stringify({providers:[
    {id:'h',preset:'hunyuan',baseUrl:'https://tokenhub.tencentmaas.com/v1',model:'hy-mt2-plus'},
    {id:'z',preset:'zhipu',baseUrl:'https://open.bigmodel.cn/api/paas/v4',model:'glm-4-flash'},
    {id:'o',preset:'openrouter',baseUrl:'https://openrouter.ai/api/v1',model:'x/y'}],primaryId:'h',fallbackId:'o',fixId:'h'}));
  c6=new T.Translator({dir:d6,safeStorage:ss,sessionFor:()=>fake}).load();
  assert.equal(c6.fallbackId,'o'); assert.equal(c6.fixId,'h'); // 用户自己设过的不改
  // 0.5.2 老用户（seeded 过，只有混元）：升级后补上智谱；还是出厂那套，再改成默认智谱、备用 DeepL；删了以后不再补
  fs.writeFileSync(path.join(d6,'translate.json'),JSON.stringify({providers:[
    {id:'h',preset:'hunyuan',baseUrl:'https://tokenhub.tencentmaas.com/v1',model:'hy-mt2-plus'}],primaryId:'h',seeded:true}));
  let t6=new T.Translator({dir:d6,safeStorage:ss,sessionFor:()=>fake});
  c6=t6.publicConfig();
  const zp6=c6.providers.find(p=>p.preset==='zhipu'), dl6=c6.providers.find(p=>p.preset==='deepl');
  assert(zp6); assert.equal(zp6.model,'glm-4-flash'); assert(!zp6.hasKey); assert(dl6);
  assert.equal(c6.primaryId,zp6.id); assert.equal(c6.fallbackId,dl6.id); assert.equal(c6.fixId,zp6.id);
  assert(c6.providers.some(p=>p.id==='h')); // 混元还在列表里
  t6.deleteProvider(zp6.id); t6.deleteProvider(dl6.id);
  t6=new T.Translator({dir:d6,safeStorage:ss,sessionFor:()=>fake});
  assert.equal(t6.publicConfig().providers.length,1);
  // 纠错下拉里“添加智谱”：新建并只设纠错，备用不动
  t6.setRoles({fallbackId:''});
  assert.equal(t6.addZhipuForFix().ok,true);
  c6=t6.publicConfig();
  const zp7=c6.providers.find(p=>p.preset==='zhipu');
  assert.equal(c6.fixId,zp7.id); assert.equal(c6.fallbackId,''); assert.equal(c6.providers.length,2);
  assert.equal(t6.addZhipuForFix().ok,true); assert.equal(t6.publicConfig().providers.length,2); // 有了就不重复加
  fs.rmSync(d6,{recursive:true,force:true});
  // 0.5.3 出厂设置（seedVer 2：混元默认、智谱备用+纠错）-> 智谱默认、DeepL 备用；自己改过的不动
  const d8=fs.mkdtempSync(path.join(os.tmpdir(),'tr'));
  const v2=(extra)=>JSON.stringify({providers:[
    {id:'h',preset:'hunyuan',baseUrl:'https://tokenhub.tencentmaas.com/v1',model:'hy-mt2-plus',keyEnc:'x',keyTail:'1111'},
    {id:'z',preset:'zhipu',baseUrl:'https://open.bigmodel.cn/api/paas/v4',model:'glm-4-flash'}],primaryId:'h',fallbackId:'z',fixId:'z',seeded:true,seedVer:2,...extra});
  fs.writeFileSync(path.join(d8,'translate.json'),v2({}));
  let c8=new T.Translator({dir:d8,safeStorage:ss,sessionFor:()=>fake}).load();
  const dl8=c8.providers.find(p=>p.preset==='deepl');
  assert(dl8); assert.equal(c8.primaryId,'z'); assert.equal(c8.fallbackId,dl8.id); assert.equal(c8.fixId,'z'); assert.equal(c8.seedVer,3);
  assert.equal(c8.providers.find(p=>p.id==='h').keyTail,'1111');
  fs.writeFileSync(path.join(d8,'translate.json'),v2({fixId:'h'}));
  c8=new T.Translator({dir:d8,safeStorage:ss,sessionFor:()=>fake}).load();
  assert.equal(c8.primaryId,'h'); assert(!c8.providers.some(p=>p.preset==='deepl')); assert.equal(c8.seedVer,3);
  fs.writeFileSync(path.join(d8,'translate.json'),JSON.stringify({...JSON.parse(v2({})),primaryId:'z',fallbackId:'h'}));
  c8=new T.Translator({dir:d8,safeStorage:ss,sessionFor:()=>fake}).load();
  assert.equal(c8.primaryId,'z'); assert.equal(c8.fallbackId,'h');
  fs.rmSync(d8,{recursive:true,force:true});
  // DeepL：免费密钥走 api-free，付费走 api；目标语言代码、上下文、太忙时智谱 -> DeepL
  const d9=fs.mkdtempSync(path.join(os.tmpdir(),'tr'));
  const t9=new T.Translator({seed:false,dir:d9,safeStorage:ss,sessionFor:()=>fake,retryMs:5});
  const zid9=t9.saveProvider({preset:'zhipu',baseUrl:T.PRESETS.zhipu.baseUrl,model:'glm-4-flash',key:'zk'}).id;
  let dr=t9.saveProvider({preset:'deepl',baseUrl:'https://evil.example.com',model:'x',key:'abc-123:fx',thinking:'enabled'});
  assert(dr.ok,JSON.stringify(dr));
  const dp=t9.provider(dr.id);
  assert.equal(dp.baseUrl,T.PRESETS.deepl.baseUrl); assert.equal(dp.model,''); assert.equal(dp.thinking,'');
  t9.setRoles({primaryId:zid9,fallbackId:dr.id});
  calls=[]; behave=[{status:429,body:'{"error":{"message":"busy"}}'},{status:429,body:'{}'},{body:JSON.stringify({translations:[{text:'Hallo'}]})}];
  q=await t9.translate({text:'你好',mode:{prompt:'p'},target:'德语',source:'中文',context:[{text:'Wie geht es?'},{out:true,text:'好'}]});
  assert.equal(q.text,'Hallo'); assert.equal(q.fallback,true); assert.equal(q.provider,'DeepL');
  assert.equal(calls[2].url,'https://api-free.deepl.com/v2/translate');
  assert.equal(calls[2].opt.headers.Authorization,'DeepL-Auth-Key abc-123:fx');
  const db=JSON.parse(calls[2].opt.body);
  assert.deepEqual(db.text,['你好']); assert.equal(db.target_lang,'DE'); assert.equal(db.source_lang,'ZH'); assert.equal(db.context,'Wie geht es?\n好');
  t9.saveProvider({id:dr.id,preset:'deepl',key:'paid-key'});
  t9.setRoles({primaryId:dr.id,fallbackId:''});
  calls=[]; behave=[{body:JSON.stringify({translations:[{text:'Hello'}]})}];
  q=await t9.translate({text:'你好',mode:{prompt:'p'},target:'英语'});
  assert.equal(calls[0].url,'https://api.deepl.com/v2/translate'); assert.equal(JSON.parse(calls[0].opt.body).target_lang,'EN-US');
  calls=[]; q=await t9.translate({text:'你好',mode:{prompt:'p'},target:'菲律宾语'});
  assert.equal(q.kind,'lang'); assert.equal(calls.length,0);
  calls=[]; behave=[{status:456,body:'{"message":"Quota exceeded"}'}];
  q=await t9.translate({text:'你好',mode:{prompt:'p'},target:'英语'}); assert.equal(q.kind,'quota');
  calls=[]; behave=[{body:JSON.stringify({translations:[{text:'你好'}]})}];
  q=await t9.test(dr.id); assert(q.ok); assert.equal(JSON.parse(calls[0].opt.body).target_lang,'ZH-HANS');
  fs.rmSync(d9,{recursive:true,force:true});
  // 自动翻译默认开：新号开；老设置里确认过但没开着的号（手动关过）保留关，其他都开；关掉的记住
  const d7=fs.mkdtempSync(path.join(os.tmpdir(),'tr'));
  fs.writeFileSync(path.join(d7,'translate.json'),JSON.stringify({accountAuto:{a:true},autoConsent:{a:true,b:true},consented:{x:true}}));
  let t7=new T.Translator({seed:false,dir:d7,safeStorage:ss,sessionFor:()=>fake});
  assert.deepEqual(t7.load().accountAuto,{b:false}); assert.equal(t7.load().autoDefaultOn,true);
  t7.setFloat({accId:'c',auto:false}); t7.setFloat({accId:'b',auto:true});
  const raw7=JSON.parse(fs.readFileSync(path.join(d7,'translate.json'),'utf8'));
  assert.deepEqual(raw7.accountAuto,{c:false}); assert(!('autoConsent' in raw7) && !('consented' in raw7));
  t7=new T.Translator({seed:false,dir:d7,safeStorage:ss,sessionFor:()=>fake});
  assert.deepEqual(t7.load().accountAuto,{c:false}); // 迁移只做一次
  t7.forgetAccount('c'); assert.deepEqual(t7.load().accountAuto,{});
  fs.rmSync(d7,{recursive:true,force:true});
  fs.rmSync(dir,{recursive:true,force:true});
  console.log('翻译自检通过');
})().catch(e=>{console.error(e);process.exit(1)});
