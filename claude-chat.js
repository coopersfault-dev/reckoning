/* Reckoning — Claude chat.
   Loaded after the main page script. Adds a chat card above the dashboard.
   Claude can log food, log weight, add a summary to a ride, and PROPOSE plan
   changes (nothing in the plan changes until the Apply button is tapped).
   Every write is a targeted row insert/update/delete, made while holding the
   page's _syncRunning lock. It never calls save() or pushState().
   The Anthropic key never reaches the browser: calls go through the Supabase
   Edge Function "claude". */
(function(){
'use strict';

const RED = '#e5484d';
const MAX_ROUNDS = 6;          // Claude calls per message (tool loop)
const KEEP = 24;               // messages of history sent each call
const sleep = ms => new Promise(r => setTimeout(r, ms));

let history = [];
let busy = false;

// ---------------------------------------------------------------- small helpers
function clean(s, max){
  return String(s === undefined || s === null ? '' : s).replace(/[<>&]/g, '').trim().slice(0, max || 200);
}
function isDate(d){
  if(typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  const [y, m, x] = d.split('-').map(Number), dt = new Date(y, m-1, x);
  return dt.getFullYear() === y && dt.getMonth() === m-1 && dt.getDate() === x;
}
function weekday(d){ const [y, m, x] = d.split('-').map(Number); return ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][new Date(y, m-1, x).getDay()]; }
function num(v, lo, hi, label){
  const n = Number(v);
  if(!isFinite(n) || n < lo || n > hi) throw new Error(label + ' must be a number from ' + lo + ' to ' + hi + ' (got ' + v + ')');
  return n;
}
async function userId(){
  const { data: { user } } = await sb.auth.getUser();
  if(!user) throw new Error('not signed in');
  return user.id;
}

// Same lock pattern as writeRides in dropbox-sync.js.
async function withLock(fn){
  while(_syncRunning) await sleep(150);
  _syncRunning = true;
  try{ return await fn(); }
  finally{
    _syncRunning = false;
    if(_syncQueued){ _syncQueued = false; scheduleSync(); }
  }
}
// Only called after the Supabase write succeeded.
function keepLocal(){
  try{ localStorage.setItem(KEY, JSON.stringify(state)); }
  catch(e){ line('Saved to the cloud, but the copy on this device failed: ' + e.message, 'err'); }
}
function redraw(){
  const fns = { renderFood, drawBalance, drawMacros, renderStats, draw, renderWeightLast, renderWeek, renderChecklist, renderRides };
  const bad = [];
  Object.keys(fns).forEach(k => { try{ fns[k](); }catch(e){ bad.push(k + ': ' + e.message); } });
  if(bad.length) line('Saved, but part of the screen did not refresh (reload to see it): ' + bad.join('; '), 'err');
}

// ---------------------------------------------------------------- UI
function line(text, kind){
  const log = document.getElementById('ccLog'); if(!log) return null;
  const p = document.createElement('div');
  p.style.cssText = 'margin:0 0 8px;white-space:pre-wrap;line-height:1.45;font-size:14px;';
  if(kind === 'you'){ p.style.color = 'var(--text-dim)'; p.textContent = 'You: ' + text; }
  else if(kind === 'err'){ p.style.color = RED; p.textContent = '⚠ ' + text; }
  else if(kind === 'ok'){ p.style.color = 'var(--teal)'; p.textContent = '✓ ' + text; }
  else if(kind === 'info'){ p.style.color = 'var(--text-mute)'; p.style.fontSize = '12px'; p.textContent = text; }
  else { p.style.color = 'var(--text)'; p.textContent = text; }
  log.appendChild(p);
  log.scrollTop = log.scrollHeight;
  return p;
}
function setBusy(b){
  busy = b;
  const btn = document.getElementById('ccSend');
  if(btn){ btn.disabled = b; btn.textContent = b ? 'Thinking…' : 'Send'; }
}
function buildCard(){
  const stack = document.getElementById('cardStack');
  if(!stack || document.getElementById('ccCard')) return;
  const card = document.createElement('div');
  card.className = 'card'; card.id = 'ccCard'; card.style.marginBottom = '12px';

  const head = document.createElement('div');
  head.style.cssText = 'font-size:14px;font-weight:500;margin-bottom:8px;';
  head.textContent = 'Claude';
  const log = document.createElement('div');
  log.id = 'ccLog';
  log.style.cssText = 'max-height:280px;overflow-y:auto;margin-bottom:8px;';
  const ta = document.createElement('textarea');
  ta.id = 'ccInput'; ta.rows = 2;
  ta.placeholder = '2 eggs, toast with butter, coffee with cream';
  ta.style.cssText = 'width:100%;box-sizing:border-box;font-family:inherit;font-size:14px;background:var(--surface-2);border:0.5px solid var(--border);border-radius:8px;padding:8px;color:var(--text);';
  const btn = document.createElement('button');
  btn.id = 'ccSend'; btn.textContent = 'Send';
  btn.style.cssText = 'width:auto;padding:6px 14px;font-size:13px;margin-top:6px;';

  card.append(head, log, ta, btn);
  stack.parentNode.insertBefore(card, stack);

  const go = () => {
    const t = ta.value.trim();
    if(!t || busy) return;
    ta.value = '';
    line(t, 'you');
    send(t);
  };
  btn.onclick = go;
  ta.addEventListener('keydown', e => { if(e.key === 'Enter' && !e.shiftKey){ e.preventDefault(); go(); } });
  line('Tell me what you ate, what you weighed, or ask about your training.', 'info');
}

// ---------------------------------------------------------------- system prompt
function systemPrompt(){
  const today = todayKey();
  const ftpRow = latest(state.ftp || []), wRow = latest(state.weights || []);
  const ftp = ftpRow ? ftpRow.w : null, lb = wRow ? wRow.lb : null;
  const wkg = ftp && lb ? (ftp / (lb / 2.20462)).toFixed(2) : '?';
  const baseline = state.config && state.config.baseline;
  const r = x => Math.round(x || 0);

  const todayItems = ((state.food[today] || {}).items || [])
    .map(i => '- ' + i.name + ': ' + r(i.kcal) + ' kcal, P' + r(i.p) + ' C' + r(i.c) + ' F' + r(i.f)).join('\n') || '- (nothing logged yet)';
  const week = [];
  for(let i = 0; i < 7; i++){
    const d = dateShift(today, -i), f = dayFood(d), b = dayBurn(d);
    week.push('- ' + d + ' ' + weekday(d) + ': eaten ' + r(f.kcal) + ' kcal (P' + r(f.p) + ' C' + r(f.c) + ' F' + r(f.f) + '), ride burn ' + r(b) + ' kcal');
  }
  const rides = sortByDate(state.rides || [], 'desc').slice(0, 8).map(x =>
    '- ' + x.date + ' ' + (x.title || '(untitled)') + ' | type ' + (x.type || '?') + ' | dur ' + (x.dur || '?') +
    ' | ' + r(x.kcal) + ' kcal | EF ' + (x.ef || '?') + ' | VI ' + (x.vi || '?') + ' | Z4 ' + (x.z4min || 0) + 'min Z5 ' + (x.z5min || 0) + 'min' +
    (x.note ? ' | note: ' + x.note : '')).join('\n') || '- (none)';
  const plan = [];
  for(let i = 0; i < 7; i++){
    const d = dateShift(today, i), p = (state.plan || {})[d];
    plan.push('- ' + d + ' ' + weekday(d) + ': ' + (p && (p.what || p.where) ? (p.what || '') + (p.where ? ' @ ' + p.where : '') : '(nothing planned)'));
  }
  const saved = (state.saved || []).map(m => '- ' + m.name + ': ' + r(m.kcal) + ' kcal, P' + r(m.p) + ' C' + r(m.c) + ' F' + r(m.f)).join('\n') || '- (none)';

  return [
    'You are the assistant inside Reckoning, Craig\'s cycling and nutrition tracker.',
    'Today is ' + today + ' (' + weekday(today) + ').',
    '',
    'NOW: FTP ' + (ftp || '?') + ' W, weight ' + (lb || '?') + ' lb, ' + wkg + ' W/kg. Baseline daily burn ' + (baseline || '?') + ' kcal.',
    'Daily target: ' + TARGET.kcal + ' kcal, protein ' + TARGET.p + ' g, carbs ' + TARGET.c + ' g, fat ' + TARGET.f + ' g.',
    '',
    'FOOD LOGGED TODAY:', todayItems, '',
    'LAST 7 DAYS:', week.join('\n'), '',
    'LAST 8 RIDES:', rides, '',
    'PLAN, NEXT 7 DAYS:', plan.join('\n'), '',
    'SAVED MEALS (use these exact numbers when the name matches):', saved, '',
    'RULES:',
    '- Reply in plain text, no markdown, 1 to 4 short sentences.',
    '- When Craig says he ate something, log it immediately with add_food using typical portions, then briefly state the portion assumption you made.',
    '- If a food matches a saved meal name, use the saved meal numbers.',
    '- When he gives a weight, log it with log_weight.',
    '- Never invent data. If something is not in the data above, say you do not have it.',
    '- You can only PROPOSE plan changes with propose_plan. Never say the plan was changed; Craig applies it himself.',
    '- If a tool returns an error, tell Craig plainly that it did not save.'
  ].join('\n');
}

// ---------------------------------------------------------------- tools
const TOOLS = [
  { name: 'add_food',
    description: 'Save food Craig ate to his food log. Date defaults to today; only today and the previous 7 days are allowed.',
    input_schema: { type: 'object', properties: {
      date: { type: 'string', description: 'YYYY-MM-DD, optional' },
      items: { type: 'array', items: { type: 'object', properties: {
        name: { type: 'string' }, kcal: { type: 'number' }, protein_g: { type: 'number' },
        carbs_g: { type: 'number' }, fat_g: { type: 'number' } },
        required: ['name','kcal','protein_g','carbs_g','fat_g'] } } },
      required: ['items'] } },
  { name: 'log_weight',
    description: 'Save Craig\'s body weight in pounds. Replaces any weight already logged on that date. Date defaults to today.',
    input_schema: { type: 'object', properties: {
      date: { type: 'string', description: 'YYYY-MM-DD, optional' },
      lb: { type: 'number' } }, required: ['lb'] } },
  { name: 'annotate_ride',
    description: 'Add a 1-2 sentence summary to a logged ride. Give the title too if there could be more than one ride that day.',
    input_schema: { type: 'object', properties: {
      date: { type: 'string', description: 'YYYY-MM-DD' },
      title: { type: 'string' }, summary: { type: 'string' } }, required: ['date','summary'] } },
  { name: 'propose_plan',
    description: 'Show Craig a proposed change to upcoming plan days. Nothing changes until he taps Apply.',
    input_schema: { type: 'object', properties: {
      changes: { type: 'array', items: { type: 'object', properties: {
        date: { type: 'string', description: 'YYYY-MM-DD' }, what: { type: 'string' }, where: { type: 'string' } },
        required: ['date','what'] } },
      reason: { type: 'string' } }, required: ['changes','reason'] } }
];

async function addFood(input){
  const today = todayKey();
  const date = input.date || today;
  if(!isDate(date)) throw new Error('bad date "' + date + '"');
  if(date > today || date < dateShift(today, -7)) throw new Error('food can only be logged for today or the previous 7 days (got ' + date + ')');
  const items = Array.isArray(input.items) ? input.items : [];
  if(!items.length || items.length > 20) throw new Error('need 1 to 20 food items');
  const rows = items.map(it => {
    const name = clean(it.name, 120);
    if(!name) throw new Error('a food item has no name');
    return { name, kcal: Math.round(num(it.kcal, 0, 5000, name + ' kcal')),
      p: Math.round(num(it.protein_g, 0, 500, name + ' protein')),
      c: Math.round(num(it.carbs_g, 0, 1000, name + ' carbs')),
      f: Math.round(num(it.fat_g, 0, 500, name + ' fat')) };
  });
  await withLock(async () => {
    const uid = await userId();
    await chk('food_items.insert', sb.from('food_items').insert(rows.map(x => ({
      user_id: uid, date, name: x.name, kcal: x.kcal, protein: x.p, carbs: x.c, fat: x.f }))));
    if(!state.food[date]) state.food[date] = { items: [] };
    if(!state.food[date].items) state.food[date].items = [];
    rows.forEach(x => state.food[date].items.push(x));
    if(state.dailyTotals) state.dailyTotals[date] = dayFood(date);
    keepLocal();
  });
  redraw();
  const total = rows.reduce((a, x) => a + x.kcal, 0);
  line('Logged ' + rows.map(x => x.name + ' ' + x.kcal).join(', ') + ' (' + total + ' kcal) on ' + date, 'ok');
  return 'Saved ' + rows.length + ' item(s), ' + total + ' kcal, to ' + date + '. Day total now ' + Math.round(dayFood(date).kcal) + ' kcal.';
}

async function logWeight(input){
  const today = todayKey();
  const date = input.date || today;
  if(!isDate(date)) throw new Error('bad date "' + date + '"');
  if(date > today) throw new Error('cannot log a weight in the future (' + date + ')');
  const lb = Math.round(num(input.lb, 80, 400, 'weight') * 10) / 10;
  await withLock(async () => {
    const uid = await userId();
    await chk('weights.delete', sb.from('weights').delete().eq('user_id', uid).eq('date', date));
    await chk('weights.insert', sb.from('weights').insert({ user_id: uid, date, lb }));
    state.weights = (state.weights || []).filter(w => w.date !== date);
    state.weights.push({ date, lb });
    keepLocal();
  });
  redraw();
  line('Logged weight ' + lb + ' lb on ' + date, 'ok');
  return 'Saved ' + lb + ' lb for ' + date + '.';
}

async function annotateRide(input){
  const date = input.date;
  if(!isDate(date)) throw new Error('bad date "' + date + '"');
  const title = input.title ? clean(input.title, 120) : '';
  const summary = clean(input.summary, 400);
  if(!summary) throw new Error('summary is empty');
  let newNote = '';
  await withLock(async () => {
    const uid = await userId();
    let q = sb.from('rides').select('*').eq('user_id', uid).eq('date', date);
    if(title) q = q.eq('title', title);
    const found = (await chk('rides.select', q)).data || [];
    if(!found.length) throw new Error('no ride found on ' + date + (title ? ' titled "' + title + '"' : ''));
    if(found.length > 1) throw new Error(found.length + ' rides on ' + date + '; give the exact title: ' + found.map(x => '"' + (x.title || '') + '"').join(', '));
    const row = found[0], old = row.note || '';
    if(old.includes(summary)) { newNote = old; return; }
    newNote = old ? old + ' — ' + summary : summary;
    let u = sb.from('rides').update({ note: newNote }).eq('user_id', uid).eq('date', date);
    if(row.id !== undefined && row.id !== null) u = u.eq('id', row.id);
    else {
      u = row.title === null || row.title === undefined ? u.is('title', null) : u.eq('title', row.title);
      u = row.note === null || row.note === undefined ? u.is('note', null) : u.eq('note', row.note);
    }
    const res = await chk('rides.update', u.select());
    if(!res.data || !res.data.length) throw new Error('ride on ' + date + ' was not updated (0 rows changed)');
    (state.rides || []).forEach(x => {
      if(x.date === date && (x.title || '') === (row.title || '') && (x.note || '') === old) x.note = newNote;
    });
    keepLocal();
  });
  redraw();
  line('Added summary to ride on ' + date, 'ok');
  return 'Ride on ' + date + ' now has note: ' + newNote;
}

function proposePlan(input){
  const today = todayKey();
  const changes = Array.isArray(input.changes) ? input.changes : [];
  if(!changes.length || changes.length > 14) throw new Error('need 1 to 14 plan changes');
  const list = changes.map(ch => {
    if(!isDate(ch.date)) throw new Error('bad date "' + ch.date + '"');
    if(ch.date < today) throw new Error('can only propose changes for today or later (got ' + ch.date + ')');
    return { date: ch.date, what: clean(ch.what, 200), where: clean(ch.where, 120) };
  });
  const reason = clean(input.reason, 400);

  const log = document.getElementById('ccLog');
  const box = document.createElement('div');
  box.style.cssText = 'margin:0 0 8px;padding:8px;border:0.5px solid var(--border);border-radius:8px;font-size:13px;line-height:1.5;';
  const h = document.createElement('div'); h.style.fontWeight = '500';
  h.textContent = 'Proposed plan change (nothing changed yet)';
  box.appendChild(h);
  list.forEach(c => {
    const d = document.createElement('div');
    d.textContent = weekday(c.date) + ' ' + c.date.slice(5) + ': ' + (c.what || '(clear the day)') + (c.where ? ' @ ' + c.where : '');
    box.appendChild(d);
  });
  if(reason){ const r = document.createElement('div'); r.style.color = 'var(--text-dim)'; r.textContent = 'Why: ' + reason; box.appendChild(r); }
  const btn = document.createElement('button');
  btn.textContent = 'Apply'; btn.className = 'primary';
  btn.style.cssText = 'width:auto;padding:5px 14px;font-size:13px;margin-top:6px;';
  btn.onclick = async () => {
    btn.disabled = true; btn.textContent = 'Applying…';
    try{
      await applyPlan(list);
      btn.textContent = 'Applied ✓';
    }catch(e){
      line('Plan change FAILED: ' + e.message + ' (reload the page to see what the plan holds now)', 'err');
      btn.disabled = false; btn.textContent = 'Apply';
    }
  };
  box.appendChild(btn);
  log.appendChild(box);
  log.scrollTop = log.scrollHeight;
  return 'Proposal shown to Craig with an Apply button. Nothing has changed; he decides.';
}

async function applyPlan(list){
  const dates = list.map(c => c.date);
  await withLock(async () => {
    const uid = await userId();
    await chk('daily_plan.delete', sb.from('daily_plan').delete().eq('user_id', uid).in('date', dates));
    const rows = list.filter(c => c.what || c.where).map(c => ({ user_id: uid, date: c.date, what: c.what || null, where_: c.where || null }));
    if(rows.length) await chk('daily_plan.insert', sb.from('daily_plan').insert(rows));
    if(!state.plan) state.plan = {};
    list.forEach(c => { if(c.what || c.where) state.plan[c.date] = { what: c.what, where: c.where }; else delete state.plan[c.date]; });
    keepLocal();
  });
  redraw();
  line('Plan updated for ' + dates.join(', '), 'ok');
}

async function runTool(name, input){
  input = input || {};
  if(name === 'add_food') return addFood(input);
  if(name === 'log_weight') return logWeight(input);
  if(name === 'annotate_ride') return annotateRide(input);
  if(name === 'propose_plan') return proposePlan(input);
  throw new Error('unknown tool ' + name);
}

// ---------------------------------------------------------------- Claude call + tool loop
async function callClaude(){
  const { data: { session } } = await sb.auth.getSession();
  if(!session) throw new Error('not signed in');
  let res;
  try{
    res = await fetch(SUPABASE_URL + '/functions/v1/claude', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + session.access_token, 'apikey': SUPABASE_PUBLISHABLE_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ system: systemPrompt(), messages: history, tools: TOOLS })
    });
  }catch(e){ throw new Error('could not reach the Claude function: ' + e.message); }
  const text = await res.text();
  let body = null; try{ body = JSON.parse(text); }catch(e){}
  if(!res.ok){
    const m = body && body.error && body.error.message ? body.error.message : text.slice(0, 300);
    throw new Error('Claude call failed (' + res.status + '): ' + m);
  }
  if(!body || !Array.isArray(body.content)) throw new Error('Claude sent back something unexpected: ' + text.slice(0, 200));
  return body;
}

// Keep the last KEEP messages, never starting on an assistant turn or on a
// user turn that only carries tool results (their tool_use would be cut off).
function trimHistory(){
  if(history.length > KEEP) history = history.slice(-KEEP);
  const plainUser = m => m.role === 'user' && (typeof m.content === 'string' || !m.content.some(b => b.type === 'tool_result'));
  while(history.length && !plainUser(history[0])) history.shift();
}

function pushUser(text){
  const last = history[history.length - 1];
  if(last && last.role === 'user'){
    // e.g. the previous turn stopped after tool results; join instead of two user turns in a row
    const blocks = typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : last.content;
    last.content = blocks.concat([{ type: 'text', text }]);
  } else history.push({ role: 'user', content: text });
}

async function send(text){
  setBusy(true);
  const before = JSON.stringify(history);
  try{
    pushUser(text);
    for(let round = 0; round < MAX_ROUNDS; round++){
      trimHistory();
      const resp = await callClaude();
      history.push({ role: 'assistant', content: resp.content });
      resp.content.filter(b => b.type === 'text' && b.text.trim()).forEach(b => line(b.text.trim()));
      if(resp.stop_reason === 'refusal') line('Claude declined to answer that.', 'err');
      if(resp.stop_reason === 'max_tokens') line('Claude\'s reply was cut off (too long).', 'err');
      const uses = resp.content.filter(b => b.type === 'tool_use');
      if(!uses.length) return;
      const results = [];
      for(const u of uses){
        try{
          results.push({ type: 'tool_result', tool_use_id: u.id, content: String(await runTool(u.name, u.input)) });
        }catch(e){
          line(u.name + ' FAILED, nothing saved: ' + e.message, 'err');
          results.push({ type: 'tool_result', tool_use_id: u.id, content: 'Error: ' + e.message, is_error: true });
        }
      }
      history.push({ role: 'user', content: results });
    }
    line('Stopped after ' + MAX_ROUNDS + ' rounds without a final answer.', 'err');
  }catch(e){
    line(e.message, 'err');
    // Drop this turn so the history never holds a tool_use without its result.
    try{ history = JSON.parse(before); }catch(x){ history = []; }
  }finally{ setBusy(false); }
}

// ---------------------------------------------------------------- new Wahoo rides
const pendingRides = [];
async function onRides(rides){
  while(busy) await sleep(300);
  let list = rides.slice();
  if(list.length > 3){
    line(list.length + ' rides imported; summarising only the 3 most recent.', 'info');
    list = sortByDate(list, 'desc').slice(0, 3);
  }
  line('New Wahoo ride' + (list.length === 1 ? '' : 's') + ' imported; asking Claude for a summary…', 'info');
  const desc = list.map(r => '- ' + r.date + ' "' + (r.title || '') + '" ' + JSON.stringify({
    type: r.type, dur: r.dur, kcal: r.kcal, ef: r.ef, vi: r.vi, z4min: r.z4min, z5min: r.z5min, surges: r.surges, temp: r.temp })).join('\n');
  await send('[Automatic message from the app] These rides were just imported from Wahoo:\n' + desc +
    '\nFor each ride, call annotate_ride (with its date and exact title) with a 1-2 sentence summary. ' +
    'Only if the rides clearly warrant it, call propose_plan for the upcoming days. Then reply in one short sentence.');
}
window.addEventListener('reckoning:rides', e => {
  const rides = e && Array.isArray(e.detail) ? e.detail : [];
  if(!rides.length) return;
  if(!document.getElementById('ccLog')) { pendingRides.push(rides); return; }
  onRides(rides).catch(err => line('Ride summary FAILED: ' + err.message, 'err'));
});

// ---------------------------------------------------------------- start
// Wait until the page has signed in and loaded its data, then build the card.
function boot(){
  let ready = false;
  try{ ready = !!state && typeof sb !== 'undefined' && typeof chk === 'function' && !!document.getElementById('cardStack'); }catch(e){ ready = false; }
  if(!ready){ setTimeout(boot, 400); return; }
  buildCard();
  try{ sb.auth.onAuthStateChange(ev => { if(ev === 'SIGNED_OUT') history = []; }); }catch(e){ line('Could not watch sign-out: ' + e.message, 'err'); }
  while(pendingRides.length){
    const r = pendingRides.shift();
    onRides(r).catch(err => line('Ride summary FAILED: ' + err.message, 'err'));
  }
}
boot();
})();
