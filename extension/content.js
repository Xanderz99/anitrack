'use strict';
// Runs on crunchyroll.com (and in its player frame). The page itself says which episode it is; the
// video element says how far through it you are. Both go to the background worker, which decides.
(() => {
  const M = globalThis.AniTrackMatch;
  const send = (msg) => chrome.runtime.sendMessage(msg).catch(() => {}); // the worker may be restarting

  /* ---------- which episode (top page only) ---------- */
  if (window === window.top) {
    const text = (sel) => document.querySelector(sel)?.textContent?.trim() || '';
    const read = () => {
      const jsonld = [];
      for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
        try {
          jsonld.push(JSON.parse(s.textContent));
        } catch {
          /* not valid JSON: skip it */
        }
      }
      return M.parseEpisode({
        url: location.pathname,
        jsonld,
        h1: text('h1'),
        // The show's name links to its series page above the episode title.
        series: text('.show-title-link h4') || text('[data-t="show-title-link"]') || text('.current-media-parent-ref a[href*="/series/"]') || text('a.show-title-link'),
        docTitle: document.title,
        ogTitle: document.querySelector('meta[property="og:title"]')?.content || '',
      });
    };
    // Crunchyroll changes pages without reloading, so look again whenever the page changes.
    let last = '';
    const check = () => {
      const info = read();
      const s = JSON.stringify(info);
      if (s === last) return;
      last = s;
      send({ type: 'episode', info });
    };
    setInterval(check, 1500);
    check();

    /* ---------- the message after marking ---------- */
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg.type === 'toast') toast(msg);
    });
    let host = null;
    function toast({ text, undo }) {
      host?.remove();
      host = document.createElement('div');
      host.id = 'anitrack-toast';
      const root = host.attachShadow({ mode: 'closed' });
      root.innerHTML = `<style>
        .t { position: fixed; z-index: 2147483647; left: 20px; bottom: 20px; max-width: min(460px, calc(100vw - 40px)); display: flex; gap: 14px; align-items: center;
          padding: 12px 16px; border-radius: 12px; background: rgba(20, 20, 24, 0.94); color: #fff; font: 500 14px/1.35 system-ui, -apple-system, sans-serif;
          box-shadow: 0 10px 30px rgba(0, 0, 0, 0.45); }
        b { color: #8aa7ff; font-weight: 700; }
        button { flex: none; border: 0; border-radius: 8px; padding: 6px 12px; background: #fff; color: #000; font: 600 13px system-ui, sans-serif; cursor: pointer; }
        .x { background: none; color: #aaa; padding: 4px 6px; }
      </style><div class="t" role="status"><span><b>AniTrack</b> · <span class="m"></span></span>${undo ? '<button class="u">Undo</button>' : ''}<button class="x" aria-label="Close">✕</button></div>`;
      root.querySelector('.m').textContent = text;
      root.querySelector('.x').addEventListener('click', () => host.remove());
      root.querySelector('.u')?.addEventListener('click', async () => {
        root.querySelector('.m').textContent = 'Undoing…';
        root.querySelector('.u').remove();
        const r = await chrome.runtime.sendMessage({ type: 'undo', undo }).catch((e) => ({ ok: false, error: e.message }));
        root.querySelector('.m').textContent = r?.ok ? 'Undone. AniList is back as it was.' : `Could not undo: ${r?.error || 'no answer'}`;
        setTimeout(() => host.remove(), 4000);
      });
      document.documentElement.append(host);
      const ref = host;
      setTimeout(() => ref.remove(), undo ? 12000 : 8000);
    }
  }

  /* ---------- how far through the video (every frame: the player can be in its own frame) ---------- */
  let sent = 0;
  setInterval(() => {
    let best = null;
    for (const v of document.querySelectorAll('video')) if (Number.isFinite(v.duration) && v.duration > 0 && (!best || v.duration > best.duration)) best = v;
    if (!best || best.paused || Date.now() - sent < 4000) return;
    sent = Date.now();
    send({ type: 'progress', t: best.currentTime, d: best.duration });
  }, 1000);
})();
