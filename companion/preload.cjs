const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld(
  "companion",
  Object.freeze({
    status: () => ipcRenderer.invoke("pm:status"),
    connect: () => ipcRenderer.invoke("pm:connect"),
    dashboard: () => ipcRenderer.invoke("pm:dashboard"),
    addProject: () => ipcRenderer.invoke("pm:project"),
    pairPhone: () => ipcRenderer.invoke("pm:pair"),
    setAutoStart: (enabled) =>
      ipcRenderer.invoke("pm:autostart", enabled === true),
  }),
);
