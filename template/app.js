/* ai-devlog viewer — vanilla JS, no dependencies, offline-safe. */
(function () {
  'use strict';

  var DATA = JSON.parse(document.getElementById('devlog-data').textContent);
  var tree = DATA.tree;
  var stats = DATA.stats || {};

  // ---------- safe helpers ----------
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function safeUrl(u) {
    return /^(https?:|mailto:|#|\/|\.)/i.test(u) ? u : '#';
  }

  // ---------- tiny markdown renderer (sanitized) ----------
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
    var lines = String(src).split(/\r?\n/);
    var out = [], i = 0;
    while (i < lines.length) {
      var line = lines[i];
      var fence = line.match(/^```(\w*)/);
      if (fence) {
        var buf = [];
        i++;
        while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i++; }
        i++;
        out.push('<pre><code>' + esc(buf.join('\n')) + '</code></pre>');
        continue;
      }
      var h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) { var lv = h[1].length; out.push('<h' + lv + '>' + inline(h[2]) + '</h' + lv + '>'); i++; continue; }
      if (/^\s*[-*]\s+/.test(line)) {
        var items = [];
        while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) { items.push('<li>' + inline(lines[i].replace(/^\s*[-*]\s+/, '')) + '</li>'); i++; }
        out.push('<ul>' + items.join('') + '</ul>');
        continue;
      }
      if (/^\s*\d+\.\s+/.test(line)) {
        var oi = [];
        while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) { oi.push('<li>' + inline(lines[i].replace(/^\s*\d+\.\s+/, '')) + '</li>'); i++; }
        out.push('<ol>' + oi.join('') + '</ol>');
        continue;
      }
      if (/^\s*>\s?/.test(line)) { out.push('<blockquote>' + inline(line.replace(/^\s*>\s?/, '')) + '</blockquote>'); i++; continue; }
      if (line.trim() === '') { i++; continue; }
      var para = [];
      while (i < lines.length && lines[i].trim() !== '' && !/^```/.test(lines[i]) && !/^#{1,6}\s/.test(lines[i]) && !/^\s*[-*]\s+/.test(lines[i]) && !/^\s*\d+\.\s+/.test(lines[i])) {
        para.push(lines[i]); i++;
      }
      out.push('<p>' + inline(para.join('\n')) + '</p>');
    }
    return out.join('\n');
  }

  function renderDiff(diff) {
    var html = String(diff).split(/\r?\n/).map(function (l) {
      var cls = 'ctx';
      if (/^\+(?!\+\+)/.test(l)) cls = 'add';
      else if (/^-(?!--)/.test(l)) cls = 'del';
      else if (/^@@/.test(l)) cls = 'hunk';
      return '<div class="line ' + cls + '">' + esc(l || ' ') + '</div>';
    }).join('');
    return '<div class="diff">' + html + '</div>';
  }

  // ---------- index nodes ----------
  var byId = {};
  (function walk(n, parent) { n._parent = parent; byId[n.id] = n; (n.children || []).forEach(function (c) { walk(c, n); }); })(tree, null);

  function searchText(n) {
    if (n._search != null) return n._search;
    n._search = ((n.title || '') + ' ' + (n.content || '') + ' ' + (n.type || '')).toLowerCase();
    return n._search;
  }

  // ---------- render tree ----------
  var center = document.getElementById('tree');
  var hiddenTypes = {}, hiddenSources = {};
  var query = '';

  function visibleByFilter(n) {
    if (hiddenTypes[n.type]) return false;
    if (n.meta && n.meta.source && hiddenSources[n.meta.source]) return false;
    return true;
  }

  function matchesQuery(n) {
    if (!query) return true;
    if (searchText(n).indexOf(query) >= 0) return true;
    return (n.children || []).some(matchesQuery);
  }

  function nodeEl(n) {
    var li = document.createElement('li');
    li.className = 'tnode';
    var kids = (n.children || []);
    var row = document.createElement('div');
    row.className = 'node-row';
    row.dataset.id = n.id;

    var tog = document.createElement('span');
    tog.className = 'toggle' + (kids.length ? '' : ' empty');
    tog.textContent = '▾';
    tog.addEventListener('click', function (e) { e.stopPropagation(); li.classList.toggle('collapsed'); });
    row.appendChild(tog);

    var isUser = n.type === 'prompt' || (n.meta && n.meta.role === 'user');
    if (isUser) {
      row.classList.add('is-user');
      var mark = document.createElement('span');
      mark.className = 'user-mark';
      mark.textContent = '🧑';
      row.appendChild(mark);
    }

    if (n.type !== 'root') {
      var badge = document.createElement('span');
      badge.className = 'badge c-' + n.type;
      badge.textContent = n.type;
      row.appendChild(badge);
    }

    var t = document.createElement('span');
    t.className = 'node-title';
    t.textContent = n.title || n.type;
    row.appendChild(t);

    row.addEventListener('click', function () { select(n.id); });
    li.appendChild(row);

    var shownKids = kids.filter(function (c) { return visibleByFilter(c) && matchesQuery(c); });
    if (shownKids.length) {
      var ul = document.createElement('ul');
      shownKids.forEach(function (c) { ul.appendChild(nodeEl(c)); });
      li.appendChild(ul);
      // collapse container nodes by default (big trees stay readable); a live
      // search expands everything so matches are visible.
      var COLLAPSE = { session: 1, idea: 1, decision: 1, verification: 1 };
      if (!query && COLLAPSE[n.type]) li.classList.add('collapsed');
    } else {
      tog.classList.add('empty');
    }
    return li;
  }

  function renderTree() {
    center.innerHTML = '';
    var ul = document.createElement('ul');
    ul.className = 'tree';
    // render children of root directly (root itself is implicit = project header)
    (tree.children || []).filter(function (c) { return visibleByFilter(c) && matchesQuery(c); })
      .forEach(function (c) { ul.appendChild(nodeEl(c)); });
    center.appendChild(ul);
    if (selectedId && byId[selectedId]) highlight(selectedId);
  }

  // ---------- detail pane ----------
  var detail = document.getElementById('detail');
  var selectedId = null;

  function chip(label, value) {
    if (value == null || value === '' || (Array.isArray(value) && !value.length)) return '';
    var v = Array.isArray(value) ? value.join(', ') : value;
    return '<span class="chip">' + esc(label) + ' <b>' + esc(v) + '</b></span>';
  }

  function select(id) {
    selectedId = id;
    var n = byId[id];
    if (!n) return;
    var m = n.meta || {};
    var html = '';
    html += '<div class="detail">';
    html += '<span class="badge c-' + n.type + '" style="font-size:11px">' + esc(n.type) + '</span>';
    html += '<h2>' + esc(n.title || n.type) + '</h2>';
    html += '<div class="chips">';
    html += chip('source', m.source);
    html += chip('role', m.role);
    html += chip('model', m.model);
    html += chip('branch', m.branch);
    html += chip('status', m.status);
    html += chip('time', m.timestamp ? new Date(m.timestamp).toLocaleString() : null);
    html += '</div>';

    if (m.files && m.files.length) {
      html += '<div class="section-label">Files</div>';
      html += m.files.map(function (f) { return '<span class="file-pill">' + esc(f) + '</span>'; }).join('');
    }

    if (n.content && n.content.trim()) {
      var asUser = n.type === 'prompt' || (m.role === 'user');
      var asAsst = n.type === 'response' || (m.role === 'assistant');
      if (asUser) {
        html += '<div class="prompt-card">' +
          '<div class="prompt-card-head"><span class="avatar">🧑</span> User prompt</div>' +
          '<div class="md">' + markdown(n.content) + '</div></div>';
      } else if (asAsst) {
        html += '<div class="role-head"><span class="avatar">🤖</span> AI response</div>';
        html += '<div class="md">' + markdown(n.content) + '</div>';
      } else {
        html += '<div class="section-label">Detail</div>';
        html += '<div class="md">' + markdown(n.content) + '</div>';
      }
    }

    if (n.diff) {
      html += '<div class="section-label">Diff</div>';
      html += renderDiff(n.diff);
    }

    if (m.commits && m.commits.length) {
      html += '<div class="section-label">Commits</div>';
      html += m.commits.map(function (c) { return '<span class="file-pill">' + esc(c) + '</span>'; }).join('');
    }

    if (!n.content && !n.diff && (!m.files || !m.files.length)) {
      html += '<p class="empty-hint">' + esc((n.children || []).length) + ' child node(s). Select one to see details.</p>';
    }
    html += '</div>';
    detail.innerHTML = html;
    highlight(id);
  }

  function highlight(id) {
    var prev = center.querySelector('.node-row.selected');
    if (prev) prev.classList.remove('selected');
    var el = center.querySelector('.node-row[data-id="' + id + '"]');
    if (el) {
      el.classList.add('selected');
      // expand ancestors
      var li = el.closest('li');
      while (li) { li.classList.remove('collapsed'); li = li.parentElement.closest('li'); }
    }
  }

  // ---------- filters UI ----------
  function buildFilters() {
    var typesBox = document.getElementById('f-types');
    var srcBox = document.getElementById('f-sources');
    var types = stats.types || {};
    var sources = stats.sources || {};
    Object.keys(types).filter(function (t) { return t !== 'root'; }).forEach(function (t) {
      typesBox.appendChild(filterRow('type', t, types[t]));
    });
    Object.keys(sources).forEach(function (s) {
      srcBox.appendChild(filterRow('source', s, sources[s]));
    });
  }
  function filterRow(kind, key, count) {
    var label = document.createElement('label');
    var cb = document.createElement('input');
    cb.type = 'checkbox'; cb.checked = true;
    cb.addEventListener('change', function () {
      var map = kind === 'type' ? hiddenTypes : hiddenSources;
      if (cb.checked) delete map[key]; else map[key] = true;
      renderTree();
    });
    label.appendChild(cb);
    if (kind === 'type') {
      var sw = document.createElement('span'); sw.className = 'swatch c-' + key; label.appendChild(sw);
    }
    var txt = document.createElement('span'); txt.textContent = key; label.appendChild(txt);
    var c = document.createElement('span'); c.className = 'count'; c.textContent = count; label.appendChild(c);
    return label;
  }

  // ---------- search ----------
  document.getElementById('search').addEventListener('input', function (e) {
    query = e.target.value.trim().toLowerCase();
    renderTree();
  });

  // ---------- header ----------
  document.getElementById('proj-name').textContent = tree.title || 'AI Devlog';
  if (tree.summary) document.getElementById('proj-sub').textContent = tree.summary;
  var st = document.getElementById('stats');
  st.innerHTML =
    chipStat('sessions', (stats.types && stats.types.session) || 0) +
    chipStat('ideas', (stats.types && stats.types.idea) || 0) +
    chipStat('decisions', (stats.types && stats.types.decision) || 0) +
    chipStat('nodes', stats.count || 0);
  function chipStat(l, v) { return '<span><b>' + v + '</b> ' + l + '</span>'; }

  buildFilters();
  renderTree();
  // auto-select first idea
  var firstIdea = Object.keys(byId).map(function (k) { return byId[k]; }).find(function (n) { return n.type === 'idea' || n.type === 'session'; });
  if (firstIdea) select(firstIdea.id);
})();
