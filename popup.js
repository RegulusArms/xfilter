const DEFAULTS = {
  enabled: true,
  allowed: [],
  blurPending: true,
  hideUnknown: true,
  showLabels: true,
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
  } else if (!settings.allowed.length) {
    el.textContent = 'Filter is on, but no locations are allowed yet — add one below.';
    el.className = 'status';
  } else {
    el.textContent = `Filter is ON — showing posts from ${settings.allowed.length} location(s).`;
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

for (const id of ['enabled', 'hideUnknown', 'blurPending', 'showLabels']) {
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

// Stored in local (not sync) storage: the URL's sig= parameter is a password.
chrome.storage.local.get({ ingestUrl: '' }).then(({ ingestUrl }) => ($('ingestUrl').value = ingestUrl));
$('ingestUrl').addEventListener('change', (e) =>
  chrome.storage.local.set({ ingestUrl: e.target.value.trim() })
);

const CLOUD_COOLDOWN_MS = 24 * 3600e3; // keep in sync with background.js

// Disables the button until the 24 h cooldown after the last successful run is over.
function applyCooldown(id, last) {
  const next = last && last.ok !== false ? last.at + CLOUD_COOLDOWN_MS : 0;
  const waiting = Date.now() < next;
  $(id).disabled = waiting;
  $(id).title = waiting
    ? 'Available again ' + new Date(next).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })
    : '';
}

async function showLastPush() {
  const { lastPush } = await chrome.storage.local.get('lastPush');
  applyCooldown('pushDb', lastPush);
  if (!lastPush) return;
  const when = new Date(lastPush.at).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
  $('pushStatus').textContent = lastPush.ok
    ? `Last push ${when}: ${lastPush.count.toLocaleString()} accounts`
    : `Last push ${when} failed (HTTP ${lastPush.status})`;
}

$('pushDb').addEventListener('click', async () => {
  $('pushDb').disabled = true;
  $('pushStatus').textContent = 'Pushing…';
  try {
    await db({ type: 'cloud-push' });
    await showLastPush();
  } catch (e) {
    $('pushStatus').textContent = 'Push failed: ' + e.message;
    applyCooldown('pushDb', (await chrome.storage.local.get('lastPush')).lastPush);
  }
});

async function showLastPull() {
  const { lastPull } = await chrome.storage.local.get('lastPull');
  applyCooldown('pullDb', lastPull);
  if (!lastPull) return;
  const when = new Date(lastPull.at).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
  $('pullStatus').textContent =
    `Last pull ${when}: ${lastPull.added.toLocaleString()} new, ${lastPull.filled.toLocaleString()} filled`;
}

$('pullDb').addEventListener('click', async () => {
  $('pullDb').disabled = true;
  $('pullStatus').textContent = 'Pulling…';
  try {
    await db({ type: 'cloud-pull' });
    await showLastPull();
    refreshDbCount();
  } catch (e) {
    $('pullStatus').textContent = 'Pull failed: ' + e.message;
    applyCooldown('pullDb', (await chrome.storage.local.get('lastPull')).lastPull);
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

load();
showLastPush();
showLastPull();
refreshStats();
refreshDbCount();
setInterval(() => {
  refreshStats();
  refreshDbCount();
}, 1000);
