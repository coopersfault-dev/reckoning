/* Reckoning — copy rides for Claude.
   Loaded after the main page script and dropbox-sync.js. Builds plain-text
   digests for pasting into a Claude conversation: one ride (from its Wahoo
   .fit file in Dropbox when it has one), or the last 14 days.
   Read-only: it writes nothing to Supabase. */
(function(){
'use strict';

const FIT_EPOCH = 631065600;            // seconds between 1970-01-01 and 1989-12-31
const STAMP_IN_NOTE = /Wahoo (\d{4}-\d{2}-\d{2}-\d{6})/;
const RED = '#e5484d';
// Coggan power zones, upper bound as a fraction of FTP (inclusive).
const ZONES = [['Z1 Active recovery', 0.55], ['Z2 Endurance', 0.75], ['Z3 Tempo', 0.90], ['Z4 Threshold', 1.05],
               ['Z5 VO2max', 1.20], ['Z6 Anaerobic', 1.50], ['Z7 Neuromuscular', Infinity]];
const BEST = [[5, '5s'], [30, '30s'], [60, '1min'], [300, '5min'], [1200, '20min'], [3600, '60min']];

// ---------------------------------------------------------------- maths
function val(x){ return (x === null || x === undefined || isNaN(x)) ? null : x; }
function sum(a){ let s = 0; for(const x of a) s += x; return s; }
function mean(a){ return a.length ? sum(a) / a.length : null; }
function maxOf(a){ let m = -Infinity; for(const x of a) if(x > m) m = x; return a.length ? m : null; }
function minOf(a){ let m = Infinity; for(const x of a) if(x < m) m = x; return a.length ? m : null; }
function rnd(x, d){ return x === null ? '?' : (d ? x.toFixed(d) : String(Math.round(x))); }
function hms(s){
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : String(m)) + ':' + String(x).padStart(2, '0');
}
function weekday(key){ const [y, m, d] = key.split('-').map(Number); return ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][new Date(y, m-1, d).getDay()]; }
function ymd(dt){ return dt.getFullYear() + '-' + String(dt.getMonth()+1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0'); }
const cToF = c => c * 9 / 5 + 32;

// One sample per second of moving time. Gaps up to 5 s are filled by holding
// the last value; longer gaps (auto-pause) are skipped.
function perSecond(recs){
  const s = { p: [], hr: [], cad: [] };
  const rs = recs.filter(r => val(r[253]) !== null);
  const src = rs.length ? rs : recs;
  for(let i = 0; i < src.length; i++){
    let n = 1;
    if(rs.length){
      n = i + 1 < rs.length ? rs[i+1][253] - rs[i][253] : 1;
      if(n <= 0) continue;
      if(n > 5) n = 1;
    }
    for(let k = 0; k < n; k++){ s.p.push(val(src[i][7]) || 0); s.hr.push(val(src[i][3])); s.cad.push(val(src[i][4])); }
  }
  return s;
}
function normalized(p){
  if(p.length < 30) return null;
  let roll = 0, acc = 0, n = 0;
  for(let i = 0; i < p.length; i++){
    roll += p[i]; if(i >= 30) roll -= p[i-30];
    if(i >= 29){ acc += Math.pow(roll / 30, 4); n++; }
  }
  return Math.pow(acc / n, 0.25);
}
function bestAvg(p, w){
  if(p.length < w) return null;
  let roll = 0, best = 0;
  for(let i = 0; i < p.length; i++){
    roll += p[i]; if(i >= w) roll -= p[i-w];
    if(i >= w - 1 && roll > best) best = roll;
  }
  return best / w;
}
function avgOf(a, nonZero){ const v = a.filter(x => x !== null && (!nonZero || x > 0)); return v.length ? mean(v) : null; }

// ---------------------------------------------------------------- digests
// ftp is { w, date } or null.
function fitDigest(fit, ride, ftp, stamp){
  const s = fit.session || {}, recs = fit.records || [];
  if(!fit.session && !recs.length) throw new Error('no ride data in the file');
  const S = perSecond(recs), p = S.p;
  const hasP = p.some(x => x > 0), hasHR = S.hr.some(x => x);
  const moving = val(s[8]) !== null ? s[8] / 1000 : p.length;
  const elapsed = val(s[7]) !== null ? s[7] / 1000 : moving;

  const avgP = hasP ? (val(s[20]) || mean(p)) : null;
  const np = hasP ? (val(s[34]) || normalized(p)) : null;
  const maxP = hasP ? (val(s[21]) || maxOf(p)) : null;
  const avgHR = hasHR ? (val(s[16]) || avgOf(S.hr)) : null;
  const maxHR = hasHR ? (val(s[17]) || maxOf(S.hr.filter(x => x))) : null;
  const cad = val(s[18]) || avgOf(S.cad, true);
  const kJ = val(s[48]) ? s[48] / 1000 : (hasP ? sum(p) / 1000 : null);
  const vi = (np && avgP) ? np / avgP : null;
  const ef = (np && avgHR) ? np / avgHR : null;

  const startTs = val(s[2]) || (recs.length ? val(recs[0][253]) : null);
  const start = startTs ? new Date((startTs + FIT_EPOCH) * 1000) : null;
  const date = start ? ymd(start) : ride.date;
  const temps = recs.map(r => val(r[13])).filter(x => x !== null);
  const indoor = s[6] === 6 || s[6] === 58;

  const L = [];
  L.push('RIDE DIGEST (Reckoning, from Wahoo file ' + stamp + ')');
  L.push('Date: ' + weekday(date) + ' ' + date + (start ? ', started ' + start.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : ''));
  L.push('Title: ' + (ride.title || 'untitled') + (indoor ? ' (indoor)' : ''));
  L.push('Duration: ' + hms(moving) + ' moving' + (Math.abs(elapsed - moving) >= 60 ? ', ' + hms(elapsed) + ' elapsed' : ''));
  const dist = val(s[9]) ? (s[9] / 100 / 1609.344).toFixed(1) + ' mi' : 'n/a';
  const climb = val(s[22]) !== null ? Math.round(s[22] * 3.28084) + ' ft' : 'n/a';
  L.push('Distance: ' + dist + ' | Climb: ' + climb);
  if(temps.length) L.push('Temperature: avg ' + rnd(cToF(mean(temps))) + 'F (' + rnd(cToF(minOf(temps))) + '-' + rnd(cToF(maxOf(temps))) + 'F)');
  else if(val(s[57]) !== null) L.push('Temperature: avg ' + rnd(cToF(s[57])) + 'F');
  else L.push('Temperature: n/a');
  L.push('FTP used: ' + (ftp ? ftp.w + ' W (set ' + ftp.date + ')' : 'none logged'));
  if(hasP) L.push('Power: avg ' + rnd(avgP) + ' W, normalized ' + rnd(np) + ' W, max ' + rnd(maxP) + ' W | VI ' + rnd(vi, 2) + (ftp && np ? ' | IF ' + (np / ftp.w).toFixed(2) : ''));
  else L.push('Power: no power data');
  L.push(hasHR ? 'Heart rate: avg ' + rnd(avgHR) + ', max ' + rnd(maxHR) + ' bpm' + (ef ? ' | EF (NP/avg HR) ' + ef.toFixed(2) : '') : 'Heart rate: no HR data');
  L.push('Cadence: ' + (cad ? 'avg ' + rnd(cad) + ' rpm' : 'n/a'));
  L.push('Work: ' + (kJ !== null ? rnd(kJ) + ' kJ' : 'n/a'));
  if(ride.note) L.push('Note in log: ' + ride.note);

  if(hasP && ftp){
    L.push('', 'Time in power zones (Coggan, FTP ' + ftp.w + ' W):');
    const secs = ZONES.map(() => 0);
    for(const x of p){ const r = x / ftp.w; secs[ZONES.findIndex(z => r <= z[1])]++; }
    let lo = 0;
    ZONES.forEach(([name, hi], i) => {
      const range = hi === Infinity ? '>' + Math.round(lo * ftp.w) + ' W' : (i ? Math.round(lo * ftp.w) + 1 : 0) + '-' + Math.round(hi * ftp.w) + ' W';
      L.push('  ' + name + ' (' + range + '): ' + hms(secs[i]) + ' (' + Math.round(secs[i] / p.length * 100) + '%)');
      lo = hi;
    });
  } else if(hasP){
    L.push('', 'Time in power zones: no FTP logged, so zones were not computed.');
  }

  if(hasP){
    L.push('', 'Best power:');
    L.push('  ' + BEST.map(([w, label]) => { const b = bestAvg(p, w); return label + ' ' + (b === null ? 'n/a' : Math.round(b) + ' W'); }).join(' | '));
  }

  if(p.length >= 10){
    const seg = p.length / 10;
    L.push('', '10 equal segments (' + hms(seg) + ' each, moving time):');
    for(let i = 0; i < 10; i++){
      const a = Math.round(i * seg), b = Math.round((i + 1) * seg);
      const sp = p.slice(a, b), sh = S.hr.slice(a, b), sc = S.cad.slice(a, b);
      L.push('  ' + String(i + 1).padStart(2) + '  ' + hms(a) + '-' + hms(b) +
        '  power ' + (hasP ? rnd(mean(sp)) + ' W' : 'n/a') +
        '  HR ' + (hasHR ? rnd(avgOf(sh)) : 'n/a') +
        '  cad ' + rnd(avgOf(sc, true)));
    }
  }

  if(hasP && hasHR && p.length >= 600){
    const h = Math.floor(p.length / 2);
    const p1 = mean(p.slice(0, h)), p2 = mean(p.slice(h)), h1 = avgOf(S.hr.slice(0, h)), h2 = avgOf(S.hr.slice(h));
    L.push('', 'Aerobic decoupling (avg power : avg HR, first half vs second half):');
    if(h1 && h2){
      const e1 = p1 / h1, e2 = p2 / h2;
      L.push('  1st half: ' + rnd(p1) + ' W / ' + rnd(h1) + ' bpm = ' + e1.toFixed(2));
      L.push('  2nd half: ' + rnd(p2) + ' W / ' + rnd(h2) + ' bpm = ' + e2.toFixed(2));
      L.push('  Decoupling: ' + ((e1 - e2) / e1 * 100).toFixed(1) + '% (under 5% is usually read as good aerobic durability)');
    } else L.push('  not enough HR data');
  }
  return L.join('\n');
}

// A ride as stored in the log (hand-entered, or when the file isn't available).
function storedLine(r){
  const parts = [r.date, r.title || 'untitled'];
  if(r.dur) parts.push(r.dur);
  if(r.kcal) parts.push(Math.round(r.kcal) + ' kcal' + (r.burnSrc === 'HR-est' ? ' (HR estimate)' : ''));
  if(r.type) parts.push(r.type);
  if(r.ef) parts.push('EF ' + r.ef);
  if(r.vi) parts.push('VI ' + r.vi);
  if(val(r.z4min) !== null) parts.push('Z4+ ' + r.z4min + ' min');
  if(val(r.z5min) !== null) parts.push('Z5+ ' + r.z5min + ' min');
  if(val(r.surges) !== null) parts.push(r.surges + ' surges');
  if(r.temp) parts.push(r.temp);
  return parts.join(' | ') + (r.note ? '\n    Note: ' + r.note : '');
}
function storedDigest(r, source){
  return 'RIDE (Reckoning ride log, ' + (source || 'entered by hand, no file') + ')\n' +
    'Date: ' + weekday(r.date) + ' ' + r.date + '\n' +
    'Title: ' + (r.title || 'untitled') + '\n' +
    (r.dur ? 'Duration: ' + r.dur + '\n' : '') +
    (r.kcal ? 'Calories: ' + Math.round(r.kcal) + ' kcal' + (r.burnSrc ? ' (' + r.burnSrc + ')' : '') + '\n' : '') +
    (r.type ? 'Type: ' + r.type + '\n' : '') +
    (r.ef ? 'EF: ' + r.ef + '\n' : '') + (r.vi ? 'VI: ' + r.vi + '\n' : '') +
    (val(r.z4min) !== null ? 'Time at Z4 or above: ' + r.z4min + ' min\n' : '') +
    (val(r.z5min) !== null ? 'Time at Z5 or above: ' + r.z5min + ' min\n' : '') +
    (val(r.surges) !== null ? 'Surges: ' + r.surges + '\n' : '') +
    (r.temp ? 'Temperature: ' + r.temp + '\n' : '') +
    (r.note ? 'Note: ' + r.note + '\n' : '');
}

if(typeof module !== 'undefined' && module.exports){ module.exports = { fitDigest, storedDigest, perSecond, bestAvg, normalized }; }
if(typeof document === 'undefined') return;

// ---------------------------------------------------------------- page data
function ftpOn(date){
  const fs = sortByDate(state.ftp || [], 'asc');
  let f = null; for(const x of fs){ if(x.date <= date) f = x; }
  return f || fs[0] || null;
}

function lastTwoWeeks(){
  const tk = todayKey(), from = dateShift(tk, -13), base = state.config.baseline;
  const f = latest(state.ftp || []), w = latest(state.weights || []);
  const L = [];
  L.push('RECKONING, LAST 14 DAYS (' + from + ' to ' + tk + '), exported ' + weekday(tk) + ' ' + new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }));
  L.push('Current FTP: ' + (f ? f.w + ' W (set ' + f.date + ')' : 'none logged'));
  L.push('Latest weight: ' + (w ? w.lb.toFixed(1) + ' lb (' + w.date + ')' : 'none logged') + (f && w ? ' | W/kg ' + (f.w / (w.lb * LB2KG)).toFixed(2) : ''));
  L.push('Daily food target: ' + TARGET.kcal + ' kcal, protein ' + TARGET.p + ' g, carbs ' + TARGET.c + ' g, fat ' + TARGET.f + ' g | baseline burn ' + base + ' kcal/day');

  const rides = sortByDate((state.rides || []).filter(r => r.date >= from && r.date <= tk), 'asc');
  L.push('', 'Rides (' + rides.length + '):');
  if(!rides.length) L.push('  none');
  rides.forEach(r => L.push('  ' + storedLine(r)));

  L.push('', 'Daily food and burn (eaten kcal, P/C/F g | ride burn | total out | net):');
  for(let d = from; d <= tk; d = dateShift(d, 1)){
    const t = dayFood(d), b = dayBurn(d), out = base + b;
    const logged = (state.food[d] && state.food[d].items && state.food[d].items.length) || state.dailyTotals[d];
    L.push('  ' + weekday(d) + ' ' + d + ': ' + (logged
      ? Math.round(t.kcal) + ' kcal, ' + Math.round(t.p) + '/' + Math.round(t.c) + '/' + Math.round(t.f) + ' | ' + Math.round(b) + ' | ' + Math.round(out) + ' | ' + (t.kcal - out >= 0 ? '+' : '') + Math.round(t.kcal - out)
      : 'no food logged | ' + Math.round(b) + ' | ' + Math.round(out)));
  }

  const ws = sortByDate((state.weights || []).filter(x => x.date >= from && x.date <= tk), 'asc');
  L.push('', 'Weights:');
  if(!ws.length) L.push('  none in this period');
  ws.forEach(x => L.push('  ' + x.date + ': ' + x.lb.toFixed(1) + ' lb'));
  const fts = sortByDate((state.ftp || []).filter(x => x.date >= from && x.date <= tk), 'asc');
  if(fts.length){ L.push('', 'FTP tests in this period:'); fts.forEach(x => L.push('  ' + x.date + ': ' + x.w + ' W' + (x.note ? ' (' + x.note + ')' : ''))); }

  L.push('', 'Plan, next 7 days:');
  for(let i = 0; i < 7; i++){
    const d = dateShift(tk, i), pl = state.plan[d];
    L.push('  ' + weekday(d) + ' ' + d + ': ' + (pl && (pl.what || pl.where) ? (pl.what || '-') + (pl.where ? ' @ ' + pl.where : '') : 'nothing planned'));
  }
  return L.join('\n');
}

// ---------------------------------------------------------------- UI
// The text goes in a box with its own Copy button: on iOS Safari a clipboard
// write only works directly inside a tap, not after waiting on a download.
function panel(host){
  let box = host.querySelector(':scope > .rxPanel');
  if(box) return box;
  box = document.createElement('div');
  box.className = 'rxPanel';
  box.style.cssText = 'margin-top:8px;';
  box.innerHTML =
    '<p class="hint rxMsg" style="margin:0 0 6px;"></p>' +
    '<textarea class="rxText" readonly rows="12" style="display:none;width:100%;font-family:ui-monospace,Menlo,monospace;font-size:12px;background:var(--surface-2);border:0.5px solid var(--border);border-radius:8px;padding:8px;color:var(--text);"></textarea>' +
    '<div style="display:flex;gap:8px;margin-top:6px;">' +
      '<button class="rxCopy primary" style="display:none;width:auto;padding:5px 14px;font-size:13px;">Copy</button>' +
      '<button class="rxClose" style="width:auto;padding:5px 14px;font-size:13px;">Close</button>' +
    '</div>';
  host.appendChild(box);
  box.querySelector('.rxClose').onclick = () => box.remove();
  box.querySelector('.rxCopy').onclick = () => copyFrom(box);
  return box;
}
function say(box, text, color){ const m = box.querySelector('.rxMsg'); m.textContent = text; m.style.color = color || ''; }
function show(box, text){
  const ta = box.querySelector('.rxText');
  ta.value = text; ta.style.display = '';
  box.querySelector('.rxCopy').style.display = '';
}
function copyFrom(box){
  const ta = box.querySelector('.rxText');
  const fallback = () => {
    ta.focus(); ta.select(); ta.setSelectionRange(0, ta.value.length);
    let ok = false; try{ ok = document.execCommand('copy'); }catch(e){}
    if(ok) say(box, 'Copied ✓ Paste it into your Claude conversation.', 'var(--teal)');
    else say(box, 'Could not copy automatically. The text is selected: use Copy from the menu.', RED);
  };
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(ta.value).then(
      () => say(box, 'Copied ✓ Paste it into your Claude conversation.', 'var(--teal)'),
      fallback);
  } else fallback();
}

async function rideDigest(btn, host, ride){
  const box = panel(host);
  const m = (ride.note || '').match(STAMP_IN_NOTE);
  if(!m){ show(box, storedDigest(ride)); say(box, 'Hand-entered ride: copied from the log fields.'); return; }
  btn.disabled = true;
  say(box, 'Downloading the ride file from Dropbox…');
  try{
    if(!window.reckoningDropbox) throw new Error('the Dropbox script did not load');
    const fit = await window.reckoningDropbox.fitForStamp(m[1]);
    show(box, fitDigest(fit, ride, ftpOn(ride.date), m[1]));
    say(box, 'Ready. Tap Copy.');
  }catch(e){
    show(box, '(The Wahoo file could not be read, so this is only what the ride log stores.)\n' + storedDigest(ride, 'Wahoo ride, stored fields only'));
    say(box, 'Could not build the full digest: ' + e.message, RED);
  }finally{ btn.disabled = false; }
}

function decorate(){
  const list = document.getElementById('rideList');
  if(!list || !state) return;
  const rides = sortByDate(state.rides || [], 'desc');   // same order renderRides() uses
  [...list.children].forEach((item, i) => {
    const ride = rides[i], host = item.firstElementChild;
    if(!ride || !host || host.querySelector('.rxBtn')) return;
    const b = document.createElement('button');
    b.className = 'rxBtn';
    b.textContent = 'Copy for Claude';
    b.style.cssText = 'width:auto;padding:3px 10px;font-size:12px;margin-top:6px;';
    b.onclick = () => rideDigest(b, host, ride);
    host.appendChild(b);
  });
}

function buildTop(){
  const list = document.getElementById('rideList');
  if(!list || document.getElementById('rxTop')) return;
  const top = document.createElement('div');
  top.id = 'rxTop'; top.style.cssText = 'margin:2px 0 10px;';
  const b = document.createElement('button');
  b.textContent = 'Copy last 14 days for Claude';
  b.style.cssText = 'width:auto;padding:5px 12px;font-size:13px;';
  b.onclick = () => {
    const box = panel(top);
    let text;
    try{ text = lastTwoWeeks(); }
    catch(e){ say(box, 'Could not build the 14-day summary: ' + e.message, RED); return; }
    show(box, text);
    copyFrom(box);   // still inside the tap, so this works on iOS too
  };
  top.appendChild(b);
  list.parentNode.insertBefore(top, list);
}

// Wait until the page has signed in and loaded its data. The ride log is
// rebuilt on every change, so re-add the buttons whenever it is.
function boot(){
  let ok = false;
  try{ ok = !!state && typeof sortByDate === 'function'; }catch(e){ ok = false; }
  const list = document.getElementById('rideList');
  if(!ok || !list){ setTimeout(boot, 400); return; }
  buildTop();
  decorate();
  new MutationObserver(decorate).observe(list, { childList: true });
}
boot();
})();
