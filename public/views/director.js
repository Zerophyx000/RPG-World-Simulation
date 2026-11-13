// Director tools: located events with composable EFFECTS (damage, needs, move, sleep, teach a place,
// change appearance/goals/traits/persona, close a service, block a path, private messages…),
// presets, needs sliders for everyone, active room changes, create citizen, reseed with scenario.
import { store, subscribeMany } from '../store.js';
import { api, esc, citizenName, roomName, gameTime, who, effectHtml } from '../util.js';
import { colorOf } from '../colors.js';
import { objectTypes, objectsIn } from './objects-ui.js';
import { emotionTypes, appraisalRowsHtml } from './emotions-ui.js';

let root = null;
let presets = [];
let effects = []; // effect rows being built
let scenarios = { active: null, list: [] };
let testDays = []; // content/test-days/*.json (step A8)

const TRAITS = ['openness', 'conscientiousness', 'extraversion', 'agreeableness', 'neuroticism'];
const PERSONA_FIELDS = ['appearance', 'personality', 'backstory', 'speechStyle', 'occupation'];
const ROOM_LEVEL = new Set(['roomService', 'blockExit', 'unblockExit']);

// [key, kind, default/options, label]
const FIELDS = {
  damage: [['amount', 'number', 20, 'hp']],
  heal: [['amount', 'number', 20, 'hp']],
  needs: [['mode', 'select', ['set', 'add']], ['hunger', 'number', '', 'hunger'], ['fatigue', 'number', '', 'fatigue'], ['hp', 'number', '', 'hp']],
  move: [['to', 'room', null, 'to']],
  sleep: [['hours', 'number', '', 'hours (empty = until rested)']],
  wake: [], collapse: [], revive: [],
  knowPlace: [['place', 'room', null, 'place'], ['services', 'services', null, 'services (none ticked = all)']],
  forgetPlace: [['place', 'room', null, 'place']],
  mark: [['text', 'text', '', 'looks… e.g. covered in soot'], ['minutes', 'number', '', 'minutes (empty = permanent)']],
  unmark: [['text', 'text', '', 'containing… (empty = all)']],
  goal: [['mode', 'select', ['add', 'remove']], ['text', 'text', '', 'goal']],
  trait: [['trait', 'select', TRAITS], ['value', 'number', '', 'set 0–1'], ['delta', 'number', '', 'or ± change']],
  persona: [['field', 'select', PERSONA_FIELDS], ['mode', 'select', ['set', 'append']], ['text', 'text', '', 'text']],
  roomService: [['room', 'room?', null, 'room'], ['service', 'select', ['food', 'bed']], ['enabled', 'bool', false, 'available'], ['minutes', 'number', '', 'minutes (empty = until changed)'], ['reason', 'text', '', 'why (shown in UI)']],
  blockExit: [['room', 'room?', null, 'from'], ['to', 'room', null, 'to'], ['minutes', 'number', '', 'minutes'], ['both', 'bool', true, 'both ways'], ['reason', 'text', '', 'why, e.g. rubble']],
  unblockExit: [['room', 'room?', null, 'from'], ['to', 'room', null, 'to']],
  whisper: [['text', 'text', '', 'what they hear/remember'], ['importance', 'number', 7, 'importance']],
};
const TYPE_LABELS = {
  damage: 'Damage', heal: 'Heal', needs: 'Change needs', move: 'Move to room', sleep: 'Put to sleep', wake: 'Wake up',
  collapse: 'Knock out', revive: 'Revive', knowPlace: 'Teach a place', forgetPlace: 'Forget a place',
  mark: 'Change appearance', unmark: 'Restore appearance', goal: 'Add/remove goal', trait: 'Change trait',
  persona: 'Change persona', roomService: 'Room service on/off', blockExit: 'Block a path', unblockExit: 'Unblock a path',
  whisper: 'Private message',
};

const CITIZEN_TEMPLATE = {
  id: 'marta', name: 'Marta', kind: 'citizen', location: 'square', home: null,
  knownPlaces: ['square'], needs: { hunger: 40, fatigue: 30 },
  persona: {
    age: 41, sex: 'female', occupation: 'travelling pedlar',
    appearance: 'Weathered face, a heavy pack of pots and ribbons, a loud laugh.',
    traits: { openness: 0.7, conscientiousness: 0.4, extraversion: 0.8, agreeableness: 0.5, neuroticism: 0.3 },
    personality: 'Charming and shrewd. You always know who is buying and who is lying.',
    backstory: 'You come through Brackenford twice a year to sell your wares and hear the news.',
    goals: ['Sell your last copper pots before you move on', 'Find somewhere cheap to sleep tonight'],
    speechStyle: 'Fast talk, flattery, a joke now and then.',
  },
};

export function mount(el) {
  root = el;
  effects = [];
  el.innerHTML = `
  <div class="director-grid">
    <form id="f-event" class="card">
      <h3>Event</h3>
      <div class="row">
        <select id="ev-preset"><option value="">— preset —</option></select>
        <select id="ev-room"></select>
      </div>
      <div class="row">
        <label>Radius <input id="ev-radius" type="number" min="0" max="10" value="2"></label>
        <label>Importance <input id="ev-imp" type="number" min="1" max="10" value="8"></label>
        <label>Icon <input id="ev-icon" type="text" value="📣" class="short"></label>
      </div>
      <label class="lbl">Here <span class="dim">(people in the room; importance as set) — leave empty for effects only</span></label>
      <textarea id="ev-here" rows="2" placeholder="A deafening blast throws you against the wall."></textarea>
      <div class="row"><button type="button" id="ev-gen">✨ Write near/far from “here”</button><span class="dim" id="ev-gen-status"></span></div>
      <label class="lbl">Near <span class="dim">(1 room away; importance −2)</span></label>
      <textarea id="ev-near" rows="2" placeholder="A loud bang from the direction of {room}."></textarea>
      <label class="lbl">Far <span class="dim">(2+ rooms away within the radius; importance −4, min 3)</span></label>
      <textarea id="ev-far" rows="2" placeholder="A distant boom rolls across the village."></textarea>
      <label class="lbl">Lasting room effect <span class="dim">(optional; arrivals see it too)</span></label>
      <textarea id="ev-fx" rows="2" placeholder="Smoke pours from a shattered hearth…"></textarea>
      <div class="row"><label>Effect lasts <input id="ev-fx-min" type="number" min="1" value="720"> game min</label></div>

      <label class="lbl">Object changes <span class="dim">(JSON, optional: [{"types":["hearth","shutters"],"state":"@broken"}] or [{"objectId":"…","state":"…"}])</span></label>
      <input id="ev-objs" class="mono" placeholder='[{"types": ["hearth"], "state": "@broken"}]'>

      <div class="effects-head"><h3>Effects</h3>
        <select id="ev-add-effect"><option value="">+ add effect…</option>
          ${Object.entries(TYPE_LABELS).map(([t, l]) => `<option value="${t}">${esc(l)}</option>`).join('')}</select></div>
      <div id="ev-effects" class="effects"></div>

      <div class="reach dim" id="ev-reach"></div>
      <div class="row"><span class="dim">{room} is replaced by the room's name.</span>
        <span><button type="button" id="ev-clear">Clear</button> <button type="submit">Send event</button></span></div>
      <div class="result" id="ev-result"></div>
    </form>

    <div class="col">
      <div class="card">
        <h3>Needs</h3>
        <div id="needs-table" class="needs-table"></div>
      </div>

      <form id="f-whisper" class="card">
        <h3>Whisper</h3>
        <p class="muted">Only one citizen perceives it: a sudden memory, a sound only they hear. Importance ≥ 8 may interrupt their thinking or wake them.</p>
        <select id="wh-citizen"></select>
        <textarea id="wh-text" rows="2" placeholder="Greta is looking at you angrily."></textarea>
        <div class="row"><label>Importance <input id="wh-imp" type="number" min="1" max="10" value="7"></label><button type="submit">Whisper</button></div>
        <div class="result" id="wh-result"></div>
      </form>

      <div class="card">
        <h3>Active room changes</h3>
        <div id="fx-list"></div>
      </div>

      <div class="card" id="emotion-card">
        <h3>Emotions and mood</h3>
        <p class="muted">Raise or lower a feeling, or set the slow mood. Code never acts for them: this only changes what they are shown.</p>
        <div class="row"><select id="emo-citizen"></select><select id="emo-type"></select><span class="dim">at</span><select id="emo-target"></select></div>
        <div class="emo-sliders">
          <label>change <input id="emo-delta" type="range" min="-6" max="8" step="0.5" value="4"><span id="emo-delta-v">+4</span></label>
        </div>
        <div class="row"><input id="emo-cause" placeholder="cause, first person: He laughed at me in front of everyone." style="flex:1"><button type="button" id="emo-apply">Apply</button></div>
        <div class="emo-sliders">
          <label>valence <input id="mood-valence" type="range" min="-5" max="5" step="0.5" value="0"><span id="mood-valence-v">0</span></label>
          <label>tension <input id="mood-tension" type="range" min="0" max="10" step="0.5" value="3"><span id="mood-tension-v">3</span></label>
        </div>
        <div class="row"><label class="check"><input type="checkbox" id="emo-contagion" checked> contagion (feelings spread in a room)</label><button type="button" id="mood-apply">Set mood</button></div>
        <div class="result" id="emo-result"></div>
        <details id="appr-details"><summary>Appraisal log (which rule caused what)</summary><div class="appr-log" id="appr-log"></div></details>
      </div>

      <div class="card" id="social-card">
        <h3>People, groups and strangers</h3>
        <div class="soc-row" id="soc-inactive"></div>

        <label class="lbl">Relationship change <span class="dim">(always with a reason they could name)</span></label>
        <div class="row"><select id="soc-a"></select><span class="dim">→</span><select id="soc-b"></select>
          <label>trust <input id="soc-dt" type="number" min="-5" max="5" step="1" value="-2" class="short"></label>
          <label>liking <input id="soc-da" type="number" min="-5" max="5" step="1" value="0" class="short"></label></div>
        <div class="row"><input id="soc-reason" placeholder="He told me the east passage was safe, and it wasn't." style="flex:1"><button type="button" id="soc-rel">Apply</button></div>

        <label class="lbl">Simulate a warning sign <span class="dim">(the first person notices it about the second)</span></label>
        <div class="row"><select id="soc-sign"><option>followed</option><option>property</option><option>intruder</option><option>hiding</option></select><button type="button" id="soc-signal">Fire</button></div>

        <label class="lbl">How the first person looks / what they hide</label>
        <div class="row"><select id="soc-field"><option value="appearanceTags">appearance tags</option><option value="secretGoals">secret goals</option><option value="covets">covets</option></select>
          <input id="soc-values" placeholder="hooded, foreign" style="flex:1"><button type="button" id="soc-set">Set</button></div>
        <div class="row"><label>Trust in strangers <input id="soc-st" type="number" min="0.05" max="0.95" step="0.05" value="0.5" class="short"></label><button type="button" id="soc-st-set">Set</button>
          <span class="dim" id="soc-cues"></span></div>

        <label class="lbl">Room danger <span class="dim">(0–10; adds to wariness of strangers)</span></label>
        <div class="row"><select id="soc-room"></select><input id="soc-danger" type="number" min="0" max="10" value="0" class="short"><button type="button" id="soc-danger-set">Set</button></div>

        <label class="lbl">Groups</label>
        <div class="row"><input id="grp-name" placeholder="name, e.g. the night watch" style="flex:1">
          <select id="grp-kind">${['family', 'household', 'village', 'guild', 'faction', 'party', 'gang'].map((k) => `<option>${k}</option>`).join('')}</select>
          <label class="check"><input type="checkbox" id="grp-secret"> secret</label><button type="button" id="grp-create">Create</button></div>
        <div class="row"><select id="grp-id"></select><select id="grp-member"></select><input id="grp-role" placeholder="role" class="short">
          <label class="check"><input type="checkbox" id="grp-msecret"> secret</label>
          <button type="button" id="grp-add">Add</button><button type="button" id="grp-remove">Remove</button></div>
        <div class="result" id="soc-result"></div>
      </div>

      <form id="f-object" class="card">
        <h3>Objects</h3>
        <p class="muted">Create an object from a type (origin <code>director</code>). To change one, click it anywhere (world view, events, inspector) and use <i>Edit</i>.</p>
        <div class="ob-form">
          <label>Type <select id="ob-type"></select></label>
          <label>Id <input id="ob-id" placeholder="e.g. tavern_letter_2"></label>
          <label>Where <select id="ob-where"></select></label>
          <label>State <select id="ob-state"></select></label>
          <label>Placement <span class="row"><select id="ob-rel">${['floor', 'on', 'in', 'behind', 'under', 'beside'].map((r) => `<option>${r}</option>`).join('')}</select><select id="ob-of"></select></span></label>
          <label>Visibility <select id="ob-vis"><option>obvious</option><option>noticeable</option><option>hidden</option></select></label>
          <label>Search difficulty <input id="ob-diff" type="number" min="0" max="10" value="0"></label>
          <label>Owner <select id="ob-owner"></select></label>
          <label class="wide">Name <input id="ob-name" placeholder="optional, e.g. Greta's spare key"></label>
          <label class="wide">Surface text <input id="ob-surface" placeholder="optional; default from the type and state"></label>
          <label class="wide">True text <input id="ob-true" placeholder="optional; what examine reveals"></label>
        </div>
        <div class="row"><span></span><button type="submit">Create object</button></div>
        <div class="result" id="ob-result"></div>
        <details><summary>Type browser</summary><div class="types-list" id="ob-types"></div></details>
      </form>

      <form id="f-create" class="card">
        <h3>Create citizen</h3>
        <p class="muted"><code>knownPlaces</code>: "all" (a local) or a list of room ids. <code>needs</code>: starting hunger/fatigue.</p>
        <textarea id="cr-json" rows="10" spellcheck="false" class="mono"></textarea>
        <div class="row"><span></span><button type="submit">Create</button></div>
        <div class="result" id="cr-result"></div>
      </form>

      <div class="card" id="testday-card">
        <h3>Test days</h3>
        <p class="muted">Scripted days from <code>content/test-days/</code>: director actions fire on game time while the clock runs. A seed makes every chance and pick choice reproducible.</p>
        <div class="row"><select id="td-name"></select><button type="button" id="td-run">Run test day</button><button type="button" id="td-stop">Stop</button></div>
        <p class="muted" id="td-desc"></p>
        <div class="row"><label>Seed <input id="td-seed" type="number" min="0" max="4294967295" step="1" placeholder="random" class="short"></label></div>
        <div id="td-status" class="dim"></div>
        <div class="result" id="td-result"></div>
        <p class="muted">For a full replay, reseed the scenario first (Reseed, dev only) and use the same seed.</p>
      </div>

      <div class="card danger">
        <h3>Reseed (dev only)</h3>
        <p class="muted">Backs up the database, then wipes all citizens and rooms and seeds a scenario from <code>content/scenarios/</code>.</p>
        <div class="row"><select id="rs-scenario"></select><button id="btn-reseed" type="button">Wipe and reseed…</button></div>
        <div class="result" id="rs-result"></div>
      </div>
    </div>
  </div>`;

  el.querySelector('#cr-json').value = JSON.stringify(CITIZEN_TEMPLATE, null, 2);
  el.querySelector('#ev-preset').addEventListener('change', applyPreset);
  for (const id of ['#ev-room', '#ev-radius', '#ev-imp']) el.querySelector(id).addEventListener('input', () => { renderEffects(); renderReach(); });
  el.querySelector('#ev-gen').addEventListener('click', generateTexts);
  el.querySelector('#ev-clear').addEventListener('click', clearForm);
  el.querySelector('#ev-add-effect').addEventListener('change', (e) => {
    if (!e.target.value) return;
    effects.push(newEffect(e.target.value));
    e.target.value = '';
    renderEffects();
    renderReach();
  });
  const fxBox = el.querySelector('#ev-effects');
  fxBox.addEventListener('input', onEffectInput);
  fxBox.addEventListener('change', onEffectInput);
  fxBox.addEventListener('click', (e) => {
    const rm = e.target.closest('[data-remove]');
    if (!rm) return;
    effects.splice(Number(rm.dataset.remove), 1);
    renderEffects();
    renderReach();
  });
  el.querySelector('#f-event').addEventListener('submit', sendEvent);
  el.querySelector('#f-whisper').addEventListener('submit', sendWhisper);
  el.querySelector('#f-create').addEventListener('submit', createCitizen);
  el.querySelector('#f-object').addEventListener('submit', createObject);
  bindSocial(el);
  bindEmotions(el);
  bindTestDays(el);
  for (const id of ['#ob-type', '#ob-where']) el.querySelector(id).addEventListener('change', fillObjectForm);
  objectTypes().then((t) => {
    types = t;
    el.querySelector('#ob-type').innerHTML = t.map((x) => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('');
    el.querySelector('#ob-types').innerHTML = t.map((x) => `<div class="ty"><b>${esc(x.name)}</b> <span class="dim">${esc(x.id)} · ${x.portable ? `portable, size ${x.size}` : 'fixed'}${x.container ? ' · container' : ''}${x.concealable ? ' · concealable' : ''}</span><br>
      states: ${x.states.map((s) => `<code>${esc(s)}</code>${x.transitions[s]?.length ? ` → ${x.transitions[s].map(esc).join('/')}` : ''}`).join(' · ')}<br>
      <span class="dim">affordances: ${esc(x.affordances.join(', '))}${Object.keys(x.rules ?? {}).length ? ` · fallback rules: ${esc(Object.keys(x.rules).join(', '))}` : ''}</span></div>`).join('');
    fillObjectForm();
  }).catch(() => {});
  el.querySelector('#btn-reseed').addEventListener('click', reseed);
  el.querySelector('#fx-list').addEventListener('click', clearRoomChange);
  const nt = el.querySelector('#needs-table');
  nt.addEventListener('input', (e) => {
    const r = e.target.closest('input[type=range]');
    if (r) r.nextElementSibling.textContent = r.value;
  });
  nt.addEventListener('click', onNeedsClick);

  api.get('/api/director/presets').then((p) => {
    presets = p;
    el.querySelector('#ev-preset').innerHTML = '<option value="">— preset —</option>'
      + presets.map((x) => `<option value="${esc(x.id)}">${esc(x.icon ?? '')} ${esc(x.label)}</option>`).join('');
  }).catch(() => {});
  api.get('/api/director/scenarios').then((s) => {
    scenarios = s;
    el.querySelector('#rs-scenario').innerHTML = s.list.map((x) => `<option value="${esc(x.id)}" ${x.id === s.active ? 'selected' : ''}>${esc(x.id)}${x.id === s.active ? ' (active)' : ''} — ${esc(x.label)}</option>`).join('');
  }).catch(() => {});

  const off = subscribeMany(['rooms', 'citizens', 'objects'], () => {
    fillSelects();
    fillSocial();
    fillEmotions();
    fillObjectForm();
    renderRoomChanges();
    renderReach();
    renderNeeds();
  });
  fillSelects();
  fillSocial();
  fillEmotions();
  fillTestDaySelect();
  renderEffects();
  renderReach();
  renderNeeds();
  renderRoomChanges();
  return () => {
    off();
    clearTimeout(tdTimer);
    tdTimer = null;
    root = null;
  };
}

const val = (id) => root.querySelector(id).value;
const setVal = (id, v) => { root.querySelector(id).value = v ?? ''; };

// ---------- emotions and mood (step 6) ----------
function bindEmotions(el) {
  const say = (ok, t) => result('#emo-result', ok, t);
  for (const id of ['emo-delta', 'mood-valence', 'mood-tension']) {
    el.querySelector(`#${id}`).addEventListener('input', (e) => { el.querySelector(`#${id}-v`).textContent = `${id === 'emo-delta' && e.target.value > 0 ? '+' : ''}${e.target.value}`; });
  }
  emotionTypes().then((t) => {
    el.querySelector('#emo-type').innerHTML = Object.keys(t.types ?? {}).map((k) => `<option>${k}</option>`).join('');
    el.querySelector('#emo-contagion').checked = t.contagion !== false;
  });
  el.querySelector('#emo-apply').addEventListener('click', async () => {
    try {
      const r = await api.post('/api/director/emotion', { citizenId: val('#emo-citizen'), type: val('#emo-type'), target: val('#emo-target') || null, delta: Number(val('#emo-delta')), cause: val('#emo-cause') || null });
      say(true, `${citizenName(val('#emo-citizen'))}: ${r.entries.map((e) => `${e.type} ${e.intensity}${e.targetName ? ` at ${e.targetName}` : ''}`).join(', ') || 'calm'}`);
      loadAppraisals();
    } catch (err) {
      say(false, err.message);
    }
  });
  el.querySelector('#mood-apply').addEventListener('click', async () => {
    try {
      const r = await api.post('/api/director/mood', { citizenId: val('#emo-citizen'), valence: Number(val('#mood-valence')), tension: Number(val('#mood-tension')) });
      say(true, `${citizenName(val('#emo-citizen'))}: mood ${r.mood.valence.toFixed(1)} / tension ${r.mood.tension.toFixed(1)}`);
    } catch (err) {
      say(false, err.message);
    }
  });
  el.querySelector('#emo-contagion').addEventListener('change', async (e) => {
    const r = await api.post('/api/director/contagion', { enabled: e.target.checked }).catch(() => null);
    say(Boolean(r), r ? `Contagion ${r.contagion ? 'on' : 'off'}.` : 'Could not change it.');
  });
  el.querySelector('#appr-details').addEventListener('toggle', (e) => e.target.open && loadAppraisals());
}

async function loadAppraisals() {
  if (!root?.querySelector('#appr-details')?.open) return;
  const rows = await api.get('/api/emotions/appraisals?limit=80').catch(() => []);
  root.querySelector('#appr-log').innerHTML = appraisalRowsHtml(rows);
}

function fillEmotions() {
  if (!root) return;
  const people = [...store.citizens.values()].map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
  const a = root.querySelector('#emo-citizen');
  const b = root.querySelector('#emo-target');
  if (a.dataset.opts !== people) {
    const [va, vb] = [a.value, b.value];
    a.innerHTML = people;
    b.innerHTML = `<option value="">— nobody —</option>${people}`;
    a.dataset.opts = people;
    if (va) a.value = va;
    if (vb) b.value = vb;
  }
}

// ---------- test days (step A8) ----------
let tdTimer = null;
function bindTestDays(el) {
  const say = (ok, t) => result('#td-result', ok, t);
  el.querySelector('#td-name').addEventListener('change', () => {
    const d = testDays.find((x) => x.name === el.querySelector('#td-name').value);
    el.querySelector('#td-desc').textContent = d?.description ?? '';
  });
  el.querySelector('#td-run').addEventListener('click', async () => {
    try {
      const seed = el.querySelector('#td-seed').value;
      const r = await api.post('/api/director/test-days/run', { name: el.querySelector('#td-name').value, seed: seed === '' ? undefined : Number(seed) });
      say(true, `Running "${r.name}" (seed ${r.seed}), ${r.actions} actions.`);
      refreshTestDay();
    } catch (err) {
      say(false, err.message);
    }
  });
  el.querySelector('#td-stop').addEventListener('click', async () => {
    try {
      const r = await api.post('/api/director/test-days/stop', {});
      say(true, `Stopped "${r.name}" after ${r.done}/${r.total} actions.`);
      refreshTestDay();
    } catch (err) {
      say(false, err.message);
    }
  });
}

async function fillTestDaySelect() {
  if (!root) return;
  testDays = await api.get('/api/director/test-days').catch(() => []);
  if (!root) return;
  const sel = root.querySelector('#td-name');
  const cur = sel.value;
  sel.innerHTML = testDays.map((d) => `<option value="${esc(d.name)}">${esc(d.name)} (${d.actions} actions)</option>`).join('');
  if (cur && testDays.some((d) => d.name === cur)) sel.value = cur;
  const d = testDays.find((x) => x.name === sel.value);
  root.querySelector('#td-desc').textContent = d?.description ?? '';
  refreshTestDay();
}

// Status line while a run is going: name, seed, done/total, next scheduled time.
async function refreshTestDay() {
  if (!root) return;
  const s = await api.get('/api/director/test-days/status').catch(() => null);
  if (!root) return;
  if (!s) return;
  const st = root.querySelector('#td-status');
  st.textContent = s.running
    ? `Running: ${s.name} · seed ${s.seed} · ${s.done}/${s.total} done${s.next != null ? ` · next at ${clockOnly(s.next)} (D${Math.floor(s.next / 1440) + 1})` : ''}`
    : (s.done ? `Last run: ${s.name} · ${s.done}/${s.total} done` : 'Not running.');
  root.querySelector('#td-stop').disabled = !s.running;
  clearTimeout(tdTimer);
  if (s.running) tdTimer = setTimeout(refreshTestDay, 2000);
}

// ---------- people, groups, strangers (step 5.5) ----------
let groupList = [];
function bindSocial(el) {
  const run = (fn) => async () => {
    try {
      result('#soc-result', true, await fn());
    } catch (err) {
      result('#soc-result', false, err.message);
    }
  };
  const on = (id, fn) => el.querySelector(id).addEventListener('click', run(fn));
  on('#soc-rel', async () => {
    const r = await api.post('/api/director/relationship', { citizenId: val('#soc-a'), otherId: val('#soc-b'), dTrust: Number(val('#soc-dt')) || 0, dAffinity: Number(val('#soc-da')) || 0, reason: val('#soc-reason') });
    return `${citizenName(val('#soc-a'))} → ${citizenName(val('#soc-b'))}: trust ${r.trust.toFixed(1)}, liking ${r.affinity.toFixed(1)}`;
  });
  on('#soc-signal', async () => {
    const r = await api.post('/api/director/signal', { citizenId: val('#soc-a'), otherId: val('#soc-b'), sign: val('#soc-sign') });
    return r.fired ? `${citizenName(val('#soc-a'))} noticed: ${val('#soc-sign')}` : 'Not fired.';
  });
  on('#soc-set', async () => JSON.stringify(await api.post('/api/director/persona-list', { citizenId: val('#soc-a'), field: val('#soc-field'), values: val('#soc-values') })));
  on('#soc-st-set', async () => JSON.stringify(await api.post('/api/director/stranger-trust', { citizenId: val('#soc-a'), value: Number(val('#soc-st')) })));
  on('#soc-danger-set', async () => {
    const r = await api.post('/api/director/room-danger', { roomId: val('#soc-room'), danger: Number(val('#soc-danger')) });
    return `${r.name}: danger ${r.danger}`;
  });
  on('#grp-create', async () => {
    const g = await api.post('/api/groups', { name: val('#grp-name'), kind: val('#grp-kind'), public: !el.querySelector('#grp-secret').checked });
    await loadGroups();
    return `Created ${g.name} (${g.id})`;
  });
  on('#grp-add', async () => {
    const g = await api.patch(`/api/groups/${encodeURIComponent(val('#grp-id'))}`, { add: [{ id: val('#grp-member'), role: val('#grp-role') || 'member', secret: el.querySelector('#grp-msecret').checked }] });
    return `${g.name}: ${g.members.filter((m) => m.leftAt == null).map((m) => m.name).join(', ')}`;
  });
  on('#grp-remove', async () => {
    const g = await api.patch(`/api/groups/${encodeURIComponent(val('#grp-id'))}`, { remove: [val('#grp-member')] });
    return `${g.name}: ${g.members.filter((m) => m.leftAt == null).map((m) => m.name).join(', ') || 'nobody'}`;
  });
  el.querySelector('#soc-inactive').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-activate]');
    if (!b) return;
    try {
      const c = await api.post('/api/director/activate', { id: b.dataset.activate });
      result('#soc-result', true, `${c.name} has arrived.`);
      loadInactive();
    } catch (err) {
      result('#soc-result', false, err.message);
    }
  });
  el.querySelector('#soc-room').addEventListener('change', () => setVal('#soc-danger', store.rooms.get(val('#soc-room'))?.danger ?? 0));
  api.get('/api/cues').then((c) => { el.querySelector('#soc-cues').textContent = `tags: ${Object.keys(c.appearance ?? {}).join(', ')}`; }).catch(() => {});
  loadInactive();
  loadGroups();
}

async function loadInactive() {
  if (!root) return;
  const list = await api.get('/api/director/inactive').catch(() => []);
  root.querySelector('#soc-inactive').innerHTML = list.length ? list.map((k) => `<div class="row"><span><b>${esc(k.name)}</b> <span class="dim">${esc(k.occupation ?? '')} · ${esc((k.appearanceTags ?? []).join(', '))}</span>
      <div class="secret-goals">🔒 ${(k.secretGoals ?? []).map(esc).join(' · ')}</div></span>
      ${k.inWorld ? '<span class="dim">in the world</span>' : `<button type="button" data-activate="${esc(k.id)}">Bring into the world</button>`}</div>`).join('')
    : '<span class="dim">No dormant test characters in this scenario.</span>';
}

async function loadGroups() {
  if (!root) return;
  groupList = await api.get('/api/groups').catch(() => []);
  const sel = root.querySelector('#grp-id');
  const cur = sel.value;
  sel.innerHTML = groupList.filter((g) => !g.dissolvedAt).map((g) => `<option value="${esc(g.id)}">${esc(g.name)}${g.public ? '' : ' 🔒'}</option>`).join('');
  if (cur) sel.value = cur;
}

function fillSocial() {
  if (!root) return;
  const people = [...store.citizens.values()].map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
  for (const id of ['#soc-a', '#soc-b', '#grp-member']) {
    const sel = root.querySelector(id);
    const cur = sel.value;
    if (sel.dataset.opts !== people) { sel.innerHTML = people; sel.dataset.opts = people; }
    if (cur) sel.value = cur;
    else if (id === '#soc-b' && sel.options.length > 1) sel.selectedIndex = 1;
  }
  const rooms = [...store.rooms.values()].map((r) => `<option value="${esc(r.id)}">${esc(r.name)} (${r.danger ?? 0})</option>`).join('');
  const rs = root.querySelector('#soc-room');
  const cur = rs.value;
  if (rs.dataset.opts !== rooms) { rs.innerHTML = rooms; rs.dataset.opts = rooms; }
  if (cur) rs.value = cur;
}

// ---------- objects (step 5) ----------
let types = [];
function fillObjectForm() {
  if (!root) return;
  const t = types.find((x) => x.id === val('#ob-type'));
  const where = root.querySelector('#ob-where');
  const cur = where.value;
  where.innerHTML = [...store.rooms.values()].map((r) => `<option value="room:${esc(r.id)}">${esc(r.name)}</option>`).join('')
    + [...store.citizens.values()].map((c) => `<option value="holder:${esc(c.id)}">held by ${esc(c.name)}</option>`).join('');
  if (cur) where.value = cur;
  const [kind, id] = where.value.split(':');
  root.querySelector('#ob-of').innerHTML = '<option value="">—</option>' + (kind === 'room' ? objectsIn(id).map((o) => `<option value="${esc(o.id)}">${esc(o.typeName)} (${esc(o.id)})</option>`).join('') : '');
  root.querySelector('#ob-state').innerHTML = (t?.states ?? []).map((s) => `<option>${esc(s)}</option>`).join('');
  const owner = root.querySelector('#ob-owner');
  const ov = owner.value;
  owner.innerHTML = '<option value="">— nobody —</option>' + [...store.citizens.values()].map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
  owner.value = ov;
}

async function createObject(e) {
  e.preventDefault();
  const [kind, id] = val('#ob-where').split(':');
  const body = {
    id: val('#ob-id').trim(), type: val('#ob-type'), state: val('#ob-state'), visibility: val('#ob-vis'),
    difficulty: Number(val('#ob-diff')) || 0, owner: val('#ob-owner') || null,
    name: val('#ob-name').trim() || null, surfaceText: val('#ob-surface').trim() || null, trueText: val('#ob-true').trim() || null,
    ...(kind === 'holder' ? { holder: id } : { room: id, placement: { relation: val('#ob-rel'), of: val('#ob-of') || null } }),
  };
  try {
    const o = await api.post('/api/director/objects', body);
    result('#ob-result', true, `Created ${o.id}: ${o.label}`);
    setVal('#ob-id', '');
  } catch (err) {
    result('#ob-result', false, err.message);
  }
}

function fillSelects() {
  if (!root) return;
  const room = root.querySelector('#ev-room');
  const prevRoom = room.value;
  room.innerHTML = '<option value="">— no room (effects on chosen citizens only) —</option>'
    + [...store.rooms.values()].map((r) => `<option value="${esc(r.id)}">${esc(r.name)}</option>`).join('')
    + '<option value="*">* everyone, everywhere</option>';
  room.value = prevRoom || 'square';
  const cit = root.querySelector('#wh-citizen');
  const prevCit = cit.value;
  cit.innerHTML = [...store.citizens.values()].map((c) => `<option value="${esc(c.id)}">${esc(c.name)} (${esc(roomName(c.location))})</option>`).join('');
  if (prevCit) cit.value = prevCit;
}

// ---------- effects builder ----------
function newEffect(type) {
  const e = { type, target: 'here', notify: '', silent: false, importance: '' };
  for (const [key, kind, def] of FIELDS[type] ?? []) {
    if (kind === 'select') e[key] = def[0];
    else if (kind === 'room') e[key] = store.rooms.keys().next().value;
    else if (kind === 'room?') e[key] = '';
    else if (kind === 'services') e[key] = [];
    else e[key] = def ?? '';
  }
  if (type === 'whisper' || type === 'knowPlace') e.target = [...store.citizens.keys()][0];
  return e;
}

function targetOptions(sel) {
  const zones = [['here', 'everyone here (distance 0)'], ['near', 'near (1 room away)'], ['far', 'far (2+ rooms)'], ['reached', 'everyone who perceives it'], ['everyone', 'everyone in the world']];
  return zones.map(([v, l]) => `<option value="${v}" ${sel === v ? 'selected' : ''}>${l}</option>`).join('')
    + '<optgroup label="a specific citizen">'
    + [...store.citizens.values()].map((c) => `<option value="${esc(c.id)}" ${sel === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')
    + '</optgroup>';
}

function roomSelect(key, value, optional, i, effect) {
  let rooms = [...store.rooms.values()];
  // blockExit/unblockExit "to": only exits of the chosen room
  if ((effect.type === 'blockExit' || effect.type === 'unblockExit') && key === 'to') {
    const from = store.rooms.get(effect.room || val('#ev-room'));
    if (from) rooms = rooms.filter((r) => from.exits?.some((x) => x.to === r.id));
  }
  return `<select data-i="${i}" data-k="${key}">${optional ? `<option value="">(event room)</option>` : ''}${rooms
    .map((r) => `<option value="${esc(r.id)}" ${r.id === value ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</select>`;
}

function fieldHtml(e, i, [key, kind, def, label]) {
  const v = e[key];
  switch (kind) {
    case 'number': return `<label>${esc(label ?? key)} <input type="number" data-i="${i}" data-k="${key}" value="${esc(v)}"></label>`;
    case 'text': return `<input type="text" class="grow" data-i="${i}" data-k="${key}" value="${esc(v)}" placeholder="${esc(label ?? key)}">`;
    case 'select': return `<select data-i="${i}" data-k="${key}">${def.map((o) => `<option ${o === v ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
    case 'bool': return `<label class="check"><input type="checkbox" data-i="${i}" data-k="${key}" ${v ? 'checked' : ''}> ${esc(label ?? key)}</label>`;
    case 'room': return `<label>${esc(label ?? key)} ${roomSelect(key, v, false, i, e)}</label>`;
    case 'room?': return `<label>${esc(label ?? key)} ${roomSelect(key, v, true, i, e)}</label>`;
    case 'services': return ['food', 'bed'].map((s) => `<label class="check"><input type="checkbox" data-i="${i}" data-k="services" data-svc="${s}" ${v.includes(s) ? 'checked' : ''}> ${s}</label>`).join('');
    default: return '';
  }
}

function renderEffects() {
  const box = root?.querySelector('#ev-effects');
  if (!box) return;
  box.innerHTML = effects.map((e, i) => {
    const roomLevel = ROOM_LEVEL.has(e.type);
    return `<div class="effect-row">
      <div class="effect-top"><b>${esc(TYPE_LABELS[e.type])}</b>
        ${roomLevel ? '' : `<select data-i="${i}" data-k="target">${targetOptions(e.target)}</select>`}
        <button type="button" data-remove="${i}" title="Remove">✕</button></div>
      <div class="effect-fields">${(FIELDS[e.type] ?? []).map((f) => fieldHtml(e, i, f)).join('')}</div>
      ${roomLevel || e.type === 'whisper' ? '' : `<div class="effect-notify">
        <input type="text" class="grow" data-i="${i}" data-k="notify" value="${esc(e.notify)}" placeholder="notification they perceive (empty = sensible default, if any)" ${e.silent ? 'disabled' : ''}>
        <label>imp <input type="number" min="1" max="10" data-i="${i}" data-k="importance" value="${esc(e.importance)}" class="tiny"></label>
        <label class="check"><input type="checkbox" data-i="${i}" data-k="silent" ${e.silent ? 'checked' : ''}> silent</label></div>`}
    </div>`;
  }).join('') || '<p class="muted">No effects: the event is only perceived. Add effects to make it do something: hurt people, change their needs, move them, teach or erase knowledge, change how they look, add goals, close a kitchen, block a path…</p>';
}

function onEffectInput(e) {
  const el = e.target;
  const i = Number(el.dataset.i);
  const k = el.dataset.k;
  if (!Number.isFinite(i) || !k || !effects[i]) return;
  const fx = effects[i];
  if (k === 'services') {
    const set = new Set(fx.services);
    el.checked ? set.add(el.dataset.svc) : set.delete(el.dataset.svc);
    fx.services = [...set];
  } else if (el.type === 'checkbox') {
    fx[k] = el.checked;
  } else {
    fx[k] = el.value;
  }
  if (e.type === 'change' && (k === 'silent' || k === 'room' || k === 'target')) renderEffects();
  renderReach();
}

/** Builder rows → API effects (numbers converted, empties dropped). */
function serializeEffects() {
  return effects.map((fx) => {
    const out = { type: fx.type };
    if (!ROOM_LEVEL.has(fx.type)) out.target = fx.target;
    for (const [key, kind] of FIELDS[fx.type] ?? []) {
      const v = fx[key];
      if (kind === 'number') { if (v !== '' && v != null) out[key] = Number(v); } else if (kind === 'bool') out[key] = Boolean(v);
      else if (kind === 'services') { if (v.length) out[key] = v; } else if (v !== '' && v != null) out[key] = v;
    }
    if (fx.silent) out.notify = false;
    else if (fx.notify?.trim()) out.notify = fx.notify.trim();
    if (fx.importance !== '' && fx.importance != null && fx.type !== 'whisper') out.importance = Number(fx.importance);
    return out;
  });
}

// ---------- presets / texts ----------
function applyPreset() {
  const p = presets.find((x) => x.id === val('#ev-preset'));
  if (!p) return;
  setVal('#ev-radius', p.radius ?? 0);
  setVal('#ev-imp', p.importance ?? 7);
  setVal('#ev-icon', p.icon ?? '📣');
  setVal('#ev-here', p.texts?.here);
  setVal('#ev-near', p.texts?.near);
  setVal('#ev-far', p.texts?.far);
  setVal('#ev-fx', p.roomEffect?.text);
  setVal('#ev-fx-min', p.roomEffect?.durationGameMinutes ?? 720);
  setVal('#ev-objs', p.objectChanges ? JSON.stringify(p.objectChanges) : '');
  effects = (p.effects ?? []).map((e) => ({ ...newEffect(e.type), ...e, notify: e.notify === false ? '' : e.notify ?? '', silent: e.notify === false }));
  if (p.damage?.hp) effects.push({ ...newEffect('damage'), amount: p.damage.hp });
  renderEffects();
  renderReach();
}

function clearForm() {
  for (const id of ['#ev-here', '#ev-near', '#ev-far', '#ev-fx', '#ev-objs']) setVal(id, '');
  setVal('#ev-preset', '');
  effects = [];
  renderEffects();
  renderReach();
}

// Client-side preview of who perceives what (same BFS as the server: exits count both ways).
function zonesFor(roomId, radius) {
  const zones = { here: [], near: [], far: [] };
  if (!roomId) return zones;
  if (roomId === '*') {
    zones.here = [...store.citizens.values()];
    return zones;
  }
  const dist = new Map([[roomId, 0]]);
  const adj = new Map();
  for (const r of store.rooms.values()) for (const e of r.exits ?? []) {
    if (!adj.has(r.id)) adj.set(r.id, new Set());
    if (!adj.has(e.to)) adj.set(e.to, new Set());
    adj.get(r.id).add(e.to);
    adj.get(e.to).add(r.id);
  }
  const q = [roomId];
  while (q.length) {
    const id = q.shift();
    for (const n of adj.get(id) ?? []) if (!dist.has(n)) { dist.set(n, dist.get(id) + 1); q.push(n); }
  }
  for (const c of store.citizens.values()) {
    const d = c.location ? dist.get(c.location) : Math.max(1, Math.min(...[c.activity?.detail?.from, c.activity?.detail?.to].map((r) => dist.get(r) ?? Infinity)));
    if (d == null || !Number.isFinite(d) || d > radius) continue;
    zones[d === 0 ? 'here' : d === 1 ? 'near' : 'far'].push(c);
  }
  return zones;
}

function renderReach() {
  if (!root) return;
  const z = zonesFor(val('#ev-room'), Number(val('#ev-radius')) || 0);
  const names = (list) => list.map((c) => who(c.id, { plain: true })).join(', ') || '–';
  const fx = serializeEffects();
  root.querySelector('#ev-reach').innerHTML = (val('#ev-room')
    ? `Would reach — here: ${names(z.here)} · near: ${names(z.near)} · far: ${names(z.far)}`
    : 'No room: only effects that target specific citizens (or everyone) will do anything.')
    + (fx.length ? `<div class="fx-preview">${fx.map((x) => `✨ ${effectHtml({ ...x, room: x.room || val('#ev-room') })}`).join('<br>')}</div>` : '');
}

async function generateTexts() {
  const status = root.querySelector('#ev-gen-status');
  if (!val('#ev-here').trim() || !val('#ev-room') || val('#ev-room') === '*') {
    status.textContent = 'needs a room and a “here” text';
    return;
  }
  status.textContent = 'writing…';
  try {
    const r = await api.post('/api/director/event-texts', { roomId: val('#ev-room'), here: val('#ev-here') });
    if (r.near) setVal('#ev-near', r.near);
    if (r.far) setVal('#ev-far', r.far);
    status.textContent = r.near || r.far ? 'done — edit before sending' : 'the model returned nothing usable';
  } catch (err) {
    status.textContent = err.message;
  }
}

function result(id, ok, text) {
  const el = root.querySelector(id);
  el.className = `result ${ok ? 'ok' : 'bad'}`;
  el.textContent = text;
}

async function sendEvent(e) {
  e.preventDefault();
  const fx = val('#ev-fx').trim();
  const preset = presets.find((x) => x.id === val('#ev-preset'));
  try {
    let objectChanges = null;
    if (val('#ev-objs').trim()) {
      try { objectChanges = JSON.parse(val('#ev-objs')); } catch { throw new Error('Object changes: not valid JSON'); }
    }
    const r = await api.post('/api/director/event', {
      objectChanges,
      roomId: val('#ev-room') || null,
      radius: Number(val('#ev-radius')) || 0,
      importance: Number(val('#ev-imp')) || 7,
      icon: val('#ev-icon') || null,
      label: preset?.label ?? null,
      texts: { here: val('#ev-here'), near: val('#ev-near'), far: val('#ev-far') },
      roomEffect: fx ? { text: fx, durationGameMinutes: Number(val('#ev-fx-min')) || 720 } : null,
      effects: serializeEffects().map((x) => (ROOM_LEVEL.has(x.type) && !x.room ? { ...x, room: undefined } : x)),
    });
    const by = (lvl) => r.delivered.filter((x) => x.level === lvl).map((x) => citizenName(x.id)).join(', ') || '–';
    const fxTxt = (r.effects?.length ? ` · effects: ${r.effects.map((x) => `${x.type}${x.targets ? ` → ${x.targets.map(citizenName).join(', ') || 'nobody'}` : ''}`).join('; ')}` : '')
      + (r.objectChanges?.length ? ` · objects: ${r.objectChanges.map((x) => `${x.objectId}${x.state ? ` → ${x.state}` : ''}${x.error ? ` (${x.error})` : ''}`).join(', ')}` : '');
    result('#ev-result', true, `Sent. here: ${by('here')} · near: ${by('near')} · far: ${by('far')}${fxTxt}`);
  } catch (err) {
    result('#ev-result', false, err.message);
  }
}

async function sendWhisper(e) {
  e.preventDefault();
  try {
    await api.post('/api/director/whisper', { citizenId: val('#wh-citizen'), text: val('#wh-text'), importance: Number(val('#wh-imp')) || 7 });
    result('#wh-result', true, `Whispered to ${citizenName(val('#wh-citizen'))}.`);
  } catch (err) {
    result('#wh-result', false, err.message);
  }
}

// ---------- needs table ----------
function renderNeeds() {
  const box = root?.querySelector('#needs-table');
  if (!box) return;
  if (box.contains(document.activeElement)) return; // don't fight the user's slider
  box.innerHTML = [...store.citizens.values()].filter((c) => c.alive !== false).map((c) => {
    const n = c.needs ?? {};
    const s = (k, max) => `<label class="slider">${k === 'hp' ? 'hp' : k}<input type="range" min="0" max="${max}" value="${Math.round(n[k] ?? 0)}" data-need="${k}"><output>${Math.round(n[k] ?? 0)}</output></label>`;
    return `<div class="needs-row" data-cid="${esc(c.id)}"><b style="color:${colorOf(c.id)}">${esc(c.name)}</b>
      ${s('hunger', 100)}${s('fatigue', 100)}${s('hp', n.hpMax ?? 100)}
      <button data-set>Set</button>${c.activity?.type === 'collapsed' ? '<button data-revive>Revive</button>' : ''}</div>`;
  }).join('');
}

async function onNeedsClick(e) {
  const row = e.target.closest('[data-cid]');
  if (!row) return;
  const id = row.dataset.cid;
  try {
    if (e.target.closest('[data-set]')) {
      const v = Object.fromEntries([...row.querySelectorAll('[data-need]')].map((i) => [i.dataset.need, Number(i.value)]));
      await api.post('/api/director/needs', { citizenId: id, ...v });
    } else if (e.target.closest('[data-revive]')) {
      await api.post('/api/director/revive', { citizenId: id });
    }
  } catch (err) {
    alert(err.message);
  }
}

// ---------- active room changes ----------
function renderRoomChanges() {
  const box = root?.querySelector('#fx-list');
  if (!box) return;
  const rows = [];
  for (const r of store.rooms.values()) {
    for (const fx of r.effects ?? []) {
      rows.push(`<div class="fx-row"><b>${esc(r.name)}</b> <span class="dim">until ${esc(gameTime(fx.until))}</span><div>${esc(fx.text)}</div>
        <button data-room="${esc(r.id)}" data-fx="${esc(fx.id)}">Clear</button></div>`);
    }
    for (const [svc, o] of Object.entries(r.serviceOverrides ?? {})) {
      if (o?.enabled !== false) continue;
      rows.push(`<div class="fx-row"><b>${esc(r.name)}</b> <span class="dim">${o.until ? `until ${esc(gameTime(o.until))}` : 'until changed'}</span><div>${esc(svc)} unavailable${o.reason ? `: ${esc(o.reason)}` : ''}</div>
        <button data-room="${esc(r.id)}" data-svc="${esc(svc)}">Restore</button></div>`);
    }
    for (const b of r.blockedExits ?? []) {
      rows.push(`<div class="fx-row"><b>${esc(r.name)} → ${esc(roomName(b.to))}</b> <span class="dim">${b.until ? `until ${esc(gameTime(b.until))}` : 'until cleared'}</span><div>path blocked${b.reason ? `: ${esc(b.reason)}` : ''}</div>
        <button data-room="${esc(r.id)}" data-unblock="${esc(b.to)}">Unblock</button></div>`);
    }
  }
  box.innerHTML = rows.join('') || '<p class="muted">None.</p>';
}

async function clearRoomChange(e) {
  const b = e.target.closest('button[data-room]');
  if (!b) return;
  try {
    if (b.dataset.fx) await api.post('/api/director/clear-effect', { roomId: b.dataset.room, effectId: b.dataset.fx });
    else if (b.dataset.svc) await api.post('/api/director/apply', { effects: [{ type: 'roomService', room: b.dataset.room, service: b.dataset.svc, enabled: true }] });
    else if (b.dataset.unblock) await api.post('/api/director/apply', { effects: [{ type: 'unblockExit', room: b.dataset.room, to: b.dataset.unblock }] });
  } catch (err) {
    alert(err.message);
  }
}

// ---------- create / reseed ----------
async function createCitizen(e) {
  e.preventDefault();
  let body;
  try {
    body = JSON.parse(val('#cr-json'));
  } catch (err) {
    return result('#cr-result', false, `Invalid JSON: ${err.message}`);
  }
  try {
    const c = await api.post('/api/citizens', body);
    result('#cr-result', true, `Created ${c.name} in ${roomName(c.location)}.`);
  } catch (err) {
    result('#cr-result', false, err.message);
  }
}

async function reseed() {
  const scenario = val('#rs-scenario') || scenarios.active;
  const answer = prompt(`This wipes all citizens and rooms (a backup is written first) and seeds the "${scenario}" scenario. Type WIPE to confirm.`);
  if (answer !== 'WIPE') return;
  try {
    const r = await api.post('/api/director/reseed', { confirm: 'WIPE', scenario });
    result('#rs-result', true, `Reseeded "${r.scenario}": ${r.rooms} rooms, ${r.citizens} citizens.`);
  } catch (err) {
    result('#rs-result', false, err.message);
  }
}
