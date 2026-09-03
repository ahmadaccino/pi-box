import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("piBoxDesktop", {
  origin: () => ipcRenderer.invoke("pi-box:origin"),
});
