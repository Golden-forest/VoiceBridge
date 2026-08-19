const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('voicebridge', {
  version: () => ipcRenderer.invoke('voicebridge:version'),
  publicConfig: () => ipcRenderer.invoke('voicebridge:public-config'),
  initialize: () => ipcRenderer.invoke('voicebridge:initialize'),
  refreshPairing: () => ipcRenderer.invoke('voicebridge:refresh-pairing'),
  unpair: () => ipcRenderer.invoke('voicebridge:unpair'),
  updateSettings: (settings) => ipcRenderer.invoke('voicebridge:update-settings', settings),
  lanState: () => ipcRenderer.invoke('voicebridge:lan-state'),
  onAgentStatus: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('voicebridge:agent-status', listener);
    return () => ipcRenderer.removeListener('voicebridge:agent-status', listener);
  },
  onDesktopState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('voicebridge:desktop-state', listener);
    return () => ipcRenderer.removeListener('voicebridge:desktop-state', listener);
  },
  onLanState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('voicebridge:lan-state', listener);
    return () => ipcRenderer.removeListener('voicebridge:lan-state', listener);
  }
});
