const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('o', {
  begin: (name) => ipcRenderer.invoke('outro:begin', name),
  frame: (buf) => ipcRenderer.invoke('outro:frame', buf),
  end: () => ipcRenderer.invoke('outro:end'),
  done: (err) => ipcRenderer.invoke('outro:done', err || null),
});
