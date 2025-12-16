import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

// 1. 定义我们需要暴露给前端的自定义 API
const api = {
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  // 👇 新增 Cookie 相关接口
  getCookie: () => ipcRenderer.invoke('get-cookie'),
  setCookie: (val) => ipcRenderer.invoke('set-cookie', val),
  onProgress: (callback) => ipcRenderer.on('download-progress', (_event, value) => callback(value)),
  onComplete: (callback) => ipcRenderer.on('download-complete', (_event, value) => callback(value)),
  onError: (callback) => ipcRenderer.on('download-error', (_event, value) => callback(value)),
  removeListeners: () => {
    ipcRenderer.removeAllListeners('download-progress')
    ipcRenderer.removeAllListeners('download-complete')
    ipcRenderer.removeAllListeners('download-error')
  },
  getSavedPath: () => ipcRenderer.invoke('get-saved-path'), // 新增
  analyzeUrl: (params) => ipcRenderer.invoke('analyze-url', params),
  // 修改下载接口，支持更多参数
  startDownload: (url, formatId, savePath, isAudioOnly, sessData) =>
    ipcRenderer.send('start-download', { url, formatId, savePath, isAudioOnly, sessData }),
  // 👇 新增登录接口
  openLoginWindow: () => ipcRenderer.invoke('open-login-window'),
  // 👇 新增
  cancelDownload: () => ipcRenderer.invoke('cancel-download')
}

// 2. 将 API 暴露给渲染进程
// 如果开启了上下文隔离 (contextIsolation: true)，必须使用 contextBridge
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', {
      ...electronAPI, // 保留官方工具链的默认 API
      ...api // 合并我们的自定义 API
    })
  } catch (error) {
    console.error(error)
  }
} else {
  // 如果没有开启隔离 (通常不建议)，直接挂载到 window
  // @ts-ignore (define in dts)
  window.electron = { ...electronAPI, ...api }
  // @ts-ignore (define in dts)
  window.api = api
}
