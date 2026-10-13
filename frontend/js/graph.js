/* DB Graph — модель, layout'ы, камера, рендер карточек и рёбер */
export const M = {
  schema: null,
  nodes: new Map(), // name -> node
  edges: [],        // рёбра FK: from = ссылаемая (1), to = ссылающаяся (N)
  layoutKind: 'force',
};
export const cam = { x: 0, y: 0, s: 1 };
export const sel = { node: null, edge: null };
export const handlers = {}; // onSelect, onEdgeSelect, onClear — вешает app.js

const NS = 'http://www.w3.org/2000/svg';
let viewport, world, cardsEl, svg;
export function initDom() {
  viewport = document.getElementById('viewport');
  world = document.getElementById('world');
  cardsEl = document.getElementById('cards');
  svg = document.getElementById('edgeSvg');
}

/* ================= модель ================= */

export function buildModel(schema) {
  M.schema = schema;
  M.nodes.clear();
  M.edges = [];

  for (const t of schema.tables) {
    M.nodes.set(t.name, {
      name: t.name, kind: t.kind, rowCount: t.rowCount, sql: t.sql,
      columns: t.columns, pk: t.primaryKey, fks: t.foreignKeys,
      indexes: t.indexes ?? (t.indexes = []),
      x: 0, y: 0, w: 224, h: 44, el: null, hidden: false,
    });
  }
  // «призраки» — таблицы, на которые ссылается FK, но которых в базе нет
  for (const t of M.schema.tables) {
    for (const fk of t.foreignKeys) {
      if (M.nodes.has(fk.toTable)) continue;
      M.nodes.set(fk.toTable, {
        name: fk.toTable, kind: 'ghost', rowCount: null, sql: null,
        columns: [], pk: [], fks: [], indexes: [],
        x: 0, y: 0, w: 224, h: 44, el: null, hidden: false,
      });
    }
  }
  let i = 0;
  for (const t of M.schema.tables) {
    for (const fk of t.foreignKeys) {
      const parent = M.nodes.get(fk.toTable);
      const toCols = fk.to.length ? fk.to : parent.pk.length ? parent.pk : [];
      M.edges.push({
        id: 'e' + i++,
        from: fk.toTable,      // ссылаемая таблица (сторона «1»)
        to: t.name,            // ссылающаяся (сторона «N», сама fk.from)
        fromCols: toCols,
        toCols: fk.from,
        oneToOne: fk.oneToOne,
        nullable: fk.nullable,
        onDelete: fk.onDelete,
        label: fk.from.join(', '),
      });
    }
  }
}

/* ================= камера ================= */

export function applyCam() {
  world.style.transform = `translate(${cam.x}px, ${cam.y}px) scale(${cam.s})`;
}

function vpRect() { return viewport.getBoundingClientRect(); }

export function zoomAt(clientX, clientY, factor) {
  const r = vpRect();
  const px = clientX - r.left, py = clientY - r.top;
  const s2 = Math.min(3, Math.max(0.04, cam.s * factor));
  cam.x = px - (px - cam.x) * (s2 / cam.s);
  cam.y = py - (py - cam.y) * (s2 / cam.s);
  cam.s = s2;
  applyCam();
}

export function camCenter(clientX, clientY) {
  const r = vpRect();
  return { x: (clientX - r.left - cam.x) / cam.s, y: (clientY - r.top - cam.y) / cam.s };
}

let camAnim = null;
export function animateCamTo(tx, ty, ts, dur = 340) {
  if (camAnim) cancelAnimationFrame(camAnim);
  const s0 = { ...cam }, t0 = performance.now();
  const ease = t => 1 - Math.pow(1 - t, 3);
  const step = now => {
    const k = Math.min(1, (now - t0) / dur);
    const e = ease(k);
    cam.x = s0.x + (tx - s0.x) * e;
    cam.y = s0.y + (ty - s0.y) * e;
    cam.s = s0.s + (ts - s0.s) * e;
    applyCam();
    if (k < 1) camAnim = requestAnimationFrame(step);
    else camAnim = null;
  };
  camAnim = requestAnimationFrame(step);
}

export function fitView({ animate = true } = {}) {
  const nodes = visibleNodes();
  if (!nodes.length) return;
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  for (const n of nodes) {
    x0 = Math.min(x0, n.x - n.w / 2); x1 = Math.max(x1, n.x + n.w / 2);
    y0 = Math.min(y0, n.y - n.h / 2); y1 = Math.max(y1, n.y + n.h / 2);
  }
  const r = vpRect();
  const bw = Math.max(1, x1 - x0) + 80, bh = Math.max(1, y1 - y0) + 80;
  const s = Math.min(1.45, Math.max(0.04, Math.min(r.width / bw, r.height / bh)));
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const tx = r.width / 2 - cx * s, ty = r.height / 2 - cy * s;
  if (animate) animateCamTo(tx, ty, s);
  else { cam.x = tx; cam.y = ty; cam.s = s; applyCam(); }
}

export function focusNode(name) {
  const n = M.nodes.get(name);
  if (!n) return;
  const r = vpRect();
  const s = Math.max(cam.s, 0.85);
  animateCamTo(r.width / 2 - n.x * s, r.height / 2 - n.y * s, s);
}

function visibleNodes() { return [...M.nodes.values()].filter(n => !n.hidden); }

/* ================= layout'ы ================= */

export function layout(kind = M.layoutKind, { rescale = true } = {}) {
  M.layoutKind = kind;
  const nodes = visibleNodes();
  if (!nodes.length) { renderEdges(); return; }
  if (kind === 'force') forceLayout(nodes);
  else if (kind === 'layers') layerLayout(nodes);
  else if (kind === 'grid') gridLayout(nodes);
  else if (kind === 'ring') ringLayout(nodes);
  for (const n of nodes) positionCard(n);
  renderEdges();
  fitView({ animate: false });
}

function positionCard(n) {
  n.el.style.transform = `translate(${n.x - n.w / 2}px, ${n.y - n.h / 2}px)`;
}

const visibleEdges = () => M.edges.filter(e => !M.nodes.get(e.from).hidden && !M.nodes.get(e.to).hidden);

function forceLayout(nodes) {
  const ns = nodes.length;
  const R = 170 * Math.sqrt(ns) || 180;
  nodes.forEach((n, i) => {
    const a = (2 * Math.PI * i) / ns;
    n.x = R * Math.cos(a); n.y = R * Math.sin(a);
    n.vx = n.vy = 0;
  });
  const links = M.edges.filter(e => e.from !== e.to && !M.nodes.get(e.from).hidden && !M.nodes.get(e.to).hidden);
  const kRepel = 60000, kLink = 0.02, kGrav = 0.12, damp = 0.8;

  for (let it = 0; it < 340; it++) {
    // отталкивание (все пары)
    for (let i = 0; i < ns; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < ns; j++) {
        const b = nodes[j];
        let dx = b.x - a.x, dy = b.y - a.y;
        let d = Math.hypot(dx, dy) || 0.01;
        const minD = (a.w + b.w) / 2 * 0.55 + 36;
        const f = Math.min(150, kRepel / (d * d));
        const ux = dx / d, uy = dy / d;
        a.vx -= ux * f; a.vy -= uy * f;
        b.vx += ux * f; b.vy += uy * f;
        if (d < minD) { // жёсткая защита от наложений
          const push = (minD - d) * 0.5;
          a.vx -= ux * push; a.vy -= uy * push;
          b.vx += ux * push; b.vy += uy * push;
        }
      }
    }
    // пружины по связям
    for (const e of links) {
      const a = M.nodes.get(e.from), b = M.nodes.get(e.to);
      const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 0.01;
      const f = (d - 250) * kLink;
      const ux = dx / d, uy = dy / d;
      a.vx += ux * f; a.vy += uy * f;
      b.vx -= ux * f; b.vy -= uy * f;
    }
    // к центру
    for (const n of nodes) {
      n.vx -= n.x * kGrav * 0.01; n.vy -= n.y * kGrav * 0.01;
      n.vx *= damp; n.vy *= damp;
      const sp = Math.hypot(n.vx, n.vy);
      if (sp > 30) { n.vx *= 30 / sp; n.vy *= 30 / sp; }
      n.x += n.vx; n.y += n.vy;
    }
  }
  separate(nodes);
}

/* финальное позиционное разведение: гарантия, что карточки не перекрываются */
function separate(nodes) {
  const GAP = 16;
  for (let pass = 0; pass < 80; pass++) {
    let moved = false;
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        const dx = b.x - a.x, dy = b.y - a.y;
        const adx = Math.abs(dx) - (a.w + b.w) / 2 - GAP;
        const ady = Math.abs(dy) - (a.h + b.h) / 2 - GAP;
        if (adx >= 0 || ady >= 0) continue;
        moved = true;
        if (adx > ady) { // раздвигаем по оси меньшего наложения
          const push = -adx / 2 * (dx >= 0 ? 1 : -1);
          a.x -= push; b.x += push;
        } else {
          const push = -ady / 2 * (dy >= 0 ? 1 : -1);
          a.y -= push; b.y += push;
        }
      }
    }
    if (!moved) break;
  }
}

function layerLayout(nodes) {
  // глубина = цепочка FK-зависимостей; циклы разрываем стеком
  const parents = new Map();
  for (const n of nodes) parents.set(n.name, []);
  for (const e of visibleEdges()) {
    if (e.from !== e.to && parents.has(e.to) && parents.has(e.from))
      parents.get(e.to).push(e.from);
  }
  const depth = new Map();
  const stack = new Set();
  const d = name => {
    if (depth.has(name)) return depth.get(name);
    if (stack.has(name)) return 0;
    stack.add(name);
    let v = 0;
    for (const p of parents.get(name) || []) v = Math.max(v, d(p) + 1);
    stack.delete(name);
    depth.set(name, v);
    return v;
  };
  nodes.forEach(n => { n._d = d(n.name); });

  const rows = new Map();
  nodes.sort((a, b) => a._d - b._d || a.name.localeCompare(b.name)).forEach(n => {
    (rows.get(n._d) || rows.set(n._d, []).get(n._d)).push(n);
  });
  const rowGap = 300, colGap = 330;
  rows.forEach((row, depth_) => {
    row.forEach((n, i) => {
      n.x = (i - (row.length - 1) / 2) * colGap;
      n.y = depth_ * rowGap;
    });
  });
}

function gridLayout(nodes) {
  const cols = Math.ceil(Math.sqrt(nodes.length));
  const mw = Math.max(224, ...nodes.map(n => n.w)) + 130;
  const mh = Math.max(120, ...nodes.map(n => n.h)) + 110;
  nodes.sort((a, b) => a.name.localeCompare(b.name));
  nodes.forEach((n, i) => {
    n.x = (i % cols - (cols - 1) / 2) * mw;
    n.y = (Math.floor(i / cols) - (Math.ceil(nodes.length / cols) - 1) / 2) * mh;
  });
}

function ringLayout(nodes) {
  const R = Math.max(300, (nodes.length * 250) / (2 * Math.PI));
  nodes.sort((a, b) => a.name.localeCompare(b.name));
  nodes.forEach((n, i) => {
    const a = (2 * Math.PI * i) / nodes.length - Math.PI / 2;
    n.x = R * Math.cos(a) * 1.25; // эллипс: карточки шире, чем выше
    n.y = R * Math.sin(a) * 0.85;
  });
}

/* ================= рендер карточек ================= */

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtCount = v => v == null ? '' : v >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : v >= 1e4 ? (v / 1e3).toFixed(1) + 'k' : String(v);
const hueOf = name => { let h = 0; for (const c of name) h = (h * 33 + c.codePointAt(0)) % 997; return Math.round(h * 137.508) % 360; };

export function renderCards() {
  cardsEl.innerHTML = '';
  for (const n of M.nodes.values()) {
    const el = document.createElement('div');
    el.className = 'card' + (n.kind === 'view' ? ' view' : '') + (n.kind === 'ghost' ? ' ghost' : '');
    el.dataset.t = n.name;
    const isFk = new Set(n.fks.flatMap(f => f.from));
    const uniq1 = new Set((n.indexes || []).filter(i => i.unique && i.columns.length === 1).flatMap(i => i.columns));
    const showCols = n.columns.slice(0, 26);
    el.innerHTML = `
      <div class="head" style="--h:${hueOf(n.name)}">
        <span class="nm">${esc(n.name)}</span>
        ${n.kind === 'view' ? '<span class="kind">VIEW</span>' : ''}
        ${n.kind === 'ghost' ? '<span class="kind">НЕТ В БД</span>' : ''}
        <span class="rc">${fmtCount(n.rowCount)}</span>
      </div>
      <ul>${showCols.map(c => `
        <li class="${c.pk ? 'pk ' : ''}${isFk.has(c.name) ? 'fk' : ''}"
            data-c="${esc(c.name)}"
            title="${esc(c.name)} ${esc(c.type || '')}${c.notNull ? ' NOT NULL' : ''}">
          ${c.pk ? '<span class="b pk">PK</span>' : ''}
          ${isFk.has(c.name) ? '<span class="b fk">FK</span>' : ''}
          ${isUniq(n, c, uniq1) ? '<span class="b u">U</span>' : ''}
          <span class="col">${esc(c.name)}</span>
          ${!c.pk && !c.notNull ? '<span class="nn" title="nullable"></span>' : ''}
          <span class="ty">${esc(shortType(c.type))}</span>
        </li>`).join('')}
      </ul>
      ${n.columns.length > showCols.length ? `<div class="more">… ещё ${n.columns.length - showCols.length}</div>` : ''}
    `;
    el.addEventListener('mousedown', ev => onCardMouseDown(ev, n));
    el.addEventListener('mouseenter', () => highlightNode(n, true));
    el.addEventListener('mouseleave', () => highlightNode(n, false));
    for (const li of el.querySelectorAll('li[data-c]')) {
      const col = li.dataset.c;
      li.addEventListener('mouseenter', () => highlightColumn(n, col, true));
      li.addEventListener('mouseleave', () => highlightColumn(n, col, false));
    }
    el.addEventListener('click', ev => { ev.stopPropagation(); if (sel.node === n) return; selectNode(n); });
    cardsEl.appendChild(el);
    n.el = el;
  }
  for (const n of M.nodes.values()) { n.w = n.el.offsetWidth; n.h = n.el.offsetHeight; positionCard(n); }
}

function isUniq(node, col, uniq1) {
  return uniq1.has(col.name) && !col.pk;
}
function shortType(t) {
  t = (t || '').trim();
  const i = t.indexOf('(');
  const base = i > 0 ? t.slice(0, i) : t;
  return base.length > 11 ? base.slice(0, 11) : base || '—';
}

/* ================= рендер рёбер ================= */

export function renderEdges() {
  svg.innerHTML = '';
  // пары таблиц для разводки параллельных рёбер поперёк стыка
  const groups = new Map();
  for (const e of M.edges) {
    if (M.nodes.get(e.from).hidden || M.nodes.get(e.to).hidden) continue;
    const key = [e.from, e.to].sort().join('¦');
    (groups.get(key) || groups.set(key, []).get(key)).push(e);
  }
  const hits = [];
  for (const list of groups.values()) {
    list.forEach((e, idx) => {
      const geo = edgeGeo(e, list.length > 1 ? idx / list.length - 0.5 : 0);
      const g = document.createElementNS(NS, 'g');
      g.classList.add('edge');
      g.dataset.e = e.id;
      g.append(mkPath(geo.d, 'wire'), mkPath(geo.foot, 'foot'));
      for (const c of geo.circles) {
        const ci = document.createElementNS(NS, 'circle');
        ci.setAttribute('class', 'dot0');
        ci.setAttribute('cx', c.cx); ci.setAttribute('cy', c.cy); ci.setAttribute('r', c.r);
        g.appendChild(ci);
      }
      if (document.getElementById('labelsChk').checked && e.label) {
        const t = document.createElementNS(NS, 'text');
        t.setAttribute('class', 'lbl');
        t.setAttribute('x', geo.mid.x); t.setAttribute('y', geo.mid.y - 5);
        t.textContent = e.label;
        if (e.oneToOne) t.textContent += ' (1:1)';
        g.appendChild(t);
      }
      svg.appendChild(g);
      e.gEl = g; e.geo = geo;
      // hit-зона живёт отдельным путём поверх всех линий —
      // чтобы ребро кликалось даже там, где его пересекает другое
      const hit = mkPath(geo.d, 'hit');
      hit.addEventListener('mouseenter', () => highlightEdge(e, true));
      hit.addEventListener('mouseleave', () => highlightEdge(e, false));
      hit.addEventListener('click', ev => { ev.stopPropagation(); selectEdge(e); });
      svg.appendChild(hit);
      e.hitEl = hit;
    });
  }
}

function mkPath(d, cls) {
  const p = document.createElementNS(NS, 'path');
  p.setAttribute('d', d);
  p.setAttribute('class', cls);
  return p;
}

const port = (n, side) => {
  const o = 3;
  return side === 'r' ? { x: n.x + n.w / 2 + o, y: n.y }
       : side === 'l' ? { x: n.x - n.w / 2 - o, y: n.y }
       : side === 't' ? { x: n.x, y: n.y - n.h / 2 - o }
       : { x: n.x, y: n.y + n.h / 2 + o };
};

function edgeGeo(e, spread = 0) {
  const a = M.nodes.get(e.from), b = M.nodes.get(e.to);
  if (a === b) return selfLoopGeo(a, e);
  const dx = b.x - a.x, dy = b.y - a.y;

  let P1, P2, C1, C2;
  if (Math.abs(dy) > 1.25 * Math.abs(dx)) { // вертикальный стык — порты t/b
    const sg = dy > 0 ? 1 : -1;
    P1 = port(a, sg > 0 ? 'b' : 't'); P2 = port(b, sg > 0 ? 't' : 'b');
    P1.x += spread * 52; P2.x += spread * 52;
    const L = Math.max(38, Math.abs(dy) * 0.42);
    C1 = { x: P1.x, y: P1.y + L * sg }; C2 = { x: P2.x, y: P2.y - L * sg };
  } else {                                  // горизонтальный — порты r/l
    const sg = dx >= 0 ? 1 : -1;
    P1 = port(a, sg > 0 ? 'r' : 'l'); P2 = port(b, sg > 0 ? 'l' : 'r');
    P1.y += spread * 46; P2.y += spread * 46;
    const L = Math.max(38, Math.abs(dx) * 0.45);
    C1 = { x: P1.x + L * sg, y: P1.y }; C2 = { x: P2.x - L * sg, y: P2.y };
  }
  const d = `M ${P1.x} ${P1.y} C ${C1.x} ${C1.y}, ${C2.x} ${C2.y}, ${P2.x} ${P2.y}`;
  const mid = { x: (P1.x + 3 * C1.x + 3 * C2.x + P2.x) / 8, y: (P1.y + 3 * C1.y + 3 * C2.y + P2.y) / 8 };

  // маркеры кардинальности: у родителя «один», у ребёнка «много» (crow's foot)
  const u1 = unit(C1.x - P1.x, C1.y - P1.y);              // от родителя наружу
  const u2 = unit(C2.x - P2.x, C2.y - P2.y);              // от ребёнка наружу
  const mk1 = markers(P1, u1, { single: true, dbl: e.oneToOne });
  const mk2 = markers(P2, u2, { crow: !e.oneToOne, single: e.oneToOne, circle: e.nullable });
  return { d, foot: mk1.d + mk2.d, circles: [...mk1.circles, ...mk2.circles], mid };
}

function selfLoopGeo(n, e) {
  const P1 = port(n, 't'), P2 = port(n, 't');
  P1.x -= 34; P2.x += 34;
  const L = n.h / 2 + 62;
  const C1 = { x: P1.x, y: P1.y - L }, C2 = { x: P2.x, y: P2.y - L };
  const d = `M ${P1.x} ${P1.y} C ${C1.x} ${C1.y}, ${C2.x} ${C2.y}, ${P2.x} ${P2.y}`;
  const mid = { x: (P1.x + 3 * C1.x + 3 * C2.x + P2.x) / 8, y: (P1.y + 3 * C1.y + 3 * C2.y + P2.y) / 8 - 8 };
  const mk2 = markers(P2, unit(C2.x - P2.x, C2.y - P2.y), { crow: true, circle: e.nullable });
  const mk1 = markers(P1, unit(C1.x - P1.x, C1.y - P1.y), { single: true });
  return { d, foot: mk1.d + mk2.d, circles: [...mk1.circles, ...mk2.circles], mid };
}

function unit(x, y) {
  const d = Math.hypot(x, y) || 1;
  return { x: x / d, y: y / d };
}

/* Маркеры кардинальности у стыка P; u — направление наружу от карточки вдоль линии */
function markers(P, u, { crow = false, single = false, dbl = false, circle = false } = {}) {
  const p = { x: -u.y, y: u.x };
  const seg = [];
  const circles = [];
  const line = (pt, dxx, dyy) => {
    seg.push(`M ${pt.x.toFixed(1)} ${pt.y.toFixed(1)} L ${(pt.x + dxx).toFixed(1)} ${(pt.y + dyy).toFixed(1)}`);
  };
  if (crow) { // «лапка» у границы таблицы: база снаружи, пальцы разбегаются по границе
    const b = { x: P.x + u.x * 13, y: P.y + u.y * 13 };
    line(b, P.x - b.x, P.y - b.y);
    line(b, p.x * 10, p.y * 10);
    line(b, -p.x * 10, -p.y * 10);
  }
  if (single) line({ x: P.x + u.x * 9, y: P.y + u.y * 9 }, p.x * 8, p.y * 8);
  if (dbl) line({ x: P.x + u.x * 16, y: P.y + u.y * 16 }, p.x * 8, p.y * 8);
  if (circle) circles.push({ cx: P.x + u.x * 26, cy: P.y + u.y * 26, r: 4.5 });
  return { d: seg.join(''), circles };
}

/* перерисовать рёбра, тронутые одним узлом (при перетаскивании карточки) */
export function refreshEdgesFor(name) {
  for (const e of M.edges) {
    if (e.from !== name && e.to !== name) continue;
    if (!e.gEl) continue;
    const key = [e.from, e.to].sort().join('¦');
    const list = M.edges.filter(x => [x.from, x.to].sort().join('¦') === key);
    const geo = edgeGeo(e, list.length > 1 ? list.indexOf(e) / list.length - 0.5 : 0);
    e.geo = geo;
    e.gEl.querySelector('.wire').setAttribute('d', geo.d);
    e.gEl.querySelector('.foot').setAttribute('d', geo.foot);
    if (e.hitEl) e.hitEl.setAttribute('d', geo.d);
    const lbl = e.gEl.querySelector('.lbl');
    if (lbl) { lbl.setAttribute('x', geo.mid.x); lbl.setAttribute('y', geo.mid.y - 5); }
    for (const c of e.gEl.querySelectorAll('.dot0')) c.remove();
    for (const c of geo.circles) {
      const ci = document.createElementNS(NS, 'circle');
      ci.setAttribute('class', 'dot0');
      ci.setAttribute('cx', c.cx); ci.setAttribute('cy', c.cy); ci.setAttribute('r', c.r);
      e.gEl.insertBefore(ci, lbl || null);
    }
  }
}

/* ================= подсветка ================= */

function clearDim() {
  viewport.classList.remove('graph-dim');
  for (const el of document.querySelectorAll('.card.hover, .edge.hover')) el.classList.remove('hover');
}

export function highlightNode(n, on) {
  clearDim();
  if (!on) return;
  viewport.classList.add('graph-dim');
  n.el.classList.add('hover');
  for (const e of M.edges) {
    if (e.from !== n.name && e.to !== n.name) continue;
    if (e.from === e.to && e.from === n.name) e.gEl?.classList.add('hover');
    else if (e.from === n.name || e.to === n.name) e.gEl?.classList.add('hover');
    const other = e.from === n.name ? M.nodes.get(e.to) : M.nodes.get(e.from);
    if (other !== n && !other.hidden) other.el.classList.add('hover');
  }
}

export function highlightColumn(node, col, on) {
  clearDim();
  if (!on) { highlightNode(node, true); return; }
  viewport.classList.add('graph-dim');
  node.el.classList.add('hover');
  for (const e of M.edges) {
    const involved = (e.to === node.name && e.toCols.includes(col)) ||
                     (e.from === node.name && e.fromCols.includes(col));
    if (involved) {
      e.gEl?.classList.add('hover');
      const other = e.from === node.name ? M.nodes.get(e.to) : M.nodes.get(e.from);
      if (!other.hidden) other.el.classList.add('hover');
    }
  }
}

export function highlightEdge(e, on) {
  clearDim();
  if (!on) return;
  viewport.classList.add('graph-dim');
  e.gEl?.classList.add('hover');
  for (const name of [e.from, e.to]) M.nodes.get(name).el?.classList.add('hover');
}

export function selectEdge(e) {
  clearSel();
  sel.edge = e;
  e.gEl?.classList.add('sel');
  e.gEl?.classList.add('hover');
  handlers.onEdgeSelect?.(e);
}

export function selectNode(n, { focus = false, silent = false } = {}) {
  clearSel();
  sel.node = n;
  n.el?.classList.add('selected');
  const item = document.querySelector(`#tableList [data-t="${CSS.escape(n.name)}"]`);
  item?.classList.add('sel'); item?.scrollIntoView({ block: 'nearest' });
  if (focus) focusNode(n.name);
  if (!silent) handlers.onSelect?.(n);
}

export function clearSel() {
  sel.node?.el?.classList.remove('selected');
  sel.edge?.gEl?.classList.remove('sel', 'hover');
  sel.node = sel.edge = null;
  document.querySelectorAll('#tableList .sel').forEach(x => x.classList.remove('sel'));
  handlers.onClear?.();
}

/* ================= события канвы ================= */

export function bindCanvas() {
  viewport.addEventListener('wheel', ev => {
    ev.preventDefault();
    zoomAt(ev.clientX, ev.clientY, Math.exp(-ev.deltaY * 0.0016));
  }, { passive: false });

  viewport.addEventListener('mousedown', ev => {
    if (ev.button !== 0 || ev.target.closest('.card')) return;
    const sx = ev.clientX, sy = ev.clientY, cx = cam.x, cy = cam.y;
    let moved = false;
    viewport.classList.add('panning');
    const move = e => {
      const dx = e.clientX - sx, dy = e.clientY - sy;
      if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
      cam.x = cx + dx; cam.y = cy + dy;
      applyCam();
    };
    const up = e => {
      viewport.classList.remove('panning');
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      if (!moved) clearSel();
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });
}

function onCardMouseDown(ev, n) {
  if (ev.button !== 0) return;
  ev.stopPropagation();
  const start = camCenter(ev.clientX, ev.clientY);
  const ox = n.x - start.x, oy = n.y - start.y;
  const move = e => {
    const w = camCenter(e.clientX, e.clientY);
    n.x = w.x + ox; n.y = w.y + oy;
    positionCard(n);
    refreshEdgesFor(n.name);
  };
  const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
}

/* ================= views ================= */

export function toggleViews(show) {
  for (const n of M.nodes.values()) {
    if (n.kind !== 'view') continue;
    n.hidden = !show;
    n.el.style.display = show ? '' : 'none';
  }
  layout(M.layoutKind);
}