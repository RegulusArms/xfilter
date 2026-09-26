// X Location Filter — background service worker.
// Owns the account database (IndexedDB, in the extension's own origin so it survives
// clearing x.com site data) and the lookup queue. Content scripts and the popup / DB
// page talk to it via messages. The actual X lookups run in x.com tabs (they need the
// logged-in page session); this worker only decides *which* account each tab looks up.
//
// Record: { handle, location (string|null), checkedAt (ms, 0 = never), firstSeen (ms),
//           comment (string), manual (bool: location was set by hand in the DB page,
//           so lookups never overwrite it),
//           queueAt? (ms: present only while waiting for a lookup — the time it becomes
//                     eligible; later than now after failures),
//           attempts?, lastError? }

const DB_NAME = 'xlf';
const STORE = 'accounts';
const TTL_NONE = 7 * 24 * 3600e3; // re-check "no location" accounts after this long
const LEASE_MS = 60e3; // a claimed account is reserved for one tab this long
const PRIORITY_MS = 30e3; // "on screen" hints expire after this long

let dbPromise = null;
function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 2);
    req.onupgradeneeded = (e) => {
      const store =
        e.oldVersion < 1
          ? req.result.createObjectStore(STORE, { keyPath: 'handle' })
          : req.transaction.objectStore(STORE);
      if (e.oldVersion < 1) store.createIndex('checkedAt', 'checkedAt');
      // Only pending records have queueAt, so this index is exactly the waiting list.
      if (e.oldVersion < 2) store.createIndex('queueAt', 'queueAt');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      dbPromise = null;
      reject(req.error);
    };
  });
  return dbPromise;
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}

// Run fn(store) in one transaction and resolve with its return value once committed.
async function withStore(mode, fn) {
  const db = await openDb();
  const tx = db.transaction(STORE, mode);
  const result = await fn(tx.objectStore(STORE));
  await txDone(tx);
  return result;
}

function cleanLocation(v) {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function validHandle(h) {
  const handle = String(h || '').replace(/^@/, '').toLowerCase();
  return /^[a-z0-9_]{1,15}$/.test(handle) ? handle : null;
}

function newRecord(handle, now) {
  return { handle, location: null, checkedAt: 0, firstSeen: now, comment: '', manual: false, queueAt: now };
}

function clearQueueFields(rec) {
  delete rec.queueAt;
  delete rec.attempts;
  delete rec.lastError;
}

// Lets open x.com tabs (and the DB page) apply changes immediately.
function notifyEdit(handle, record) {
  chrome.storage.local.set({ dbEdit: { handle, record, at: Date.now() } }).catch(() => {});
}

// ---------- reads ----------

function getMany(handles) {
  return withStore('readonly', async (store) => {
    const out = {};
    await Promise.all(
      handles.map(async (h) => {
        const rec = await reqToPromise(store.get(h));
        if (rec) out[h] = rec;
      })
    );
    return out;
  });
}

function getAll() {
  return withStore('readonly', (store) => reqToPromise(store.getAll()));
}

function count() {
  return withStore('readonly', (store) => reqToPromise(store.count()));
}

function pendingCount() {
  return withStore('readonly', (store) => reqToPromise(store.index('queueAt').count()));
}

// ---------- queue ----------

const leases = new Map(); // handle -> lease expiry
const priority = new Map(); // handle -> last time a tab reported it on screen

// Content script saw these accounts on the page. New ones become pending; "no location"
// ones older than TTL_NONE are queued for a re-check. `visible` ones jump the line.
async function markSeen(handles, visible) {
  const now = Date.now();
  const changed = await withStore('readwrite', async (store) => {
    const out = [];
    for (const h of handles) {
      const handle = validHandle(h);
      if (!handle) continue;
      let rec = await reqToPromise(store.get(handle));
      if (!rec) {
        rec = newRecord(handle, now);
      } else if (!rec.manual && rec.queueAt == null && !rec.location && now - rec.checkedAt > TTL_NONE) {
        rec.queueAt = now;
      } else {
        continue;
      }
      store.put(rec);
      out.push(rec);
    }
    return out;
  });
  for (const h of visible || []) priority.set(h, now);
  return changed.map((r) => r.handle);
}

function setPriority(handles) {
  const now = Date.now();
  for (const h of handles) priority.set(h, now);
}

// Hand the next account to look up to a tab: on-screen accounts first (most recently
// reported), then the oldest pending one. Returns { handle } or { handle: null }.
async function claim() {
  const { pausedUntil = 0 } = await chrome.storage.local.get('pausedUntil');
  if (pausedUntil > Date.now()) return { handle: null, pausedUntil };

  const now = Date.now();
  for (const [h, exp] of leases) if (exp < now) leases.delete(h);
  for (const [h, t] of priority) if (now - t > PRIORITY_MS) priority.delete(h);

  const handle = await withStore('readonly', async (store) => {
    const hinted = [...priority.entries()].sort((a, b) => b[1] - a[1]).map(([h]) => h);
    for (const h of hinted) {
      if (leases.has(h)) continue;
      const rec = await reqToPromise(store.get(h));
      if (rec && rec.queueAt != null && rec.queueAt <= now) return h;
      priority.delete(h); // resolved, deferred, or deleted
    }
    // Oldest eligible pending record that no other tab is working on.
    return new Promise((resolve, reject) => {
      const req = store.index('queueAt').openCursor(IDBKeyRange.upperBound(now));
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur) return resolve(null);
        if (!leases.has(cur.value.handle)) return resolve(cur.value.handle);
        cur.continue();
      };
      req.onerror = () => reject(req.error);
    });
  });

  if (handle) leases.set(handle, now + LEASE_MS);
  return { handle };
}

async function complete(handle, location) {
  const now = Date.now();
  const rec = await withStore('readwrite', async (store) => {
    const r = (await reqToPromise(store.get(handle))) || newRecord(handle, now);
    // If it was edited by hand while the lookup was in flight, keep the manual value.
    if (!r.manual) r.location = cleanLocation(location);
    r.checkedAt = now;
    clearQueueFields(r);
    store.put(r);
    return r;
  });
  leases.delete(handle);
  priority.delete(handle);
  notifyEdit(handle, rec);
  return rec;
}

// Lookup failed (not a rate limit): back off 15 min, 30 min, 1 h … up to a day.
async function fail(handle, error) {
  await withStore('readwrite', async (store) => {
    const r = await reqToPromise(store.get(handle));
    if (!r || r.queueAt == null) return;
    r.attempts = (r.attempts || 0) + 1;
    r.queueAt = Date.now() + Math.min(24 * 3600e3, 15 * 60e3 * 2 ** (r.attempts - 1));
    r.lastError = String(error || '').slice(0, 300);
    store.put(r);
  });
  leases.delete(handle);
  priority.delete(handle);
}

// Rate limited mid-lookup: give it back untouched so it's retried after the pause.
function release(handle) {
  leases.delete(handle);
}

// ---------- edits (DB page / import) ----------

// Imported rows. Keeps comments, never overwrites a hand-set location with a non-manual
// row, and keeps pending rows pending.
function putMany(records) {
  return withStore('readwrite', async (store) => {
    const now = Date.now();
    for (const r of records) {
      const handle = validHandle(r.handle);
      if (!handle) continue;
      const existing = (await reqToPromise(store.get(handle))) || {};
      const keepManual = existing.manual && !r.manual;
      const rec = {
        handle,
        location: keepManual ? existing.location : cleanLocation(r.location),
        checkedAt: Number(r.checkedAt) || 0,
        firstSeen: existing.firstSeen || Number(r.firstSeen) || now,
        comment: typeof r.comment === 'string' ? r.comment : existing.comment || '',
        manual: keepManual || !!r.manual,
      };
      if (!rec.manual && typeof r.queueAt === 'number') rec.queueAt = r.queueAt;
      else if (!rec.manual && !rec.checkedAt && !rec.location) rec.queueAt = now;
      store.put(rec);
    }
  });
}

// Edit from the DB page. patch may contain { location, comment }. Creates the account
// if needed; a new account without a location is queued for lookup.
async function updateOne(handle, patch) {
  handle = validHandle(handle);
  if (!handle) throw new Error('Invalid handle');
  const now = Date.now();
  const rec = await withStore('readwrite', async (store) => {
    const r = (await reqToPromise(store.get(handle))) || newRecord(handle, now);
    if ('location' in patch) {
      r.location = cleanLocation(patch.location);
      r.manual = true;
      r.checkedAt = now;
      clearQueueFields(r);
    }
    if ('comment' in patch) r.comment = String(patch.comment || '');
    store.put(r);
    return r;
  });
  notifyEdit(handle, rec);
  return rec;
}

// "Look up again" from the DB page: drop any hand-set value and queue it now.
async function relookup(handle) {
  const now = Date.now();
  const rec = await withStore('readwrite', async (store) => {
    const r = (await reqToPromise(store.get(handle))) || newRecord(handle, now);
    r.manual = false;
    delete r.attempts;
    delete r.lastError;
    r.queueAt = now;
    store.put(r);
    return r;
  });
  notifyEdit(handle, rec);
  return rec;
}

async function deleteOne(handle) {
  await withStore('readwrite', (store) => store.delete(handle));
  leases.delete(handle);
  priority.delete(handle);
  notifyEdit(handle, null);
}

async function clearAll() {
  await withStore('readwrite', (store) => store.clear());
  leases.clear();
  priority.clear();
}

// One-time move of the old chrome.storage cache (v1.0) into the database.
async function migrateOldCache() {
  const { locCache } = await chrome.storage.local.get('locCache');
  if (!locCache) return;
  const records = Object.entries(locCache).map(([handle, e]) => ({
    handle,
    location: e.loc,
    checkedAt: e.t,
  }));
  await putMany(records);
  await chrome.storage.local.remove('locCache');
}

chrome.runtime.onInstalled.addListener(() => {
  migrateOldCache().catch((e) => console.warn('[X Location Filter] migration failed', e));
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handlers = {
    'db-get': () => getMany(msg.handles || []),
    'db-count': () => count(),
    'db-update': () => updateOne(msg.handle, msg.patch || {}),
    'db-relookup': () => relookup(msg.handle),
    'db-delete': () => deleteOne(msg.handle).then(() => true),
    'db-export': () => getAll(),
    'db-import': () => putMany(msg.records || []).then(count),
    'db-clear': () => clearAll().then(() => chrome.storage.local.set({ dbClearedAt: Date.now() })),
    'queue-seen': () => markSeen(msg.handles || [], msg.visible || []),
    'queue-priority': () => Promise.resolve(setPriority(msg.handles || [])),
    'queue-claim': () => claim(),
    'queue-complete': () => complete(msg.handle, msg.location),
    'queue-fail': () => fail(msg.handle, msg.error).then(() => true),
    'queue-release': () => Promise.resolve(release(msg.handle)),
    'queue-stats': () => pendingCount().then((pending) => ({ pending, working: leases.size })),
  };
  const fn = msg && handlers[msg.type];
  if (!fn) return false;
  fn().then(
    (result) => sendResponse({ ok: true, result }),
    (err) => sendResponse({ ok: false, error: String((err && err.message) || err) })
  );
  return true; // async response
});
