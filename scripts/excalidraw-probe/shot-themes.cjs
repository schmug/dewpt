const {chromium}=require('playwright');
(async()=>{const b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium'});
const p=await b.newPage({viewport:{width:1100,height:600}}); const reqs=[];p.on("requestfailed",r=>console.log("fail",r.url()));p.on("response",r=>{if(r.status()>=400)console.log("404",r.url())});let bytes=0;
p.on('response',async r=>{try{const bb=await r.body();bytes+=bb.length;reqs.push(r.url().replace('http://localhost:8799',''))}catch{}});
p.on('console',m=>{if(m.type()==='error')console.log('console',m.text().slice(0,120))});
for (const q of ['theme=light','theme=dark','theme=light&font=Nunito']){reqs.length=0;bytes=0;
 await p.goto('http://localhost:8799/?'+q,{waitUntil:'networkidle'}); await p.waitForTimeout(1500);
 await p.screenshot({path:`exc-${q.replace(/[=&]/g,'-')}.png`}); console.log(q,'requests',reqs.length,'bytes',bytes, reqs.filter(u=>!u.startsWith('/')).slice(0,3));}
await b.close();})();
