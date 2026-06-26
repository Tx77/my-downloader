import { ElectronAPI } from '@electron-toolkit/preload'

interface SubtitleOptions {
  mode: 'none' | 'subtitle-only' | 'with-media'
  languages: string[]
  format: 'srt' | 'vtt'
  includeAuto: boolean
  includeManual: boolean
}

// ===== 视频分析类型 =====

interface AnalysisRequest {
  id: string
  url: string
  savePath: string
  sessData?: string
  strategy?: 'subtitle-first' | 'asr-only'
  model?: 'medium' | 'large-v3'
  language?: string
}

interface AnalysisProgress {
  id: string
  stage: 'checking-deps' | 'fetching-info' | 'downloading' | 'extracting-audio' | 'transcribing' | 'done'
  percent: number
  overallPercent: number
  message: string
}

interface WhisperSegment {
  start: number
  end: number
  text: string
}

interface AnalysisResult {
  id: string
  title: string
  url: string
  subtitleSource: 'external' | 'asr' | 'none'
  transcript: {
    fullText: string
    segments: WhisperSegment[]
    language: string
    processingTime: number
  }
  error?: string
}

interface AnalysisDepsStatus {
  whisperAvailable: boolean
  modelAvailable: boolean
  modelPath: string
}

interface ElectronAPI {
  // 已有
  getSavedPath: () => Promise<string>
  getCookie: () => Promise<string>
  setCookie: (val: string) => Promise<boolean>
  selectFolder: () => Promise<string | null>
  showItemInFolder: (filePath: string) => Promise<boolean>
  openLoginWindow: () => Promise<string | null>
  analyzeUrl: (args: { url: string; sessData: string }) => Promise<any>
  parseSubtitleFile: (filePath: string) => Promise<any[]>
  startDownload: (
    url: string, formatId: string | null, savePath: string,
    isAudioOnly: boolean, sessData: string, id: string,
    subtitleOptions?: SubtitleOptions
  ) => void
  cancelDownload: (id: string) => Promise<boolean>
  deleteLocalFile: (filePath: string, title: string, ext: string) => Promise<boolean>
  deleteLocalFiles: (paths: string[]) => Promise<boolean>
  getTasks: () => Promise<any[]>
  setTasks: (tasks: any[]) => Promise<boolean>
  deleteFile: (path: string) => Promise<boolean>

  // 事件监听
  onProgress: (callback: (data: any) => void) => void
  onComplete: (callback: (data: any) => void) => void
  onError: (callback: (data: any) => void) => void
  onFile: (callback: (data: { id: string; path: string }) => void) => void
  onCanceled: (callback: (data: { id: string; removed: number }) => void) => void
  removeListeners: () => void

  // ===== 视频分析 API (新增) =====
  startAnalysis: (request: AnalysisRequest) => Promise<AnalysisResult>
  cancelAnalysis: (id: string) => Promise<boolean>
  checkAnalysisDeps: () => Promise<AnalysisDepsStatus>
  onAnalysisProgress: (callback: (data: AnalysisProgress) => void) => void
  onAnalysisComplete: (callback: (data: AnalysisResult) => void) => void
  onAnalysisError: (callback: (data: { id: string; error: string }) => void) => void

  electronAPI: ElectronAPI
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: unknown
  }
}
