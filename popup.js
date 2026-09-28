const DEFAULTS = {
  enabled: true,
  allowed: [],
  blurPending: false,
  hideUnknown: false,
  showLabels: false,
  learningMode: true,
  slowMode: false,
  queryId: '',
};

const $ = (id) => document.getElementById(id);
let settings = { ...DEFAULTS };

async function load() {
  settings = { ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) };
  $('enabled').checked = settings.enabled;
  $('hideUnknown').checked = settings.hideUnknown;
  $('blurPending').checked = settings.blurPending;
  $('showLabels').checked = settings.showLabels;
  $('learningMode').checked = settings.learningMode;
  $('slowMode').checked = settings.slowMode;
  $('queryId').value = settings.queryId;
  renderList();
  renderStatus();
}

function save(patch) {
  Object.assign(settings, patch);
  renderStatus();
  return chrome.storage.sync.set(patch);
}

function renderStatus() {
  const el = $('status');
  if (!settings.enabled) {
    el.textContent = 'Filter is OFF — all posts are shown.';
    el.className = 'status off';
  } else if (settings.learningMode) {
    el.textContent = 'Learning mode — all posts are shown; 1 location lookup every 10 s.';
    el.className = 'status learning';
  } else if (!settings.allowed.length) {
    el.textContent = 'Filter is on, but no locations are allowed yet — add one below.';
    el.className = 'status';
  } else {
    el.textContent = `Filter is ON — showing posts from ${settings.allowed.length} location(s).`;
    if (settings.slowMode) el.textContent += ' Slow mode: 1 lookup every 10 s.';
    el.className = 'status';
  }
}

function renderList() {
  const ul = $('list');
  ul.textContent = '';
  if (!settings.allowed.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No locations yet';
    ul.appendChild(li);
    return;
  }
  settings.allowed.forEach((loc, i) => {
    const li = document.createElement('li');
    const span = document.createElement('span');
    span.textContent = loc;
    const btn = document.createElement('button');
    btn.textContent = '×';
    btn.title = 'Remove';
    btn.addEventListener('click', () => {
      const allowed = settings.allowed.filter((_, j) => j !== i);
      save({ allowed });
      renderList();
    });
    li.append(span, btn);
    ul.appendChild(li);
  });
}

$('addForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const val = $('newLoc').value.trim();
  if (!val) return;
  if (!settings.allowed.some((a) => a.toLowerCase() === val.toLowerCase())) {
    save({ allowed: [...settings.allowed, val] });
    renderList();
  }
  $('newLoc').value = '';
  $('newLoc').focus();
});

for (const id of ['enabled', 'hideUnknown', 'blurPending', 'showLabels', 'learningMode', 'slowMode']) {
  $(id).addEventListener('change', (e) => save({ [id]: e.target.checked }));
}

$('queryId').addEventListener('change', (e) => save({ queryId: e.target.value.trim() }));

function db(msg) {
  return chrome.runtime.sendMessage(msg).then((r) => {
    if (!r || !r.ok) throw new Error((r && r.error) || 'no response');
    return r.result;
  });
}

async function refreshDbCount() {
  try {
    const [n, q] = await Promise.all([db({ type: 'db-count' }), db({ type: 'queue-stats' })]);
    $('dbCount').textContent =
      `${n.toLocaleString()} account(s) saved · ${q.pending.toLocaleString()} waiting for lookup.`;
  } catch (e) {
    $('dbCount').textContent = 'Database error: ' + e.message;
  }
}

function flash(id, text) {
  const btn = $(id);
  const orig = btn.textContent;
  btn.textContent = text;
  setTimeout(() => (btn.textContent = orig), 1500);
}

$('openDb').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('db.html') });
});

$('exportDb').addEventListener('click', async () => {
  const rows = await db({ type: 'db-export' });
  const blob = new Blob([JSON.stringify(rows, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `x-location-filter-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});

// A file picker closes the popup (and kills this script), so import runs from a tab.
const inTab = location.hash === '#tab';
$('importDb').addEventListener('click', () => {
  if (inTab) $('importFile').click();
  else chrome.tabs.create({ url: chrome.runtime.getURL('popup.html#tab') });
});
$('importFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const records = Array.isArray(data) ? data : [];
    const s = await db({ type: 'db-import', records });
    flash('importDb', `Added ${s.added}, filled ${s.filled}`);
    refreshDbCount();
  } catch (err) {
    flash('importDb', 'Bad file');
  }
});

$('clearDb').addEventListener('click', async () => {
  if (!confirm('Delete all saved accounts? They will have to be looked up on X again.')) return;
  await db({ type: 'db-clear' });
  refreshDbCount();
});

async function refreshStats() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  try {
    const s = await chrome.tabs.sendMessage(tab.id, { type: 'xlf-stats' });
    if (!s) return;
    let text = `Hidden: ${s.hidden} · Shown: ${s.shown} · Checking: ${s.pending}`;
    text += `\nLooking up now: ${s.queue} · X lookups this page: ${s.apiLookups}`;
    text += `\nAuth token captured from X: ${s.tokenCaptured ? 'yes' : 'no'}`;
    if (s.pausedUntil) text += `\nRate limited until ${new Date(s.pausedUntil).toLocaleTimeString()}`;
    else if (s.lastError) text += `\nLast error: ${s.lastError}`;
    $('stats').textContent = text;
    $('stats').style.whiteSpace = 'pre-line';
  } catch {
    $('stats').textContent = 'Open x.com in this tab to see stats.';
  }
}

// ---------- tabs ----------

function showTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.panel').forEach((p) => (p.hidden = p.id !== 'panel-' + name));
  try {
    localStorage.setItem('xlf-tab', name);
  } catch {
    /* storage unavailable: just don't remember the tab */
  }
  if (name === 'history') refreshHistory(true);
}

document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => showTab(t.dataset.tab)));

// ---------- history ----------

const HISTORY_DEFAULT_LIMIT = 100; // keep in sync with background.js
const HISTORY_MAX_LIMIT = 10000;
let historyKey = '';

chrome.storage.sync
  .get({ historyLimit: HISTORY_DEFAULT_LIMIT })
  .then(({ historyLimit }) => ($('historyLimit').value = historyLimit));

$('historyLimit').addEventListener('change', async (e) => {
  const n = Math.min(HISTORY_MAX_LIMIT, Math.max(10, Math.floor(Number(e.target.value)) || HISTORY_DEFAULT_LIMIT));
  e.target.value = n;
  await chrome.storage.sync.set({ historyLimit: n });
  refreshHistory(true);
});

$('clearHistory').addEventListener('click', async () => {
  if (!confirm('Clear the list of posts you have seen?')) return;
  await db({ type: 'history-clear' });
  refreshHistory(true);
});

function timeAgo(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function renderPost(p) {
  const li = document.createElement('li');
  li.title = new Date(p.seenAt).toLocaleString();

  const head = document.createElement('div');
  head.className = 'post-head';
  const name = document.createElement('span');
  name.className = 'post-name';
  name.textContent = p.name || '@' + p.handle;
  const meta = document.createElement('span');
  meta.className = 'post-meta';
  meta.textContent = `@${p.handle} · seen ${timeAgo(p.seenAt)} ago`;
  head.append(name, meta);

  const text = document.createElement('div');
  text.className = p.text ? 'post-text' : 'post-text none';
  text.textContent = p.text || '(no text)';
  li.append(head, text);

  if (p.image) {
    const img = document.createElement('img');
    img.className = 'post-img';
    img.src = p.image;
    img.alt = '';
    img.loading = 'lazy';
    li.append(img);
  }
  if (p.location) {
    const loc = document.createElement('div');
    loc.className = 'post-loc';
    loc.textContent = '📍 ' + p.location;
    li.append(loc);
  }
  if (p.url) li.addEventListener('click', () => chrome.tabs.create({ url: p.url }));
  return li;
}

// Re-renders only when the list changed (or force), so scrolling isn't disturbed.
async function refreshHistory(force) {
  if ($('panel-history').hidden) return;
  let posts;
  try {
    posts = await db({ type: 'history-list' });
  } catch (e) {
    $('history').textContent = 'History error: ' + e.message;
    return;
  }
  const key = posts.map((p) => p.id + ':' + p.seenAt).join(',');
  if (!force && key === historyKey) return;
  historyKey = key;
  const ol = $('history');
  const scroll = ol.scrollTop;
  ol.textContent = '';
  if (!posts.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No posts yet — scroll x.com and they will show up here.';
    ol.append(li);
  } else {
    posts.forEach((p) => ol.append(renderPost(p)));
  }
  ol.scrollTop = scroll;
}

let initialTab = 'filter';
try {
  initialTab = localStorage.getItem('xlf-tab') === 'history' ? 'history' : 'filter';
} catch {
  /* default tab */
}
showTab(initialTab);

load();
refreshStats();
refreshDbCount();
setInterval(() => {
  refreshStats();
  refreshDbCount();
  refreshHistory(false);
}, 1000);
