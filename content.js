// X Location Filter — content script.
// Finds posts on the page, looks up each author's "Account based in" value (the same
// data x.com/<user>/about shows), and hides posts whose location isn't allowed.
// Everything here is display-only: nothing is posted or changed on X.
(() => {
  'use strict';

  // Last-resort bearer token. The real one is captured from x.com's own requests by
  // page-hook.js (see getBearer); this is only used if nothing has been captured yet.
  const FALLBACK_BEARER =
    'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhzTvJ8Hs3LrNvKyIzUMaW0tyJK1Ukb';
  // Fallback GraphQL query id for AboutAccountQuery. X rotates these, so we try to
  // discover the current one from X's own JS bundles first.
  const DEFAULT_QUERY_ID = 'XRqGa7EeokUU5kppkh13EA';

  // Lookups this tab runs at once. The background worker (background.js) owns the queue
  // and hands out one account per slot, so tabs never look up the same account twice.
  const CONCURRENCY = 2;
  const IDLE_POLL_MS = 5000; // ask for more work this often when the queue was empty

  const DEFAULTS = {
    enabled: true,
    allowed: [],
    blurPending: true,
    hideUnknown: true,
    showLabels: true,
    queryId: '',
  };

  let settings = { ...DEFAULTS };
  // In-memory copy of DB rows: handle(lowercase) -> { loc, t, manual, pending }
  let cache = {};
  const dbChecked = new Set(); // handles already asked of the DB this page load
  const dbBatch = new Set(); // handles waiting for the next DB query
  const reported = new Set(); // handles already reported to the queue this page load
  const seenBatch = new Set(); // handles waiting to be reported
  let queryId = null;
  let extraFeatures = null; // filled in if X demands feature flags
  let savedBearer = null; // last bearer captured by page-hook.js, persisted across loads

  let active = 0;
  let pausedUntil = 0;
  let lastError = '';
  let lookupsThisPage = 0;

  // ---------- storage ----------

  async function init() {
    const [sync, local] = await Promise.all([
      chrome.storage.sync.get(DEFAULTS),
      chrome.storage.local.get({ queryId: null, extraFeatures: null, bearer: null, pausedUntil: 0 }),
    ]);
    savedBearer = local.bearer;
    settings = { ...DEFAULTS, ...sync };
    pausedUntil = local.pausedUntil;
    queryId = local.queryId;
    extraFeatures = local.extraFeatures;

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'sync') {
        for (const [k, { newValue }] of Object.entries(changes)) {
          settings[k] = newValue === undefined ? DEFAULTS[k] : newValue;
        }
        if (changes.queryId) queryId = null;
        rescanAll();
      } else if (area === 'local') {
        if (changes.dbClearedAt) {
          // Database cleared from the popup: forget everything and look accounts up again.
          cache = {};
          dbChecked.clear();
          reported.clear();
          rescanAll();
        }
        if (changes.dbEdit && changes.dbEdit.newValue) {
          // Account edited/deleted on the DB page.
          const { handle, record } = changes.dbEdit.newValue;
          if (record) {
            cache[handle] = fromRecord(record);
          } else {
            delete cache[handle];
            dbChecked.delete(handle);
            reported.delete(handle);
          }
          rescanAll();
        }
        if (changes.pausedUntil) {
          // Rate limit hit in another x.com tab: the limit is per account, so pause here too.
          pausedUntil = Math.max(pausedUntil, changes.pausedUntil.newValue || 0);
        }
      }
    });

    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg && msg.type === 'xlf-stats') sendResponse(getStats());
    });

    startObserver();
    scan();
    pump();
  }

  // ---------- database ----------

  function sendMsg(msg) {
    return chrome.runtime.sendMessage(msg).then((r) => {
      if (!r || !r.ok) throw new Error((r && r.error) || 'no response from background');
      return r.result;
    });
  }

  function fromRecord(r) {
    return { loc: r.location, t: r.checkedAt, manual: !!r.manual, pending: r.queueAt != null };
  }

  // Batch DB reads: every handle first seen during this frame goes in one query.
  let dbTimer = null;
  function checkDb(handle) {
    if (dbChecked.has(handle)) return;
    dbBatch.add(handle);
    if (!dbTimer) dbTimer = setTimeout(flushDb, 50);
  }

  async function flushDb() {
    dbTimer = null;
    const handles = [...dbBatch];
    dbBatch.clear();
    let rows = {};
    try {
      rows = await sendMsg({ type: 'db-get', handles });
    } catch (e) {
      console.warn('[X Location Filter] DB read failed', e);
    }
    for (const h of handles) {
      dbChecked.add(h);
      const r = rows[h];
      if (r) cache[h] = fromRecord(r);
      else {
        cache[h] = { loc: null, t: 0, manual: false, pending: true };
        reportSeen(h); // new account: add to the waiting list
      }
    }
    scan();
  }

  // Tell the background queue about accounts on this page. It adds new ones as pending
  // and re-queues stale "no location" ones; it ignores everything else.
  let seenTimer = null;
  function reportSeen(handle) {
    if (reported.has(handle)) return;
    reported.add(handle);
    seenBatch.add(handle);
    if (!seenTimer) seenTimer = setTimeout(flushSeen, 100);
  }

  async function flushSeen() {
    seenTimer = null;
    const handles = [...seenBatch];
    seenBatch.clear();
    try {
      await sendMsg({ type: 'queue-seen', handles, visible: visiblePending() });
    } catch (e) {
      console.warn('[X Location Filter] queue report failed', e);
    }
    pump();
  }

  // Pending posts on or near the screen (within one screen height), so the queue can
  // look those up first.
  function visiblePending() {
    const margin = window.innerHeight;
    const out = [];
    document.querySelectorAll('[data-xlf="pending"][data-xlf-handle]').forEach((cell) => {
      const r = cell.getBoundingClientRect();
      if (r.bottom > -margin && r.top < window.innerHeight + margin) out.push(cell.dataset.xlfHandle);
    });
    return [...new Set(out)];
  }

  let lastPriority = '';
  let priorityAt = 0;
  function reportPriority() {
    if (Date.now() - priorityAt < 1000) return;
    const handles = visiblePending();
    const key = handles.join(',');
    // Resend unchanged lists every 10s so the hint doesn't expire while still on screen.
    if (!handles.length || (key === lastPriority && Date.now() - priorityAt < 10e3)) return;
    lastPriority = key;
    priorityAt = Date.now();
    sendMsg({ type: 'queue-priority', handles }).catch(() => {});
  }

  // ---------- DOM scanning ----------

  function getHandle(article) {
    const link = article.querySelector('[data-testid="User-Name"] a[href^="/"]');
    if (!link) return null;
    const m = link.getAttribute('href').match(/^\/([A-Za-z0-9_]{1,15})(?:$|[/?#])/);
    return m ? m[1].toLowerCase() : null;
  }

  function isAllowed(loc) {
    const l = loc.toLowerCase();
    return settings.allowed.some((a) => {
      const n = String(a).trim().toLowerCase();
      return n && l.includes(n);
    });
  }

  // Returns 'show' | 'hide' | 'pending'
  function decide(handle) {
    if (!settings.enabled || !settings.allowed.length) return 'show';
    const e = cache[handle];
    if (!e) {
      checkDb(handle);
      return settings.blurPending ? 'pending' : 'show';
    }
    // "No location" rows: let the queue decide whether they're due for a re-check.
    if (!e.loc && !e.manual && !e.pending) reportSeen(handle);
    // Waiting for a lookup. (A re-lookup of a known location keeps filtering by the old one.)
    if (e.pending && !e.loc) return settings.blurPending ? 'pending' : 'show';
    if (!e.loc) return settings.hideUnknown ? 'hide' : 'show';
    return isAllowed(e.loc) ? 'show' : 'hide';
  }

  function processArticle(article) {
    const handle = getHandle(article);
    if (!handle) return;
    const cell = article.closest('[data-testid="cellInnerDiv"]') || article;
    const state = decide(handle);
    if (cell.dataset.xlf !== state) cell.dataset.xlf = state;
    cell.dataset.xlfHandle = handle;
    updateLabel(article, handle, state);
  }

  function updateLabel(article, handle, state) {
    let label = article.querySelector(':scope .xlf-label');
    const e = cache[handle];
    const want = settings.showLabels && state === 'show' && e && !(e.pending && !e.loc) && settings.enabled;
    if (!want) {
      if (label) label.remove();
      return;
    }
    const text = e.loc ? `📍 ${e.loc}` : '📍 unknown';
    if (!label) {
      const userName = article.querySelector('[data-testid="User-Name"]');
      if (!userName || !userName.parentElement) return;
      label = document.createElement('span');
      label.className = 'xlf-label';
      userName.insertAdjacentElement('afterend', label);
    }
    if (label.textContent !== text) label.textContent = text;
  }

  function scan() {
    document.querySelectorAll('article[data-testid="tweet"]').forEach(processArticle);
    reportPriority();
  }

  function rescanAll() {
    if (!settings.enabled || !settings.allowed.length) {
      document.querySelectorAll('[data-xlf]').forEach((el) => (el.dataset.xlf = 'show'));
    }
    scan();
  }

  let scanScheduled = false;
  function startObserver() {
    new MutationObserver(() => {
      if (scanScheduled) return;
      scanScheduled = true;
      requestAnimationFrame(() => {
        scanScheduled = false;
        scan();
      });
    }).observe(document.body, { childList: true, subtree: true });
  }

  function getStats() {
    const cells = document.querySelectorAll('[data-xlf]');
    const s = { hidden: 0, shown: 0, pending: 0 };
    cells.forEach((c) => {
      if (c.dataset.xlf === 'hide') s.hidden++;
      else if (c.dataset.xlf === 'pending') s.pending++;
      else s.shown++;
    });
    return {
      ...s,
      queue: active,
      apiLookups: lookupsThisPage,
      pausedUntil: pausedUntil > Date.now() ? pausedUntil : 0,
      lastError,
      tokenCaptured: !!document.documentElement.dataset.xlfBearer,
    };
  }

  // ---------- lookup worker ----------

  let pumping = false;
  let pumpAgain = false;
  let pumpTimer = null;

  function pumpLater(ms) {
    clearTimeout(pumpTimer);
    pumpTimer = setTimeout(pump, ms);
  }

  // Fill free lookup slots with accounts claimed from the background queue.
  async function pump() {
    if (pumping) {
      pumpAgain = true;
      return;
    }
    pumping = true;
    clearTimeout(pumpTimer);
    try {
      while (active < CONCURRENCY) {
        if (!settings.enabled) return pumpLater(IDLE_POLL_MS);
        if (Date.now() < pausedUntil) return pumpLater(pausedUntil - Date.now() + 250);
        let claim;
        try {
          claim = await sendMsg({ type: 'queue-claim' });
        } catch {
          return pumpLater(IDLE_POLL_MS);
        }
        if (claim.pausedUntil) {
          pausedUntil = Math.max(pausedUntil, claim.pausedUntil);
          continue;
        }
        if (!claim.handle) return pumpLater(IDLE_POLL_MS);
        active++;
        run(claim.handle);
      }
    } finally {
      pumping = false;
      if (pumpAgain) {
        pumpAgain = false;
        pump();
      }
    }
  }

  async function run(handle) {
    try {
      const loc = await lookup(handle);
      lastError = '';
      const rec = await sendMsg({ type: 'queue-complete', handle, location: loc });
      cache[handle] = fromRecord(rec);
      scan();
    } catch (err) {
      if (err && err.retry) {
        sendMsg({ type: 'queue-release', handle }).catch(() => {});
      } else {
        lastError = String((err && err.message) || err);
        console.warn('[X Location Filter]', handle, lastError);
        sendMsg({ type: 'queue-fail', handle, error: lastError }).catch(() => {});
      }
    } finally {
      active--;
      pump();
    }
  }

  function csrfToken() {
    const m = document.cookie.match(/(?:^|;\s*)ct0=([^;]+)/);
    return m ? m[1] : '';
  }

  function findKey(obj, key) {
    if (!obj || typeof obj !== 'object') return undefined;
    if (key in obj) return obj[key];
    for (const v of Object.values(obj)) {
      const r = findKey(v, key);
      if (r !== undefined) return r;
    }
    return undefined;
  }

  // Bearer token x.com's own app is using, recorded by page-hook.js. X makes API calls
  // right after load, so wait briefly for one if we haven't seen it yet.
  async function getBearer() {
    for (let i = 0; i < 20; i++) {
      const live = document.documentElement.dataset.xlfBearer;
      if (live) {
        if (live !== savedBearer) {
          savedBearer = live;
          chrome.storage.local.set({ bearer: live }).catch(() => {});
        }
        return live;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    return savedBearer || FALLBACK_BEARER;
  }

  async function describeError(res, json) {
    const msg = json && (json.errors || []).map((e) => `${e.message} (${e.code})`).join('; ');
    return `HTTP ${res.status}${msg ? ': ' + msg : ''}`;
  }

  async function lookup(handle, attempt = 0) {
    const qid = await getQueryId();
    const bearer = await getBearer();
    let url =
      `${location.origin}/i/api/graphql/${qid}/AboutAccountQuery?variables=` +
      encodeURIComponent(JSON.stringify({ screenName: handle }));
    if (extraFeatures) url += '&features=' + encodeURIComponent(JSON.stringify(extraFeatures));

    lookupsThisPage++;
    const res = await fetch(url, {
      credentials: 'include',
      headers: {
        authorization: `Bearer ${bearer}`,
        'x-csrf-token': csrfToken(),
        'x-twitter-auth-type': 'OAuth2Session',
        'x-twitter-active-user': 'yes',
        'content-type': 'application/json',
      },
    });

    const remaining = res.headers.get('x-rate-limit-remaining');
    const reset = Number(res.headers.get('x-rate-limit-reset')) * 1000;

    if (res.status === 429) {
      pausedUntil = reset > Date.now() ? reset : Date.now() + 60e3;
      chrome.storage.local.set({ pausedUntil }).catch(() => {});
      lastError = 'Rate limited by X — paused until ' + new Date(pausedUntil).toLocaleTimeString();
      throw { retry: true };
    }
    if (remaining === '0' && reset > Date.now()) {
      pausedUntil = reset;
      chrome.storage.local.set({ pausedUntil }).catch(() => {});
    }

    if (res.status === 404 && attempt === 0 && !settings.queryId) {
      // Query id probably rotated — rediscover and try once more.
      queryId = await discoverQueryId(true);
      return lookup(handle, attempt + 1);
    }

    let json = null;
    try {
      json = await res.json();
    } catch {
      /* non-JSON body */
    }

    if (res.status === 400 && json && attempt < 2) {
      const msg = (json.errors || []).map((e) => e.message).join(' ');
      const m = msg.match(/features cannot be null:\s*(.+)$/i);
      if (m) {
        extraFeatures = { ...(extraFeatures || {}) };
        m[1].split(',').forEach((f) => (extraFeatures[f.trim()] = false));
        chrome.storage.local.set({ extraFeatures }).catch(() => {});
        return lookup(handle, attempt + 1);
      }
    }

    if (res.status === 401 && attempt === 0) {
      // Token may have changed since we last saw it; drop the saved one and retry once.
      savedBearer = null;
      chrome.storage.local.remove('bearer').catch(() => {});
      return lookup(handle, attempt + 1);
    }

    if (!res.ok) throw new Error(await describeError(res, json));

    const loc = findKey(json, 'account_based_in');
    return typeof loc === 'string' && loc.trim() ? loc.trim() : null;
  }

  // ---------- query id discovery ----------

  let discovering = null;
  async function getQueryId() {
    if (settings.queryId) return settings.queryId;
    const live = document.documentElement.dataset.xlfQueryId; // seen in X's own traffic
    if (live) return live;
    if (queryId) return queryId;
    queryId = await discoverQueryId(false);
    return queryId;
  }

  function discoverQueryId(force) {
    if (discovering) return discovering;
    discovering = (async () => {
      try {
        if (!force) {
          const { queryId: stored } = await chrome.storage.local.get({ queryId: null });
          if (stored) return stored;
        }
        const urls = new Set();
        document.querySelectorAll('script[src]').forEach((s) => urls.add(s.src));
        performance.getEntriesByType('resource').forEach((e) => urls.add(e.name));
        const list = [...urls]
          .filter((u) => /abs\.twimg\.com\/responsive-web\/.+\.js(\?|$)/.test(u))
          .sort((a, b) => /\/main\./.test(b) - /\/main\./.test(a));
        for (const u of list) {
          try {
            const text = await (await fetch(u)).text();
            const m = text.match(/queryId:"([\w-]+)",operationName:"AboutAccountQuery"/);
            if (m) {
              chrome.storage.local.set({ queryId: m[1] }).catch(() => {});
              return m[1];
            }
          } catch {
            /* skip unreadable bundle */
          }
        }
      } catch {
        /* fall through */
      }
      return DEFAULT_QUERY_ID;
    })();
    return discovering.finally(() => (discovering = null));
  }

  init();
})();
