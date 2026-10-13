'use strict';
// The toolbar popup: connect your AniList account, see what this tab is playing and which show it is
// matched to, link it by hand when the guess is wrong, and choose when episodes count as watched.
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ask = (msg) => chrome.runtime.sendMessage(msg);
let tabId = null;
let state = null;

async function load() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id ?? null;
  state = await ask({ type: 'popup:state', tabId });
  render();
}

function render() {
  const s = state;
  $('#who').textContent = s.viewer ? s.viewer.name : '';
  if (!s.viewer) {
    $('#main').innerHTML = `
      <p>Connect your AniList account, then watch on <b>crunchyroll.com</b> as usual. Near the end of each episode, AniTrack marks it watched on your AniList list.</p>
      <button class="primary" id="connect">Connect with AniTrack</button>
      <p class="muted">Opens the AniTrack web app. Log in with AniList there (or already be logged in) and the extension connects by itself.</p>
      <h2>Or paste a login code</h2>
      <form id="paste"><input name="code" placeholder="AniList code or the whole address" autocomplete="off" spellcheck="false"><button>Use</button></form>
      <p class="msg" id="msg"></p>`;
    $('#connect').onclick = async () => {
      await ask({ type: 'popup:connect' });
      window.close();
    };
    $('#paste').onsubmit = async (e) => {
      e.preventDefault();
      $('#msg').textContent = 'Checking with AniList…';
      const r = await ask({ type: 'popup:token', text: e.target.elements.code.value });
      if (!r.ok) $('#msg').textContent = r.error;
      else load();
    };
    return;
  }

  const entry = s.pick?.mediaId ? s.entries.find((e) => e.mediaId === s.pick.mediaId) : null;
  let now = '<p class="muted">Open an episode on crunchyroll.com and it shows up here.</p>';
  if (s.info?.partial) now = `<div class="card"><p>This looks like a Crunchyroll episode, but AniTrack could not read ${s.info.series ? 'the episode number' : 'the show name'}.</p></div>`;
  else if (s.info) {
    const options = s.entries
      .slice()
      .sort((a, b) => a.title.localeCompare(b.title))
      .map((e) => `<option value="${e.mediaId}" ${entry?.mediaId === e.mediaId ? 'selected' : ''}>${esc(e.title)}</option>`)
      .join('');
    now = `<div class="card">
        <span class="muted">Playing</span>
        <b>${esc(s.info.series)}${s.info.season > 1 ? ` · Season ${s.info.season}` : ''} · Episode ${esc(s.info.episode)}</b>
        <span class="muted">${entry ? `On your list as <b>${esc(entry.title)}</b> · ${entry.progress}${entry.episodes ? `/${entry.episodes}` : ''} watched${s.pick.why === 'linked' ? ' (linked by you)' : ''}` : `Not matched: ${esc(s.pick?.why || 'unknown')}`}</span>
        <label class="muted" for="pickShow">Show on your AniList list</label>
        <select id="pickShow"><option value="">${entry ? 'Automatic' : 'Choose…'}</option>${options}</select>
        <div class="row"><label class="muted" for="offset">Crunchyroll numbers this season from episode</label><input type="number" id="offset" min="1" value="${(s.linked?.offset || 0) + 1}"></div>
        <div class="row"><button class="primary" id="mark" ${entry || s.linked ? '' : 'disabled'}>Mark episode ${esc(s.info.episode - (s.pick?.offset || 0))} watched</button></div>
      </div>`;
  }
  $('#main').innerHTML = `
    <h2>This tab</h2>${now}
    <p class="msg" id="msg">${esc(s.error || '')}</p>
    <h2>Settings</h2>
    <label class="check"><input type="checkbox" id="auto" ${s.settings.auto ? 'checked' : ''}> Mark episodes watched automatically</label>
    <div class="row"><label for="pct">when you reach</label><select id="pct" style="width:auto">${[0.8, 0.85, 0.9, 0.95]
      .map((v) => `<option value="${v}" ${s.settings.pct === v ? 'selected' : ''}>${Math.round(v * 100)}% of the episode</option>`)
      .join('')}</select></div>
    <div class="foot"><button class="link" id="web">Open AniTrack</button><button class="link" id="logout">Disconnect ${esc(s.viewer.name)}</button></div>`;

  const link = async () => {
    const mediaId = $('#pickShow').value;
    const offset = Math.max(0, (Number($('#offset').value) || 1) - 1);
    await ask({ type: 'popup:link', info: s.info, mediaId: mediaId || null, offset });
    await load();
    $('#msg').textContent = mediaId ? 'Linked. Episodes of this season now go to that show.' : 'Back to automatic.';
  };
  if ($('#pickShow')) $('#pickShow').onchange = link;
  if ($('#offset')) $('#offset').onchange = () => ($('#pickShow').value ? link() : ($('#msg').textContent = 'Choose the show first, then the numbering.'));
  if ($('#mark'))
    $('#mark').onclick = async () => {
      $('#msg').textContent = 'Saving to AniList…';
      const r = await ask({ type: 'popup:mark', tabId });
      const text = r.ok ? `Marked episode ${r.ep} of ${r.title}.` : r.error;
      if (r.ok) await load(); // shows the new progress
      $('#msg').textContent = text;
    };
  $('#auto').onchange = (e) => ask({ type: 'popup:settings', settings: { auto: e.target.checked } });
  $('#pct').onchange = (e) => ask({ type: 'popup:settings', settings: { pct: Number(e.target.value) } });
  $('#web').onclick = () => chrome.tabs.create({ url: 'https://xanderz99.github.io/anitrack/' });
  $('#logout').onclick = async () => {
    await ask({ type: 'popup:logout' });
    load();
  };
}

load().catch((e) => ($('#main').innerHTML = `<p class="msg">${esc(e.message)}</p>`));
