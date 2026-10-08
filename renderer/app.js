'use strict';
(() => {
  const $ = (sel) => document.querySelector(sel);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k, d) {
      try {
        const v = localStorage.getItem(k);
        return v == null ? d : JSON.parse(v);
      } catch {
        return d;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem(k, JSON.stringify(v));
      } catch {
        /* storage unavailable */
      }
    },
  };

  const svg = (d) => `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const VIEWS = [
    { id: 'home', label: 'Home', group: 'Watch', ico: svg('<path d="M3 11 12 3l9 8M5 10v10h5v-6h4v6h5V10"/>') },
    { id: 'tonight', label: 'Tonight', group: 'Watch', ico: svg('<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>') },
    { id: 'mine', label: 'My Shows', group: 'Watch', ico: svg('<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>') },
    { id: 'airing', label: 'Airing Soon', group: 'Watch', ico: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>') },
    { id: 'foryou', label: 'For You', group: 'Discover', ico: svg('<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/>') },
    { id: 'season', label: 'This Season', group: 'Discover', ico: svg('<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>') },
    { id: 'list', label: 'My List', group: 'Library', ico: svg('<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>') },
    { id: 'settings', label: 'Settings', group: 'Library', ico: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>') },
  ];
  const SORTS = { popular: 'Popular', match: 'Best match', score: 'Rating', airing: 'Airing soon', az: 'A–Z' };
  const TIMES = [
    { id: 30, label: 'Quick', sub: '1 episode' },
    { id: 60, label: 'An hour', sub: '2 episodes' },
    { id: 180, label: 'An evening', sub: 'up to 4' },
  ];
  const SEASONS = ['WINTER', 'SPRING', 'SUMMER', 'FALL'];
  const STATUS_LABEL = { WATCHING: 'Watching', PLANNING: 'Planning', DROPPED: 'Dropped', SKIP: 'Not interested', COMPLETED: 'Completed', PAUSED: 'Paused' };

  const WEB = window.api.platform === 'web';
  const TABS = ['home', 'tonight', 'mine', 'airing', 'foryou', 'list'];
  const S = {
    view: store.get('view', 'home'),
    sort: store.get('sort', 'popular'),
    tmins: store.get('tmins', 60),
    seed: Math.floor(Math.random() * 1e6),
    undo: null,
    data: null,
    filters: Object.assign({ cr: true, dub: false, hideSeq: true, q: '' }, store.get('filters', {})),
    shownSyncHint: false,
    player: null,
    listTab: store.get('listTab', 'WATCHING'),
  };
  if (!VIEWS.some((v) => v.id === S.view)) S.view = 'home';
  S.filters.q = '';

  const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  const timeFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });

  function rel(ts) {
    let s = Math.round(ts - Date.now() / 1000);
    const past = s < 0;
    s = Math.abs(s);
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    const t = d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
    return past ? `${t} ago` : `in ${t}`;
  }

  const byId = (id) => S.data && S.data.shows.find((s) => s.id === id);
  const listById = (id) => S.data && S.data.list.find((e) => e.id === id);
  const LIST_TABS = ['WATCHING', 'PLANNING', 'PAUSED', 'DROPPED', 'COMPLETED'];
  const listStatus = (e) => (LIST_TABS.includes(e.me.status) ? e.me.status : 'PLANNING');
  const aired = (s) => (s.next ? s.next.episode - 1 : s.airStatus === 'FINISHED' ? s.episodes : null);

  /* ---------- filtering ---------- */
  function passes(s, opts = {}) {
    const f = S.filters;
    if (f.q && !`${s.title} ${s.romaji}`.toLowerCase().includes(f.q.toLowerCase())) return false;
    if (opts.skipToggles) return true;
    if (f.cr && !s.onCR) return false;
    if (f.dub && s.dub !== 'announced') return false;
    if (opts.forYou && f.hideSeq && s.needsPrequel) return false;
    return true;
  }

  function applySort(arr) {
    const k = S.sort;
    if (k === 'popular') return arr.sort((a, b) => b.popularity - a.popularity);
    if (k === 'match') return arr.sort((a, b) => (b.match ?? -1) - (a.match ?? -1));
    if (k === 'score') return arr.sort((a, b) => (b.score || 0) - (a.score || 0));
    if (k === 'airing') return arr.sort((a, b) => (a.next ? a.next.airingAt : Infinity) - (b.next ? b.next.airingAt : Infinity));
    return arr.sort((a, b) => a.title.localeCompare(b.title));
  }
  const isNew = (s) => {
    const now = Date.now() / 1000;
    if (s.next && s.next.episode === 1 && s.next.airingAt - now < 7 * 86400) return 'Premieres soon';
    if (s.next && s.next.episode === 2 && s.next.airingAt - now > 0) return 'New this week';
    return '';
  };
  function rng(seed) {
    let t = seed + 0x6d2b79f5;
    return () => {
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function tile(s, sub) {
    const me = s.me;
    const pct = me.status && s.episodes ? Math.min(100, Math.round((me.progress / s.episodes) * 100)) : 0;
    return `<article class="tile" data-id="${s.id}" style="${s.color ? `--tint:${esc(s.color)}` : ''}">
      <button class="poster" data-act="watch" aria-label="Watch ${esc(s.title)}">${s.cover ? `<img src="${esc(s.cover)}" alt="" loading="lazy">` : ''}
        ${s.dub === 'announced' ? '<span class="badge">DUB</span>' : ''}${s.match != null && !me.status ? `<span class="badge m">${s.match}%</span>` : ''}
        ${pct ? `<span class="track"><i style="width:${pct}%"></i></span>` : ''}</button>
      <div class="tt" title="${esc(s.title)}">${esc(s.title)}</div><div class="ts">${esc(sub)}</div></article>`;
  }
  function shelf(title, items, subFn) {
    if (!items.length) return '';
    return `<section class="shelf"><h2 class="shelf-t">${title}</h2><div class="shelf-row">${items.map((s) => tile(s, subFn(s))).join('')}</div></section>`;
  }
  function homeHtml() {
    const shows = S.data.shows;
    const upNext = shows
      .filter((s) => s.me.status === 'WATCHING' && aired(s) != null && aired(s) > s.me.progress)
      .sort((a, b) => (b.resume && !b.resume.done ? 1 : 0) - (a.resume && !a.resume.done ? 1 : 0));
    const foryou = listFor('foryou');
    const hero = upNext[0] || foryou[0] || shows.find((s) => s.onCR);
    let html = '';
    if (hero) {
      const kind = upNext[0] ? (hero.resume && !hero.resume.done && hero.resume.time > 30 ? 'Continue Watching' : 'Up Next') : 'Featured for you';
      const bits = [hero.genres.slice(0, 3).join(' · '), hero.episodes ? `${hero.episodes} episodes` : '', hero.dub === 'announced' ? 'English dub' : ''].filter(Boolean);
      const blurb = upNext[0] ? `Episode ${hero.me.progress + 1} is ready${aired(hero) - hero.me.progress > 1 ? `, ${aired(hero) - hero.me.progress} waiting` : ''}.` : hero.why && hero.why.length ? `Because you like ${hero.why.join(', ')}.` : '';
      html += `<section class="hero" data-id="${hero.id}" style="${hero.color ? `--tint:${esc(hero.color)}` : ''}">
        <div class="hero-bg" style="background-image:url('${esc(hero.cover)}')"></div>
        <div class="hero-in"><div class="eyebrow">${kind}${hero.match != null && !upNext[0] ? ` · ${hero.match}% match` : ''}</div>
          <h1 class="hero-t">${esc(hero.title)}</h1><div class="hero-m">${esc(bits.join('  ·  '))}</div><div class="hero-d">${esc(blurb)}</div>
          <div class="hero-a"><button class="btn primary big" data-act="watch">▶ ${esc(watchLabel(hero))}</button>
          ${hero.me.status ? '' : '<button class="btn big" data-act="plan">+ Plan to watch</button>'}</div></div>
        ${hero.cover ? `<img class="hero-p" src="${esc(hero.cover)}" alt="">` : ''}</section>`;
    }
    const wk = Date.now() / 1000 + 7 * 86400;
    const airing = shows.filter((s) => s.next && s.next.airingAt < wk && ['WATCHING', 'PLANNING'].includes(s.me.status)).sort((a, b) => a.next.airingAt - b.next.airingAt);
    const fresh = shows.filter((s) => isNew(s) && s.onCR && !s.me.status);
    const planning = shows.filter((s) => s.me.status === 'PLANNING');
    const epSub = (s) => (s.resume && !s.resume.done && s.resume.time > 30 ? `Ep ${s.resume.ep || s.me.progress + 1} · ${clock(s.resume.time)} in` : `Episode ${s.me.progress + 1}`);
    html += shelf('Up Next', upNext, epSub);
    html += shelf('Airing This Week', airing, (s) => `Ep ${s.next.episode} · ${rel(s.next.airingAt)}`);
    html += shelf('Top Picks for You', foryou.slice(0, 16), (s) => (s.why && s.why.length ? s.why.slice(0, 2).join(', ') : s.genres.slice(0, 2).join(', ')));
    html += shelf('New This Week', fresh, (s) => isNew(s));
    html += shelf('Plan to Watch', planning, (s) => (s.next ? `Ep ${s.next.episode} · ${rel(s.next.airingAt)}` : s.genres.slice(0, 2).join(', ')));
    return html || '<div class="empty">Nothing to show yet. Check Settings for your AniList username.</div>';
  }
  function tonightPicks() {
    const shows = S.data.shows;
    const budget = S.tmins <= 30 ? 1 : S.tmins <= 60 ? 2 : 4;
    const ready = shows
      .filter((s) => s.me.status === 'WATCHING' && aired(s) != null && aired(s) > s.me.progress)
      .map((s) => ({ s, eps: Math.min(budget, aired(s) - s.me.progress), kind: s.resume && !s.resume.done && s.resume.time > 30 ? 'resume' : 'next' }));
    const planned = shows.filter((s) => s.me.status === 'PLANNING' && aired(s) >= 1).map((s) => ({ s, eps: Math.min(budget, aired(s)), kind: 'start' }));
    const fresh = listFor('foryou').slice(0, 8).filter((s) => aired(s) >= 1).map((s) => ({ s, eps: Math.min(budget, aired(s)), kind: 'try' }));
    const r = rng(S.seed);
    const shuf = (a) => a.map((x) => [r(), x]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
    const resumes = ready.filter((x) => x.kind === 'resume');
    const rest = shuf(ready.filter((x) => x.kind !== 'resume'));
    return [...resumes, ...rest, ...shuf(planned), ...shuf(fresh)].slice(0, 3);
  }
  function tonightHtml() {
    const picks = tonightPicks();
    const pills = TIMES.map((t) => `<button class="pill ${S.tmins === t.id ? 'on' : ''}" data-tmins="${t.id}">${t.label} <span class="sub">${t.sub}</span></button>`).join('');
    const KIND = { resume: 'Pick up where you left off', next: 'Next up', start: 'From your plan-to-watch', try: 'Something new for you' };
    const body = picks.length
      ? picks
          .map(
            (p, i) => `<div class="pick"><div class="pick-k">${i === 0 ? 'Top pick · ' : ''}${KIND[p.kind]} · ${p.eps} ep${p.eps > 1 ? 's' : ''}</div>${card(p.s)}</div>`
          )
          .join('')
      : '<div class="empty">Nothing aired and waiting. You are all caught up. Try Discover for something new.</div>';
    return `<div class="tonight-top"><div><h2 class="sec">What are you in the mood for?</h2><div class="sub">How long have you got tonight?</div></div><div class="tpills">${pills}<button class="btn small" data-act="shuffle">Shuffle</button></div></div><div class="picks">${body}</div>`;
  }

  function listFor(view) {
    const shows = S.data ? S.data.shows : [];
    if (view === 'foryou') {
      const hasTaste = !!S.data.taste || shows.some((s) => s.match != null);
      return shows
        .filter((s) => !s.me.status && passes(s, { forYou: true }))
        .sort((a, b) => (hasTaste ? (b.match ?? 0) - (a.match ?? 0) : b.popularity - a.popularity));
    }
    if (view === 'season') return applySort(shows.filter((s) => !s.offSeason && passes(s)));
    if (view === 'mine') {
      return shows
        .filter((s) => ['WATCHING', 'PLANNING'].includes(s.me.status) && passes(s, { skipToggles: true }))
        .sort((a, b) => {
          if (a.me.status !== b.me.status) return a.me.status === 'WATCHING' ? -1 : 1;
          return (a.next ? a.next.airingAt : Infinity) - (b.next ? b.next.airingAt : Infinity);
        });
    }
    if (view === 'airing') return shows.filter((s) => s.next && passes(s)).sort((a, b) => a.next.airingAt - b.next.airingAt);
    return [];
  }

  /* ---------- rendering ---------- */
  function renderNav() {
    const counts = S.data
      ? {
          foryou: listFor('foryou').length,
          season: listFor('season').length,
          mine: listFor('mine').length,
          list: S.data.list.length,
          airing: listFor('airing').length,
        }
      : {};
    let grp = '';
    $('#nav').innerHTML = VIEWS.map((v) => {
      const head = v.group !== grp ? `<div class="nav-label">${v.group}</div>` : '';
      grp = v.group;
      return `${head}<button class="nav-btn ${S.view === v.id ? 'on' : ''}" data-nav="${v.id}">${v.ico}<span class="nl">${v.label}</span>${
        counts[v.id] != null ? `<span class="n">${counts[v.id]}</span>` : ''
      }</button>`;
    }).join('');
    const tb = $('#tabbar');
    if (tb) {
      tb.innerHTML = VIEWS.filter((v) => TABS.includes(v.id))
        .map((v) => `<button class="tab ${S.view === v.id ? 'on' : ''}" data-nav="${v.id}" aria-label="${v.label}">${v.ico}<span>${v.id === 'foryou' ? 'Discover' : v.label.replace('Airing Soon', 'Airing')}</span></button>`)
        .join('');
    }
    const d = S.data;
    const seasonName = d ? `${d.season.season[0]}${d.season.season.slice(1).toLowerCase()} ${d.season.year}` : '';
    const updated = d && d.updatedAt ? `Updated ${timeFmt.format(new Date(d.updatedAt))}` : 'Loading…';
    $('#sidefoot').innerHTML = d
      ? `<div class="season"><button class="btn small" data-season="-1" aria-label="Previous season">‹</button><b>${esc(seasonName)}</b><button class="btn small" data-season="1" aria-label="Next season">›</button></div>
         <div class="updated">${esc(updated)}</div><button class="btn small" data-refresh>Refresh now</button>`
      : '<div>Loading…</div>';
  }

  function renderBar() {
    if (S.player) {
      $('#bar').innerHTML = `<button class="btn" data-act="closePlayer">← Library</button><h1>${esc(S.player.title)}</h1><span class="spacer"></span><button class="btn small" data-act="playerExt">Open in browser</button>`;
      return;
    }
    const v = VIEWS.find((x) => x.id === S.view);
    const f = S.filters;
    const pill = (key, label) => `<button class="pill ${f[key] ? 'on' : ''}" data-filter="${key}" aria-pressed="${!!f[key]}">${label}</button>`;
    let html = `<h1>${v.label}</h1>`;
    if (['foryou', 'season', 'airing'].includes(S.view)) html += pill('cr', 'Crunchyroll') + pill('dub', 'English dub');
    if (S.view === 'foryou') html += pill('hideSeq', 'Hide unseen sequels');
    if (S.view === 'season') html += `<select id="sort" aria-label="Sort by">${Object.entries(SORTS).map(([k, v]) => `<option value="${k}" ${S.sort === k ? 'selected' : ''}>${v}</option>`).join('')}</select>`;
    if (S.view === 'airing' || S.view === 'mine') html += '<button class="btn small" data-act="exportCal" title="Save upcoming episodes as a calendar file">Export calendar</button>';
    if (S.view === 'list' && S.data) {
      const counts = {};
      for (const e of S.data.list) counts[listStatus(e)] = (counts[listStatus(e)] || 0) + 1;
      html += LIST_TABS.map(
        (t) => `<button class="pill ${S.listTab === t ? 'on' : ''}" data-listtab="${t}" aria-pressed="${S.listTab === t}">${STATUS_LABEL[t]} ${counts[t] || 0}</button>`
      ).join('');
    }
    if (WEB && S.view === 'foryou') html += '<button class="pill narrow-only" data-nav="season">Whole season</button>';
    if (WEB && S.view === 'season' && S.data) {
      const d = S.data.season;
      html += `<span class="narrow-only pager"><button class="btn small" data-season="-1" aria-label="Previous season">‹</button>${d.season[0]}${d.season.slice(1).toLowerCase()} ${d.year}<button class="btn small" data-season="1" aria-label="Next season">›</button></span>`;
    }
    html += '<span class="spacer"></span>';
    if (WEB && S.view !== 'settings') html += `<button class="btn small narrow-only gear" data-nav="settings" aria-label="Settings">${VIEWS.find((v) => v.id === 'settings').ico}</button>`;
    if (!['settings', 'tonight', 'home'].includes(S.view)) html += `<input type="search" id="q" placeholder="Search" value="${esc(f.q)}" aria-label="Search shows">`;
    $('#bar').innerHTML = html;
  }

  function badges(s) {
    const b = [];
    if (s.onCR) b.push('<span class="chip cr">Crunchyroll</span>');
    if (s.dub === 'announced') b.push('<span class="chip dub">English dub</span>');
    else if (s.dub === 'tbd') b.push('<span class="chip">Dub TBD</span>');
    if (s.offSeason) b.push('<span class="chip">Earlier season</span>');
    if (s.isSequel) b.push(`<span class="chip">${s.needsPrequel ? 'Sequel · earlier season not on your list' : 'Sequel'}</span>`);
    return b.join('');
  }

  function nextLine(s) {
    if (s.next) {
      const d = new Date(s.next.airingAt * 1000);
      const live = s.next.airingAt * 1000 <= Date.now();
      return `<div class="next ${live ? 'live' : ''}">Ep ${s.next.episode} · ${dayFmt.format(d)}, ${timeFmt.format(d)} · ${rel(s.next.airingAt)}</div>`;
    }
    if (s.start && s.start.year && s.airStatus === 'NOT_YET_RELEASED') {
      return `<div class="next">Starts ${s.start.day || '?'}/${s.start.month || '?'}/${s.start.year}</div>`;
    }
    return '';
  }

  function clock(sec) {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function watchLabel(s) {
    const r = s.resume;
    if (r && !r.done && r.time > 30) return `Resume${r.ep ? ` ep ${r.ep}` : ''} · ${clock(r.time)}`;
    return s.onCR ? 'Watch' : 'Find on Crunchyroll';
  }

  function card(s) {
    const me = s.me;
    const total = s.episodes ? ` / ${s.episodes}` : '';
    const behind = me.status === 'WATCHING' && aired(s) != null && aired(s) > me.progress ? aired(s) - me.progress : 0;
    const matchLine =
      s.match != null
        ? `<div class="why">${s.why.length ? `Because you like ${esc(s.why.join(', '))}` : ''}${
            s.against.length ? `${s.why.length ? ' · ' : ''}Not your usual: ${esc(s.against.join(', '))}` : ''
          }</div>`
        : '';
    const opts = ['', 'PLANNING', 'WATCHING', 'DROPPED', 'SKIP']
      .map((v) => `<option value="${v}" ${me.status === v || (!me.status && v === '') ? 'selected' : ''}>${v ? STATUS_LABEL[v] : 'Not tracking'}</option>`)
      .join('');
    const status = ['COMPLETED', 'PAUSED'].includes(me.status) ? `<option value="${me.status}" selected>${STATUS_LABEL[me.status]}</option>` : '';
    const pct = me.status && s.episodes ? Math.min(100, Math.round((me.progress / s.episodes) * 100)) : 0;
    return `<article class="card" data-id="${s.id}" style="${s.color ? `--tint:${esc(s.color)}` : ''}">
      <div class="cover" style="${s.color ? `background:${esc(s.color)}` : ''}">${s.cover ? `<img src="${esc(s.cover)}" alt="" loading="lazy">` : ''}</div>
      <div class="info">
        <div class="head">
          <div class="title">${esc(s.title)}</div>
          ${s.match != null ? `<span class="score ${s.match < 45 ? 'low' : ''}" title="How well this fits your AniList ratings">${s.match}%</span>` : ''}
        </div>
        <div class="meta">${esc([s.genres.slice(0, 3).join(', '), s.episodes ? `${s.episodes} eps` : 'ongoing', s.studio].filter(Boolean).join(' · '))}</div>
        ${matchLine}
        <div class="chips">${isNew(s) ? `<span class="chip hot">${isNew(s)}</span>` : ''}${badges(s)}</div>
        ${nextLine(s)}
        ${pct ? `<div class="track" title="${me.progress} of ${s.episodes} watched"><i style="width:${pct}%"></i></div>` : ''}
        <div class="acts">
          <button class="btn primary small" data-act="watch">${watchLabel(s)}</button>
          ${s.siteUrl ? `<button class="link" data-act="ext" data-url="${esc(s.siteUrl)}">AniList</button>` : ''}
          <select data-act="status" aria-label="Status for ${esc(s.title)}">${opts}${status}</select>
          ${
            me.status === 'WATCHING'
              ? `<span class="prog"><button class="btn small" data-act="dec" aria-label="One episode back">−</button>Ep ${me.progress}${total}<button class="btn small" data-act="inc">+1</button></span>${
                  behind ? `<span class="behind">${behind} behind</span>` : ''
                }`
              : ''
          }
        </div>
      </div>
    </article>`;
  }

  function tastePanel() {
    const t = S.data.taste;
    if (!t) {
      return `<p class="note">Ranking is by popularity for now. Add your AniList username in <b>Settings</b> and shows will be ranked by how well they match what you rate highly.</p>`;
    }
    return `<p class="note">Ranked against your AniList ratings. You tend to like <b>${esc(t.likes.join(', ') || '…')}</b>${
      t.tagLikes.length ? ` (especially ${esc(t.tagLikes.join(', '))})` : ''
    }${t.skips.length ? `, and tend to skip <b>${esc(t.skips.join(', '))}</b>` : ''}. Shows already on your list live under My Shows.</p>`;
  }

  function errors() {
    const e = S.data.errors || {};
    return Object.values(e)
      .map((m) => `<p class="err">${esc(m)}</p>`)
      .join('');
  }

  function listRow(e) {
    const me = e.me;
    const total = e.episodes ? ` / ${e.episodes}` : '';
    const sel = LIST_TABS.map((v) => `<option value="${v}" ${listStatus(e) === v ? 'selected' : ''}>${STATUS_LABEL[v]}</option>`).join('');
    return `<div class="row" data-id="${e.id}">
      <div class="rcover" style="${e.color ? `background:${esc(e.color)}` : ''}">${e.cover ? `<img src="${esc(e.cover)}" alt="" loading="lazy">` : ''}</div>
      <div class="rmain"><div class="title">${esc(e.title)}</div><div class="meta">${esc([e.format, `${me.progress}${total} eps`].filter(Boolean).join(' · '))}</div></div>
      <div class="rscore" title="Your score">${e.score ? e.score : '–'}</div>
      <div class="racts">
        <button class="btn small" data-act="watch">Watch</button>
        ${['WATCHING', 'PAUSED'].includes(me.status) ? '<button class="btn small" data-act="inc" aria-label="Add one episode">+1</button>' : ''}
        <select data-act="status" aria-label="Status for ${esc(e.title)}">${sel}</select>
      </div>
    </div>`;
  }

  function listHtml() {
    const d = S.data;
    if (!d.settings.userName) return '<div class="empty">Add your AniList username in Settings to see your list here.</div>';
    if (!d.list.length) return `<div class="empty">No anime found for "${esc(d.settings.userName)}". Check the username in Settings and that your list is public.</div>`;
    const q = S.filters.q.toLowerCase();
    const items = d.list
      .filter((e) => listStatus(e) === S.listTab && (!q || `${e.title} ${e.romaji}`.toLowerCase().includes(q)))
      .sort((a, b) => (S.listTab === 'COMPLETED' ? (b.score || 0) - (a.score || 0) : 0) || a.title.localeCompare(b.title));
    const done = d.list.filter((e) => listStatus(e) === 'COMPLETED').length;
    const head = `<p class="note"><b>${esc(d.settings.userName)}</b> on AniList · ${d.list.length} anime, ${done} completed. Changes here are sent to AniList when you are logged in.</p>`;
    return head + (items.length ? `<div class="rows">${items.map(listRow).join('')}</div>` : '<div class="empty">Nothing here.</div>');
  }

  function renderContent() {
    const el = $('#content');
    const top = el.scrollTop;
    if (S.player) {
      el.innerHTML = '';
      return;
    }
    if (!S.data || (S.data.loading && S.view !== 'settings')) {
      el.innerHTML = '<div class="empty">Loading this season from AniList…</div>';
      return;
    }
    if (S.view === 'settings') {
      el.innerHTML = settingsHtml();
      return;
    }
    if (S.view === 'list') {
      el.innerHTML = errors() + listHtml();
      el.scrollTop = top;
      return;
    }
    if (S.view === 'home') {
      const sl = [...el.querySelectorAll('.shelf-row')].map((r) => r.scrollLeft);
      el.innerHTML = errors() + homeHtml();
      el.querySelectorAll('.shelf-row').forEach((r, i) => (r.scrollLeft = sl[i] || 0));
      el.scrollTop = top;
      return;
    }
    if (S.view === 'tonight') {
      el.innerHTML = errors() + tonightHtml();
      el.scrollTop = top;
      return;
    }
    const list = listFor(S.view);
    let html = errors();
    if (S.view === 'foryou') html += tastePanel();
    if (S.view === 'season' || S.view === 'airing') {
      if (S.filters.dub) html += `<p class="note">English dub status comes from Crunchyroll's announcements. A dub often starts days or weeks after the subtitled episode.</p>`;
    }
    if (!list.length) {
      html += `<div class="empty">${
        S.view === 'mine' ? 'Nothing here yet. Shows you are watching on AniList appear here automatically, and you can add new ones with the status menu on any card.' : 'No shows match these filters.'
      }</div>`;
    } else if (S.view === 'airing') {
      let day = '';
      let open = false;
      for (const s of list) {
        const d = dayFmt.format(new Date(s.next.airingAt * 1000));
        if (d !== day) {
          if (open) html += '</div>';
          day = d;
          html += `<div class="day">${esc(d)}</div><div class="grid">`;
          open = true;
        }
        html += card(s);
      }
      if (open) html += '</div>';
    } else {
      html += `<div class="grid">${list.map(card).join('')}</div>`;
    }
    el.innerHTML = html;
    el.scrollTop = top;
  }

  function settingsHtml() {
    const d = S.data;
    const st = d.settings;
    const login = d.auth.loggedIn
      ? `<span>Logged in as <b>${esc(d.auth.name)}</b></span> <button class="btn small" data-act="logout">Log out</button>`
      : `<button class="btn primary small" data-act="login">Log in with AniList</button>`;
    if (WEB) {
      return `
      <section class="section">
        <h2>AniList</h2>
        <div class="field"><label for="userName">Username</label><input type="text" id="userName" value="${esc(st.userName)}" placeholder="Your AniList username" autocapitalize="off" autocorrect="off"><span class="hint">Used to learn your taste and see what you already watch. Your list must be public.</span></div>
        <div class="field"><label for="clientId">Client ID</label><input type="text" id="clientId" inputmode="numeric" value="${esc(st.clientId)}" placeholder="e.g. 12345"><span class="hint">Lets the app update your list. At anilist.co/settings/developer create a client with the redirect URL <b>${esc(d.redirectUrl)}</b> and paste its ID here. This is a separate client from the Mac app's.</span></div>
        <div class="field"><label>Account</label><div>${login}</div></div>
        ${d.auth.loggedIn ? '' : `<div class="field"><label for="tokenPaste">Or paste a token</label><input type="text" id="tokenPaste" placeholder="Long code from AniList" autocapitalize="off" autocorrect="off"><span class="hint">If logging in opens Safari and never comes back, set the client's redirect URL to <b>https://anilist.co/api/v2/oauth/pin</b> instead, tap Log in, copy the code AniList shows and paste it here.</span></div>`}
      </section>
      <section class="section">
        <h2>Watching on iPhone</h2>
        <p class="note">Watch opens the show on Crunchyroll. When you come back, AniTrack asks whether you finished the episode and marks it on AniList for you.</p>
        <p class="note">For a reminder when episodes air, use <b>Export calendar</b> on My Shows and choose Add All.</p>
      </section>
      <section class="section"><h2>Season</h2><div class="season"><button class="btn small" data-season="-1" aria-label="Previous season">‹</button><b>${esc(`${d.season.season[0]}${d.season.season.slice(1).toLowerCase()} ${d.season.year}`)}</b><button class="btn small" data-season="1" aria-label="Next season">›</button></div>
        <p class="note">${d.updatedAt ? `Updated ${esc(timeFmt.format(new Date(d.updatedAt)))}` : ''} <button class="btn small" data-refresh>Refresh now</button></p></section>`;
    }
    return `
      <section class="section">
        <h2>AniList</h2>
        <div class="field"><label for="userName">Username</label><input type="text" id="userName" value="${esc(st.userName)}" placeholder="Your AniList username"><span class="hint">Used to learn your taste and see what you already watch. Your list must be public.</span></div>
        <div class="field"><label for="clientId">Client ID</label><input type="text" id="clientId" value="${esc(st.clientId)}" placeholder="e.g. 12345"><span class="hint">Needed once so the app can update your list. Create a free app at anilist.co/settings/developer and set its redirect URL to <b>http://localhost/anitrack</b>. Paste the ID it shows here.</span></div>
        <div class="field"><label>Account</label><div>${login}</div></div>
      </section>
      <section class="section">
        <h2>Watching</h2>
        <div class="field"><label for="autoMark">Mark episode watched at</label><select id="autoMark">${[0.8, 0.9, 0.95]
          .map((v) => `<option value="${v}" ${Number(st.autoMarkPct) === v ? 'selected' : ''}>${Math.round(v * 100)}% of the episode</option>`)
          .join('')}</select><span class="hint">Applies when you watch in the Crunchyroll window. The next episode is counted and sent to AniList.</span></div>
        <div class="field"><label for="notify">Notifications</label><label><input type="checkbox" id="notify" ${st.notify ? 'checked' : ''}> Tell me when an episode of a Watching or Planning show airs</label></div>
        <div class="field"><label>Crunchyroll playback</label><div>${
          d.drm
            ? 'Widevine build detected. Sign in to Crunchyroll once in the watch window and it stays signed in.'
            : 'This copy of Electron has no Widevine, so video will not play in the app. Watch opens Crunchyroll but you will need the Widevine build (see README).'
        }</div></div>
      </section>
      <section class="section">
        <h2>More</h2>
        <div class="field"><label>Menu bar</label><div>The next episode countdown for your shows shows in the menu bar. Click it to open AniTrack.</div></div>
        <div class="field"><label>Shortcuts</label><div class="keys"><span><kbd>⌘1</kbd>–<kbd>⌘8</kbd> switch view</span><span><kbd>/</kbd> or <kbd>⌘F</kbd> search</span><span><kbd>Esc</kbd> clear search / close player</span></div></div>
      </section>`;
  }

  function render() {
    renderNav();
    renderBar();
    renderContent();
  }

  /* ---------- toast ---------- */
  let toastTimer;
  function toast(msg, action) {
    const t = $('#toast');
    t.textContent = msg;
    S.undo = action || null;
    if (action) {
      const b = document.createElement('button');
      b.className = 'toast-act';
      b.textContent = action.label;
      b.dataset.act = 'undo';
      t.append(b);
    }
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), action ? 15000 : 5000);
  }

  /* ---------- actions ---------- */
  async function applyTrack(id, patch, noUndo) {
    const s = byId(id);
    const l = listById(id);
    if (!s && !l) return;
    const before = { status: (s || l).me.status || null, progress: (s || l).me.progress };
    const r = await window.api.setTrack(id, patch);
    if (s) s.me = r.me;
    if (l) l.me = r.me;
    const undo = noUndo ? null : { label: 'Undo', fn: () => applyTrack(id, before, true) };
    if (r.pushed) toast(`AniList updated: ${(s || l).title}`, undo);
    else if (r.error) toast(`Saved here, but AniList said: ${r.error}`);
    else if (!noUndo && patch.progress != null) toast(`${(s || l).title}: episode ${r.me.progress}`, undo);
    else if (r.reason === 'not-logged-in' && !S.shownSyncHint) {
      S.shownSyncHint = true;
      toast('Saved here. Log in with AniList in Settings to sync it to your list.');
    }
    render();
  }

  document.addEventListener('click', async (e) => {
    const nav = e.target.closest('[data-nav]');
    if (nav) {
      if (S.player) await window.api.closePlayer();
      S.view = nav.dataset.nav;
      store.set('view', S.view);
      render();
      return;
    }
    const tm = e.target.closest('[data-tmins]');
    if (tm) {
      S.tmins = Number(tm.dataset.tmins);
      store.set('tmins', S.tmins);
      render();
      return;
    }
    const lt = e.target.closest('[data-listtab]');
    if (lt) {
      S.listTab = lt.dataset.listtab;
      store.set('listTab', S.listTab);
      render();
      return;
    }
    const filter = e.target.closest('[data-filter]');
    if (filter) {
      const k = filter.dataset.filter;
      S.filters[k] = !S.filters[k];
      store.set('filters', { cr: S.filters.cr, dub: S.filters.dub, hideSeq: S.filters.hideSeq });
      render();
      return;
    }
    if (e.target.closest('[data-refresh]')) {
      toast('Refreshing from AniList…');
      S.data = await window.api.refresh({ force: true });
      render();
      return;
    }
    const sw = e.target.closest('[data-season]');
    if (sw && S.data) {
      const { season, year } = S.data.season;
      let i = SEASONS.indexOf(season) + Number(sw.dataset.season);
      let y = year;
      if (i < 0) {
        i = 3;
        y -= 1;
      } else if (i > 3) {
        i = 0;
        y += 1;
      }
      toast(`Loading ${SEASONS[i].toLowerCase()} ${y}…`);
      S.data = await window.api.refresh({ season: SEASONS[i], year: y });
      render();
      return;
    }
    const btn = e.target.closest('[data-act]');
    if (!btn || btn.tagName === 'SELECT') return;
    const act = btn.dataset.act;
    if (act === 'undo') {
      const u = S.undo;
      S.undo = null;
      $('#toast').hidden = true;
      if (u) u.fn();
      return;
    }
    if (act === 'plan') {
      const id0 = Number(btn.closest('[data-id]').dataset.id);
      applyTrack(id0, { status: 'PLANNING' });
      return;
    }
    if (act === 'shuffle') {
      S.seed = Math.floor(Math.random() * 1e6);
      render();
      return;
    }
    if (act === 'exportCal') {
      const r = await window.api.exportCalendar();
      if (r && r.ok) toast(`Saved ${r.count} upcoming episodes to your calendar file`);
      else if (r && r.error) toast(r.error);
      return;
    }
    if (act === 'login') {
      toast('Opening AniList…');
      const r = await window.api.login();
      if (r.ok) {
        S.data = r.data;
        toast(`Logged in as ${r.name}`);
      } else toast(r.error);
      render();
      return;
    }
    if (act === 'logout') {
      S.data = await window.api.logout();
      render();
      return;
    }
    if (act === 'closePlayer') {
      await window.api.closePlayer();
      return;
    }
    if (act === 'playerExt') {
      window.api.playerExternal();
      return;
    }
    const cardEl = btn.closest('[data-id]');
    const id = cardEl ? Number(cardEl.dataset.id) : null;
    const s = id ? byId(id) || listById(id) : null;
    if (act === 'ext') window.api.openExternal(btn.dataset.url);
    else if (act === 'watch' && id) {
      const r = await window.api.watch(id);
      if (r.ok && r.external && s) {
        S.pending = { id, ep: (s.me.progress || 0) + 1, title: s.title, t: Date.now() };
        store.set('pending', S.pending);
      }
      if (!r.ok) toast(r.error);
      else if (!r.drm) toast('No Widevine in this Electron build, so video may not play. See the README.');
    } else if ((act === 'inc' || act === 'dec') && s) {
      applyTrack(id, { progress: Math.max(0, s.me.progress + (act === 'inc' ? 1 : -1)) });
    }
  });

  document.addEventListener('change', async (e) => {
    const t = e.target;
    if (t.id === 'sort') {
      S.sort = t.value;
      store.set('sort', S.sort);
      render();
      return;
    }
    if (t.dataset.act === 'status') {
      const id = Number(t.closest('[data-id]').dataset.id);
      applyTrack(id, { status: t.value || null });
      return;
    }
    if (!S.data || S.view !== 'settings') return;
    const patch = {};
    if (t.id === 'userName') patch.userName = t.value;
    else if (t.id === 'clientId') patch.clientId = t.value;
    else if (t.id === 'tokenPaste' && t.value.trim()) {
      toast('Checking with AniList…');
      const r = await window.api.loginWithToken(t.value);
      S.data = r.data;
      toast(r.msg);
      render();
      return;
    }
    else if (t.id === 'notify') patch.notify = t.checked;
    else if (t.id === 'autoMark') patch.autoMarkPct = Number(t.value);
    else return;
    S.data = await window.api.saveSettings(patch);
    toast('Saved');
    render();
  });

  document.addEventListener('input', (e) => {
    if (e.target.id === 'q') {
      S.filters.q = e.target.value;
      renderNav();
      renderContent();
    }
  });

  document.addEventListener('keydown', async (e) => {
    const typing = ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName);
    if ((e.metaKey || e.ctrlKey) && /^[1-8]$/.test(e.key)) {
      e.preventDefault();
      const v = VIEWS[Number(e.key) - 1];
      if (v) {
        if (S.player) await window.api.closePlayer();
        S.view = v.id;
        store.set('view', S.view);
        render();
      }
    } else if (((e.metaKey || e.ctrlKey) && e.key === 'f') || (e.key === '/' && !typing)) {
      const q = $('#q');
      if (q) {
        e.preventDefault();
        q.focus();
        q.select();
      }
    } else if (e.key === 'Escape') {
      if (S.player) window.api.closePlayer();
      else if (S.filters.q) {
        S.filters.q = '';
        render();
      }
    }
  });

  // iPhone: you watched in the Crunchyroll app, so ask about it when you come back.
  S.pending = store.get('pending', null);
  function askPending() {
    const p = S.pending;
    if (!p || !S.data) return;
    const away = Date.now() - p.t;
    if (away < 4 * 60e3) return; // just a quick look
    S.pending = null;
    store.set('pending', null);
    if (away > 12 * 3600e3) return;
    const cur = byId(p.id) || listById(p.id);
    if (cur && cur.me.progress >= p.ep) return; // already counted
    toast(`Finished ${p.title} episode ${p.ep}?`, { label: 'Mark watched', fn: () => applyTrack(p.id, { progress: p.ep }) });
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') setTimeout(askPending, 600);
  });

  window.api.on('data', (d) => {
    S.data = d;
    render();
  });
  window.api.on('toast', toast);
  window.api.on('player', (p) => {
    S.player = p;
    render();
  });
  setInterval(() => {
    if (S.data && !S.player && S.view !== 'settings' && document.activeElement?.id !== 'q' && document.activeElement?.tagName !== 'SELECT') renderContent();
  }, 60000); // keeps the countdowns fresh

  render();
  window.api.init().then((d) => {
    S.data = d;
    render();
    setTimeout(askPending, 800);
  });
})();
