'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);
const EVENTS = ['data', 'toast', 'player'];

contextBridge.exposeInMainWorld('api', {
  init: () => invoke('app:init'),
  refresh: (opts) => invoke('app:refresh', opts),
  setTrack: (id, patch) => invoke('track:set', id, patch),
  saveSettings: (patch) => invoke('settings:save', patch),
  login: () => invoke('anilist:login'),
  logout: () => invoke('anilist:logout'),
  watch: (id) => invoke('watch:open', id),
  closePlayer: () => invoke('player:close'),
  exportCalendar: () => invoke('calendar:export'),
  playerExternal: () => invoke('player:external'),
  openExternal: (url) => invoke('open:external', url),
  on: (channel, cb) => {
    if (!EVENTS.includes(channel)) return () => {};
    const handler = (_event, payload) => cb(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
});
