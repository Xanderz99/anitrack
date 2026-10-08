# AniTrack

A Mac app and iPhone web app for keeping up with new anime, synced through your AniList account.

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

## Accounts

Your AniTrack account is your AniList account. Press **Log in with AniList** and you are done: your list, ratings and episode progress are saved on AniList, so they follow you to the Mac app, the iPhone app and the AniList website. Private lists work too. There is no AniTrack server and no AniTrack password. Nothing is stored anywhere except AniList and your own device.

On first launch AniTrack offers three ways in:

- **Log in with AniList** (recommended). Progress syncs everywhere.
- **Use a public username**. Recommendations come from that public list, and anything you track stays on this device.
- **Just look around**. Nothing leaves the device.

Things that make it safe to share a device or switch accounts:

- Tracking is kept separately per account. Logging in as someone else never shows or sends the previous person's changes. Shows you tracked while logged out stay on the device until you choose **Add to my AniList**.
- Changes that could not reach AniList (offline, AniList down) are retried on every refresh. Settings shows how many are waiting, with a **Sync now** button.
- An expired login logs you out cleanly instead of failing on every change. Your unsynced changes wait for you to log back in.
- On the web, a login link the app did not start (for example one someone sent you) asks before switching accounts.
- **Settings > Remove all AniTrack data** logs out and wipes local data. On the Mac it also clears the AniList and Crunchyroll sessions.

### One-time setup for whoever hosts the app

So that nobody else has to register anything, the app ships with one AniList API client:

1. At https://anilist.co/settings/developer create a client named AniTrack with the redirect URL `https://xanderz99.github.io/anitrack/`.
2. Put its numeric ID in `src/config.js` (`anilistClientId`), then run `npm run build:web` and commit.

The Mac app uses the same client. Its login window catches the redirect before the page loads. Until an ID is set, Settings asks each person for their own client ID, as before. A copy of the web app hosted at another address cannot use the built-in client (AniList only redirects to the registered URL), so it falls back to asking for one.

## How the code fits together

- `src/core.js` is the shared engine: it loads and caches AniList data, merges it with what you track locally and syncs changes back. Both apps use it.
- `src/main.js` is the Mac app (Electron main process: windows, Crunchyroll player, menu bar, notifications). `web/core.js` is the iPhone version of the same layer, built on browser storage.
- `src/config.js` holds the built-in AniList client ID and the web address.
- `renderer/app.js` is the UI for both. `src/taste.js` does the For You ranking, `src/anilist.js` talks to AniList, and `src/dubs.js` has the dub list.

## Notes and limits

- Crunchyroll has no public player API, so the app embeds Crunchyroll's own site in the window. Playback and auto-marking are best-effort and depend on that site, which can change. They were not tested against the live site. The +1 button always works.
- English dub status is not available from AniList. It comes from Crunchyroll's Fall 2026 announcements and lives in `src/dubs.js`. You can add shows without editing code by creating `dubs.json` in the app's data folder (`~/Library/Application Support/AniTrack/`) like `{ "announced": ["some title"], "tbd": [] }`.
- A dub usually starts after the subtitled episode, so a show can be dubbed and still be behind the sub.

Run `npm test` to run the tests (taste matching, dub matching, the AniList client, sync and account rules, the calendar file, and a check that `docs/` is up to date). They need no `npm install`, and GitHub Actions runs them on every push.

## Extras

- **Tonight**: pick how long you have (one episode, an hour, an evening) and get up to three picks: resume, next episode, plan-to-watch or something new. Shuffle for another set.
- **Menu bar countdown** to your next episode; click it to open the app.
- **Export calendar** (My Shows / Airing Soon) saves upcoming episodes as an `.ics` file.
- **Sort** the season by popularity, match, rating, airing time or A–Z, and **filter by genre** on For You, This Season and Airing Soon.
- **Undo** after changing a status or episode count; cards show a progress bar.
- **Search any anime**: the search box filters the view you are on, then also searches all of AniList, so you can track shows from any season.
- **Rate when you finish**: marking the last episode asks for a 1-10 score, saved to AniList (it also sharpens For You).
- **Show details**: tap a poster or title for the full synopsis, trailer, where to watch, episode progress and status, and related seasons (tap one to jump to it).
- **Pull down to refresh** on iPhone. Countdowns tick live without redrawing the page.
- **Every legal service**: cards list where a show streams. Shows that are not on Crunchyroll open on the service that has them (Netflix, HIDIVE and so on).
- Shortcuts: ⌘1–⌘8 switch views, `/` or ⌘F search, Esc closes the player or clears search.

## TorBox / Stremio

AniTrack can hand off TorBox setup to the official TorBox Stremio integration. In **Settings**, choose **Set up TorBox in Stremio**. Complete the TorBox setup in Stremio, then use Stremio for playback.

AniTrack deliberately does not embed a torrent-source scraper or reproduce TorBox's streaming service. TorBox's official integration handles its own account, provider configuration and playback.

## iPhone (free, as a Home Screen app)

The same app runs on iPhone as a web app. It tracks, recommends and syncs to AniList exactly like the Mac version, so both stay in step. Crunchyroll opens in its own app; when you come back, AniTrack asks "Finished episode N?" and marks it with one tap.

Live at https://xanderz99.github.io/anitrack/ (served from `docs/`). After changing the code run `npm run build:web` to rebuild `docs/`. `npm test` fails if you forget. On the iPhone open the page in Safari, tap Share > Add to Home Screen.

If logging in from the Home Screen app opens Safari and never comes back, use Settings > Advanced with your own client whose redirect is `https://anilist.co/api/v2/oauth/pin`, and paste the code AniList shows. Safari can clear a website's storage after a few weeks without visits; Home Screen apps and logged-in progress (which lives on AniList) are not affected.

For airing alerts, tap Export calendar on My Shows and choose Add All.
