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

// ---------------------------------------------------------------- full ride (CSV)
// Decodes every field of every record message, not just the ones the
// importer needs, plus laps and developer-field names. Nothing is averaged,
// smoothed or dropped: one CSV row per record message in the file.

// Base type (low 5 bits) -> [byte size, invalid value or null]
const BASE = { 0: [1, 0xFF], 1: [1, 0x7F], 2: [1, 0xFF], 3: [2, 0x7FFF], 4: [2, 0xFFFF], 5: [4, 0x7FFFFFFF],
  6: [4, 0xFFFFFFFF], 7: [1, null], 8: [4, null], 9: [8, null], 10: [1, 0], 11: [2, 0], 12: [4, 0], 13: [1, 0xFF],
  14: [8, null], 15: [8, null], 16: [8, null] };
function readOne(dv, p, t, le){
  switch(t){
    case 0: case 2: case 10: case 13: return dv.getUint8(p);
    case 1: return dv.getInt8(p);
    case 3: return dv.getInt16(p, le);
    case 4: case 11: return dv.getUint16(p, le);
    case 5: return dv.getInt32(p, le);
    case 6: case 12: return dv.getUint32(p, le);
    case 8: return dv.getFloat32(p, le);
    case 9: return dv.getFloat64(p, le);
    case 14: { const v = dv.getBigInt64(p, le); return v === 0x7FFFFFFFFFFFFFFFn ? null : Number(v); }
    case 15: { const v = dv.getBigUint64(p, le); return v === 0xFFFFFFFFFFFFFFFFn ? null : Number(v); }
    case 16: { const v = dv.getBigUint64(p, le); return v === 0n ? null : Number(v); }
  }
  return null;
}
// One field's value: a number, a string, an array of numbers, or null if invalid.
function readField(dv, p, size, type, le){
  const t = type & 0x1F, b = BASE[t];
  if(!b) return null;
  if(t === 7){
    let s = ''; const bytes = [];
    for(let i = 0; i < size; i++){ const c = dv.getUint8(p + i); if(!c) break; bytes.push(c); }
    try{ s = new TextDecoder().decode(new Uint8Array(bytes)); }catch(e){ s = String.fromCharCode(...bytes); }
    return s || null;
  }
  const n = Math.floor(size / b[0]);
  if(n < 1) return null;
  const vals = [];
  for(let i = 0; i < n; i++){
    let v = readOne(dv, p + i * b[0], t, le);
    if(v !== null && ((b[1] !== null && v === b[1]) || ((t === 8 || t === 9) && isNaN(v)))) v = null;
    vals.push(v);
  }
  if(n === 1) return vals[0];
  return vals.every(v => v === null) ? null : vals;
}

function decodeFull(buf){
  const dv = new DataView(buf);
  if(buf.byteLength < 14) throw new Error('file too small to be a FIT file');
  const hs = dv.getUint8(0);
  if(String.fromCharCode(dv.getUint8(8), dv.getUint8(9), dv.getUint8(10), dv.getUint8(11)) !== '.FIT') throw new Error('not a FIT file');
  const end = Math.min(buf.byteLength, hs + dv.getUint32(4, true));
  const defs = {}, records = [], laps = [], devDesc = {};
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
      const fields = [], dev = []; let size = 0;
      for(let i = 0; i < n; i++){ fields.push({ num: dv.getUint8(p), size: dv.getUint8(p+1), type: dv.getUint8(p+2) }); size += dv.getUint8(p+1); p += 3; }
      if(hasDev){
        const nd = dv.getUint8(p++);
        for(let i = 0; i < nd; i++){ dev.push({ num: dv.getUint8(p), size: dv.getUint8(p+1), idx: dv.getUint8(p+2) }); size += dv.getUint8(p+1); p += 3; }
      }
      defs[lt] = { g, le, fields, dev, size };
      continue;
    } else { def = defs[h & 0x0F]; }
    if(!def) throw new Error('corrupt FIT file (data before definition)');
    if(p + def.size > end) break;                    // truncated tail; keep what we have
    const m = {}; let q = p;
    for(const f of def.fields){ m[f.num] = readField(dv, q, f.size, f.type, def.le); q += f.size; }
    const devVals = {};
    for(const f of def.dev){
      const d = devDesc[f.idx + ':' + f.num];
      devVals[f.idx + ':' + f.num] = d ? readField(dv, q, f.size, d.type, def.le) : null;
      q += f.size;
    }
    if(compressedOff !== null){
      let ts = (lastTs & ~0x1F) + compressedOff;
      if(compressedOff < (lastTs & 0x1F)) ts += 32;
      m[253] = ts;
    }
    if(typeof m[253] === 'number') lastTs = m[253];
    if(def.g === 20){ m._dev = devVals; records.push(m); }
    else if(def.g === 19) laps.push({ start: m[2], end: m[253] });
    else if(def.g === 206 && typeof m[0] === 'number' && typeof m[1] === 'number')
      devDesc[m[0] + ':' + m[1]] = { type: m[2] || 0, name: m[3] || ('dev_' + m[0] + '_' + m[1]), units: m[8] || '' };
    p += def.size;
  }
  return { records, laps, devDesc };
}

// Record fields with a known meaning: [column, scale, offset]. Positions are
// semicircles, converted to degrees. Anything else goes out raw as field_<n>.
const REC = {
  7: ['power_w'], 3: ['heart_rate_bpm'], 4: ['cadence_rpm'], 53: ['fractional_cadence_rpm', 128],
  6: ['speed_m_s', 1000], 73: ['enhanced_speed_m_s', 1000], 5: ['distance_m', 100],
  2: ['altitude_m', 5, 500], 78: ['enhanced_altitude_m', 5, 500], 13: ['temperature_c'], 9: ['grade_pct', 100],
  0: ['lat_deg'], 1: ['long_deg'], 32: ['vertical_speed_m_s', 1000], 29: ['accumulated_power_j'],
  30: ['left_right_balance_raw'], 31: ['gps_accuracy_m'], 33: ['calories_kcal'],
  43: ['left_torque_effectiveness_pct', 2], 44: ['right_torque_effectiveness_pct', 2],
  45: ['left_pedal_smoothness_pct', 2], 46: ['right_pedal_smoothness_pct', 2], 47: ['combined_pedal_smoothness_pct', 2]
};
const SEMI = 180 / 2147483648;
function scaled(num, v){
  if(v === null || v === undefined) return '';
  if(Array.isArray(v)) return v.map(x => x === null ? '' : x).join('|');
  if(typeof v !== 'number') return v;
  if(num === 0 || num === 1) return (v * SEMI).toFixed(7);
  const k = REC[num];
  if(!k || !k[1]) return String(v);
  return String(+((v / k[1]) - (k[2] || 0)).toFixed(7));
}
function csvCell(x){ x = String(x); return /[",\n\r]/.test(x) ? '"' + x.replace(/"/g, '""') + '"' : x; }
function pad2(n){ return String(n).padStart(2, '0'); }

function rideCsv(buf){
  const { records, laps, devDesc } = decodeFull(buf);
  if(!records.length) throw new Error('no per-second records in the file');
  const present = new Set(), devPresent = new Set();
  records.forEach(r => {
    Object.keys(r).forEach(k => { if(k !== '_dev' && k !== '253' && r[k] !== null) present.add(+k); });
    Object.keys(r._dev).forEach(k => { if(r._dev[k] !== null) devPresent.add(k); });
  });
  const order = Object.keys(REC).map(Number);
  const cols = order.filter(n => present.has(n)).concat([...present].filter(n => !REC[n]).sort((a, b) => a - b));
  const devCols = [...devPresent].sort();
  const header = ['timestamp_utc', 'time_local', 'elapsed_s', 'lap', 'lap_start']
    .concat(cols.map(n => REC[n] ? REC[n][0] : 'field_' + n))
    .concat(devCols.map(k => 'dev_' + devDesc[k].name.replace(/\W+/g, '_') + (devDesc[k].units ? '_' + devDesc[k].units.replace(/\W+/g, '_') : '')));

  const lapStarts = laps.map(l => l.start).filter(x => typeof x === 'number').sort((a, b) => a - b);
  const t0 = records.find(r => typeof r[253] === 'number');
  const first = t0 ? t0[253] : null;
  const lines = [header.join(',')];
  let lastLap = 0;
  records.forEach(r => {
    const ts = typeof r[253] === 'number' ? r[253] : null;
    let utc = '', local = '', el = '', lap = '', lapStart = '';
    if(ts !== null){
      const d = new Date((ts + FIT_EPOCH) * 1000);
      utc = d.toISOString().replace('.000Z', 'Z');
      local = pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
      el = ts - first;
      if(lapStarts.length){
        let n = 0; for(const s of lapStarts){ if(s <= ts) n++; }
        lap = Math.max(1, n);
        if(lap !== lastLap){ lapStart = 1; lastLap = lap; }
      }
    }
    lines.push([utc, local, el, lap, lapStart]
      .concat(cols.map(n => scaled(n, r[n])))
      .concat(devCols.map(k => scaled(-1, r._dev[k])))
      .map(csvCell).join(','));
  });
  return { text: lines.join('\n') + '\n', rows: records.length, columns: header.length, laps: lapStarts.length };
}

function fileBase(ride){
  const slug = String(ride.title || 'ride').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'ride';
  return ride.date + '-' + slug;
}

if(typeof module !== 'undefined' && module.exports){ module.exports = { fitDigest, storedDigest, perSecond, bestAvg, normalized, decodeFull, rideCsv, fileBase }; }
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
// Results go in a box with their own Copy button or Save link: on iOS Safari a
// clipboard write or download only works directly inside a tap, not after
// waiting on Dropbox.
function panel(host){
  let box = host.querySelector(':scope > .rxPanel');
  if(box) return box;
  box = document.createElement('div');
  box.className = 'rxPanel';
  box.style.cssText = 'margin-top:8px;';
  box.innerHTML =
    '<p class="hint rxMsg" style="margin:0 0 6px;"></p>' +
    '<textarea class="rxText" readonly rows="12" style="display:none;width:100%;font-family:ui-monospace,Menlo,monospace;font-size:12px;background:var(--surface-2);border:0.5px solid var(--border);border-radius:8px;padding:8px;color:var(--text);"></textarea>' +
    '<div style="display:flex;gap:8px;margin-top:6px;align-items:center;">' +
      '<button class="rxCopy primary" style="display:none;width:auto;padding:5px 14px;font-size:13px;">Copy</button>' +
      '<a class="rxSave" style="display:none;background:var(--blue);color:#fff;border-radius:8px;padding:5px 14px;font-size:13px;text-decoration:none;"></a>' +
      '<button class="rxClose" style="width:auto;padding:5px 14px;font-size:13px;">Close</button>' +
    '</div>';
  host.appendChild(box);
  box.querySelector('.rxClose').onclick = () => { clearSave(box); box.remove(); };
  box.querySelector('.rxCopy').onclick = () => copyFrom(box);
  return box;
}
function say(box, text, color){ const m = box.querySelector('.rxMsg'); m.textContent = text; m.style.color = color || ''; }
function clearSave(box){
  const a = box.querySelector('.rxSave');
  if(a.href) URL.revokeObjectURL(a.href);
  a.removeAttribute('href'); a.style.display = 'none';
}
function show(box, text){
  clearSave(box);
  const ta = box.querySelector('.rxText');
  ta.value = text; ta.style.display = '';
  box.querySelector('.rxCopy').style.display = '';
}
function offerFile(box, blob, name){
  clearSave(box);
  box.querySelector('.rxText').style.display = 'none';
  box.querySelector('.rxCopy').style.display = 'none';
  const a = box.querySelector('.rxSave');
  a.href = URL.createObjectURL(blob); a.download = name;
  a.textContent = 'Save ' + name + ' (' + (blob.size >= 1048576 ? (blob.size / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(blob.size / 1024)) + ' KB') + ')';
  a.style.display = '';
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

// kind 'csv': every record in the file as CSV. kind 'fit': the original file, byte for byte.
async function rideFile(btn, host, ride, stamp, kind){
  const box = panel(host);
  clearSave(box);
  box.querySelector('.rxText').style.display = 'none';
  box.querySelector('.rxCopy').style.display = 'none';
  btn.disabled = true;
  say(box, 'Downloading the ride file from Dropbox…');
  try{
    if(!window.reckoningDropbox || !window.reckoningDropbox.fitFileForStamp) throw new Error('the Dropbox script did not load');
    const file = await window.reckoningDropbox.fitFileForStamp(stamp);
    if(kind === 'fit'){
      offerFile(box, new Blob([file.buf], { type: 'application/octet-stream' }), fileBase(ride) + '.fit');
      say(box, 'Original file from Dropbox (' + file.name + '), unchanged. Tap Save.');
    } else {
      say(box, 'Building the CSV…');
      const csv = rideCsv(file.buf);
      offerFile(box, new Blob([csv.text], { type: 'text/csv' }), fileBase(ride) + '.csv');
      say(box, csv.rows.toLocaleString() + ' rows × ' + csv.columns + ' columns' + (csv.laps ? ', ' + csv.laps + ' lap' + (csv.laps === 1 ? '' : 's') : '') + '. Tap Save.');
    }
  }catch(e){
    say(box, 'Could not prepare the ' + (kind === 'fit' ? '.fit file' : 'CSV') + ': ' + e.message, RED);
  }finally{ btn.disabled = false; }
}

function smallBtn(label, onclick){
  const b = document.createElement('button');
  b.className = 'rxBtn'; b.textContent = label;
  b.style.cssText = 'width:auto;padding:3px 10px;font-size:12px;';
  b.onclick = () => onclick(b);
  return b;
}
function decorate(){
  const list = document.getElementById('rideList');
  if(!list || !state) return;
  const rides = sortByDate(state.rides || [], 'desc');   // same order renderRides() uses
  [...list.children].forEach((item, i) => {
    const ride = rides[i], host = item.querySelector('.rideDetail') || item.firstElementChild;
    if(!ride || !host || host.querySelector('.rxBtn')) return;
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;margin-top:6px;';
    row.appendChild(smallBtn('Copy summary', b => rideDigest(b, host, ride)));
    const m = (ride.note || '').match(STAMP_IN_NOTE);
    if(m){
      row.appendChild(smallBtn('Download full ride', b => rideFile(b, host, ride, m[1], 'csv')));
      row.appendChild(smallBtn('Download .fit', b => rideFile(b, host, ride, m[1], 'fit')));
    }
    host.appendChild(row);
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
