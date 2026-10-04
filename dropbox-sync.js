/* Reckoning — Wahoo ride import via Dropbox.
   Loaded after the main page script. Reads .fit files from Apps/WahooFitness,
   turns each new one into a ride-log entry, and inserts it into Supabase.
   It only ever ADDS ride rows; it never deletes or rewrites existing ones. */
(function(){
'use strict';

const DBX_KEY      = '9bmas3g4dc3e5ct';
const DBX_REDIRECT = 'https://reckoning.coopersfault.com/';
const DBX_FOLDER   = '/Apps/WahooFitness';
const LS_REFRESH = 'reckoning_dbx_refresh', LS_VERIFIER = 'reckoning_dbx_verifier',
      LS_STATE = 'reckoning_dbx_state', LS_SKIP = 'reckoning_dbx_skip';
const FIT_EPOCH = 631065600;            // seconds between 1970-01-01 and 1989-12-31
const STAMP_RE = /^(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})/;

// ---------------------------------------------------------------- FIT parsing
function fitVal(dv, p, size, type, le){
  switch(type & 0x1F){
    case 0: case 2: case 13: { const v = dv.getUint8(p); return v !== 0xFF ? v : null; }
    case 10: { const v = dv.getUint8(p); return v !== 0 ? v : null; }
    case 1: { const v = dv.getInt8(p); return v !== 0x7F ? v : null; }
    case 3: { if(size < 2) return null; const v = dv.getInt16(p, le); return v !== 0x7FFF ? v : null; }
    case 4: { if(size < 2) return null; const v = dv.getUint16(p, le); return v !== 0xFFFF ? v : null; }
    case 11: { if(size < 2) return null; const v = dv.getUint16(p, le); return v !== 0 ? v : null; }
    case 5: { if(size < 4) return null; const v = dv.getInt32(p, le); return v !== 0x7FFFFFFF ? v : null; }
    case 6: { if(size < 4) return null; const v = dv.getUint32(p, le); return v !== 0xFFFFFFFF ? v : null; }
    case 12: { if(size < 4) return null; const v = dv.getUint32(p, le); return v !== 0 ? v : null; }
    case 8: { if(size < 4) return null; const v = dv.getFloat32(p, le); return isNaN(v) ? null : v; }
    default: return null;
  }
}

// Returns { session: {fieldNum: value} | null, records: [{fieldNum: value}] }
// Only the session (18) and record (20) messages are decoded; the rest are skipped.
function parseFit(buf){
  const dv = new DataView(buf);
  if(buf.byteLength < 14) throw new Error('file too small to be a FIT file');
  const hs = dv.getUint8(0);
  const sig = String.fromCharCode(dv.getUint8(8), dv.getUint8(9), dv.getUint8(10), dv.getUint8(11));
  if(sig !== '.FIT') throw new Error('not a FIT file');
  const end = Math.min(buf.byteLength, hs + dv.getUint32(4, true));
  const defs = {}; const sessions = [], records = [];
  let p = hs, lastTs = 0;
  while(p < end){
    const h = dv.getUint8(p++);
    let def, compressedOff = null;
    if(h & 0x80){ def = defs[(h >> 5) & 3]; compressedOff = h & 0x1F; }
    else if(h & 0x40){
      const lt = h & 0x0F, hasDev = h & 0x20;
      p++;                                           // reserved
      const le = dv.getUint8(p++) === 0;
      const g = dv.getUint16(p, le); p += 2;
      const n = dv.getUint8(p++);
      const fields = []; let size = 0;
      for(let i = 0; i < n; i++){
        const f = { num: dv.getUint8(p), size: dv.getUint8(p+1), type: dv.getUint8(p+2) };
        fields.push(f); size += f.size; p += 3;
      }
      if(hasDev){ const nd = dv.getUint8(p++); for(let i = 0; i < nd; i++){ size += dv.getUint8(p+1); p += 3; } }
      defs[lt] = { g, le, fields, size };
      continue;
    } else { def = defs[h & 0x0F]; }
    if(!def) throw new Error('corrupt FIT file (data before definition)');
    if(p + def.size > end) break;                    // truncated tail; keep what we have
    if(def.g === 18 || def.g === 20){
      const m = {}; let q = p;
      for(const f of def.fields){ m[f.num] = fitVal(dv, q, f.size, f.type, def.le); q += f.size; }
      if(compressedOff !== null){
        let ts = (lastTs & ~0x1F) + compressedOff;
        if(compressedOff < (lastTs & 0x1F)) ts += 32;
        m[253] = ts;
      }
      if(m[253]) lastTs = m[253];
      (def.g === 18 ? sessions : records).push(m);
    } else {
      // still track timestamps so compressed headers stay correct
      let q = p;
      for(const f of def.fields){ if(f.num === 253 && f.size === 4){ const v = dv.getUint32(q, def.le); if(v !== 0xFFFFFFFF) lastTs = v; } q += f.size; }
    }
    p += def.size;
  }
  return { session: sessions[0] || null, records };
}

function ymdLocal(dt){
  return dt.getFullYear() + '-' + String(dt.getMonth()+1).padStart(2,'0') + '-' + String(dt.getDate()).padStart(2,'0');
}
function num(v){ return (v === null || v === undefined || isNaN(v)) ? null : v; }
function mean(a){ return a.length ? a.reduce((x,y)=>x+y,0) / a.length : null; }

// Turn a parsed FIT file into a ride in the shape the ride log already uses.
// ftpFor(date) returns the FTP in force on that date (or null).
function summarize(fit, fileName, ftpFor){
  const s = fit.session || {}, recs = fit.records;
  if(!fit.session && !recs.length) throw new Error('no ride data in file');
  const stamp = (fileName.match(STAMP_RE) || [''])[0];
  const numM = fileName.match(/-(\d+)-\d+\.fit$/i);

  const startTs = num(s[2]) || (recs.length ? num(recs[0][253]) : null);
  if(!startTs) throw new Error('no start time in file');
  const date = ymdLocal(new Date((startTs + FIT_EPOCH) * 1000));

  const pw = recs.map(r => num(r[7]));
  const hasPower = pw.some(v => v > 0);
  const p0 = pw.map(v => v || 0);
  const hrs = recs.map(r => num(r[3])).filter(v => v);
  const cads = recs.map(r => num(r[4])).filter(v => v);
  const temps = recs.map(r => num(r[13])).filter(v => v !== null);

  const avgP = hasPower ? (num(s[20]) || Math.round(mean(p0))) : null;
  let np = hasPower ? num(s[34]) : null;
  if(hasPower && !np && p0.length >= 30){
    let sum = 0, acc = 0, n = 0;
    for(let i = 0; i < p0.length; i++){
      sum += p0[i]; if(i >= 30) sum -= p0[i-30];
      if(i >= 29){ acc += Math.pow(sum/30, 4); n++; }
    }
    np = Math.round(Math.pow(acc/n, 0.25));
  }
  const avgHR = num(s[16]) || (hrs.length ? Math.round(mean(hrs)) : null);
  const maxHR = num(s[17]) || (hrs.length ? Math.max(...hrs) : null);
  const cad = num(s[18]) || (cads.length ? Math.round(mean(cads)) : null);

  const vi = (np && avgP) ? +(np/avgP).toFixed(2) : null;
  const ef = (np && avgHR) ? +(np/avgHR).toFixed(3) : null;

  // Time above threshold, counted second by second against the FTP in force that day.
  let z4min = null, z5min = null, surges = null;
  const ftp = hasPower ? ftpFor(date) : null;
  if(ftp){
    let z4 = 0, z5 = 0, run = 0; surges = 0;
    for(const v of p0){
      if(v >= 0.91*ftp) z4++;
      if(v >= 1.06*ftp) z5++;
      if(v >= 1.20*ftp){ run++; if(run === 10) surges++; } else run = 0;
    }
    z4min = Math.round(z4/60); z5min = Math.round(z5/60);
  }

  let kcal = null, burnSrc = null;
  if(num(s[48])){ kcal = Math.round(s[48]/1000); burnSrc = 'kJ'; }
  else if(hasPower){ kcal = Math.round(p0.reduce((a,b)=>a+b,0)/1000); burnSrc = 'kJ'; }
  else if(num(s[11])){ kcal = s[11]; burnSrc = 'HR-est'; }

  const secs = num(s[8]) ? s[8]/1000 : (num(s[7]) ? s[7]/1000 : recs.length);
  const hh = Math.floor(secs/3600), mm = Math.round((secs - hh*3600)/60);
  const durParts = [hh ? hh + 'h' + String(mm).padStart(2,'0') : mm + 'min'];
  if(num(s[9])) durParts.push((s[9]/100/1609.344).toFixed(1) + 'mi');
  if(num(s[22])) durParts.push(s[22] + 'm');

  const tC = num(s[57]) !== null ? s[57] : (temps.length ? mean(temps) : null);
  const temp = tC !== null ? Math.round(tC*9/5 + 32) + 'F' : '';

  const noteParts = [];
  if(np) noteParts.push('NP ' + np);
  if(avgP) noteParts.push('avg ' + avgP + 'W');
  if(avgHR) noteParts.push('HR ' + avgHR + (maxHR ? '/' + maxHR : ''));
  if(cad) noteParts.push('cad ' + cad);
  noteParts.push('Wahoo ' + stamp);

  const indoor = s[6] === 6 || s[6] === 58;
  return {
    date, title: (indoor ? 'Indoor ride' : 'Ride') + (numM ? ' ' + numM[1] : ''),
    ef, vi, type: (vi && vi > 1.15) ? 'surgy' : 'steady',
    z4min, z5min, surges, kcal, burnSrc,
    dur: durParts.join(' / '), temp, note: noteParts.join(' · ')
  };
}

if(typeof module !== 'undefined' && module.exports){ module.exports = { parseFit, summarize }; }
if(typeof document === 'undefined') return;

// ---------------------------------------------------------------- Dropbox auth
function b64url(bytes){
  let s = ''; bytes.forEach(b => s += String.fromCharCode(b));
  return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
function lsGet(k){ try{ return localStorage.getItem(k); }catch(e){ return null; } }
function lsSet(k,v){ try{ localStorage.setItem(k,v); }catch(e){} }
function lsDel(k){ try{ localStorage.removeItem(k); }catch(e){} }

async function startConnect(){
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  const st = b64url(crypto.getRandomValues(new Uint8Array(12)));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  lsSet(LS_VERIFIER, verifier); lsSet(LS_STATE, st);
  location.href = 'https://www.dropbox.com/oauth2/authorize?client_id=' + DBX_KEY +
    '&response_type=code&token_access_type=offline&code_challenge_method=S256' +
    '&code_challenge=' + b64url(new Uint8Array(digest)) +
    '&redirect_uri=' + encodeURIComponent(DBX_REDIRECT) + '&state=' + st;
}

async function tokenRequest(params){
  const res = await fetch('https://api.dropboxapi.com/oauth2/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: DBX_KEY, ...params }).toString()
  });
  const j = await res.json().catch(() => ({}));
  if(!res.ok) throw new Error(j.error_description || j.error || ('Dropbox sign-in failed (' + res.status + ')'));
  return j;
}

// Runs once on page load: if Dropbox just sent us back with a code, finish the handshake.
let connectError = null;
const callbackDone = (async () => {
  const q = new URLSearchParams(location.search);
  const st = q.get('state');
  if(!st || st !== lsGet(LS_STATE)) return;
  try{
    if(q.get('code')){
      const j = await tokenRequest({ grant_type: 'authorization_code', code: q.get('code'),
        code_verifier: lsGet(LS_VERIFIER) || '', redirect_uri: DBX_REDIRECT });
      if(!j.refresh_token) throw new Error('Dropbox did not return a refresh token');
      lsSet(LS_REFRESH, j.refresh_token);
      access = { token: j.access_token, exp: Date.now() + (j.expires_in - 60) * 1000 };
    } else if(q.get('error')){
      throw new Error(q.get('error_description') || q.get('error'));
    }
  }catch(e){ connectError = e.message; }
  lsDel(LS_VERIFIER); lsDel(LS_STATE);
  history.replaceState(null, '', location.pathname);
})();

let access = null;
async function accessToken(){
  if(access && Date.now() < access.exp) return access.token;
  const rt = lsGet(LS_REFRESH);
  if(!rt) throw new Error('not connected');
  let j;
  try{ j = await tokenRequest({ grant_type: 'refresh_token', refresh_token: rt }); }
  catch(e){
    if(/invalid_grant|revoked|expired/i.test(e.message)){ lsDel(LS_REFRESH); throw new Error('Dropbox access was revoked. Connect again.'); }
    throw e;
  }
  access = { token: j.access_token, exp: Date.now() + (j.expires_in - 60) * 1000 };
  return access.token;
}

async function dbxRpc(path, body){
  const res = await fetch('https://api.dropboxapi.com/2/' + path, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + await accessToken(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if(!res.ok){
    const t = await res.text();
    if(/not_found/.test(t)) throw new Error('Folder ' + DBX_FOLDER + ' not found in Dropbox');
    throw new Error('Dropbox ' + path + ' failed (' + res.status + '): ' + t.slice(0, 160));
  }
  return res.json();
}

async function listFitFiles(){
  let out = [], j = await dbxRpc('files/list_folder', { path: DBX_FOLDER, limit: 2000 });
  out = out.concat(j.entries);
  while(j.has_more){ j = await dbxRpc('files/list_folder/continue', { cursor: j.cursor }); out = out.concat(j.entries); }
  return out.filter(e => e['.tag'] === 'file' && /\.fit$/i.test(e.name) && STAMP_RE.test(e.name))
            .sort((a,b) => a.name < b.name ? -1 : 1);
}

async function downloadFile(f){
  const res = await fetch('https://content.dropboxapi.com/2/files/download', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + await accessToken(), 'Dropbox-API-Arg': JSON.stringify({ path: f.id }) }
  });
  if(!res.ok) throw new Error('download failed (' + res.status + ')');
  return res.arrayBuffer();
}

// ---------------------------------------------------------------- Import
const sleep = ms => new Promise(r => setTimeout(r, ms));
function stampOf(name){ const m = name.match(STAMP_RE); return m ? m[0] : null; }
function stampLocalDate(stamp){
  const m = stamp.match(STAMP_RE);
  return ymdLocal(new Date(Date.UTC(+m[1], +m[2]-1, +m[3], +m[4], +m[5], +m[6])));
}
function ftpFor(date){
  const fs = (state.ftp || []).slice().sort((a,b) => a.date < b.date ? -1 : 1);
  if(!fs.length) return null;
  let v = fs[0].w; for(const f of fs){ if(f.date <= date) v = f.w; }
  return v;
}

// Insert only the new rows. Holds the page's sync lock so it can't interleave
// with a delete-and-reinsert of the rides table.
async function writeRides(newRides){
  while(_syncRunning) await sleep(150);
  _syncRunning = true;
  try{
    const { data: { user } } = await sb.auth.getUser();
    if(!user) throw new Error('not signed in');
    await chk('rides.insert', sb.from('rides').insert(newRides.map(r => ({
      user_id: user.id, date: r.date, title: r.title, ef: r.ef, vi: r.vi, type: r.type,
      z4min: r.z4min, z5min: r.z5min, surges: r.surges, kcal: r.kcal, burn_src: r.burnSrc,
      dur: r.dur, temp: r.temp, note: r.note }))));
    newRides.forEach(r => state.rides.push(r));
    state.rides.sort((a,b) => a.date < b.date ? 1 : -1);
    lsSet(KEY, JSON.stringify(state));
  } finally {
    _syncRunning = false;
    if(_syncQueued){ _syncQueued = false; scheduleSync(); }
  }
}

let busy = false;
async function importNew(){
  if(busy) return; busy = true; setBtn();
  try{
    msg('Checking Dropbox…');
    const files = await listFitFiles();
    const known = new Set();
    (state.rides || []).forEach(r => { const m = (r.note || '').match(/Wahoo (\d{4}-\d{2}-\d{2}-\d{6})/); if(m) known.add(m[1]); });
    const manualDates = new Set((state.rides || []).filter(r => !/Wahoo \d{4}-\d{2}-\d{2}-\d{6}/.test(r.note || '')).map(r => r.date));
    let skip; try{ skip = new Set(JSON.parse(lsGet(LS_SKIP) || '[]')); }catch(e){ skip = new Set(); }

    const added = [], failed = []; let already = 0;
    const todo = files.filter(f => !known.has(stampOf(f.name)));
    for(let i = 0; i < todo.length; i++){
      const f = todo[i], stamp = stampOf(f.name);
      if(skip.has(stamp) || manualDates.has(stampLocalDate(stamp))){ already++; continue; }
      msg('Reading ride ' + (i+1) + ' of ' + todo.length + '…');
      try{
        const ride = summarize(parseFit(await downloadFile(f)), f.name, ftpFor);
        if(manualDates.has(ride.date)){ already++; skip.add(stamp); continue; }
        added.push(ride);
      }catch(e){ failed.push(f.name + ' — ' + e.message); }
    }
    lsSet(LS_SKIP, JSON.stringify([...skip]));

    if(added.length){
      msg('Saving ' + added.length + ' ride' + (added.length === 1 ? '' : 's') + '…');
      await writeRides(added);
      try{ renderRides(); drawBalance(); renderFood(); }catch(e){ console.error(e); }
    }
    const t = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    let text = added.length
      ? 'Imported ' + added.length + ' ride' + (added.length === 1 ? '' : 's') + ' ✓ (' + added.map(r => r.date.slice(5)).join(', ') + ')'
      : 'No new rides. Checked ' + t + '.';
    if(already) text += ' ' + already + ' file' + (already === 1 ? '' : 's') + ' left alone (a ride is already logged on that date).';
    if(failed.length){ msg(text + ' Could not read: ' + failed.join('; '), '#e5484d'); }
    else msg(text, added.length ? 'var(--teal)' : '');
  }catch(e){
    msg('Dropbox import FAILED: ' + e.message, '#e5484d');
  }finally{ busy = false; setBtn(); }
}

// ---------------------------------------------------------------- UI
function msg(text, color){
  const el = document.getElementById('dbxMsg'); if(!el) return;
  el.style.color = color || ''; el.textContent = text;
}
function setBtn(){
  const b = document.getElementById('dbxBtn'), off = document.getElementById('dbxOff');
  if(!b) return;
  const connected = !!lsGet(LS_REFRESH);
  b.textContent = connected ? (busy ? 'Checking…' : 'Check for new rides') : 'Connect Dropbox';
  b.disabled = busy;
  b.className = connected ? '' : 'primary';
  if(off) off.style.display = connected ? '' : 'none';
}
function buildCard(){
  const host = document.querySelector('.dashCard[data-card="rides"]');
  if(!host || document.getElementById('dbxCard')) return;
  const card = document.createElement('div');
  card.className = 'card'; card.id = 'dbxCard'; card.style.marginBottom = '12px';
  card.innerHTML =
    '<div style="display:flex;align-items:center;gap:8px;">' +
      '<div style="flex:1;font-size:14px;font-weight:500;">Wahoo rides <span style="font-weight:400;color:var(--text-mute);font-size:12px;">via Dropbox</span></div>' +
      '<button id="dbxBtn" style="width:auto;padding:6px 12px;font-size:13px;"></button>' +
    '</div>' +
    '<p class="hint" id="dbxMsg"></p>' +
    '<p class="hint" id="dbxOff" style="cursor:pointer;text-decoration:underline;display:none;">Disconnect Dropbox</p>';
  const ctrl = host.querySelector('.cardCtrl');
  host.insertBefore(card, ctrl ? ctrl.nextSibling : host.firstChild);
  document.getElementById('dbxBtn').onclick = () => { if(lsGet(LS_REFRESH)) importNew(); else startConnect(); };
  document.getElementById('dbxOff').onclick = () => {
    if(!confirm('Disconnect Dropbox on this device? Imported rides stay in the log.')) return;
    lsDel(LS_REFRESH); access = null; setBtn(); msg('Disconnected.');
  };
}

// Wait until the page has signed in and loaded its data, then build the card
// and run one check.
let started = false;
async function boot(){
  if(started) return;
  let ready = false;
  try{ ready = !!state && typeof sb !== 'undefined' && typeof chk === 'function'; }catch(e){ ready = false; }
  if(!ready){ setTimeout(boot, 400); return; }
  started = true;
  await callbackDone;
  buildCard(); setBtn();
  if(connectError){ msg('Dropbox connection FAILED: ' + connectError, '#e5484d'); return; }
  if(lsGet(LS_REFRESH)) importNew();
  else msg('Connect once on each device to import rides automatically.');
}
boot();

// Read-only access for ride-export.js: the .fit file for a Wahoo stamp, raw
// ({ name, buf }) or parsed. Downloads are kept for the page's lifetime.
let fileList = null;
const fileCache = {};
async function fitFileForStamp(stamp){
  if(fileCache[stamp]) return fileCache[stamp];
  if(!lsGet(LS_REFRESH)) throw new Error('Dropbox is not connected on this device. Use Connect Dropbox in the Wahoo box first.');
  let f = (fileList || (fileList = await listFitFiles())).find(x => x.name.startsWith(stamp));
  if(!f){ fileList = await listFitFiles(); f = fileList.find(x => x.name.startsWith(stamp)); }
  if(!f) throw new Error('No file starting ' + stamp + ' in ' + DBX_FOLDER);
  return (fileCache[stamp] = { name: f.name, buf: await downloadFile(f) });
}
async function fitForStamp(stamp){ return parseFit((await fitFileForStamp(stamp)).buf); }
window.reckoningDropbox = { fitForStamp, fitFileForStamp };
})();
