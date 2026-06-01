const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('voicebridge', {
  version: () => ipcRenderer.invoke('voicebridge:version'),
  publicConfig: () => ipcRenderer.invoke('voicebridge:public-config'),
  login: (credentials) => ipcRenderer.invoke('voicebridge:login', {
    email: String(credentials?.email || ''),
    password: String(credentials?.password || '')
  }),
  logout: () => ipcRenderer.invoke('voicebridge:logout'),
  onAgentStatus: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('voicebridge:agent-status', listener);
    return () => ipcRenderer.removeListener('voicebridge:agent-status', listener);
  }
});
