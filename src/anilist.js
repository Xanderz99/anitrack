'use strict';
// Thin AniList GraphQL client (https://docs.anilist.co). Uses the global fetch in Electron's main process.
const API = 'https://graphql.anilist.co';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function gql(query, variables = {}, token) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ query, variables }),
    });
    if (res.status === 429) {
      const wait = Number(res.headers.get('retry-after')) || 10;
      await sleep(Math.min(wait, 60) * 1000);
      continue;
    }
    let json = null;
    try {
      json = await res.json();
    } catch {
      /* non-JSON error body */
    }
    if (!res.ok || !json || json.errors) {
      const err = new Error(json?.errors?.[0]?.message || `AniList returned HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return json.data;
  }
  throw new Error('AniList is rate limiting requests. Try again in a minute.');
}

const MEDIA_FIELDS = `
      id siteUrl title{ romaji english } format episodes duration genres
      tags{ name rank } averageScore popularity status description(asHtml:false)
      coverImage{ large color } studios(isMain:true){ nodes{ name } }
      startDate{ year month day } nextAiringEpisode{ episode airingAt }
      externalLinks{ site type url }
      relations{ edges{ relationType node{ id type format } } }
`;

const SEASON_Q = `query($page:Int,$season:MediaSeason,$year:Int){
  Page(page:$page, perPage:50){
    pageInfo{ hasNextPage }
    media(season:$season, seasonYear:$year, type:ANIME, sort:POPULARITY_DESC, format_in:[TV,TV_SHORT,ONA]){
${MEDIA_FIELDS}
    }
  }
}`;

const BY_IDS_Q = `query($ids:[Int]){
  Page(perPage:50){
    media(id_in:$ids, type:ANIME){
${MEDIA_FIELDS}
    }
  }
}`;

async function fetchSeason(season, year) {
  const all = [];
  for (let page = 1; page <= 8; page++) {
    const data = await gql(SEASON_Q, { page, season, year });
    all.push(...data.Page.media);
    if (!data.Page.pageInfo.hasNextPage) break;
  }
  return all;
}

// Shows from other seasons (for example something you are still watching from last season).
async function fetchByIds(ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += 50) {
    const data = await gql(BY_IDS_Q, { ids: ids.slice(i, i + 50) });
    out.push(...data.Page.media);
  }
  return out;
}

const USER_Q = `query($u:String){
  MediaListCollection(userName:$u, type:ANIME){
    lists{ entries{ status score(format:POINT_10) progress media{ id genres tags{ name rank } title{ romaji english } coverImage{ medium color } episodes format siteUrl } } }
  }
}`;

async function fetchUserList(userName) {
  const data = await gql(USER_Q, { u: userName });
  const seen = new Set();
  const entries = [];
  for (const list of data.MediaListCollection?.lists || []) {
    for (const e of list.entries) {
      if (seen.has(e.media.id)) continue; // custom lists repeat entries
      seen.add(e.media.id);
      entries.push(e);
    }
  }
  return entries;
}

async function fetchViewer(token) {
  const data = await gql('query { Viewer { id name } }', {}, token);
  return data.Viewer;
}

// Only sends the fields it is given, so it never overwrites anything else on the entry.
async function saveEntry(token, { mediaId, progress, status }) {
  const vars = { mediaId };
  let defs = '$mediaId:Int';
  let args = 'mediaId:$mediaId';
  if (progress != null) {
    vars.progress = progress;
    defs += ',$progress:Int';
    args += ',progress:$progress';
  }
  if (status) {
    vars.status = status;
    defs += ',$status:MediaListStatus';
    args += ',status:$status';
  }
  const data = await gql(`mutation(${defs}){ SaveMediaListEntry(${args}){ id status progress } }`, vars, token);
  return data.SaveMediaListEntry;
}

module.exports = { fetchSeason, fetchByIds, fetchUserList, fetchViewer, saveEntry };
