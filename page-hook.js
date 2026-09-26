// X Location Filter — runs in the page's own JS world (not the isolated content-script
// world) so it can see the headers x.com's app sends. It only *reads*: it records the
// current bearer token and AboutAccountQuery id on <html> data attributes, where
// content.js picks them up. Requests are passed through unchanged.
(() => {
  'use strict';
  const root = document.documentElement;

  function noteAuth(value) {
    if (typeof value === 'string' && /^Bearer\s+\S+/i.test(value)) {
      const token = value.replace(/^Bearer\s+/i, '');
      if (root.dataset.xlfBearer !== token) root.dataset.xlfBearer = token;
    }
  }

  function noteUrl(url) {
    const m = String(url || '').match(/\/graphql\/([\w-]+)\/AboutAccountQuery/);
    if (m && root.dataset.xlfQueryId !== m[1]) root.dataset.xlfQueryId = m[1];
  }

  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    try { noteUrl(url); } catch {}
    return origOpen.apply(this, arguments);
  };

  const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    try { if (String(name).toLowerCase() === 'authorization') noteAuth(value); } catch {}
    return origSetHeader.apply(this, arguments);
  };

  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      noteUrl(typeof input === 'string' ? input : input && input.url);
      const headers = (init && init.headers) || (input instanceof Request ? input.headers : null);
      if (headers) {
        if (headers instanceof Headers) noteAuth(headers.get('authorization'));
        else if (Array.isArray(headers)) {
          headers.forEach(([k, v]) => String(k).toLowerCase() === 'authorization' && noteAuth(v));
        } else {
          for (const k of Object.keys(headers)) {
            if (k.toLowerCase() === 'authorization') noteAuth(headers[k]);
          }
        }
      }
    } catch {}
    return origFetch.apply(this, arguments);
  };
})();
