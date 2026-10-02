// Same-origin account proxy keeps HttpOnly sessions first-party on the Vercel dashboard.
import { dashboardOrigin } from '../../lib/dashboard-origin.mjs';
const allowed = new Set(['me','logout','computers','computers/revoke','auth/options','auth/verify','enrollment/details','enrollment/approve','access/start','access/status','access/finish']);
export default async function handler(req,res) {
  res.setHeader('Cache-Control','no-store');
  try {
    const pathname = new URL(req.url,'https://local.invalid').pathname.replace(/^\/account-api\//,'').replace(/^\/api\/account\//,'');
    if(!allowed.has(pathname)||!['GET','POST'].includes(req.method))return res.status(404).json({error:'not_found'});
    const base=new URL(process.env.RELAY_PUBLIC_URL??'');if(base.protocol!=='wss:'||base.origin+'/'!==base.href)throw Error('invalid_release_configuration');
    const origin=dashboardOrigin();
    if(req.method==='POST'&&req.headers.origin!==origin)return res.status(403).json({error:'origin_forbidden'});
    const body=req.method==='POST'?(typeof req.body==='string'?req.body:JSON.stringify(req.body??{})):undefined;
    if(body&&Buffer.byteLength(body)>32768)return res.status(413).json({error:'body_too_large'});
    const upstream=await fetch(base.origin.replace(/^wss:/,'https:')+'/account-api/'+pathname,{method:req.method,headers:{'Content-Type':'application/json',Origin:origin,Cookie:req.headers.cookie??'','X-CSRF-Token':req.headers['x-csrf-token']??''},body,redirect:'error',signal:AbortSignal.timeout(15000)});
    const cookie=upstream.headers.get('set-cookie');if(cookie)res.setHeader('Set-Cookie',cookie);
    res.status(upstream.status).setHeader('Content-Type','application/json');res.end(await upstream.text());
  }catch{res.status(503).json({error:'account_service_unavailable'});}
}
