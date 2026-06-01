import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('voicebridge', {
  version: () => ipcRenderer.invoke('voicebridge:version')
});
