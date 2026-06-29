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
  // Open showing project → categories → top-level ideas; collapse deeper so the
  // structure is visible at a glance (mind-map best practice: ~3 levels).
  var COLLAPSE_DEPTH = 2;
  (function walk(n, parent, depth) {
    n._parent = parent; n._depth = depth;
    byId[n.id] = n;
    n._collapsed = depth >= COLLAPSE_DEPTH && n.children && n.children.length;
    (n.children || []).forEach(function (c) { walk(c, n, depth + 1); });
  })(tree, null, 0);

  function searchText(n) {
    if (n._s != null) return n._s;
    var d = n.detail || {};
    n._s = ((n.title || '') + ' ' + (n.titleEn || '') + ' ' + (n.titleZh || '') + ' ' +
      (d.prompt || '') + ' ' + (d.response || '') + ' ' + n.type).toLowerCase();
    return n._s;
  }

  // ---------- state ----------
  var tx = 60, ty = 60, scale = 0.9, selectedId = null, query = '', showSet = null;
  var lang = 'zh'; // 'zh' | 'en'
  function labelFor(n) {
    return (lang === 'zh' ? (n.titleZh || n.titleEn) : (n.titleEn || n.titleZh)) || n.title || n.type;
  }

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

  // ---------- layout (radial tree — expands in all directions) ----------
  function layout() {
    var leaf = 0, maxDepth = 0, countAt = [];
    (function order(n, depth) {
      n._depth = depth; if (depth > maxDepth) maxDepth = depth;
      countAt[depth] = (countAt[depth] || 0) + 1;
      var kids = childrenToShow(n); n._kids = kids;
      if (!kids.length) { n._leaf = leaf++; }
      else kids.forEach(function (k) { order(k, depth + 1); });
    })(tree, 0);
    var totalLeaves = Math.max(leaf, 1);
    // leaves get equal slices of the full circle; a parent sits at the midpoint
    // of its children's angles
    (function ang(n) {
      if (!n._kids.length) n._ang = (n._leaf + 0.5) / totalLeaves * 2 * Math.PI;
      else { n._kids.forEach(ang); n._ang = (n._kids[0]._ang + n._kids[n._kids.length - 1]._ang) / 2; }
    })(tree);
    // each ring's radius is big enough to fit that depth's node count
    var ring = [0];
    for (var d = 1; d <= maxDepth; d++) {
      var need = (countAt[d] || 1) * (NODE_W + 36) / (2 * Math.PI);
      ring[d] = Math.max(ring[d - 1] + 170, need);
    }
    (function pos(n) {
      var r = ring[n._depth] || 0;
      n._x = Math.cos(n._ang) * r - NODE_W / 2;
      n._y = Math.sin(n._ang) * r - NODE_H / 2;
      (n._kids || []).forEach(pos);
    })(tree);
  }
  function visibleNodes() {
    var out = [];
    (function w(n) { out.push(n); (n._kids || []).forEach(w); })(tree);
    return out;
  }

  // ---------- render ----------
  var KIND = { root: 'project', category: 'category', commits: 'commits', idea: 'goal', refine: 'refine',
    fix: 'fix', question: 'question', decision: 'pivot', verification: 'test', 'ai-idea': 'insight' };

  function render() {
    layout();
    while (linksG.firstChild) linksG.removeChild(linksG.firstChild);
    while (nodesG.firstChild) nodesG.removeChild(nodesG.firstChild);
    var nodes = visibleNodes();

    nodes.forEach(function (n) {
      (n._kids || []).forEach(function (c) {
        var x1 = n._x + NODE_W / 2, y1 = n._y + NODE_H / 2, x2 = c._x + NODE_W / 2, y2 = c._y + NODE_H / 2;
        var path = document.createElementNS(SVG, 'path');
        path.setAttribute('d', 'M' + x1 + ',' + y1 + ' L' + x2 + ',' + y2);
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
          '<div class="label">' + (n.type === 'ai-idea' ? '💡 ' : '') + esc(labelFor(n)) + '</div>' +
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
    h += '<div class="d-title">' + (n.type === 'ai-idea' ? '💡 ' : '') + esc(labelFor(n)) + '</div>';
    h += '<div class="chips">' +
      chip('source', m.source) + chip('model', m.model) + chip('status', m.status) +
      chip('branch', m.branch) + chip('files', d.files) + chip('commits', d.commits) +
      chip('time', (d.promptTime || m.timestamp) ? new Date(d.promptTime || m.timestamp).toLocaleString() : null) +
      '</div>';

    if (n.type === 'ai-idea') {
      h += '<p class="empty-hint">A design decision / insight the AI introduced while working on “' + esc(d.context || '') + '”.</p>';
    }
    if (n.type === 'category') {
      h += '<p class="empty-hint">Category · ' + esc(n.summary || '') + '. Expand to see the ideas under it.</p>';
    }
    if (n.type === 'commits' && d.unlinkedCommits) {
      h += '<p class="empty-hint">' + esc(n.summary || '') + '</p>';
      h += '<div class="section">Commits</div>' + d.unlinkedCommits.map(commitRow).join('');
    }
    if (d.prompt && d.prompt.trim()) {
      h += '<div class="prompt-card"><div class="head">User prompt</div><div class="md">' + markdown(d.prompt) + '</div></div>';
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
    if (!d.prompt && !d.response && n.type !== 'commits' && n.type !== 'ai-idea' && n.type !== 'category') {
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
    '<span><b>' + (t.category || 0) + '</b> categories</span>' +
    '<span><b>' + ideaCount() + '</b> ideas</span>' +
    '<span><b>' + (t['ai-idea'] || 0) + '</b> AI insights</span>';

  var legend = document.getElementById('legend');
  var LG = [['category', 'category'], ['idea', 'goal'], ['refine', 'refine'], ['fix', 'fix'],
    ['question', 'question'], ['decision', 'pivot'], ['verification', 'test'], ['ai-idea', 'AI insight']];
  legend.innerHTML = LG.filter(function (x) { return t[x[0]]; }).map(function (x) {
    return '<span class="item"><span class="sw" style="background:var(--t-' + x[0] + ')"></span>' + x[1] + '</span>';
  }).join('') + '<span class="item hint">drag to pan · scroll to zoom · click a node</span>';

  document.getElementById('reset').addEventListener('click', function () { render(); fitView(); });

  // ---------- language toggle ----------
  var langBtn = document.getElementById('lang');
  function setLangLabel() { langBtn.textContent = lang === 'zh' ? 'EN' : '中文'; }
  langBtn.addEventListener('click', function () {
    lang = lang === 'zh' ? 'en' : 'zh';
    setLangLabel();
    render();
    if (selectedId) select(selectedId);
  });
  setLangLabel();

  // ---------- export ----------
  function slug(s) { return (s || 'ai-devlog').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'ai-devlog'; }
  function oneLine(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }
  function toMarkdown() {
    var out = ['# ' + (tree.title || 'AI Devlog')];
    if (tree.summary) out.push('', '> ' + tree.summary);
    out.push('');
    (function walk(n, depth) {
      (n._allKids || n.children || []).forEach(function (c) {
        var ind = '  '.repeat(Math.max(0, depth));
        var lab = labelFor(c), d = c.detail || {};
        if (c.type === 'category') { out.push('', '## ' + lab, ''); walk(c, 0); }
        else if (c.type === 'ai-idea') { out.push(ind + '- 💡 ' + lab); }
        else if (c.type === 'commits') {
          out.push('', '## ' + lab, '');
          (d.unlinkedCommits || []).forEach(function (cc) { out.push('- `' + (cc.short || cc) + '` ' + (cc.subject || '')); });
        } else {
          out.push(ind + '- **' + lab + '**' + (c.meta && c.meta.intent ? '  _(' + c.meta.intent + ')_' : ''));
          if (d.prompt) out.push(ind + '  - prompt: ' + oneLine(d.prompt).slice(0, 240));
          if (d.files && d.files.length) out.push(ind + '  - files: ' + d.files.join(', '));
          if (d.commits && d.commits.length) out.push(ind + '  - commits: ' + d.commits.map(function (x) { return x.short || x; }).join(', '));
          walk(c, depth + 1);
        }
      });
    })(tree, 0);
    return out.join('\n') + '\n';
  }
  function download(name, text, mime) {
    var blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); if (a.parentNode) a.parentNode.removeChild(a); }, 200);
  }
  function doExport(fmt) {
    var base = slug(tree.title);
    if (fmt === 'json') download(base + '.json', JSON.stringify(DATA, null, 2), 'application/json');
    else download(base + '.md', toMarkdown(), 'text/markdown;charset=utf-8');
  }
  var exportBtn = document.getElementById('export');
  var exportMenu = document.getElementById('export-menu');
  exportBtn.addEventListener('click', function (e) { e.stopPropagation(); exportMenu.hidden = !exportMenu.hidden; });
  exportMenu.addEventListener('click', function (e) {
    var b = e.target.closest('button[data-fmt]');
    if (b) { doExport(b.getAttribute('data-fmt')); exportMenu.hidden = true; }
  });
  document.addEventListener('click', function () { exportMenu.hidden = true; });

  // ---------- light / dark ----------
  var themeBtn = document.getElementById('theme');
  themeBtn.addEventListener('click', function () {
    var dark = document.body.classList.toggle('dark');
    themeBtn.textContent = dark ? '☀' : '🌙';
  });

  // ---------- go ----------
  render(); fitView();
})();
