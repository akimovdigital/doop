const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('lab', {
  select: mode => ipcRenderer.invoke('mode', mode),
  onState: handler => ipcRenderer.on('state', (_event, state) => handler(state)),
})
