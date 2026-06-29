/* ai-devlog viewer — tree-only canvas. Vanilla JS, no deps, offline-safe. */
(function () {
  'use strict';
  var SVG = 'http://www.w3.org/2000/svg';
  var DATA = JSON.parse(document.getElementById('devlog-data').textContent);
  var tree = DATA.tree, stats = DATA.stats || {};

  var COL = 280, ROW = 60, NODE_W = 234, NODE_H = 46;

  // ---------- safe helpers ----------
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function safeUrl(u) { return /^(https?:|mailto:|#|\/|\.)/i.test(u) ? u : '#'; }

  // ---------- tiny markdown ----------
  function inline(s) {
    s = esc(s);
    s = s.replace(/`([^`]+)`/g, function (_, c) { return '<code>' + c + '</code>'; });
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, function (_, t, u) {
      return '<a href="' + esc(safeUrl(u)) + '" target="_blank" rel="noopener">' + t + '</a>';
    });
    return s;
  }
  function markdown(src) {
    if (!src) return '';
    var lines = String(src).split(/\r?\n/), out = [], i = 0;
    while (i < lines.length) {
      var line = lines[i];
      if (/^```/.test(line)) {
        var buf = []; i++;
        while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i++; }
        i++; out.push('<pre><code>' + esc(buf.join('\n')) + '</code></pre>'); continue;
      }
      var h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) { out.push('<h' + h[1].length + '>' + inline(h[2]) + '</h' + h[1].length + '>'); i++; continue; }
      if (/^\s*[-*]\s+/.test(line)) {
        var li = [];
        while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) { li.push('<li>' + inline(lines[i].replace(/^\s*[-*]\s+/, '')) + '</li>'); i++; }
        out.push('<ul>' + li.join('') + '</ul>'); continue;
      }
      if (/^\s*\d+\.\s+/.test(line)) {
        var oi = [];
        while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) { oi.push('<li>' + inline(lines[i].replace(/^\s*\d+\.\s+/, '')) + '</li>'); i++; }
        out.push('<ol>' + oi.join('') + '</ol>'); continue;
      }
      if (/^\s*>\s?/.test(line)) { out.push('<blockquote>' + inline(line.replace(/^\s*>\s?/, '')) + '</blockquote>'); i++; continue; }
      if (line.trim() === '') { i++; continue; }
      var p = [];
      while (i < lines.length && lines[i].trim() !== '' && !/^```/.test(lines[i]) && !/^#{1,6}\s/.test(lines[i]) && !/^\s*[-*]\s+/.test(lines[i]) && !/^\s*\d+\.\s+/.test(lines[i])) { p.push(lines[i]); i++; }
      out.push('<p>' + inline(p.join('\n')) + '</p>');
    }
    return out.join('\n');
  }
  function renderDiff(d) {
    return '<div class="diff">' + String(d).split(/\r?\n/).map(function (l) {
      var c = 'ctx';
      if (/^\+(?!\+\+)/.test(l)) c = 'add'; else if (/^-(?!--)/.test(l)) c = 'del'; else if (/^@@/.test(l)) c = 'hunk';
      return '<div class="line ' + c + '">' + esc(l || ' ') + '</div>';
    }).join('') + '</div>';
  }

  // ---------- index ----------
  var byId = {};
  var TURN = { idea: 1, refine: 1, fix: 1, question: 1, decision: 1, verification: 1 };
  (function walk(n, parent, depth) {
    n._parent = parent;
    byId[n.id] = n;
    // collapse "turn" nodes by default so a big tree opens readable
    n._collapsed = !!(TURN[n.type] && n.children && n.children.length);
    (n.children || []).forEach(function (c) { walk(c, n, depth + 1); });
  })(tree, null, 0);

  function searchText(n) {
    if (n._s != null) return n._s;
    var d = n.detail || {};
    n._s = ((n.title || '') + ' ' + (d.prompt || '') + ' ' + (d.response || '') + ' ' + n.type).toLowerCase();
    return n._s;
  }

  // ---------- state ----------
  var tx = 60, ty = 60, scale = 0.9, selectedId = null, query = '', showSet = null;

  var canvas = document.getElementById('canvas');
  var viewport = document.getElementById('viewport');
  var linksG = document.getElementById('links');
  var nodesG = document.getElementById('nodes');

  function childrenToShow(n) {
    var kids = n.children || [];
    if (showSet) return kids.filter(function (c) { return showSet.has(c.id); });
    return n._collapsed ? [] : kids;
  }
  function hasHidden(n) { return !showSet && n._collapsed && n.children && n.children.length; }

  // ---------- layout (left-to-right tidy tree) ----------
  function layout() {
    var leaf = 0;
    (function place(n, depth) {
      n._x = depth * COL;
      var kids = childrenToShow(n);
      n._kids = kids;
      if (!kids.length) { n._y = leaf * ROW; leaf++; }
      else { kids.forEach(function (k) { place(k, depth + 1); }); n._y = (kids[0]._y + kids[kids.length - 1]._y) / 2; }
    })(tree, 0);
  }
  function visibleNodes() {
    var out = [];
    (function w(n) { out.push(n); (n._kids || []).forEach(w); })(tree);
    return out;
  }

  // ---------- render ----------
  var KIND = { root: 'project', commits: 'commits', idea: 'goal', refine: 'refine', fix: 'fix',
    question: 'question', decision: 'pivot', verification: 'test', 'ai-idea': 'ai idea' };

  function render() {
    layout();
    while (linksG.firstChild) linksG.removeChild(linksG.firstChild);
    while (nodesG.firstChild) nodesG.removeChild(nodesG.firstChild);
    var nodes = visibleNodes();

    nodes.forEach(function (n) {
      (n._kids || []).forEach(function (c) {
        var x1 = n._x + NODE_W, y1 = n._y + NODE_H / 2, x2 = c._x, y2 = c._y + NODE_H / 2;
        var mx = (x1 + x2) / 2;
        var path = document.createElementNS(SVG, 'path');
        path.setAttribute('d', 'M' + x1 + ',' + y1 + ' C' + mx + ',' + y1 + ' ' + mx + ',' + y2 + ' ' + x2 + ',' + y2);
        path.setAttribute('class', 'link' + (c.id === selectedId || n.id === selectedId ? ' hl' : ''));
        linksG.appendChild(path);
      });
    });

    nodes.forEach(function (n) {
      var fo = document.createElementNS(SVG, 'foreignObject');
      fo.setAttribute('x', n._x); fo.setAttribute('y', n._y);
      fo.setAttribute('width', NODE_W); fo.setAttribute('height', NODE_H);
      var isUser = !!TURN[n.type];
      var matched = showSet && searchText(n).indexOf(query) >= 0;
      var cls = 'card t-' + n.type + (isUser ? ' is-user' : '') +
        (n.id === selectedId ? ' selected' : '') + (matched ? ' match' : '');
      var toggle = hasHidden(n) ? '<button class="toggle" data-t="' + n.id + '">+' + n.children.length + '</button>'
        : (!showSet && n.children && n.children.length ? '<button class="toggle" data-t="' + n.id + '">–</button>' : '');
      fo.innerHTML =
        '<div class="' + cls + '" data-id="' + n.id + '">' +
          '<span class="dot"></span>' +
          '<div class="label">' + (isUser ? '🧑 ' : (n.type === 'ai-idea' ? '💡 ' : '')) + esc(n.title || n.type) + '</div>' +
          '<div class="badges"><span class="kind">' + esc(KIND[n.type] || n.type) + '</span>' + toggle + '</div>' +
        '</div>';
      nodesG.appendChild(fo);
    });
    applyTransform();
  }
  function applyTransform() { viewport.setAttribute('transform', 'translate(' + tx + ',' + ty + ') scale(' + scale + ')'); }

  function fitView() {
    var ns = visibleNodes();
    if (!ns.length) return;
    var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    ns.forEach(function (n) {
      minX = Math.min(minX, n._x); maxX = Math.max(maxX, n._x + NODE_W);
      minY = Math.min(minY, n._y); maxY = Math.max(maxY, n._y + NODE_H);
    });
    var r = canvas.getBoundingClientRect();
    var s = Math.min(r.width / (maxX - minX + 140), r.height / (maxY - minY + 140), 1);
    scale = Math.max(s, 0.2);
    tx = (r.width - (maxX - minX) * scale) / 2 - minX * scale;
    ty = (r.height - (maxY - minY) * scale) / 2 - minY * scale;
    applyTransform();
  }

  // ---------- interactions ----------
  nodesG.addEventListener('click', function (e) {
    var tg = e.target.closest('.toggle');
    if (tg) { e.stopPropagation(); var n = byId[tg.getAttribute('data-t')]; n._collapsed = !n._collapsed; render(); return; }
    var card = e.target.closest('.card');
    if (card) select(card.getAttribute('data-id'));
  });

  // pan
  var panning = false, sx = 0, sy = 0, moved = 0;
  canvas.addEventListener('pointerdown', function (e) {
    if (e.target.closest('.card')) return; // let cards handle their own clicks
    panning = true; moved = 0; sx = e.clientX; sy = e.clientY;
    canvas.classList.add('panning'); canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', function (e) {
    if (!panning) return;
    var dx = e.clientX - sx, dy = e.clientY - sy; sx = e.clientX; sy = e.clientY;
    moved += Math.abs(dx) + Math.abs(dy); tx += dx; ty += dy; applyTransform();
  });
  canvas.addEventListener('pointerup', function (e) { panning = false; canvas.classList.remove('panning'); });
  canvas.addEventListener('wheel', function (e) {
    e.preventDefault();
    var r = canvas.getBoundingClientRect(), cx = e.clientX - r.left, cy = e.clientY - r.top;
    var ns = Math.min(Math.max(scale * (1 - e.deltaY * 0.0012), 0.2), 2);
    tx = cx - (cx - tx) * (ns / scale); ty = cy - (cy - ty) * (ns / scale); scale = ns; applyTransform();
  }, { passive: false });

  // ---------- detail drawer ----------
  var drawer = document.getElementById('drawer'), drawerBody = document.getElementById('drawer-body');
  document.getElementById('drawer-close').addEventListener('click', function () { drawer.classList.remove('open'); selectedId = null; render(); });

  function chip(l, v) {
    if (v == null || v === '' || (Array.isArray(v) && !v.length)) return '';
    return '<span class="chip">' + esc(l) + ' <b>' + esc(Array.isArray(v) ? v.length : v) + '</b></span>';
  }
  function select(id) {
    selectedId = id;
    var n = byId[id]; if (!n) return;
    var d = n.detail || {}, m = n.meta || {};
    var h = '<div class="t-' + n.type + '">';
    h += '<div class="d-kind">' + esc(KIND[n.type] || n.type) + '</div>';
    h += '<div class="d-title">' + (TURN[n.type] ? '🧑 ' : n.type === 'ai-idea' ? '💡 ' : '') + esc(n.title || n.type) + '</div>';
    h += '<div class="chips">' +
      chip('source', m.source) + chip('model', m.model) + chip('status', m.status) +
      chip('branch', m.branch) + chip('files', d.files) + chip('commits', d.commits) +
      chip('time', (d.promptTime || m.timestamp) ? new Date(d.promptTime || m.timestamp).toLocaleString() : null) +
      '</div>';

    if (n.type === 'ai-idea') {
      h += '<p class="empty-hint">An idea the AI proposed while working on “' + esc(d.context || '') + '”.</p>';
    }
    if (n.type === 'commits' && d.unlinkedCommits) {
      h += '<p class="empty-hint">' + esc(n.summary || '') + '</p>';
      h += '<div class="section">Commits</div>' + d.unlinkedCommits.map(commitRow).join('');
    }
    if (d.prompt && d.prompt.trim()) {
      h += '<div class="prompt-card"><div class="head">🧑 User prompt</div><div class="md">' + markdown(d.prompt) + '</div></div>';
    }
    if (d.response && d.response.trim()) {
      h += '<div class="section">🤖 What the AI did</div><div class="md">' + markdown(d.response) + '</div>';
    }
    if (d.files && d.files.length) {
      h += '<div class="section">Files changed</div>' + d.files.map(function (f) { return '<span class="file-pill">' + esc(f) + '</span>'; }).join('');
    }
    if (d.diff) { h += '<div class="section">Diff</div>' + renderDiff(d.diff); }
    if (d.commits && d.commits.length) {
      h += '<div class="section">Commits</div>' + d.commits.map(commitRow).join('');
    }
    if (!d.prompt && !d.response && n.type !== 'commits' && n.type !== 'ai-idea') {
      h += '<p class="empty-hint">' + ((n.children || []).length) + ' child idea(s).</p>';
    }
    h += '</div>';
    drawerBody.innerHTML = h;
    drawer.classList.add('open');
    render();
  }
  function commitRow(c) {
    if (typeof c === 'string') c = { short: c };
    var h = '<div class="commit-row"><span class="h">' + esc(c.short || '') + '</span> ' + esc(c.subject || '') +
      (c.author ? ' · ' + esc(c.author) : '');
    if (c.files && c.files.length) h += '<div>' + c.files.map(function (f) { return '<span class="file-pill">' + esc(f) + '</span>'; }).join('') + '</div>';
    if (c.diff) h += renderDiff(c.diff);
    return h + '</div>';
  }

  // ---------- search ----------
  document.getElementById('search').addEventListener('input', function (e) {
    query = e.target.value.trim().toLowerCase();
    if (!query) { showSet = null; render(); return; }
    var marked = new Set();
    Object.keys(byId).forEach(function (k) { if (searchText(byId[k]).indexOf(query) >= 0) marked.add(k); });
    showSet = new Set();
    marked.forEach(function (id) { var n = byId[id]; while (n) { showSet.add(n.id); n = n._parent; } });
    render(); fitView();
  });

  // ---------- header / legend ----------
  document.getElementById('proj-name').textContent = tree.title || 'AI Devlog';
  if (tree.summary) document.getElementById('proj-sub').textContent = tree.summary;
  var t = stats.types || {};
  function ideaCount() { return (t.idea || 0) + (t.refine || 0) + (t.fix || 0) + (t.question || 0) + (t.decision || 0) + (t.verification || 0); }
  document.getElementById('stats').innerHTML =
    '<span><b>' + ideaCount() + '</b> ideas</span>' +
    '<span><b>' + (t['ai-idea'] || 0) + '</b> AI ideas</span>' +
    '<span><b>' + Object.keys(stats.sources || {}).length + '</b> sources</span>';

  var legend = document.getElementById('legend');
  var LG = [['idea', 'goal'], ['refine', 'refine'], ['fix', 'fix'], ['question', 'question'],
    ['decision', 'pivot'], ['verification', 'test'], ['ai-idea', 'AI idea']];
  legend.innerHTML = LG.filter(function (x) { return t[x[0]]; }).map(function (x) {
    return '<span class="item"><span class="sw" style="background:var(--t-' + x[0] + ')"></span>' + x[1] + '</span>';
  }).join('') + '<span class="item hint">drag to pan · scroll to zoom · click a node</span>';

  document.getElementById('reset').addEventListener('click', function () { render(); fitView(); });

  // ---------- go ----------
  render(); fitView();
})();
