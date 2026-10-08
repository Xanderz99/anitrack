# AniTrack

A small Mac app for keeping up with new anime.

- **For You**: this season's shows ranked by how well they match what you rate highly on AniList. Scores are read against your own average (an 8 from someone who rates everything 9 counts as a miss), and studios you rate well count too.
- **English dub** and **Crunchyroll** filters, plus a sequel check (hides sequels whose earlier season isn't on your list).
- **My Shows** and **Airing Soon**: episode countdowns in your local time, with a notification when an episode airs.
- **Watch** plays Crunchyroll inside the app window (no separate browser). It remembers where you stopped, so the button turns into **Resume** (episode and time). When you pass 90% of an episode, the next episode is counted and sent to your AniList list.

## Run it

Needs Node.js 18+ on your Mac.

    cd anitrack
    npm install
    npm start

`npm install` pulls the Widevine build of Electron (castlabs), which is what lets Crunchyroll video play.
If that download fails, run `npm i -D electron` instead. Everything works except in-app video.

## Make it a real .app

    npm run app

This builds `AniTrack.app` (with an icon), puts it in `~/Applications`, and opens it. Drag it to the Dock.
It is signed ad hoc, so it runs on your own Mac without a developer account. If video does not play in the
.app but does with `npm start`, the Widevine check is rejecting the ad-hoc signature. Keep using `npm start`,
or sign the app with castlabs' free EVS service (search "castlabs EVS").

## Set up AniList syncing (once, about a minute)

1. Go to anilist.co/settings/developer and create a new app. Set the redirect URL to `http://localhost/anitrack`.
2. Copy the client ID it shows.
3. In AniTrack, open Settings, paste the client ID, then press "Log in with AniList".

Without logging in the app still works and keeps your progress locally. Those changes are sent to AniList the next time you are logged in, and Settings shows how many are still waiting (with a **Sync now** button). The same retry covers changes that failed because you were offline. Your username (Xanderz99 by default) is only used to read your public list.

## How the code fits together

- `src/core.js` is the shared engine: it loads and caches AniList data, merges it with what you track locally and syncs changes back. Both apps use it.
- `src/main.js` is the Mac app (Electron main process: windows, Crunchyroll player, menu bar, notifications). `web/core.js` is the iPhone version of the same layer, built on browser storage.
- `renderer/app.js` is the UI for both. `src/taste.js` does the For You ranking, `src/anilist.js` talks to AniList, and `src/dubs.js` has the dub list.

## Notes and limits

- Crunchyroll has no public player API, so the app embeds Crunchyroll's own site in the window. Playback and auto-marking are best-effort and depend on that site, which can change. They were not tested against the live site. The +1 button always works.
- English dub status is not available from AniList. It comes from Crunchyroll's Fall 2026 announcements and lives in `src/dubs.js`. You can add shows without editing code by creating `dubs.json` in the app's data folder (`~/Library/Application Support/AniTrack/`) like `{ "announced": ["some title"], "tbd": [] }`.
- A dub usually starts after the subtitled episode, so a show can be dubbed and still be behind the sub.

Run `npm test` to run the tests (taste matching, dub matching, the AniList client, sync rules, the calendar file, and a check that `docs/` is up to date).

## Extras

- **Tonight**: pick how long you have (one episode, an hour, an evening) and get up to three picks: resume, next episode, plan-to-watch or something new. Shuffle for another set.
- **Menu bar countdown** to your next episode; click it to open the app.
- **Export calendar** (My Shows / Airing Soon) saves upcoming episodes as an `.ics` file.
- **Sort** the season by popularity, match, rating, airing time or A–Z, and **filter by genre** on For You, This Season and Airing Soon.
- **Undo** after changing a status or episode count; cards show a progress bar.
- Shortcuts: ⌘1–⌘8 switch views, `/` or ⌘F search, Esc closes the player or clears search.

## iPhone (free, as a Home Screen app)

The same app runs on iPhone as a web app. It tracks, recommends and syncs to AniList exactly like the Mac version, so both stay in step. Crunchyroll opens in its own app; when you come back, AniTrack asks "Finished episode N?" and marks it with one tap.

Live at https://xanderz99.github.io/anitrack/ (served from `docs/`). After changing the code run `npm run build:web` to rebuild `docs/`. `npm test` fails if you forget. On the iPhone open the page in Safari, tap Share > Add to Home Screen.

AniList login on iPhone needs its own AniList client whose redirect URL is the page address (Settings in the app shows it). If the login opens Safari and never comes back, set that client's redirect to `https://anilist.co/api/v2/oauth/pin` and paste the code it shows into Settings.

For airing alerts, tap Export calendar on My Shows and choose Add All.
