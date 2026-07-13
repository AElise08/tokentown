// Ponte segura: expõe só o evento de uso ao renderer + o envio do retrato da cidade
// (sem dar acesso ao Node). contextIsolation mantido — nada de Node no renderer.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('tt', {
  onUsage: (cb) => ipcRenderer.on('usage', (_e, data) => cb(data)),
  onSetup: (cb) => ipcRenderer.on('setup', (_e, data) => cb(data)), // setup local (skills/mcp/hooks/tools/models) — SEMPRE (D5)
  sendCity: (city) => ipcRenderer.send('city', city)
});
