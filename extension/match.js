'use strict';
// Works out which episode a Crunchyroll page is playing and which show on your AniList list it is.
// Plain functions with no browser APIs, shared by the content script, the background worker and the
// tests (node test/extension.test.js).
(() => {
  const WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
  const ROMAN = { ii: 2, iii: 3, iv: 4, v: 5, vi: 6 };

  // Lower case, no accents or punctuation: "Frieren: Beyond Journey’s End" -> "frieren beyond journeys end".
  function norm(s) {
    return String(s || '')
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/['’`]/g, '')
      .replace(/&/g, ' and ')
      .replace(/\([^)]*\b(dub|dubbed|sub|subbed|uncut)\b[^)]*\)/g, ' ') // "(English Dub)"
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  // Which season a title names, if any: "Season 2", "2nd Season", "Part 2" of a split season is not one.
  function seasonOf(title) {
    const t = norm(title);
    let m = /\bseason (\d+)\b/.exec(t) || /\b(\d+)(?:st|nd|rd|th) season\b/.exec(t);
    if (m) return Number(m[1]);
    m = /\bseason (one|two|three|four|five|six|seven|eight|nine|ten)\b/.exec(t);
    if (m) return WORDS[m[1]];
    m = / (ii|iii|iv|v|vi)$/.exec(t);
    if (m) return ROMAN[m[1]];
    m = /^(?!.*\b(?:part|no) \d+$).* ([2-9])$/.exec(t); // "Mushoku Tensei 2", not "Kaiju No. 8"
    return m ? Number(m[1]) : null;
  }

  // The title without its season or part, to compare shows across seasons.
  function base(title) {
    return norm(title)
      .replace(/\b(the )?final season\b/g, ' ')
      .replace(/\bseason (\d+|one|two|three|four|five|six|seven|eight|nine|ten)\b/g, ' ')
      .replace(/\b\d+(st|nd|rd|th) season\b/g, ' ')
      .replace(/\b(part|cour) \d+\b/g, ' ')
      .replace(/ (ii|iii|iv|v|vi)$/, ' ')
      .replace(/^(?!.*\bno [2-9]$)(.*) [2-9]$/, '$1')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // What a watch page is playing, from what the page shows. `raw` holds plain strings and objects the
  // content script read: { url, jsonld: [...], h1, series, docTitle, ogTitle }.
  // Returns { series, season, episode, source } or null when this is not an episode page.
  function parseEpisode(raw) {
    if (!/\/watch\//.test(raw.url || '')) return null;
    let series = null;
    let season = null;
    let episode = null;
    let source = null;
    const num = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

    // 1. Structured data, when the page has it.
    const flat = [];
    for (const j of raw.jsonld || []) for (const o of Array.isArray(j) ? j : j && j['@graph'] ? j['@graph'] : [j]) if (o && typeof o === 'object') flat.push(o);
    const ep = flat.find((o) => [].concat(o['@type'] || []).includes('TVEpisode'));
    if (ep) {
      series = ep.partOfSeries?.name || null;
      season = num(ep.partOfSeason?.seasonNumber);
      episode = num(ep.episodeNumber);
      if (series && episode != null) source = 'page data';
    }
    // 2. The page itself: the episode heading reads "E3 - Title" (or "S2 E3 - Title").
    if (episode == null) {
      const m = /^\s*(?:S(\d+)\s*)?E(?:pisode)?\s*(\d+(?:\.\d+)?)\b/i.exec(raw.h1 || '');
      if (m) {
        episode = Number(m[2]);
        if (season == null && m[1]) season = Number(m[1]);
        source = 'page';
      }
    }
    if (!series && raw.series) series = String(raw.series).trim();
    // 3. The tab title: "Watch Frieren Season 2 Episode 3 - …".
    for (const t of [raw.ogTitle, raw.docTitle]) {
      if (series && episode != null) break;
      const m = /^(?:Watch\s+)?(.+?)\s+(?:Season\s+(\d+)\s+)?(?:Episode|Ep\.?)\s*(\d+(?:\.\d+)?)\b/i.exec(t || '');
      if (!m) continue;
      if (!series) series = m[1].replace(/[\s:|–-]+$/, '').trim();
      if (season == null && m[2]) season = Number(m[2]);
      if (episode == null) episode = Number(m[3]);
      source = source || 'tab title';
    }
    if (!series || episode == null) return series || episode != null ? { series, season, episode, source: null, partial: true } : null;
    if (season == null) season = seasonOf(series);
    return { series: series.replace(/\s+/g, ' ').trim(), season, episode, source };
  }

  // Netflix's player shows the show and episode while its controls are visible:
  // <div data-uia="video-title"><h4>Show</h4><span>S1:E3</span><span>Episode title</span></div>
  // (one-season shows say just "E3"). `raw` is { url, show, parts: [span texts] }.
  function parseNetflix(raw) {
    if (!/^\/watch\/\d+/.test(raw.url || '')) return null;
    const series = String(raw.show || '').replace(/\s+/g, ' ').trim();
    let season = null;
    let episode = null;
    for (const p of raw.parts || []) {
      const m = /^\s*(?:S(?:eason)?\s*(\d+)\s*[:·,]?\s*)?(?:E|Ep\.?|Episode)\s*(\d+)\s*$/i.exec(p);
      if (m) {
        season = m[1] ? Number(m[1]) : null;
        episode = Number(m[2]);
        break;
      }
    }
    if (!series || episode == null) return series ? { series, season, episode: null, source: null, partial: true, site: 'netflix' } : null;
    return { series, season: season || seasonOf(series), episode, source: 'netflix', site: 'netflix' };
  }

  // The key a manual link is saved under: one per Crunchyroll series and season.
  const linkKey = (info) => `${norm(info.series)}|${info.season || 1}`;

  // Picks the AniList entry for a page. `entries` are your list entries:
  // { mediaId, status, progress, episodes, titles: [english, romaji, synonyms…] }.
  // `links` are choices you made in the popup: { [linkKey]: { mediaId, offset } }.
  // Returns { entry, offset, why } or { entry: null, candidates, why }.
  function pickEntry(info, entries, links = {}) {
    const link = links[linkKey(info)];
    if (link) {
      const entry = entries.find((e) => e.mediaId === link.mediaId);
      if (entry) return { entry, offset: link.offset || 0, why: 'linked' };
    }
    const want = base(info.series);
    const full = norm(info.series);
    if (!want) return { entry: null, candidates: [], why: 'no title' };
    const scored = [];
    for (const e of entries) {
      let best = 0;
      for (const t of e.titles || []) {
        if (!t) continue;
        const b = base(t);
        if (norm(t) === full) best = Math.max(best, 3);
        else if (b === want) best = Math.max(best, 2);
        else if (b && (b.startsWith(`${want} `) || want.startsWith(`${b} `))) best = Math.max(best, 1); // subtitles
      }
      if (best) scored.push({ e, best });
    }
    if (!scored.length) return { entry: null, candidates: [], why: 'not on your list' };
    const seasonOfEntry = (e) => {
      for (const t of e.titles || []) {
        const s = seasonOf(t);
        if (s) return s;
      }
      return 1;
    };
    const active = (e) => (['CURRENT', 'REPEATING'].includes(e.status) ? 2 : ['PLANNING', 'PAUSED'].includes(e.status) ? 1 : 0);
    const fits = (e) => (info.episode > e.progress && (!e.episodes || info.episode <= e.episodes) ? 1 : 0);
    const next = (e) => (info.episode === e.progress + 1 ? 1 : 0);
    const seasonMatch = (e) => (info.season ? (seasonOfEntry(e) === info.season ? 1 : 0) : 0);
    // The season Crunchyroll names, then a show this episode fits, then one you are watching, then the closest title.
    scored.sort((a, b) => seasonMatch(b.e) - seasonMatch(a.e) || fits(b.e) - fits(a.e) || active(b.e) - active(a.e) || b.best - a.best || next(b.e) - next(a.e));
    const top = scored[0];
    // Two equally good guesses: ask instead of marking the wrong show.
    const tie = scored[1] && seasonMatch(scored[1].e) === seasonMatch(top.e) && scored[1].best === top.best && active(scored[1].e) === active(top.e) && next(scored[1].e) === next(top.e) && fits(scored[1].e) === fits(top.e);
    if (tie) return { entry: null, candidates: scored.map((x) => x.e), why: 'more than one show matches' };
    return { entry: top.e, offset: 0, why: 'title', candidates: scored.map((x) => x.e) };
  }

  // What to save after watching episode `ep` of `entry`, or why nothing should change.
  function nextSave(entry, ep) {
    if (!Number.isInteger(ep) || ep < 1) return { skip: 'not a numbered episode' };
    if (ep <= entry.progress) return { skip: 'already marked' };
    if (entry.episodes && ep > entry.episodes) return { skip: `episode ${ep} is past the ${entry.episodes} AniList has for this show` };
    const status = entry.episodes && ep >= entry.episodes ? 'COMPLETED' : entry.status === 'REPEATING' ? 'REPEATING' : 'CURRENT';
    return { save: { mediaId: entry.mediaId, progress: ep, status } };
  }

  const api = { norm, base, seasonOf, parseEpisode, parseNetflix, linkKey, pickEntry, nextSave };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else globalThis.AniTrackMatch = api;
})();
