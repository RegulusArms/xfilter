// Account database viewer/editor. Reads and writes through background.js.

const PAGE_SIZE = 100;
const DEFAULTS = { enabled: true, allowed: [], hideUnknown: false, learningMode: true };

const $ = (id) => document.getElementById(id);
let rows = [];
let settings = { ...DEFAULTS };
let sortKey = 'checkedAt';
let sortDir = 'desc';
let page = 0;
const rowRefreshers = new Map(); // handle -> refresh fn for the rendered row

function db(msg) {
  return chrome.runtime.sendMessage(msg).then((r) => {
    if (!r || !r.ok) throw new Error((r && r.error) || 'no response');
    return r.result;
  });
}

const isWaiting = (rec) => rec.queueAt != null;

// Same rule as content.js: shown if the location contains any allowed entry.
function status(rec) {
  if (isWaiting(rec) && !rec.location) return 'waiting';
  if (!settings.enabled || settings.learningMode || !settings.allowed.length) return 'off';
  if (!rec.location) return settings.hideUnknown ? 'hidden' : 'shown';
  const l = rec.location.toLowerCase();
  const ok = settings.allowed.some((a) => {
    const n = String(a).trim().toLowerCase();
    return n && l.includes(n);
  });
  return ok ? 'shown' : 'hidden';
}

function fmtDate(ms) {
  return ms ? new Date(ms).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' }) : '';
}

async function load() {
  settings = { ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) };
  rows = await db({ type: 'db-export' });
  render();
}

function filtered() {
  const q = $('search').value.trim().toLowerCase();
  const f = $('filter').value;
  let list = rows.filter((r) => {
    if (q && ![r.handle, r.location || '', r.comment || ''].some((v) => v.toLowerCase().includes(q))) {
      return false;
    }
    switch (f) {
      case 'shown': return status(r) === 'shown';
      case 'hidden': return status(r) === 'hidden';
      case 'waiting': return isWaiting(r);
      case 'unknown': return !r.location && !isWaiting(r);
      case 'manual': return !!r.manual;
      case 'comment': return !!r.comment;
      default: return true;
    }
  });
  const val = (r) => (sortKey === 'status' ? status(r) : r[sortKey]);
  list.sort((a, b) => {
    const x = val(a) ?? '';
    const y = val(b) ?? '';
    const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
    return sortDir === 'asc' ? c : -c;
  });
  return list;
}

function render() {
  const list = filtered();
  const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  page = Math.min(page, pages - 1);
  const slice = list.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  $('count').textContent =
    list.length === rows.length
      ? `${rows.length.toLocaleString()} accounts`
      : `${list.length.toLocaleString()} of ${rows.length.toLocaleString()} accounts`;
  $('pageInfo').textContent = `Page ${page + 1} of ${pages}`;
  $('prev').disabled = page === 0;
  $('next').disabled = page >= pages - 1;

  document.querySelectorAll('th[data-sort]').forEach((th) => {
    if (th.dataset.sort === sortKey) th.dataset.dir = sortDir;
    else delete th.dataset.dir;
  });

  const tbody = $('rows');
  tbody.textContent = '';
  rowRefreshers.clear();
  if (!slice.length) {
    const tr = document.createElement('tr');
    tr.className = 'empty';
    const td = document.createElement('td');
    td.colSpan = 7;
    td.textContent = rows.length ? 'No accounts match.' : 'No accounts saved yet — browse x.com with the filter on.';
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }
  for (const rec of slice) tbody.appendChild(renderRow(rec));
}

function renderRow(rec) {
  const tr = document.createElement('tr');
  const cell = (child, cls) => {
    const td = document.createElement('td');
    if (cls) td.className = cls;
    if (child) td.append(child);
    tr.appendChild(td);
    return td;
  };

  const a = document.createElement('a');
  a.className = 'handle';
  a.href = `https://x.com/${rec.handle}/about`;
  a.target = '_blank';
  a.rel = 'noopener';
  a.textContent = '@' + rec.handle;
  cell(a);

  const locInput = editor(rec, 'location', 'no location', refresh);
  const locTd = cell(locInput);
  const edited = document.createElement('span');
  edited.className = 'edited';
  edited.textContent = 'edited';
  edited.title = 'Set by hand — lookups will not overwrite it';
  locTd.appendChild(edited);

  const badge = document.createElement('span');
  cell(badge);

  cell(editor(rec, 'comment', 'add comment…', refresh));
  const checkedTd = cell(null, 'date');

  // Update this row's derived bits in place (no re-render, so focus isn't lost).
  function refresh() {
    edited.hidden = !rec.manual;
    const st = status(rec);
    badge.className = 'badge ' + st;
    badge.textContent = st === 'off' ? 'filter off' : st === 'waiting' ? 'waiting for lookup' : st;
    badge.title = rec.lastError ? `Last attempt failed: ${rec.lastError}` : '';
    if (document.activeElement !== locInput) {
      locInput.value = rec.location || '';
      locInput.placeholder = isWaiting(rec) ? 'waiting for lookup…' : 'no location';
    }
    checkedTd.textContent = rec.checkedAt ? fmtDate(rec.checkedAt) : 'never';
  }
  rowRefreshers.set(rec.handle, refresh);
  refresh();

  cell(document.createTextNode(fmtDate(rec.firstSeen)), 'date');

  const again = document.createElement('button');
  again.className = 'relookup';
  again.textContent = '↻';
  again.title = 'Look up again (clears a hand-set location)';
  again.addEventListener('click', async () => {
    Object.assign(rec, await db({ type: 'db-relookup', handle: rec.handle }));
    refresh();
  });

  const del = document.createElement('button');
  del.className = 'del';
  del.textContent = '×';
  del.title = 'Delete account';
  del.addEventListener('click', async () => {
    if (!confirm(`Delete @${rec.handle} from the database?`)) return;
    await db({ type: 'db-delete', handle: rec.handle });
    rows = rows.filter((r) => r.handle !== rec.handle);
    render();
  });
  const actions = cell(again, 'actions');
  actions.appendChild(del);
  return tr;
}

function editor(rec, field, placeholder, onSaved) {
  const input = document.createElement('input');
  input.type = 'text';
  input.value = rec[field] || '';
  input.placeholder = placeholder;
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') input.blur();
    if (e.key === 'Escape') {
      input.value = rec[field] || '';
      input.blur();
    }
  });
  input.addEventListener('change', async () => {
    try {
      const updated = await db({ type: 'db-update', handle: rec.handle, patch: { [field]: input.value } });
      for (const k of ['queueAt', 'attempts', 'lastError']) delete rec[k];
      Object.assign(rec, updated);
      input.classList.remove('error');
      input.classList.add('saved');
      setTimeout(() => input.classList.remove('saved'), 1200);
      onSaved();
    } catch (e) {
      input.classList.add('error');
      input.title = e.message;
    }
  });
  return input;
}

$('addForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const handle = $('addHandle').value.trim().replace(/^@/, '').toLowerCase();
  const patch = { comment: $('addComment').value.trim() };
  if ($('addLocation').value.trim()) patch.location = $('addLocation').value;
  try {
    const rec = await db({ type: 'db-update', handle, patch });
    rows = rows.filter((r) => r.handle !== rec.handle).concat(rec);
    $('addForm').reset();
    $('addMsg').textContent = `Saved @${rec.handle}`;
    render();
  } catch (err) {
    $('addMsg').textContent = err.message;
  }
  setTimeout(() => ($('addMsg').textContent = ''), 2500);
});

document.querySelectorAll('th[data-sort]').forEach((th) =>
  th.addEventListener('click', () => {
    const key = th.dataset.sort;
    sortDir = sortKey === key && sortDir === 'asc' ? 'desc' : 'asc';
    sortKey = key;
    render();
  })
);

$('search').addEventListener('input', () => {
  page = 0;
  render();
});
$('filter').addEventListener('change', () => {
  page = 0;
  render();
});
$('prev').addEventListener('click', () => {
  page--;
  render();
});
$('next').addEventListener('click', () => {
  page++;
  render();
});
$('refresh').addEventListener('click', load);

chrome.storage.onChanged.addListener((changes, area) => {
  // Filter settings changed in the popup → recompute the status column.
  if (area === 'sync' && (changes.allowed || changes.enabled || changes.hideUnknown || changes.learningMode)) load();
  // A lookup finished (or another tab edited an account): update that row in place.
  if (area === 'local' && changes.dbEdit && changes.dbEdit.newValue) {
    const { handle, record } = changes.dbEdit.newValue;
    const rec = rows.find((r) => r.handle === handle);
    if (rec && record) {
      for (const k of ['queueAt', 'attempts', 'lastError']) delete rec[k];
      Object.assign(rec, record);
      const refresh = rowRefreshers.get(handle);
      if (refresh) refresh();
    }
  }
});

load();
