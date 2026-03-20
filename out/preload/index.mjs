import { contextBridge, ipcRenderer } from "electron";
const api = {
  stacks: {
    list: () => ipcRenderer.invoke("stacks:list"),
    get: (id) => ipcRenderer.invoke("stacks:get", id),
    create: (opts) => ipcRenderer.invoke("stacks:create", opts),
    teardown: (id) => ipcRenderer.invoke("stacks:teardown", id)
  },
  tasks: {
    dispatch: (stackId, prompt) => ipcRenderer.invoke("tasks:dispatch", stackId, prompt),
    list: (stackId) => ipcRenderer.invoke("tasks:list", stackId)
  },
  diff: {
    get: (stackId) => ipcRenderer.invoke("diff:get", stackId)
  },
  push: {
    execute: (stackId, message) => ipcRenderer.invoke("push:execute", stackId, message)
  },
  ports: {
    get: (stackId) => ipcRenderer.invoke("ports:get", stackId)
  },
  logs: {
    stream: (containerId, runtime) => ipcRenderer.invoke("logs:stream", containerId, runtime)
  },
  runtime: {
    available: () => ipcRenderer.invoke("runtime:available")
  },
  on: (channel, callback) => {
    const handler = (_event, ...args) => callback(...args);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  }
};
contextBridge.exposeInMainWorld("sandstorm", api);
