/// <reference types="vite/client" />

interface Window {
  electron: {
    selectFolder: () => Promise<string>
    startDownload: (url: string, format: string, savePath: string) => void
    onProgress: (callback: (data: { log: string; percent: number }) => void) => void
    onComplete: (callback: (code: number) => void) => void
    onError: (callback: (err: string) => void) => void
    removeListeners: () => void
    // ... 其他 electron-toolkit 自带的方法
    ipcRenderer: any
    process: any
  }
}
