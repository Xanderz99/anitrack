'use strict';
// App-wide settings shared by the Mac app and the web app.
//
// anilistClientId: the AniList API client everyone logs in through, so nobody has to register their own.
// Create it once at https://anilist.co/settings/developer with the redirect URL set to webUrl below,
// then paste its numeric ID here and rebuild the web app (npm run build:web).
// The Mac app uses the same client: its login window catches the redirect before the page loads.
// Leave it empty and the app asks each person for their own client ID instead (the old behaviour).
module.exports = {
  anilistClientId: '',
  webUrl: 'https://xanderz99.github.io/anitrack/',
};
