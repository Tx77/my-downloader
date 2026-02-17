import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

// 自定义 API
const api = {
  getSavedPath: () => ipcRenderer.invoke('get-saved-path'),
  getCookie: () => ipcRenderer.invoke('get-cookie'),
  setCookie: (val: string) => ipcRenderer.invoke('set-cookie', val),
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  showItemInFolder: (filePath: string) => ipcRenderer.invoke('show-item-in-folder', filePath),
  openLoginWindow: () => ipcRenderer.invoke('open-login-window'),
  analyzeUrl: (args: { url: string; sessData: string }) => ipcRenderer.invoke('analyze-url', args),

  startDownload: (
    url: string,
    formatId: string | null,
    savePath: string,
    isAudioOnly: boolean,
    sessData: string,
    id: string
  ) => {
    ipcRenderer.send('start-download', {
      url,
      formatId,
      savePath,
      isAudioOnly,
      sessData,
      id
    })
  },

  cancelDownload: (id: string) => ipcRenderer.invoke('cancel-download', id),

  // ✅ 删除：旧接口（兼容）
  deleteLocalFile: (filePath: string, title: string, ext: string) =>
    ipcRenderer.invoke('delete-local-file', filePath, title, ext),

  // ✅ 删除：新接口（按真实路径数组删）
  deleteLocalFiles: (paths: string[]) => ipcRenderer.invoke('delete-local-files', paths),

  // 🔥 监听器透传
  onProgress: (callback: (data: any) => void) => {
    ipcRenderer.removeAllListeners('download-progress')
    ipcRenderer.on('download-progress', (_event, data) => callback(data))
  },
  onComplete: (callback: (data: any) => void) => {
    ipcRenderer.removeAllListeners('download-complete')
    ipcRenderer.on('download-complete', (_event, data) => callback(data))
  },
  onError: (callback: (data: any) => void) => {
    ipcRenderer.removeAllListeners('download-error')
    ipcRenderer.on('download-error', (_event, data) => callback(data))
  },

  // ✅ 新增：真实文件路径回传
  onFile: (callback: (data: { id: string; path: string }) => void) => {
    ipcRenderer.removeAllListeners('download-file')
    ipcRenderer.on('download-file', (_event, data) => callback(data))
  },

  // ✅ 新增：取消确认（并带 removed 数量）
  onCanceled: (callback: (data: { id: string; removed: number }) => void) => {
    ipcRenderer.removeAllListeners('download-canceled')
    ipcRenderer.on('download-canceled', (_event, data) => callback(data))
  },

  removeListeners: () => {
    ipcRenderer.removeAllListeners('download-progress')
    ipcRenderer.removeAllListeners('download-complete')
    ipcRenderer.removeAllListeners('download-error')
    ipcRenderer.removeAllListeners('download-file')
    ipcRenderer.removeAllListeners('download-canceled')
  },

  // 保留：如果你之前有用到（目前主进程没有 delete-file handler）
  deleteFile: (path: string) => ipcRenderer.invoke('delete-file', path),
  getTasks: () => ipcRenderer.invoke('get-tasks'),
  setTasks: (tasks) => ipcRenderer.invoke('set-tasks', tasks),

  // 如果你还要用 electron-toolkit 的 api，也可以暴露
  electronAPI
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore
  window.electron = api
}
