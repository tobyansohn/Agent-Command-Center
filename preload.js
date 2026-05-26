const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getAgents:    ()               => ipcRenderer.invoke('agent:list'),
  getWorldInfo: ()               => ipcRenderer.invoke('world:info'),
  getMemory:    (agentId)        => ipcRenderer.invoke('memory:get', agentId),
  clearMemory:  (agentId)        => ipcRenderer.invoke('memory:clear', agentId),
  sendMessage:  (agentId, msg)   => ipcRenderer.invoke('chat:send', { agentId, message: msg }),
  routeMessage: (msg)            => ipcRenderer.invoke('chat:route', { message: msg }),
  sendAll:      (msg)            => ipcRenderer.invoke('chat:send-all', { message: msg }),
  onConsulting:  (cb) => ipcRenderer.on('chat:consulting',  (_, data) => cb(data)),
  onConsulted:   (cb) => ipcRenderer.on('chat:consulted',   (_, data) => cb(data)),
  onClarifyQ:    (cb) => ipcRenderer.on('chat:clarify-q',   (_, data) => cb(data)),
  onClarifyA:    (cb) => ipcRenderer.on('chat:clarify-a',   (_, data) => cb(data)),
  onStreamStart: (cb) => ipcRenderer.on('chat:stream-start',(_, data) => cb(data)),
  onStreamDelta: (cb) => ipcRenderer.on('chat:stream-delta',(_, data) => cb(data)),
  onStreamEnd:   (cb) => ipcRenderer.on('chat:stream-end',  (_, data) => cb(data)),
  onHermesFile:  (cb) => ipcRenderer.on('hermes:file',      (_, data) => cb(data)),
  minimize:     ()               => ipcRenderer.invoke('window:minimize'),
  maximize:     ()               => ipcRenderer.invoke('window:maximize'),
  close:        ()               => ipcRenderer.invoke('window:close'),
});
