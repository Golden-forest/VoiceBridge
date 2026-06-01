const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('voicebridge', {
  version: () => ipcRenderer.invoke('voicebridge:version')
});
