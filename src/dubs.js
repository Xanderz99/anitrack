'use strict';
// English dub announcements. AniList has no dub data, so this list comes from Crunchyroll's
// Fall 2026 announcements (via Siliconera / Anime News Network coverage) and is matched by title.
// To add or fix entries without touching code, create dubs.json in the app's data folder:
//   { "announced": ["some title"], "tbd": ["another title"] }
const fs = require('fs');

const BUNDLED = {
  announced: [
    'aoashi',
    'apothecary diaries',
    'reincarnated aristocrat',
    'black clover',
    'detective is already dead',
    'firefly wedding',
    'fx fighter',
    'iceblade sorcerer',
    'laid off cheat granting mage',
    'magic knight rayearth',
    'magical explorer',
    'prince of tennis',
    'overgeared',
    'reborn as a space mercenary',
    'returner s magic',
    'sasaki and peeps',
    'world s strongest witch',
  ],
  tbd: ['psyren'],
};

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function loadExtra(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function makeDubMatcher(extraFile) {
  const extra = extraFile ? loadExtra(extraFile) : null;
  const ann = [...BUNDLED.announced, ...(extra?.announced || [])].map(norm);
  const tbd = [...BUNDLED.tbd, ...(extra?.tbd || [])].map(norm);
  return (show) => {
    const names = [show.title?.english, show.title?.romaji].map(norm).filter(Boolean);
    const has = (list) => list.some((k) => names.some((n) => n.includes(k)));
    if (has(ann)) return 'announced';
    if (has(tbd)) return 'tbd';
    return null;
  };
}

module.exports = { makeDubMatcher, norm };
