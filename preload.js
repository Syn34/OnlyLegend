// The only bridge between the launcher UI and the rest of the computer.
const { contextBridge, ipcRenderer } = require('electron');

const call = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('onlylegend', {
  loadCatalog: call('catalog:load'),
  state: call('game:state'),
  install: call('game:install'),
  cancel: call('game:cancel'),
  checkUpdate: call('game:checkUpdate'),
  uninstall: call('game:uninstall'),
  play: call('game:play'),
  chooseFile: call('game:chooseFile'),
  openFolder: call('game:openFolder'),
  chooseLibrary: call('library:choose'),
  openLibrary: call('library:open'),
  openLink: call('link:open'),
  on: (channel, fn) => {
    const allowed = ['game:progress', 'game:changed', 'toast'];
    if (!allowed.includes(channel)) return;
    ipcRenderer.on(channel, (_e, payload) => fn(payload));
  },
});
