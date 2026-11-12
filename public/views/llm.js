// LLM calls: list (filter by purpose), detail with thinking / answer / tool calls / prompt,
// plus the thinking test from step 1.
import { subscribe } from '../store.js';
import { api, esc, citizenName, gameTime, debounce } from '../util.js';

let root = null;
let purpose = '';
let pendingCall = null;

export function mount(el) {
  root = el;
  el.innerHTML = `
    <div class="llm-cols">
      <section>
        <div class="row">
          <select id="llm-purpose">
            <option value="">all purposes</option><option value="decide">decide</option>
            <option value="observer">observer</option><option value="director_text">director_text</option><option value="test">test</option>
          </select>
          <span class="dim" id="llm-stats"></span>
        </div>
        <ul id="llm-calls" class="log"></ul>
      </section>
      <section>
        <pre id="llm-detail" class="detail tall">Click a call to see its prompt, thinking and answer.</pre>
        <details class="think-test">
          <summary>Thinking test</summary>
          <p class="muted">Sends a situation to the configured model and shows its thinking separately from its answer.</p>
          <textarea id="think-prompt" rows="3">You are a baker in a small village. A stranger in a torn cloak asks you for free bread. What do you do?</textarea>
          <button id="think-send">Send</button>
          <h3>Thinking</h3><pre id="think-reasoning" class="detail"></pre>
          <h3>Answer</h3><pre id="think-answer" class="detail"></pre>
        </details>
      </section>
    </div>`;
  el.querySelector('#llm-purpose').value = purpose;
  el.querySelector('#llm-purpose').addEventListener('change', (e) => {
    purpose = e.target.value;
    loadCalls();
  });
  el.querySelector('#llm-calls').addEventListener('click', (e) => {
    const li = e.target.closest('[data-call]');
    if (li) showCall(Number(li.dataset.call));
  });
  el.querySelector('#think-send').addEventListener('click', thinkTest);
  const refresh = debounce(loadCalls, 500);
  const off = subscribe('llm', (c) => {
    root?.querySelector('#llm-stats') && (root.querySelector('#llm-stats').textContent = `last #${c.id}: ${c.purpose} · ${c.status} · ${c.durationMs} ms`);
    refresh();
  });
  loadCalls();
  if (pendingCall) showCall(pendingCall);
  return () => {
    off();
    root = null;
  };
}

async function loadCalls() {
  if (!root) return;
  let calls = await api.get('/api/llm/calls?limit=150').catch(() => []);
  if (purpose) calls = calls.filter((c) => c.purpose === purpose);
  root.querySelector('#llm-calls').innerHTML = calls.map((c) => `<li class="clickable" data-call="${c.id}">
    <span class="t">#${c.id}</span><span class="type">${esc(c.purpose)}</span>
    <span class="${c.status === 'ok' ? '' : 'bad'}">${esc(c.status)} · ${c.duration_ms} ms${c.citizen_id ? ` · ${esc(citizenName(c.citizen_id))}` : ''} · ${esc(gameTime(c.game_time))}</span></li>`).join('');
}

/** Show one call's detail (also used by the inspector, which switches to this view first). */
export async function showCall(id) {
  if (!root) {
    pendingCall = id;
    return;
  }
  pendingCall = null;
  const c = await api.get(`/api/llm/calls/${id}`);
  const box = root?.querySelector('#llm-detail');
  if (!box) return;
  box.textContent = [
    `#${c.id} · ${c.purpose} · ${c.status} · ${c.duration_ms} ms${c.citizen_id ? ` · ${citizenName(c.citizen_id)}` : ''}`,
    c.error ? `ERROR: ${c.error}` : '',
    '--- THINKING ---', c.reasoning ?? '(none)',
    '--- ANSWER ---', c.content ?? '(none)',
    c.tool_calls?.length ? `--- TOOL CALLS ---\n${JSON.stringify(c.tool_calls, null, 2)}` : '',
    '--- PROMPT ---', (c.request.messages ?? []).map((m) => `=== ${m.role.toUpperCase()} ===\n${typeof m.content === 'string' && m.content ? m.content : JSON.stringify(m.tool_calls ?? m.content, null, 2)}`).join('\n\n'),
  ].filter(Boolean).join('\n');
  box.scrollTop = 0;
}

async function thinkTest() {
  const btn = root.querySelector('#think-send');
  btn.disabled = true;
  btn.textContent = 'Thinking…';
  root.querySelector('#think-reasoning').textContent = '';
  root.querySelector('#think-answer').textContent = '';
  try {
    const r = await api.post('/api/llm/test', { prompt: root.querySelector('#think-prompt').value });
    root.querySelector('#think-reasoning').textContent = r.reasoning ?? '(the model returned no separate thinking — see README: thinking mode)';
    root.querySelector('#think-answer').textContent = r.content ?? '';
  } catch (err) {
    root.querySelector('#think-answer').textContent = `Error: ${err.message}`;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Send';
  }
}
