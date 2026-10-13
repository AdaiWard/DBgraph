/* DB Graph — UI: загрузка схемы, сайдбар, панель деталей, хоткеи */
import {
  M, handlers, initDom, buildModel, renderCards, renderEdges, layout,
  fitView, focusNode, zoomAt, applyCam, bindCanvas, selectNode, clearSel,
  toggleViews, cam,
} from './graph.js';

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const hueOf = name => { let h = 0; for (const c of name) h = (h * 33 + c.codePointAt(0)) % 997; return Math.round(h * 137.508) % 360; };

initDom();
bindCanvas();
applyCam();

/* ---------- загрузка ---------- */

async function loadSchema(url) {
  setHint('загрузка…');
  try {
    const res = await fetch(url);
    const json = await res.json();
    if (!res.ok) throw new Error(json.detail || res.statusText);
    mount(json);
    setHint('');
  } catch (e) {
    setHint('⚠ ' + e.message, 6000);
  }
}

function mount(schema) {
  buildModel(schema);
  renderCards();
  layout(M.layoutKind);   // раскладка сама делает мгновенный fitView
  renderSidebar();
  renderStats();
  const file = (schema.path || '').split(/[/\\]/).pop();
  $('dbfile').textContent = file ? `— ${file}` : '';
}

function renderStats() {
  const s = M.schema.stats;
  $('stats').innerHTML =
    `<span class="chip">таблиц <b>${s.tables}</b></span>` +
    (s.views ? `<span class="chip">views <b>${s.views}</b></span>` : '') +
    `<span class="chip">связей <b>${s.relations}</b></span>`;
}

const HINT_TIMEOUT = Symbol();
function setHint(text, ms) {
  const el = $('hint');
  el.textContent = text || baseHint;
  clearTimeout(el[HINT_TIMEOUT]);
  if (ms) el[HINT_TIMEOUT] = setTimeout(() => { el.textContent = baseHint; }, ms);
}
const baseHint = 'колесо — зум · тянуть фон — панорама · тянуть карточку — двигать · hover — связи';

/* ---------- сайдбар ---------- */

function renderSidebar() {
  const list = $('tableList');
  const items = [...M.nodes.values()].sort((a, b) =>
    (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'table' ? -1 : 1));
  list.innerHTML = '';
  for (const n of items) {
    const div = document.createElement('div');
    div.className = 'tbl-item' + (n.kind === 'view' ? ' vw' : '') + (n.kind === 'ghost' ? ' gh' : '');
    div.dataset.t = n.name;
    div.innerHTML = `<span class="dot" style="background:hsl(${n.kind === 'ghost' ? '0 0% 45%' : hueOf(n.name) + ' 62% 55%'})"></span>
      <span class="nm">${esc(n.name)}</span>
      <span class="rc">${n.rowCount ?? ''}</span>`;
    div.addEventListener('click', () => selectNode(n, { focus: true }));
    list.appendChild(div);
  }
}

$('search').addEventListener('input', () => {
  const q = $('search').value.trim().toLowerCase();
  for (const it of $('tableList').children) {
    it.style.display = !q || it.dataset.t.toLowerCase().includes(q) ? '' : 'none';
  }
});
$('search').addEventListener('keydown', ev => {
  if (ev.key !== 'Enter') return;
  const q = $('search').value.trim().toLowerCase();
  const first = [...$('tableList').children].find(it => !q || it.dataset.t.toLowerCase().includes(q));
  const node = first && M.nodes.get(first.dataset.t);
  if (node) { selectNode(node, { focus: true }); $('search').value = ''; renderSidebarFilter(); }
});
function renderSidebarFilter() {
  for (const it of $('tableList').children) it.style.display = '';
}

/* ---------- панель деталей ---------- */

const panel = $('panel');

handlers.onSelect = node => showNodePanel(node);
handlers.onEdgeSelect = edge => showEdgePanel(edge);
handlers.onClear = () => { panel.hidden = true; panel.innerHTML = ''; };

function head(title, hue, kind) {
  return `<h3><span class="dot" style="width:10px;height:10px;border-radius:3px;flex:none;background:hsl(${hue ?? '0 0% 50%'} 62% 55%)"></span>${esc(title)}<button class="x" id="panelClose">✕</button></h3>`;
}

function showNodePanel(node) {
  panel.hidden = false;
  const isFk = new Set(node.fks.flatMap(f => f.from));
  panel.innerHTML = head(node.name + (node.kind === 'view' ? ' (view)' : ''), node.kind === 'ghost' ? null : hueOf(node.name)) +
    `<div class="kv"><b>${fmtKind(node)}</b>${node.rowCount != null ? ` · строк: <b>${node.rowCount}</b>` : ''}</div>` +
    (node.columns.length ? `<h4>Колонки</h4><table class="rows"><tr>${node.columns.slice(0, 40).map(c =>
      `<td style="max-width:150px">${c.pk ? '<b style="color:var(--warn)">PK</b> ' : ''}${isFk.has(c.name) ? '<span style="color:var(--link)">FK</span> ' : ''}${esc(c.name)}</td><td style="color:var(--faint)">${esc(c.type || '')}</td></tr>`).join('')}</table>` : '') +
    `<h4>Связи</h4><div class="linklist">${incidentLinks(node)}</div>` +
    `<h4>Данные <span style="color:var(--faint);font-weight:400">(SELECT * LIMIT 15)</span></h4><div id="sampleBox"><div class="spin"></div></div>` +
    (node.sql ? `<h4>SQL</h4><div class="sql">${esc(node.sql)}</div>` : '');
  loadSample(node);
}

function fmtKind(n) {
  return n.kind === 'ghost' ? 'таблица отсутствует в базе (битая FK-ссылка)'
       : n.kind === 'view' ? 'VIEW' : 'TABLE';
}

function incidentLinks(node) {
  const seen = new Map();
  for (const e of M.edges) {
    if (e.from !== node.name && e.to !== node.name) continue;
    const out = e.to === node.name && e.from !== node.name; // node ссылается наружу
    const other = out ? e.from : e.to;
    const key = out + other;
    if (seen.has(key)) continue;
    seen.set(key, { e, other, out, cols: out ? e.toCols : e.fromCols });
  }
  return [...seen.values()].map(({ e, other, out, cols }) => {
    const nn = M.nodes.get(other);
    return `<div class="lk" data-go="${esc(other)}">
      <span class="dir">${out ? '↗' : '↙'}</span>
      <span style="flex:1">${esc(other)} <span style="color:var(--faint)">· ${esc(cols.join(', ')) || '—'}</span></span>
      <span class="rc" style="font-size:10px;color:var(--faint)">${cardinality(e)}</span>
    </div>`;
  }).join('') || '<div class="kv">нет FK-связей</div>';
}

function cardinality(e) { return e.oneToOne ? '1:1' : e.nullable ? '0..1:N' : '1:N'; }

function showEdgePanel(e) {
  panel.hidden = false;
  const a = M.nodes.get(e.from), b = M.nodes.get(e.to);
  panel.innerHTML = head('FK-связь', null) +
    `<div class="kv">${cardinality(e)}${e.nullable ? ' · optional (NULL допускается)' : ''}</div>` +
    `<div class="kv">со стороны «один»: <b class="lk" style="display:inline-flex" data-go="${esc(a.name)}">${esc(a.name)}</b> ${esc(e.fromCols.join(', ')) || '(PK)'}</div>` +
    `<div class="kv">со стороны «много»: <b class="lk" style="display:inline-flex" data-go="${esc(b.name)}">${esc(b.name)}</b> ${esc(e.toCols.join(', '))}</div>` +
    (e.onDelete ? `<div class="kv">ON DELETE: <b>${esc(e.onDelete)}</b></div>` : '') +
    `<div class="kv">Клик по имени таблицы — фокус на карточке, X — закрыть панель</div>`;
}

async function loadSample(node) {
  const box = $('sampleBox');
  if (!box) return;
  try {
    const res = await fetch(`/api/sample?path=${encodeURIComponent(M.schema.path)}&table=${encodeURIComponent(node.name)}&limit=15`);
    const json = await res.json();
    if (!res.ok) throw new Error(json.detail || '');
    if (box.isConnected && !json.rows.length) { box.textContent = 'пусто'; return; }
    if (!box.isConnected) return;
    box.innerHTML = `<table class="rows">
      <tr>${json.columns.map(c => `<th>${esc(c)}</th>`).join('')}</tr>
      ${json.rows.map(r => `<tr>${r.map(v => `<td class="${v == null ? 'nu' : ''}">${v == null ? 'NULL' : esc(v)}</td>`).join('')}</tr>`).join('')}
    </table>`;
  } catch (e) {
    if (box.isConnected) box.textContent = '⚠ ' + e.message || 'не удалось прочитать';
  }
}

// клики в панели — делегирование: ссылки на таблицы и кнопка закрытия
panel.addEventListener('click', ev => {
  if (ev.target.closest('#panelClose')) { clearSel(); return; }
  const lk = ev.target.closest('.lk[data-go]');
  if (!lk) return;
  const n = M.nodes.get(lk.dataset.go);
  if (n) selectNode(n, { focus: true });
});

/* ---------- тулбар ---------- */

$('layouts').addEventListener('click', ev => {
  const b = ev.target.closest('button');
  if (!b) return;
  for (const x of $('layouts').children) x.classList.toggle('on', x === b);
  layout(b.dataset.layout);
});

$('fitBtn').addEventListener('click', () => fitView());
$('zoomInBtn').addEventListener('click', () => zoomAt(centerX(), centerY(), 1.25));
$('zoomOutBtn').addEventListener('click', () => zoomAt(centerX(), centerY(), 0.8));
const centerX = () => { const r = document.getElementById('viewport').getBoundingClientRect(); return r.left + r.width / 2; };
const centerY = () => { const r = document.getElementById('viewport').getBoundingClientRect(); return r.top + r.height / 2; };

$('labelsChk').addEventListener('change', renderEdges);
$('viewsChk').addEventListener('change', ev => toggleViews(ev.target.checked));

/* ---------- источники ---------- */

$('demoBtn').addEventListener('click', () => loadSchema('/api/schema?demo=1'));
$('openBtn').addEventListener('click', () => $('fileInput').click());
$('fileInput').addEventListener('change', async ev => {
  const file = ev.target.files[0];
  if (!file) return;
  setHint('загрузка ' + file.name + '…');
  const fd = new FormData();
  fd.append('file', file);
  try {
    const res = await fetch('/api/upload', { method: 'POST', body: fd });
    const json = await res.json();
    if (!res.ok) throw new Error(json.detail || res.statusText);
    mount(json);
    setHint('');
  } catch (e) {
    setHint('⚠ ' + e.message, 6000);
  } finally {
    ev.target.value = '';
  }
});

/* ---------- хоткеи ---------- */

window.addEventListener('keydown', ev => {
  if (ev.target.matches('input')) return;
  if (ev.key === 'f') fitView();
  if (ev.key === 'Escape') clearSel();
  if (ev.key === '=' || ev.key === '+') zoomAt(centerX(), centerY(), 1.25);
  if (ev.key === '-') zoomAt(centerX(), centerY(), 0.8);
});

/* ---------- старт ---------- */
loadSchema('/api/schema');