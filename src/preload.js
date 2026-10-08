'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);
const EVENTS = ['data', 'toast', 'player'];

contextBridge.exposeInMainWorld('api', {
  init: () => invoke('app:init'),
  refresh: (opts) => invoke('app:refresh', opts),
  setTrack: (id, patch) => invoke('track:set', id, patch),
  rate: (id, score) => invoke('track:rate', id, score),
  removeFromList: (id) => invoke('track:remove', id),
  search: (q) => invoke('anime:search', q),
  details: (id) => invoke('anime:details', id),
  saveSettings: (patch) => invoke('settings:save', patch),
  login: () => invoke('anilist:login'),
  logout: () => invoke('anilist:logout'),
  adoptGuest: () => invoke('account:adopt-guest'),
  resetDevice: () => invoke('device:reset'),
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
