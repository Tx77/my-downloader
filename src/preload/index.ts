import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

interface SubtitleOptions {
  mode: 'none' | 'subtitle-only' | 'with-media'
  languages: string[]
  format: 'srt' | 'vtt'
  includeAuto: boolean
  includeManual: boolean
}

// 自定义 API
const api = {
  getSavedPath: () => ipcRenderer.invoke('get-saved-path'),
  getCookie: () => ipcRenderer.invoke('get-cookie'),
  setCookie: (val: string) => ipcRenderer.invoke('set-cookie', val),
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  selectAnalysisFolder: () => ipcRenderer.invoke('select-analysis-folder'),
  showItemInFolder: (filePath: string) => ipcRenderer.invoke('show-item-in-folder', filePath),
  openLoginWindow: () => ipcRenderer.invoke('open-login-window'),
  analyzeUrl: (args: { url: string; sessData: string }) => ipcRenderer.invoke('analyze-url', args),
  parseSubtitleFile: (filePath: string) => ipcRenderer.invoke('parse-subtitle-file', filePath),

  startDownload: (
    url: string,
    formatId: string | null,
    savePath: string,
    isAudioOnly: boolean,
    sessData: string,
    id: string,
    subtitleOptions?: SubtitleOptions
  ) => {
    ipcRenderer.send('start-download', {
      url,
      formatId,
      savePath,
      isAudioOnly,
      sessData,
      id,
      subtitleOptions
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

  // ===== 视频分析 API (新增) =====
  startAnalysis: (request) => ipcRenderer.invoke('start-analysis', request),
  listExistingTranscripts: (folderPath: string) => ipcRenderer.invoke('list-existing-transcripts', folderPath),
  analyzeExistingFolder: (request: any) => ipcRenderer.invoke('analyze-existing-folder', request),
  cancelAnalysis: (id: string) => ipcRenderer.invoke('cancel-analysis', id),
  readAnalysisFile: (filePath: string) => ipcRenderer.invoke('read-analysis-file', filePath),
  checkAnalysisDeps: () => ipcRenderer.invoke('check-analysis-deps'),
  askQuestion: (analysisId: string, question: string, options?: any) =>
    ipcRenderer.invoke('ask-question', { analysisId, question, ...(options || {}) }),
  getLlmSettings: () => ipcRenderer.invoke('get-llm-settings'),
  saveLlmSettings: (settings: any) => ipcRenderer.invoke('save-llm-settings', settings),

  onAnalysisProgress: (callback: (data: any) => void) => {
    ipcRenderer.removeAllListeners('analysis-progress')
    ipcRenderer.on('analysis-progress', (_event, data) => callback(data))
  },
  onAnalysisComplete: (callback: (data: any) => void) => {
    ipcRenderer.removeAllListeners('analysis-complete')
    ipcRenderer.on('analysis-complete', (_event, data) => callback(data))
  },
  onAnalysisError: (callback: (data: any) => void) => {
    ipcRenderer.removeAllListeners('analysis-error')
    ipcRenderer.on('analysis-error', (_event, data) => callback(data))
  },

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
