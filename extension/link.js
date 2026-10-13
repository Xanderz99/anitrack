'use strict';
// Runs on the AniTrack web app. Only after you press "Connect with AniTrack" in the extension, it passes
// the AniList login this browser already has there (or gets once you log in) to the extension.
(async () => {
  const want = await chrome.runtime.sendMessage({ type: 'link:wanted' }).catch(() => null);
  if (!want?.wanted) return;
  const tokenHere = () => {
    try {
      return JSON.parse(localStorage.getItem('anitrack:settings') || '{}').token || '';
    } catch {
      return '';
    }
  };
  const banner = (text) => {
    let el = document.getElementById('anitrack-ext-link');
    if (!el) {
      el = document.createElement('div');
      el.id = 'anitrack-ext-link';
      el.style.cssText = 'position:fixed;z-index:2147483647;left:50%;top:max(12px,env(safe-area-inset-top));transform:translateX(-50%);max-width:calc(100vw - 32px);padding:10px 16px;border-radius:12px;background:#fff;color:#000;font:600 14px system-ui,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.4)';
      document.documentElement.append(el);
    }
    el.textContent = text;
    return el;
  };
  banner('AniTrack extension: log in with AniList here to connect it.');
  const started = Date.now();
  const timer = setInterval(async () => {
    const token = tokenHere();
    if (!token) {
      if (Date.now() - started > 10 * 60e3) clearInterval(timer);
      return;
    }
    clearInterval(timer);
    const r = await chrome.runtime.sendMessage({ type: 'link:token', token }).catch((e) => ({ ok: false, error: e.message }));
    const el = banner(r?.ok ? `AniTrack extension connected as ${r.name}. You can close this tab.` : `Could not connect the extension: ${r?.error || 'no answer'}`);
    setTimeout(() => el.remove(), 8000);
  }, 1000);
})();
