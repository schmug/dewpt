const {chromium}=require('playwright');
(async()=>{const b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium'});const p=await b.newPage({viewport:{width:1100,height:600}});
const errs=[];p.on('pageerror',e=>errs.push(e.message));
await p.goto('http://localhost:8799/p2.html',{waitUntil:'networkidle'});await p.waitForTimeout(2000);
console.log(JSON.stringify(await p.evaluate(()=>window.__restored)), 'errors', errs);
await p.screenshot({path:'roundtrip.png'});await b.close();})();
