import { ElectronAPI } from '@electron-toolkit/preload'

declare global {
  interface Window {
    electron: {
      ipcRenderer: ElectronAPI['ipcRenderer']

      // 基础操作
      getSavedPath: () => Promise<string>
      getCookie: () => Promise<string>
      setCookie: (val: string) => Promise<void>
      selectFolder: () => Promise<string | null>
      showItemInFolder: (filePath: string) => Promise<boolean>
      openLoginWindow: () => Promise<string | null>

      // 解析
      analyzeUrl: (args: { url: string; sessData: string }) => Promise<any>

      // 下载
      startDownload: (
        url: string,
        formatId: string | null,
        savePath: string,
        isAudioOnly: boolean,
        sessData: string,
        id: string
      ) => void

      cancelDownload: (id: string) => Promise<boolean>

      onProgress: (
        callback: (data: { id: string; log: string; percent: number; totalSize: string }) => void
      ) => void
      onComplete: (callback: (data: { id: string; code: number }) => void) => void
      onError: (callback: (data: { id: string; error: string }) => void) => void

      // ✅ 新增：真实文件路径 & 取消确认
      onFile: (callback: (data: { id: string; path: string }) => void) => void
      onCanceled: (callback: (data: { id: string; removed: number }) => void) => void

      // 删除（旧+新）
      deleteLocalFile: (filePath: string, title: string, ext: string) => Promise<boolean>
      deleteLocalFiles: (paths: string[]) => Promise<boolean>

      // 清理监听器
      removeListeners: () => void

      // 兼容保留（如果你旧代码还在用）
      deleteFile: (path: string) => Promise<boolean>
      getTasks: () => Promise<any[]>
      setTasks: (tasks: any[]) => Promise<boolean>
    }
  }
}
