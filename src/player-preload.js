'use strict';
// Runs in the Crunchyroll window (and its iframes, where the player lives).
// It reports playback position and, once per page, asks the main process whether to jump ahead.
const { ipcRenderer } = require('electron');

let asked = false;

setInterval(() => {
  try {
    const v = document.querySelector('video');
    if (!v || !isFinite(v.duration) || v.duration <= 0) return;
    ipcRenderer.send('player:tick', { currentTime: v.currentTime, duration: v.duration, paused: v.paused });
    if (!asked && v.readyState >= 1) {
      asked = true;
      // Give Crunchyroll a moment to apply its own resume point first.
      setTimeout(async () => {
        try {
          const t = await ipcRenderer.invoke('player:resume-time');
          if (t && t - v.currentTime > 20 && t < v.duration - 30) v.currentTime = t;
        } catch {
          /* window closed */
        }
      }, 3000);
    }
  } catch {
    /* page is mid-navigation */
  }
}, 5000);
