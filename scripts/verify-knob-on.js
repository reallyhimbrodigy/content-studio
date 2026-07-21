// Boot a LOCAL server with WALL_ENFORCEMENT=on and prove the knob-ON cells that
// production (dark) can't show: a wall-capable .none account -> 403 wall_required;
// a paid account still passes. This is exactly the launch "move two" behavior.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const env = {};
for (const line of fs.readFileSync('/Users/zaclibman/content-studio/.env.local','utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m) env[m[1]] = m[2].replace(/^["']|["']$/g,'');
}
const PORT = 8788;
const child = spawn('node', ['server.js'], {
  cwd: '/Users/zaclibman/content-studio',
  env: { ...process.env, ...env, PORT: String(PORT), WALL_ENFORCEMENT: 'on', WALL_FLIP_DATE: '2020-01-01', NODE_ENV: 'test' },
  stdio: ['ignore','pipe','pipe'],
});
let booted = false;
const sleep = ms => new Promise(r=>setTimeout(r,ms));
async function signIn(email, password) {
  const url=(env.SUPABASE_URL||env.NEXT_PUBLIC_SUPABASE_URL).replace(/\/$/,'');
  const anon=env.NEXT_PUBLIC_SUPABASE_ANON_KEY||env.SUPABASE_ANON_KEY;
  const r=await fetch(`${url}/auth/v1/token?grant_type=password`,{method:'POST',headers:{'Content-Type':'application/json',apikey:anon},body:JSON.stringify({email,password})});
  const j=await r.json(); if(!j.access_token) throw new Error('signin '+email+' '+JSON.stringify(j).slice(0,80)); return j.access_token;
}
async function gate(token){
  const r=await fetch(`http://localhost:${PORT}/api/video-jobs`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`,'X-Promptly-Wall-Capable':'1'},body:JSON.stringify({gate_probe:true})});
  let b=null; try{b=await r.json();}catch(_){}; return {status:r.status,body:b};
}
(async()=>{
  // wait for boot
  for(let i=0;i<40;i++){ await sleep(500); try{ const r=await fetch(`http://localhost:${PORT}/api/health`); if(r.ok){booted=true;break;} }catch(_){} }
  if(!booted){ console.log('LOCAL SERVER DID NOT BOOT'); child.kill('SIGKILL'); process.exit(1); }
  console.log('local knob-ON server booted on :'+PORT);
  let fail=0; const ck=(l,ok,d)=>{console.log(`  ${ok?'✓':'✗ FAIL'} ${l}${d?' ('+d+')':''}`); if(!ok)fail++;};
  try {
    // Paid account: passes even with knob on (Pro is never walled)
    const proTok=await signIn(env.PROBE_PRO_EMAIL, env.PROBE_PRO_PASSWORD);
    const g1=await gate(proTok);
    ck('PAID + knob-on -> gate_probe 200 (Pro never walled)', g1.status===200, 'got '+g1.status);
    ck('PAID tier==paid, unlimited', g1.body&&g1.body.tier==='paid'&&g1.body.render_limit==='unlimited');
    // .none account, wall-capable: THE WALL — 403 wall_required
    const freeTok=await signIn(env.PROBE_FREE_EMAIL, env.PROBE_FREE_PASSWORD);
    const g2=await gate(freeTok);
    ck('.none + knob-on + wall-capable -> 403 wall_required (THE FLIP)', g2.status===403 && g2.body && g2.body.error==='wall_required', 'got '+g2.status+' '+(g2.body&&g2.body.error));
    ck('.none wall body has route:wall + old-client-safe message', g2.body && g2.body.route==='wall' && /update/i.test(g2.body.message||''), g2.body&&g2.body.message);
  } catch(e){ ck('knob-on probes ran', false, e.message); }
  console.log(fail===0?'KNOB-ON LIVE (local): the wall holds — .none walled, paid passes':'KNOB-ON VERIFY FAILED');
  child.kill('SIGKILL');
  process.exit(fail===0?0:1);
})();
