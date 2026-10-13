# AniTrack

A Mac app and iPhone web app for keeping up with new anime, synced through your AniList account.

- **For You**: this season's shows ranked by how well they match what you rate highly on AniList. Scores are read against your own average (an 8 from someone who rates everything 9 counts as a miss), and studios you rate well count too.
- **English dub** and **Crunchyroll** filters, plus a sequel check (hides sequels whose earlier season isn't on your list).
- **My Shows** and **Airing Soon**: episode countdowns in your local time, with a notification when an episode airs.
- **Watch** plays Crunchyroll inside the app window (no separate browser). It remembers where you stopped, so the button turns into **Resume** (episode and time). When you pass 90% of an episode, the next episode is counted and sent to your AniList list.

## Download for Mac

Get the latest **AniTrack for Mac** from the [mac-latest release](https://github.com/Xanderz99/anitrack/releases/tag/mac-latest): `AniTrack-mac-apple-silicon.zip` for M1 and later, `AniTrack-mac-intel.zip` for older Macs. Unzip it and drag AniTrack to Applications. The first time, macOS says it cannot check the app (it is not from the App Store): open System Settings > Privacy & Security and click **Open Anyway**.

If Crunchyroll says a video is "not available" inside the app, its copy protection (Widevine) is refusing an app without a Widevine signature. Either choose **Settings > Play Crunchyroll in > Your web browser**, or add the signature (free, about five minutes, once):

1. In Terminal on your Mac (a private Python environment avoids macOS refusing the install):
   `python3 -m venv ~/evs && ~/evs/bin/pip install castlabs-evs && ~/evs/bin/python -m castlabs_evs.account signup`
   Answer the prompts (account name, password, email, name); it emails you a code to type in.
2. On GitHub, open the repository's **Settings > Secrets and variables > Actions** and add two secrets: `EVS_ACCOUNT_NAME` (your EVS account name) and `EVS_PASSWD` (its password).
3. Under **Actions > mac-app**, press **Run workflow**. The new download is signed for Widevine.

GitHub rebuilds it automatically whenever the app's code changes (`.github/workflows/mac-app.yml`). For an app that always matches the website instead, open the web app in Safari on a Mac and choose File > Add to Dock.

## Browser extension for crunchyroll.com

Watching on crunchyroll.com in Chrome, Edge, Brave or Firefox? The **AniTrack for Crunchyroll** extension marks each episode watched on your AniList list when you reach 85% of it (adjustable), with an **Undo** button on the page. Get `AniTrack-extension.zip` from the [extension-latest release](https://github.com/Xanderz99/anitrack/releases/tag/extension-latest) and unzip it.

- **Chrome, Edge, Brave**: open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and choose the unzipped folder.
- **Firefox**: open `about:debugging`, choose **This Firefox > Load Temporary Add-on** and pick `manifest.json` in the folder (Firefox removes it again when it restarts).

Click the AniTrack icon in the toolbar and choose **Connect with AniTrack**: it opens the web app, and once you are logged in there the extension connects by itself. It only takes the login when you press Connect. You can paste a login code instead.

It reads the show name and episode number from the page and finds the show on your list (Watching, Planning, Paused or Rewatching), picking the right season. If it guesses wrong, or Crunchyroll spells the title differently, choose the show in the extension's menu. That choice is remembered for that season, along with the episode Crunchyroll starts counting from (for example 13 for a second half). It never lowers your progress and never marks past a show's last episode. The extension talks only to AniList; its code is in `extension/`. Like the Mac app's auto-marking, it depends on Crunchyroll's page layout and was tested against a mock of it, not the live site.

## Run it

Needs Node.js 22.12 or later on your Mac (the Widevine Electron build requires it).

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
- **Notifications** (the bell): episodes out for shows you watch, and what airs in the next 24 hours. A badge counts new ones since you last looked.
- **Spoiler guard**: a sequel's synopsis stays blurred until you tap it, unless you finished the season before (or already started the sequel). Turn it off in Settings.
- **Your stats** (My List > More stats): episodes this week and month, your daily streak and the last 14 days (from episodes you mark in AniTrack on that device), top genres and your top-rated shows.
- **Every legal service**: cards list where a show streams. Shows that are not on Crunchyroll open on the service that has them (Netflix, HIDIVE and so on).
- Shortcuts: ⌘1–⌘8 switch views, `/` or ⌘F search, Esc closes the player or clears search.

## iPhone (free, as a Home Screen app)

The same app runs on iPhone as a web app. It tracks, recommends and syncs to AniList exactly like the Mac version, so both stay in step. Crunchyroll opens in its own app; when you come back, AniTrack asks "Finished episode N?" and marks it with one tap.

Live at https://xanderz99.github.io/anitrack/ (served from `docs/`). After changing the code run `npm run build:web` to rebuild `docs/`. `npm test` fails if you forget. On the iPhone open the page in Safari, tap Share > Add to Home Screen.

If logging in from the Home Screen app opens Safari and never comes back, use Settings > Advanced with your own client whose redirect is `https://anilist.co/api/v2/oauth/pin`, and paste the code AniList shows. Safari can clear a website's storage after a few weeks without visits; Home Screen apps and logged-in progress (which lives on AniList) are not affected.

For airing alerts, tap Export calendar on My Shows and choose Add All.
