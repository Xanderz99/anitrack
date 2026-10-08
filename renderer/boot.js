'use strict';
// Loaded before app.js, so it can report app.js failing to start (a syntax error stops app.js before any
// of its own code runs). It only reacts while the app is starting: once app.js sets
// window.__anitrackBooted, later errors are left to the app, and a missing poster or other failed
// resource load never counts (those error events have no script error attached).
(() => {
  const show = (message) => {
    if (window.__anitrackBooted || document.getElementById('boot-error')) return;
    const box = document.createElement('main');
    box.id = 'boot-error';
    box.setAttribute('role', 'alert');
    box.style.cssText = 'position:fixed;inset:0;z-index:100;display:grid;place-items:center;padding:24px;background:#0b0b0e;color:#fff;font:16px system-ui,sans-serif';
    const card = document.createElement('section');
    card.style.maxWidth = '560px';
    const h = document.createElement('h1');
    h.style.margin = '0 0 12px';
    h.textContent = 'AniTrack could not start';
    const p = document.createElement('p');
    p.style.cssText = 'margin:0 0 16px;opacity:.8';
    p.textContent = 'Close the app fully and open it again. If this keeps happening, the message below says what broke.';
    const pre = document.createElement('pre');
    pre.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere;background:#17171c;padding:14px;border-radius:10px;font-size:13px';
    pre.textContent = String(message || 'Unknown error').slice(0, 2000);
    card.append(h, p, pre);
    box.append(card);
    document.body.append(box);
  };
  window.addEventListener('error', (e) => {
    if (!e.error && !e.message) return; // a failed image or other resource, not a script error
    show(e.error?.stack || `${e.message} (${e.filename || 'app'}:${e.lineno || '?'})`);
  });
  window.addEventListener('unhandledrejection', (e) => show(e.reason?.stack || e.reason?.message || String(e.reason)));
  // If app.js never finishes starting (for example it failed to download), say so instead of a blank page.
  setTimeout(() => show('The app did not finish loading. Check your connection.'), 20000);
})();
