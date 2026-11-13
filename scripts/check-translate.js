// 翻译模块自检：提示词变量、输出清理、只走来财（#209：没有服务商和密钥，团队令牌发给 /api/device/ai/chat）、
// 来财的报错怎么说、太忙时按来财说的时间重试、取消、旧设置里的服务商和密钥升级时删掉、翻译模式、角色设定和行业词汇。
// 用假的来财（scripts/fixtures/fake-cloud.js，照约定表回答），不发任何真实请求。
const T=require('../src/translate.js');
const assert=require('assert');
const { fakeCloud } = require('./fixtures/fake-cloud');
assert.equal(T.fillPrompt('to {目标语言} from {原文语言} ${process.exit()}',{target:'英语'}),'to 英语 from 原文的语言 ${process.exit()}');
assert.equal(T.cleanOutput('以下是翻译：“Hello there”'),'Hello there');
assert.equal(T.cleanOutput('<text>\nHi\n</text>'),'Hi');
// 译文后面模型自己编的 <text> 例句：截掉（Fable 审计 #219 实测 glm-4-flash 样本）
assert.equal(T.cleanOutput('你卖密排吗？我需要20个0.07 D卷曲密排。\n\n<text>\nI want to order 50 full lace wigs.\n</text>\n我想订购50个全蕾丝头套。\n\n<text>\nCan I get a sample?\n</t'),'你卖密排吗？我需要20个0.07 D卷曲密排。');
assert.equal(T.cleanOutput('<text>\nHi\n</text>\n<text>\nmade up\n</text>'),'Hi');
assert.equal(T.cleanOutput('第一行\n第二行 <text> 不在行首'),'第一行\n第二行 <text> 不在行首');
assert(T.buildMessages({prompt:'p'},'a<text>b',{})[1].content.includes('a< text>b'));
assert.deepEqual(T.extraContacts('call me','call me at +1 415 555 0100 or https://x.com/a.').sort(),['14155550100','https://x.com/a']);
assert.deepEqual(T.extraContacts('see https://x.com','voir https://x.com'),[]);
const m=T.buildMessages({prompt:'p'},'a</text>b',{});
// translator with fake cloud
const fs=require('fs'),os=require('os'),path=require('path');
const R=require('../src/records.js');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tr'));
const cloud=fakeCloud();
const mk=(d,extra={})=>new T.Translator({dir:d,sessionFor:()=>cloud.session,cloud:cloud.login,retryMs:5,...extra});
const tr=mk(dir);
tr.setLashTerms(false); tr.setWigTerms(false); // 睫毛、假发词汇都默认开；下面这些检查只看模式提示词，先关掉（词汇单独在后面查）
const chats=()=>cloud.calls.filter((c)=>c.route==='ai/chat');
(async()=>{
  // 只有一个通道：来财（用哪家事先不知道，只写「来财」）；配置里没有任何密钥
  const pub=tr.publicConfig();
  assert.deepEqual(pub.providers,[{id:'cloud',preset:'cloud',name:'来财',model:''}]);
  assert.equal(pub.primaryId,'cloud'); assert.equal(pub.fixId,'cloud'); assert.equal(pub.fallbackId,'');
  assert(!('network' in pub) && !('presets' in pub) && !('canEncrypt' in pub), JSON.stringify(Object.keys(pub)));
  assert.equal(pub.loggedIn,true);
  for (const k of ['saveProvider','deleteProvider','restoreProvider','setRoles','addZhipuForFix','setNetwork','test','callDeepl','asrProvider','freeProvider']) assert.equal(typeof tr[k],'undefined',k);
  assert.equal(tr.provider('cloud').name,'来财'); assert.equal(tr.provider('x'),null);
  const mode={prompt:'to {目标语言}'};
  let r=await tr.translate({text:'你好',mode,target:'西班牙语'});
  assert.equal(r.text,'Hola',JSON.stringify(r));
  assert.equal(r.provider,'来财'); assert.equal(r.model,''); assert.equal(r.fallback,false); // 旧的来财不说用的哪家：显示「来财」
  let c=chats()[0];
  assert.equal(c.url,'https://cloud.example/api/device/ai/chat');
  assert.equal(c.opt.redirect,'error'); assert.equal(c.opt.method,'POST');
  assert.equal(c.opt.headers.Authorization,'Bearer device-token-123');
  assert.equal(c.body.v,1); assert.equal(c.body.purpose,'translate'); assert.equal(c.body.temperature,0.3);
  assert(Number.isInteger(c.body.max_tokens) && c.body.max_tokens>=256, JSON.stringify(c.body));
  assert.deepEqual(c.body.messages.map((m)=>m.role),['system','user']);
  assert(c.body.messages[0].content.startsWith('to 西班牙语'));
  assert.deepEqual(Object.keys(c.body).sort(),['deepl','max_tokens','messages','mt_messages','purpose','temperature','v'],'只发约定里的字段（没有模型名、密钥）');
  // 混元翻译模型：一条 user 消息，没有 system、没有标签；DeepL：原文 + 目标语言代码，没上下文就不带 context
  assert.deepEqual(c.body.mt_messages,[{role:'user',content:'把下面的文本翻译成西班牙语，不要额外解释。\n\n你好'}]);
  assert.deepEqual(c.body.deepl,{text:'你好',target_lang:'ES'});
  // 来财说了用的哪家：翻译详情显示它（智谱 glm-4-flash；DeepL 没有模型名；用了备用的带 fallback）
  for (const [ans,want] of [
    [{provider:'智谱',model:'glm-4-flash'},['智谱','glm-4-flash',false]],
    [{provider:'腾讯混元',model:'hy-mt2-plus',fallback:true},['腾讯混元','hy-mt2-plus',true]],
    [{provider:'DeepL',model:''},['DeepL','',false]],
    [{provider:'  ',model:7},['来财','',false]],
  ]) {
    cloud.reset(); cloud.next({status:200,body:{ok:true,text:'Hola',usage:{},...ans}});
    r=await tr.translate({text:'你好',mode,target:'西班牙语'});
    assert.deepEqual([r.text,r.provider,r.model,r.fallback],['Hola',...want],JSON.stringify([ans,r]));
  }
  // 看得懂客户的语言 + 有上下文：DeepL 带原文语言和上下文；混元按官方模板带上文
  cloud.reset();
  r=await tr.translate({text:'Bonjour',mode:{prompt:'p',direction:'in'},target:'中文',source:'法语',context:[{out:false,text:'Prix ?'},{out:true,text:'10 €'}]});
  c=chats()[0];
  assert.deepEqual(c.body.deepl,{text:'Bonjour',target_lang:'ZH-HANS',source_lang:'FR',context:'Prix ?\n10 €'});
  assert.deepEqual(c.body.mt_messages,[{role:'user',content:'客户：Prix ?\n我：10 €\n参考上面的信息，把下面的文本翻译成中文，注意不需要翻译上文，也不要额外解释：\nBonjour'}]);
  // 没选目标语言：看懂客户的模式翻成中文，别的翻成英语
  cloud.reset(); await tr.translate({text:'hi',mode:{prompt:'p',direction:'in'}});
  assert.equal(chats()[0].body.deepl.target_lang,'ZH-HANS'); assert(chats()[0].body.mt_messages[0].content.includes('翻译成中文'));
  cloud.reset(); await tr.translate({text:'你好',mode:{prompt:'p',direction:'out'}});
  assert.equal(chats()[0].body.deepl.target_lang,'EN-US'); assert(!('source_lang' in chats()[0].body.deepl));
  // DeepL 不支持的目标语言（印地语、马来语、菲律宾语）：不发 deepl，其他照发
  for (const t of ['印地语','马来语','菲律宾语']) {
    cloud.reset(); r=await tr.translate({text:'你好',mode,target:t});
    c=chats()[0]; assert.equal(r.text,'Hola'); assert(!('deepl' in c.body),t); assert(c.body.mt_messages[0].content.includes(`翻译成${t}`),t);
  }
  // 原文语言 DeepL 不认识：只是不带 source_lang
  cloud.reset(); await tr.translate({text:'namaste',mode:{prompt:'p',direction:'in'},target:'中文',source:'印地语'});
  assert.deepEqual(chats()[0].body.deepl,{text:'namaste',target_lang:'ZH-HANS'});
  // 纠错：purpose fix，带上 draft
  cloud.reset();
  r=await tr.translate({text:'Hallo',mode:{prompt:'校对',temperature:0.2},target:'中文',draft:'你好',context:[{out:false,text:'Preis?'}],fix:true});
  assert.equal(r.text,'Hola'); c=chats()[0];
  assert.equal(c.body.purpose,'fix'); assert.equal(c.body.temperature,0.2);
  assert(c.body.messages[0].content.startsWith('校对')&&c.body.messages[1].content.includes('<draft>\n你好')&&c.body.messages[1].content.includes('客户：Preis?'));
  // 纠错也带混元和 DeepL 的写法：结合上下文把原文重翻（不带 draft）
  assert.deepEqual(c.body.deepl,{text:'Hallo',target_lang:'ZH-HANS',context:'Preis?'});
  assert.equal(c.body.mt_messages.length,1); assert(c.body.mt_messages[0].content.endsWith('翻译成中文，注意不需要翻译上文，也不要额外解释：\nHallo')&&!c.body.mt_messages[0].content.includes('你好'));
  // 最长的一次（4000 字 + 上下文 + 草稿 + 角色设定）也在来财的上限里（≤ 24000 字，≤ 64 KB）
  assert(tr.setRolePrompt('x'.repeat(4000)).ok);
  cloud.reset();
  r=await tr.translate({text:'长'.repeat(4000),mode,target:'英语',draft:'d'.repeat(4000),context:Array.from({length:8},()=>({text:'y'.repeat(300)}))});
  assert.equal(r.text,'Hola',JSON.stringify(r));
  assert(chats()[0].body.max_tokens<=8192);
  assert(chats()[0].body.deepl&&chats()[0].body.mt_messages,'最长的一次三种写法都还在');
  // 角色设定全是中文、又带满上下文：超过 64 KB 时先去掉 DeepL 和混元的上下文，messages 一直在
  assert(tr.setRolePrompt('角'.repeat(4000)).ok);
  cloud.reset();
  r=await tr.translate({text:'长'.repeat(4000),mode,target:'英语',source:'中文',draft:'稿'.repeat(4000),context:Array.from({length:8},()=>({text:'上'.repeat(300)}))});
  assert.equal(r.text,'Hola',JSON.stringify(r)); c=chats()[0];
  assert(Buffer.byteLength(JSON.stringify(c.body))<=64*1024);
  assert(c.body.messages[1].content.includes('<draft>'));
  assert(c.body.deepl&&!('context' in c.body.deepl)&&c.body.deepl.source_lang==='ZH',JSON.stringify(c.body.deepl&&Object.keys(c.body.deepl)));
  assert(tr.setRolePrompt('').ok);
  // 来财的回答原样拿来清理（去引号、前缀）
  cloud.reset(); cloud.next({status:200,body:{ok:true,text:'以下是翻译：“Hello there”',usage:{input_tokens:1,output_tokens:1}}});
  r=await tr.translate({text:'你好',mode}); assert.equal(r.text,'Hello there');
  cloud.reset(); cloud.next({status:200,body:{ok:true,text:'  '}});
  r=await tr.translate({text:'你好',mode}); assert.equal(r.kind,'empty');
  // 没登录团队：不发请求，只说先登录（没有「去填密钥」要的 providerId）
  cloud.logout(); cloud.reset();
  r=await tr.translate({text:'你好',mode});
  assert.deepEqual(r,{error:'先登录团队才能翻译',kind:'auth'}); assert.equal(cloud.calls.length,0);
  assert.equal(tr.publicConfig().loggedIn,false); assert.deepEqual(tr.raceSet(),[]);
  assert.equal(await tr.raceFree({text:'你好',mode}),null,'没登录：不走并行通道');
  cloud.loginAgain();
  // 来财的每种报错 -> 界面上的一句话（约定表）
  const cases=[
    [{status:401,error:'login_required'},'auth','团队登录失效，请重新登录'],
    [{status:403,error:'revoked'},'auth','团队登录失效，请重新登录'],
    [{status:403,body:{ok:false,error:'revoked',revoked:true}},'auth','这台电脑已被管理员停用'],
    [{status:409,error:'no_key'},'config','翻译还没开通，请找管理员在来财 设置 › WAswitch 填密钥'],
    [{status:409,error:'not_set_up'},'config','翻译还没开通，请找管理员在来财 设置 › WAswitch 填密钥'],
    [{status:402,error:'over_budget'},'quota','本月翻译额度用完了，请找管理员'],
    [{status:402,error:'no_balance'},'quota','翻译服务余额不足，请找管理员'],
    [{status:402,error:'no_balance',extra:{provider:'DeepSeek'}},'quota','DeepSeek余额不足，请找管理员'],
    [{status:422,error:'bad_key'},'config','来财的翻译服务密钥不对，请找管理员'],
    [{status:422,error:'bad_key',extra:{provider:'智谱'}},'config','来财的智谱密钥不对，请找管理员'],
    [{status:422,error:'bad_key',extra:{provider:'DeepL'}},'config','来财的DeepL密钥不对，请找管理员'],
    [{status:400,error:'upstream_rejected'},'bad','来财那边拒绝了这次请求（可能文字太长）'],
    [{status:400,error:'bad_input'},'bad','来财那边拒绝了这次请求（可能文字太长）'],
    [{status:413,error:'too_large'},'bad','文字太长，请分几次翻译'],
    [{status:426,error:'old_version'},'config','这个版本太旧，请更新 WAswitch'],
    [{status:504,error:'timeout'},'timeout','来财那边超时了，请稍后再试'],
    [{status:502,error:'unreachable'},'server','来财连不上翻译服务，请稍后再试'],
    [{status:502,error:'unreachable',extra:{provider:'腾讯混元'}},'server','来财连不上腾讯混元，请稍后再试'],
    [{status:502,error:'empty'},'empty','来财没有返回译文'],
    [{status:500,error:'x'},'server','来财那边出错了，请稍后再试'],
  ];
  for (const [ans,kind,text] of cases) {
    cloud.reset(); cloud.next(ans);
    r=await tr.translate({text:'你好',mode});
    assert.deepEqual([r.kind,r.error],[kind,text],JSON.stringify([ans,r]));
    assert(!('providerId' in r),'报错不带服务商');
    assert.equal(cloud.calls.length,1,`${ans.status} ${ans.error} 不重试`);
  }
  // 连不上来财
  cloud.reset(); cloud.next('net');
  r=await tr.translate({text:'你好',mode}); assert.deepEqual([r.kind,r.error],['network','连不上来财']); assert(r.detail);
  // 429 太忙：原地重试，成功就用
  const busy={status:429,error:'rate_limited'};
  const busyN=(n)=>Array(n).fill(busy);
  cloud.reset(); cloud.next(busy);
  r=await tr.translate({text:'你好',mode}); assert(r.text==='Hola' && chats().length===2, JSON.stringify(r));
  // 最多重试 3 次：没给等多久就 5、10、20 毫秒（retryMs:5），各自上下 15%；每次等完告诉界面 0
  let waits=[];
  cloud.reset(); cloud.next(...busyN(3));
  r=await tr.translate({text:'你好',mode,onWait:(ms)=>waits.push(ms)}); assert(r.text==='Hola' && chats().length===4, JSON.stringify(r));
  const w=waits.filter((x)=>x>0);
  assert.equal(w.length,3,JSON.stringify(waits)); assert.deepEqual(waits.map((x)=>x>0),[true,false,true,false,true,false],JSON.stringify(waits));
  [5,10,20].forEach((b,i)=>assert(w[i]>=Math.floor(b*0.85)&&w[i]<=Math.ceil(b*1.15),JSON.stringify(waits)));
  // 语音转出来的文字：purpose voice（纠错仍是 fix）；queued_ms 每次真发请求前现算，太忙重试时起点不变
  let clk=1000;
  cloud.reset(); cloud.next(busy);
  r=await tr.translate({text:'Hallo',mode,voice:true,queuedMs:()=>{clk+=250;return clk-1000;}});
  assert.equal(r.text,'Hola',JSON.stringify(r));
  assert.deepEqual(chats().map((x)=>[x.body.purpose,x.body.queued_ms]),[['voice',250],['voice',500]],'重发的那次带的是到重发时一共等的');
  cloud.reset(); await tr.translate({text:'Hallo',mode,voice:true,fix:true,draft:'你好',queuedMs:()=>5});
  assert.equal(chats()[0].body.purpose,'fix'); assert(!('queued_ms' in chats()[0].body),'纠错不带等了多久');
  cloud.reset(); await tr.translate({text:'Hallo',mode});
  assert.equal(chats()[0].body.purpose,'translate'); assert(!('queued_ms' in chats()[0].body),'没给 queuedMs 就不带');
  // 只发 0 到 1 小时的整数毫秒；算不出来就不带
  for (const [ms,want] of [[1234.6,1235],[-40,0],[5e9,3600000],[3600000,3600000],[NaN,undefined],[Infinity,undefined]]) {
    cloud.reset(); r=await tr.translate({text:'Hallo',mode,queuedMs:()=>ms});
    assert.equal(r.text,'Hola',String(ms)); assert.strictEqual(chats()[0].body.queued_ms,want,String(ms));
  }
  cloud.reset(); r=await tr.translate({text:'Hallo',mode,queuedMs:()=>{throw new Error('x');}});
  assert.equal(r.text,'Hola'); assert(!('queued_ms' in chats()[0].body));
  // 收到的消息走的单独通道（raceFree）也带上
  cloud.reset(); r=await tr.raceFree({text:'Hallo',mode,voice:true,queuedMs:()=>42});
  assert.deepEqual([chats()[0].body.purpose,chats()[0].body.queued_ms],['voice',42]);
  // 重试 3 次还忙：只说一句太忙
  cloud.reset(); cloud.next(...busyN(4));
  r=await tr.translate({text:'你好',mode}); assert.deepEqual([r.kind,r.error,chats().length],['overload','来财请求太频繁，请重试',4]);
  // 来财给了 retry_after_s：按它等，只往后加一点随机
  waits=[]; cloud.reset(); cloud.next({...busy,extra:{retry_after_s:0.08}});
  let t0=Date.now();
  r=await tr.translate({text:'你好',mode,onWait:(ms)=>waits.push(ms)}); assert(r.text==='Hola' && chats().length===2, JSON.stringify(r));
  assert(waits[0]>=80 && waits[0]<=92, JSON.stringify(waits)); assert(Date.now()-t0>=75, String(Date.now()-t0));
  // 没有 retry_after_s 时看 Retry-After 头
  waits=[]; cloud.reset(); cloud.next({...busy,headers:{'retry-after':'0.06'}});
  r=await tr.translate({text:'你好',mode,onWait:(ms)=>waits.push(ms)}); assert(r.text==='Hola' && waits[0]>=60 && waits[0]<=70, JSON.stringify(waits));
  // HTTP 日期格式的 Retry-After 也认
  assert(Math.abs(T.retryAfterMs(new Date(Date.now()+5000).toUTCString())-5000)<=1500); assert.equal(T.retryAfterMs('3'),3000); assert.equal(T.retryAfterMs('soon'),null); assert.equal(T.retryAfterMs(''),null);
  assert.equal(T.backoffMs(2,null,1500,()=>0.5),6000); assert.equal(T.backoffMs(0,null,1500,()=>0),1275); assert.equal(T.backoffMs(0,4000,1500,()=>0),4000);
  assert.equal(T.backoffMs(1,0,1500,()=>0.5),3000); // Retry-After 0 或过去的日期：当没给
  // 要等超过 20 秒的不等
  waits=[]; cloud.reset(); cloud.next({...busy,extra:{retry_after_s:60}});
  t0=Date.now();
  r=await tr.translate({text:'你好',mode,onWait:(ms)=>waits.push(ms)}); assert(r.kind==='overload' && chats().length===1 && !waits.length && Date.now()-t0<1000, JSON.stringify(r));
  // 等着重试时点取消：立刻停，不再发请求
  waits=[]; cloud.reset(); cloud.next({...busy,extra:{retry_after_s:5}});
  t0=Date.now();
  const pc=tr.translate({text:'你好',mode,onWait:(ms)=>{ waits.push(ms); if(ms>0) setTimeout(()=>tr.cancel(),20); }});
  r=await pc; assert.equal(r.kind,'cancel'); assert.equal(chats().length,1); assert(Date.now()-t0<1000, String(Date.now()-t0)); assert.deepEqual(waits.map((x)=>x>0),[true,false],JSON.stringify(waits));
  // 翻译中取消
  cloud.reset(); cloud.next('hang');
  const p=tr.translate({text:'你好',mode}); setTimeout(()=>tr.cancel(),20);
  r=await p; assert.equal(r.kind,'cancel', JSON.stringify(r)); assert.equal(cloud.calls.length,1);
  // 指定服务商的老参数（翻译页以前用）不再起作用：照样走来财
  cloud.reset(); r=await tr.translate({text:'你好',mode,providerId:'gone'}); assert.equal(r.text,'Hola');
  // 收到的消息：登录着就在自己的通道上翻（raceSet 只有来财），可以同时几条
  assert.deepEqual(tr.raceSet().map((x)=>x.id),['cloud']);
  cloud.reset(); cloud.next({delay:40,ok:true},{delay:40,ok:true});
  t0=Date.now();
  const both=await Promise.all([tr.raceFree({text:'a',mode,target:'中文'}),tr.raceFree({text:'b',mode,target:'中文'})]);
  assert(both.every((x)=>x.text==='Hola') && Date.now()-t0<75, `两条同时翻 ${Date.now()-t0}ms`);
  assert(!tr.busy,'并行通道不占本体');
  const ac=new AbortController(); cloud.reset(); cloud.next('hang');
  const pr=tr.raceFree({text:'a',mode},{signal:ac.signal}); setTimeout(()=>ac.abort(),20);
  assert.equal((await pr).kind,'cancel');
  // 设置页：来财开通了没有
  cloud.reset(); assert.deepEqual(await tr.cloudStatus(),{ready:true,overBudget:false});
  assert.equal(cloud.calls[0].route,'ai/status'); assert.deepEqual(cloud.calls[0].body,{v:1});
  cloud.next({status:200,body:{ok:true,ready:false,over_budget:false}}); assert.deepEqual(await tr.cloudStatus(),{ready:false,overBudget:false});
  cloud.next({status:200,body:{ok:true,ready:true,over_budget:true}}); assert.deepEqual(await tr.cloudStatus(),{ready:true,overBudget:true});
  cloud.next({status:403,error:'revoked'}); assert.deepEqual(await tr.cloudStatus(),{error:'团队登录失效，请重新登录',kind:'auth'});
  cloud.next('net'); assert.equal((await tr.cloudStatus()).kind,'network');
  cloud.logout(); cloud.reset(); assert.deepEqual(await tr.cloudStatus(),{error:'先登录团队才能翻译',kind:'auth'}); assert.equal(cloud.calls.length,0); cloud.loginAgain();
  // 不认识的老设置文件内容：旧服务商、加密后的密钥、DeepL 用量、翻译网络一次删掉，别的设置照旧
  const dOld=fs.mkdtempSync(path.join(os.tmpdir(),'tr'));
  fs.writeFileSync(path.join(dOld,'translate.json'),JSON.stringify({providers:[
    {id:'z1',preset:'zhipu',name:'智谱',baseUrl:'https://open.bigmodel.cn/api/paas/v4',model:'glm-4-flash',keyEnc:Buffer.from('Esecret-zp').toString('base64'),keyTail:'t-zp'},
    {id:'d1',preset:'deepl',name:'DeepL',baseUrl:'https://api.deepl.com/v2',model:'',keyEnc:'RWRsLWtleQ==',keyTail:'y:fx'}],primaryId:'z1',fallbackId:'d1',fixId:'z1',
    network:{mode:'proxy',proxyUrl:'socks5://127.0.0.1:7891'},deeplUsage:{month:'2026-10',chars:42},deeplCap:15000,seeded:true,seedVer:3,
    rolePrompt:'贴牌 = private label',dailyCap:200,accountLang:{a1:'德语'},accountAuto:{a2:false},autoDefaultOn:true,termsDefaultOn:true,wigTerms:false,lashTerms:true,trPlace:'panel',trPlaceInlineDefault:true,
    chatLang:{'a1:0123456789abcdef':{lang:'德语',src:'manual',at:1}},float:{dx:30,dy:70,collapsed:true},floatInMode:'m1'}));
  fs.writeFileSync(path.join(dOld,'translate.json.broken-1'),'{"providers":[{"keyEnc":"RWRsLWtleQ=="}]');
  fs.writeFileSync(path.join(dOld,'other.json'),'{}');
  const tOld=mk(dOld);
  const cOld=tOld.publicConfig();
  assert(!fs.existsSync(path.join(dOld,'translate.json.broken-1')),'读坏时留下的旧备份（可能有密钥）也删了');
  assert(fs.existsSync(path.join(dOld,'other.json')),'别的文件不动');
  assert.deepEqual(cOld.providers.map((x)=>x.id),['cloud']);
  const rawOld=fs.readFileSync(path.join(dOld,'translate.json'),'utf8');
  for (const k of ['providers','primaryId','fallbackId','fixId','network','deeplUsage','deeplCap','seeded','seedVer','keyEnc','keyTail']) assert(!rawOld.includes(`"${k}"`),`升级后 translate.json 里没有 ${k}`);
  assert(!rawOld.includes('c2VjcmV0') && !rawOld.includes('RWRsLWtleQ') && !rawOld.includes('智谱'),'旧密钥（加密后的）也删了');
  assert.equal(cOld.rolePrompt,'贴牌 = private label'); assert.equal(cOld.dailyCap,200); assert.deepEqual(cOld.accountLang,{a1:'德语'}); assert.deepEqual(cOld.accountAuto,{a2:false});
  assert.equal(cOld.wigTerms,false); assert.equal(cOld.trPlace,'panel'); assert.equal(cOld.floatInMode,'m1'); assert.deepEqual(tOld.chatLang('a1:0123456789abcdef'),{lang:'德语',src:'manual'});
  // 只重写一次：再读不再改文件
  const mtime=fs.statSync(path.join(dOld,'translate.json')).mtimeMs;
  await new Promise((ok)=>setTimeout(ok,20));
  mk(dOld).load(); assert.equal(fs.statSync(path.join(dOld,'translate.json')).mtimeMs,mtime,'第二次打开不再重写');
  fs.rmSync(dOld,{recursive:true,force:true});
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
  // 收到的消息默认只出译文，不加【要点】；老用户没改过的「看懂客户」换成新提示词，改过的不动
  assert(!T.DEFAULT_MODES.some((m)=>m.prompt.includes('要点')));
  const in1=ms2.upsert({name:'看懂客户',direction:'in',prompt:T.UPDATED_MODES[0].old});
  const in2=ms2.upsert({name:'看懂客户',direction:'in',prompt:'我改过的，要【要点】'});
  assert.equal(T.updateModes(ms2),1);
  assert.equal(ms2.get(in1.id).prompt,T.DEFAULT_MODES.find((m)=>m.name==='看懂客户').prompt);
  assert.equal(ms2.get(in2.id).prompt,'我改过的，要【要点】');
  assert.equal(T.updateModes(ms2),0);
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
  const t2=mk(dir);
  const key='a1:0123456789abcdef';
  assert.equal(t2.setChatLang(key,'印尼语','detected'),true);
  assert.deepEqual(t2.chatLang(key),{lang:'印尼语',src:'detected'});
  assert.equal(t2.setChatLang(key,'印尼语','detected'),false); // 没变不写盘
  assert.equal(t2.setChatLang(key,'中文','detected'),true); // 对方写中文也记（自动选择时中文不翻）
  assert.deepEqual(t2.chatLang(key),{lang:'中文',src:'detected'});
  assert.equal(t2.setChatLang(key,'印尼语','detected'),true);
  assert(!/function rememberDetected[\s\S]*?\n  }/.exec(fs.readFileSync(path.join(__dirname,'..','src','translate-ipc.js'),'utf8'))[0].includes('中文'),'rememberDetected 不能再跳过中文');
  assert.equal(t2.setChatLang(key,'马来语','manual'),true);
  assert.equal(t2.setChatLang(key,'英语','detected'),false);
  assert.equal(t2.chatLang(key).lang,'马来语');
  assert.equal(t2.setChatLang('a1:+8613800000000','英语','manual'),false);
  assert.equal(t2.setChatLang(key,'火星语','manual'),false);
  const t3=mk(dir);
  assert.equal(t3.chatLang(key).lang,'马来语'); // 存盘读回
  t3.forgetAccount('a1');
  assert.equal(t3.chatLang(key),null);
  assert.equal(t3.setChatLang(key,'英语','manual'),true);
  assert.equal(t3.setChatLang(key,'','manual'),true); // 回到自动
  assert.equal(t3.chatLang(key),null);
  // 角色设定：放在 system 最前面，跟着目标语言替换变量
  const rm=T.buildMessages({prompt:'p'},'hi',{target:'德语'},undefined,'','你是{目标语言}专家');
  assert(rm[0].content.startsWith('你是德语专家\n\np'));
  const d4=fs.mkdtempSync(path.join(os.tmpdir(),'tr'));
  const t4=mk(d4);
  assert(t4.setRolePrompt('贴牌 = private label').ok); assert(t4.setRolePrompt('x'.repeat(5000)).error);
  const sys=()=>chats().at(-1).body.messages[0].content;
  cloud.reset(); await t4.translate({text:'Hallo',mode:{prompt:'p'},target:'中文'});
  assert(sys().startsWith('贴牌 = private label'));
  assert.equal(mk(d4).load().rolePrompt,'贴牌 = private label');
  // 假发词汇：默认开（和睫毛一样）；跟在角色设定后面，用户写了同一个词的用用户的；开关存盘
  let rt;
  assert.equal(t4.publicConfig().wigTerms,true); assert.equal(t4.load().wigTerms,true);
  rt=t4.roleText(); assert(rt.startsWith('贴牌 = private label\n\n睫毛、假发行业固定译法') && rt.includes('发帘 = Bundle') && rt.includes('密排 = Lash trays'),rt);
  assert(t4.setWigTerms(false).ok); // 下面先单看睫毛词汇
  // 睫毛词汇：默认开（老设置没存过也算开），单独开关、单独存盘；密排排在睫毛前面
  assert.equal(t4.publicConfig().lashTerms,true); assert.deepEqual(t4.publicConfig().lashList,[{zh:'密排',en:'Lash trays'},{zh:'假睫毛',en:'Lash trays'},{zh:'睫毛',en:'Lash'}]);
  rt=t4.roleText();
  assert(rt.startsWith('贴牌 = private label\n\n睫毛行业固定译法') && rt.includes('密排 = Lash trays\n假睫毛 = Lash trays\n睫毛 = Lash') && rt.includes('Lash trays → 密排\nLash → 睫毛') && !rt.includes('→ 假睫毛') && !rt.includes('头套'),rt);
  assert(t4.setLashTerms(false).ok); assert.equal(t4.publicConfig().lashTerms,false);
  assert.equal(mk(d4).load().lashTerms,false);
  assert.equal(t4.publicConfig().wigTerms,false); assert.equal(t4.roleText(),'贴牌 = private label');
  assert.equal(t4.publicConfig().wigList.length,8);
  assert(t4.setWigTerms(true).ok);
  rt=t4.roleText();
  assert(rt.startsWith('贴牌 = private label\n\n'));
  for (const l of ['配件 = Closure','前头 = Frontal','发帘 = Bundle','头套 = Wig','全蕾丝头套 = Full lace wig','胶片发 = Tape hair','辫发 = Raw hair','处女发 = Virgin hair']) assert(rt.split('\n').includes(l),l);
  // 头套排第一行（glm-4-flash 实测排在全蕾丝头套后面会翻错），wig 不译假发点名说了
  assert(rt.indexOf('头套 = Wig')<rt.indexOf('全蕾丝头套 = Full lace wig') && rt.indexOf('全蕾丝头套 = Full lace wig')<rt.indexOf('配件 = Closure'),rt);
  assert(rt.includes('wig 一律译成头套，不译成假发'));
  cloud.reset(); await t4.translate({text:'Hallo',mode:{prompt:'p'},target:'中文'});
  assert(sys().includes('处女发 = Virgin hair'));
  assert.equal(mk(d4).load().wigTerms,true);
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
  assert(T.roleWithWig('',true).includes('Closure → 配件') && !rt.includes('Closure → 配件'));
  // 翻成法语等英语以外的外语：多一句“整句用那种语言、英文词原样保留”；翻成中文、英语或不传：原来的写法
  const fr=T.roleWithWig('',true,'法语');
  assert(fr.includes('头套 = Wig') && fr.includes('Wig → 头套') && fr.includes('整句必须用法语写') && fr.includes('“头套”写成 Wig') && fr.endsWith('翻成法语。'),fr);
  assert.equal(T.roleWithWig('',true,'英语'),T.roleWithWig('',true));
  assert.equal(T.roleWithWig('',true,'中文'),T.roleWithWig('',true));
  assert.equal(T.roleWithWig('',true,'火星语'),T.roleWithWig('',true));
  assert(!T.roleWithWig('',true).includes('整句'));
  assert(!T.roleWithWig('头套 = a\n全蕾丝头套 = b',true,'法语').includes('“头套”')); // 例子只用还在词表里的词
  cloud.reset(); await t4.translate({text:'头套',mode:{prompt:'p'},target:'法语'});
  assert(sys().includes('整句必须用法语写'));
  cloud.reset(); await t4.translate({text:'wig',mode:{prompt:'p'},target:'中文'});
  assert(sys().includes('Wig → 头套'));
  assert(t4.setWigTerms(false).ok); assert.equal(t4.roleText(),'贴牌 = private label');
  // 两套都开：合成一段，头句写“睫毛、假发”，睫毛在前（实测假发在前会把睫毛翻成 Lash trays）；用户写过睫毛的用用户的
  rt=T.roleWithTerms('',{wig:true,lash:true});
  assert(rt.startsWith('睫毛、假发行业固定译法') && rt.indexOf('睫毛 = Lash\n')<rt.indexOf('头套 = Wig') && rt.indexOf('头套 = Wig')<rt.indexOf('全蕾丝头套') && rt.includes('Lash → 睫毛') && rt.includes('wig 一律译成头套'),rt);
  rt=T.roleWithTerms('睫毛 = eyelash',{lash:true});
  assert(rt.includes('密排 = Lash trays') && !rt.split('\n').includes('睫毛 = Lash') && rt.includes('\n睫毛行业'),rt);
  assert.equal(T.roleWithTerms('密排 = a\n假睫毛 = c\n睫毛 = b',{lash:true}),'密排 = a\n假睫毛 = c\n睫毛 = b');
  assert(T.roleWithTerms('',{lash:true}).startsWith('睫毛行业固定译法（这些词在原文里一出现就必须用右边的英文，包括“假睫毛”），必须照用')); assert(!T.roleWithTerms('',{wig:true}).includes('假睫毛'));
  assert(!T.roleWithTerms('假睫毛 = false lashes',{lash:true}).includes('包括“假睫毛”'));
  assert(T.roleWithTerms('',{lash:true,wig:true}).includes('wig 一律译成头套，不译成假发；假睫毛一律译成 Lash trays，不译成 false eyelashes）') && T.roleWithTerms('',{lash:true}).includes('（不管单复数、大小写，也不当量词；假睫毛一律译成 Lash trays'));
  assert(!T.roleWithTerms('假睫毛 = false lashes',{lash:true}).includes('不译成 false eyelashes') && !T.roleWithTerms('',{wig:true}).includes('假睫毛'));
  rt=T.roleWithTerms('密排 = strip lashes',{lash:true}); assert(rt.includes('假睫毛 = Lash trays') && rt.includes('Lash trays → 假睫毛'),rt); // 密排被用户改了，假睫毛顶上反方向
  assert(T.roleWithTerms('',{lash:true},'德语').includes('“密排”写成 Lash trays'));
  assert.equal(T.roleWithTerms('x',{}),'x');
  // 老设置没有 lashTerms：默认开；开关打开后存盘
  const dL=fs.mkdtempSync(path.join(os.tmpdir(),'tr')); fs.writeFileSync(path.join(dL,'translate.json'),JSON.stringify({rolePrompt:'',wigTerms:true}));
  const tL=mk(dL);
  assert.equal(tL.publicConfig().lashTerms,true); assert(tL.roleText().startsWith('睫毛、假发行业'));
  assert(tL.setLashTerms(true).ok); assert.equal(JSON.parse(fs.readFileSync(path.join(dL,'translate.json'),'utf8')).lashTerms,true);
  fs.rmSync(dL,{recursive:true,force:true});
  // 老设置没有 wigTerms：默认开（发帘不再被睫毛词表带成 Lash trays）；存过 false 的仍关
  const dW=fs.mkdtempSync(path.join(os.tmpdir(),'tr')); fs.writeFileSync(path.join(dW,'translate.json'),JSON.stringify({rolePrompt:'',lashTerms:true}));
  let tW=mk(dW);
  assert.equal(tW.publicConfig().wigTerms,true); assert(tW.roleText().includes('发帘 = Bundle') && tW.roleText().startsWith('睫毛、假发行业'));
  // 0.5.12/0.5.13 的设置：wigTerms:false 是默认关时顺手存进去的（睫毛可能也关着）→ 升级时打开一次并存盘
  fs.writeFileSync(path.join(dW,'translate.json'),JSON.stringify({rolePrompt:'',wigTerms:false,lashTerms:false,seeded:true,seedVer:3,autoDefaultOn:true,chatLang:{}}));
  tW=mk(dW);
  assert.equal(tW.publicConfig().wigTerms,true); assert.equal(tW.publicConfig().lashTerms,true); assert(tW.roleText().startsWith('睫毛、假发行业'));
  let sW=JSON.parse(fs.readFileSync(path.join(dW,'translate.json'),'utf8')); assert.equal(sW.termsDefaultOn,true); assert.equal(sW.wigTerms,true); assert.equal(sW.lashTerms,true);
  // 迁移之后用户自己关掉：重开不会再打开
  assert(tW.setWigTerms(false).ok); assert(tW.setLashTerms(false).ok);
  tW=mk(dW);
  assert.equal(tW.publicConfig().wigTerms,false); assert.equal(tW.publicConfig().lashTerms,false); assert(!tW.roleText().includes('发帘'));
  // 新装（没有设置文件）：默认开，标记一起存上，之后关掉也不会被打开
  const dN=fs.mkdtempSync(path.join(os.tmpdir(),'tr'));
  let tN=mk(dN);
  assert.equal(tN.publicConfig().wigTerms,true); assert(tN.setWigTerms(false).ok);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dN,'translate.json'),'utf8')).termsDefaultOn,true);
  tN=mk(dN); assert.equal(tN.publicConfig().wigTerms,false); assert.equal(tN.publicConfig().lashTerms,true);
  fs.rmSync(dN,{recursive:true,force:true});
  assert(tW.setWigTerms(true).ok); assert.equal(JSON.parse(fs.readFileSync(path.join(dW,'translate.json'),'utf8')).wigTerms,true);
  fs.rmSync(dW,{recursive:true,force:true});
  assert(t4.setLashTerms(true).ok); assert(t4.roleText().includes('睫毛 = Lash'));
  fs.rmSync(d4,{recursive:true,force:true});
  // 自动翻译默认开：新号开；老设置里确认过但没开着的号（手动关过）保留关，其他都开；关掉的记住
  const d7=fs.mkdtempSync(path.join(os.tmpdir(),'tr'));
  fs.writeFileSync(path.join(d7,'translate.json'),JSON.stringify({accountAuto:{a:true},autoConsent:{a:true,b:true},consented:{x:true}}));
  let t7=mk(d7);
  assert.deepEqual(t7.load().accountAuto,{b:false}); assert.equal(t7.load().autoDefaultOn,true);
  t7.setFloat({accId:'c',auto:false}); t7.setFloat({accId:'b',auto:true});
  const raw7=JSON.parse(fs.readFileSync(path.join(d7,'translate.json'),'utf8'));
  assert.deepEqual(raw7.accountAuto,{c:false}); assert(!('autoConsent' in raw7) && !('consented' in raw7));
  t7=mk(d7);
  assert.deepEqual(t7.load().accountAuto,{c:false}); // 迁移只做一次
  t7.forgetAccount('c'); assert.deepEqual(t7.load().accountAuto,{});
  fs.rmSync(d7,{recursive:true,force:true});
  // 译文显示位置默认「消息下面」：新装是 inline；1.0.4 存下的值升级时一次性改成 inline，之后用户自己选的 panel 保留
  const dPl=fs.mkdtempSync(path.join(os.tmpdir(),'tr'));
  let tPl=mk(dPl);
  assert.equal(tPl.publicConfig().trPlace,'inline'); // 新装
  fs.writeFileSync(path.join(dPl,'translate.json'),JSON.stringify({seeded:true,seedVer:3,termsDefaultOn:true,autoDefaultOn:true,trPlace:'panel'}));
  tPl=mk(dPl);
  assert.equal(tPl.publicConfig().trPlace,'inline'); // 升级：旧的 panel 改成 inline
  assert.equal(JSON.parse(fs.readFileSync(path.join(dPl,'translate.json'),'utf8')).trPlaceInlineDefault,true);
  tPl.setFloat({place:'panel'});
  tPl=mk(dPl);
  assert.equal(tPl.publicConfig().trPlace,'panel'); // 用户自己改的不再覆盖
  fs.rmSync(dPl,{recursive:true,force:true});
  // 翻译页单独一条通道（lane）：工作台在翻时翻译页照样能翻，取消只取消自己；配置共用一份
  const dLn=fs.mkdtempSync(path.join(os.tmpdir(),'tr'));
  const tLn=mk(dLn);
  cloud.reset();
  const hangs=[];
  cloud.next(()=>({delay:60000}));
  const page=tLn.lane();
  const work=tLn.translate({text:'慢一点',mode:{prompt:'p'},target:'英语'});
  assert(tLn.busy,'工作台在翻');
  let q=await page.translate({text:'快',mode:{prompt:'p'},target:'英语'});
  assert.equal(q.text,'Hola','工作台在翻时翻译页不用排队'); assert(tLn.busy && !page.busy);
  cloud.next('hang');
  const pageSlow=page.translate({text:'慢慢',mode:{prompt:'p'},target:'英语'});
  assert(page.busy && tLn.busy);
  assert.equal(page.cancel(),true);
  q=await pageSlow; assert.equal(q.kind,'cancel','翻译页取消只取消自己');
  assert(tLn.busy,'工作台那条还在翻');
  assert.equal(tLn.cancel(),true); q=await work; assert.equal(q.kind,'cancel');
  assert.equal(page.cancel(),false,'没在翻时取消什么也不做');
  // 配置是同一份：本体改的角色设定，通道翻译时也带上，也写进同一个文件
  assert(tLn.setRolePrompt('贴牌 = OEM').ok);
  cloud.reset(); q=await page.translate({text:'你好',mode:{prompt:'p'},target:'德语'}); assert.equal(q.text,'Hola',JSON.stringify(q));
  assert(chats()[0].body.messages[0].content.startsWith('贴牌 = OEM'),'通道用的是本体的角色设定');
  assert(!Object.prototype.hasOwnProperty.call(page,'cfg'),'通道不自己存配置');
  fs.rmSync(dLn,{recursive:true,force:true});
  fs.rmSync(dir,{recursive:true,force:true});
  console.log('翻译自检通过');
})().catch(e=>{console.error(e);process.exit(1)});
