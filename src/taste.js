'use strict';
// Learns genre/tag preferences from a user's AniList list and scores shows against them.

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

// How you use the 10-point scale. A generous scorer's 7 is a weak show and a harsh scorer's 7 a good
// one, so scores are read relative to your own average and spread. Short lists use a neutral default.
const DEFAULT_SCALE = { mean: 6.5, spread: 3.5 };
function scoreScale(entries) {
  const s = entries.map((e) => e.score).filter((x) => x > 0);
  if (s.length < 5) return DEFAULT_SCALE;
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  const sd = Math.sqrt(s.reduce((a, b) => a + (b - mean) ** 2, 0) / s.length);
  return { mean, spread: Math.max(1.5, sd * 1.5) };
}

// How strongly one list entry says "I like this" (+1) or "I don't" (-1). null = no signal.
function entryValue(e, scale = DEFAULT_SCALE) {
  if (e.score > 0) return clamp((e.score - scale.mean) / scale.spread, -1, 1);
  if (e.status === 'DROPPED') return -0.6;
  if (e.status === 'COMPLETED' || e.status === 'REPEATING') return 0.3;
  if (e.status === 'CURRENT') return 0.4;
  return null; // planning / paused with no score tells us nothing
}

const studiosOf = (media) => (media.studios?.nodes || []).map((n) => n?.name?.trim()).filter(Boolean);

function buildTaste(entries) {
  const g = {};
  const t = {};
  const st = {};
  // weight lets a tag that barely applies (rank 60) count for less than a defining one (rank 100).
  const add = (map, key, v, weight = 1) => {
    const o = map[key] || (map[key] = { sum: 0, w: 0, n: 0 });
    o.sum += v * weight;
    o.w += weight;
    o.n += 1;
  };
  const scale = scoreScale(entries);
  for (const e of entries) {
    const v = entryValue(e, scale);
    if (v === null) continue;
    for (const name of e.media.genres || []) add(g, name, v);
    for (const tag of e.media.tags || []) if (tag.rank >= 60) add(t, tag.name, v, tag.rank / 100);
    for (const name of studiosOf(e.media)) add(st, name, v);
  }
  const fin = (map) => {
    const w = {};
    const n = {};
    for (const [k, o] of Object.entries(map)) {
      w[k] = o.sum / (o.w + 2); // smoothing: a single entry cannot dominate
      n[k] = o.n;
    }
    return { w, n };
  };
  const G = fin(g);
  const T = fin(t);
  const ST = fin(st);
  return { genres: G.w, genreCounts: G.n, tags: T.w, tagCounts: T.n, studios: ST.w, studioCounts: ST.n };
}

function scoreShow(show, taste) {
  if (!taste) return null;
  const gs = (show.genres || []).map((n) => ({ n, w: taste.genres[n] ?? 0 }));
  const ts = (show.tags || [])
    .filter((x) => x.rank >= 60)
    .slice(0, 8)
    .map((x) => ({ n: x.name, w: taste.tags[x.name] ?? 0 }));
  // A studio only counts once you have seen at least two of its shows (tastes caches from before studios were tracked have none).
  const studio = studiosOf(show).find((n) => (taste.studioCounts?.[n] || 0) >= 2);
  const sw = studio ? taste.studios[studio] : 0;
  const mean = (a) => (a.length ? a.reduce((s, x) => s + x.w, 0) / a.length : 0);
  const quality = ((show.averageScore || 65) - 65) / 100 * 0.4;
  const raw = 0.55 * mean(gs) + 0.45 * mean(ts) + 0.2 * sw + quality;
  const pct = clamp(Math.round(50 + raw * 110), 1, 99);
  const all = [...gs, ...ts, ...(studio ? [{ n: studio, w: sw }] : [])];
  const why = all.filter((x) => x.w > 0.15).sort((a, b) => b.w - a.w).slice(0, 3).map((x) => x.n);
  const against = all.filter((x) => x.w < -0.2).sort((a, b) => a.w - b.w).slice(0, 2).map((x) => x.n);
  return { pct, why, against };
}

function summarizeTaste(taste) {
  const rank = (w, n, min) =>
    Object.keys(w)
      .filter((k) => n[k] >= min)
      .sort((a, b) => w[b] - w[a]);
  const gl = rank(taste.genres, taste.genreCounts, 3);
  const tl = rank(taste.tags, taste.tagCounts, 4);
  return {
    likes: gl.filter((k) => taste.genres[k] > 0.1).slice(0, 5),
    skips: gl.filter((k) => taste.genres[k] < -0.1).slice(-3).reverse(),
    tagLikes: tl.filter((k) => taste.tags[k] > 0.1).slice(0, 4),
  };
}

function listMapFrom(entries) {
  const m = {};
  for (const e of entries) m[e.media.id] = { status: e.status, score: e.score, progress: e.progress };
  return m;
}

const SEASONS = ['WINTER', 'SPRING', 'SUMMER', 'FALL'];
function seasonFor(date) {
  return { season: SEASONS[Math.floor(date.getMonth() / 3)], year: date.getFullYear() };
}

module.exports = { buildTaste, scoreShow, summarizeTaste, listMapFrom, seasonFor, entryValue, scoreScale };
