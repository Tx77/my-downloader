import { ElectronAPI } from '@electron-toolkit/preload'

interface SubtitleOptions {
  mode: 'none' | 'subtitle-only' | 'with-media'
  languages: string[]
  format: 'srt' | 'vtt'
  includeAuto: boolean
  includeManual: boolean
}

interface SubtitleSegment {
  id: string
  index: number
  startTime: number
  endTime: number
  text: string
  speaker?: string
  speakerSource?: 'detected' | 'manual' | 'ai' | 'unknown'
}

type LLMProvider = 'deepseek' | 'openai' | 'codex-cli'
type ContentAnalysisType = 'summary' | 'key-points' | 'mind-map'

interface SummaryResult {
  text: string
  style: 'concise' | 'detailed'
}

interface KeyPoint {
  title: string
  description: string
  timestamp: number
  importance: 1 | 2 | 3 | 4 | 5
}

interface MindMapNode {
  topic: string
  children: MindMapNode[]
}

interface QAResponse {
  answer: string
  references: Array<{ startTime: number; endTime: number; text: string }>
}

interface ExistingTranscriptCandidate {
  path: string
  name: string
  kind: 'transcript' | 'readme'
  recommended: boolean
}

interface AnalysisResultPayload {
  id: string
  title: string
  url: string
  subtitleSource: 'external' | 'asr' | 'ocr' | 'none'
  transcript: {
    fullText: string
    segments: { start: number; end: number; text: string }[]
    language: string
    processingTime: number
  }
  outputFiles: { txt: string; json: string; readme?: string; analysisMd?: string; promptMd?: string }
  savePath: string
  summary?: SummaryResult
  keyPoints?: KeyPoint[]
  mindMap?: MindMapNode
  llmProvider?: LLMProvider
  llmModel?: string
  error?: string
}

declare global {
  interface Window {
    electron: {
      ipcRenderer: ElectronAPI['ipcRenderer']

      // 基础操作
      getSavedPath: () => Promise<string>
      getCookie: () => Promise<string>
      setCookie: (val: string) => Promise<void>
      selectFolder: () => Promise<string | null>
      selectAnalysisFolder: () => Promise<string | null>
      showItemInFolder: (filePath: string) => Promise<boolean>
      openLoginWindow: () => Promise<string | null>

      // 解析
      analyzeUrl: (args: { url: string; sessData: string }) => Promise<any>
      parseSubtitleFile: (filePath: string) => Promise<SubtitleSegment[]>

      // 下载
      startDownload: (
        url: string,
        formatId: string | null,
        savePath: string,
        isAudioOnly: boolean,
        sessData: string,
        id: string,
        subtitleOptions?: SubtitleOptions
      ) => void

      cancelDownload: (id: string) => Promise<boolean>

      onProgress: (
        callback: (data: { id: string; log: string; percent: number; totalSize: string }) => void
      ) => void
      onComplete: (callback: (data: { id: string; code: number; error?: string }) => void) => void
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

      // ===== 视频分析 API (新增) =====
      startAnalysis: (request: {
        id: string
        url: string
        savePath: string
        sessData?: string
        strategy?: 'subtitle-first' | 'asr-only' | 'ocr'
        model?: 'tiny' | 'base' | 'small' | 'medium' | 'large-v3'
        language?: string
        llmProvider?: LLMProvider
        llmModel?: string
        llmApiKey?: string
        llmApiBase?: string
        analysisTypes?: ContentAnalysisType[]
      }) => Promise<AnalysisResultPayload>

      listExistingTranscripts: (folderPath: string) => Promise<ExistingTranscriptCandidate[]>
      analyzeExistingFolder: (request: {
        id: string
        folderPath: string
        transcriptPath?: string
        llmProvider?: LLMProvider
        llmModel?: string
        llmApiKey?: string
        llmApiBase?: string
        analysisTypes?: ContentAnalysisType[]
        language?: string
      }) => Promise<AnalysisResultPayload>

      cancelAnalysis: (id: string) => Promise<boolean>
      readAnalysisFile: (filePath: string) => Promise<string>
      getLlmSettings: () => Promise<{
        provider: LLMProvider
        model: string
        apiKey: string
        saveApiKey: boolean
      }>
      saveLlmSettings: (settings: {
        provider: LLMProvider
        model?: string
        apiKey?: string
        saveApiKey?: boolean
      }) => Promise<boolean>
      askQuestion: (
        analysisId: string,
        question: string,
        options?: {
          llmProvider?: LLMProvider
          llmModel?: string
          llmApiKey?: string
          llmApiBase?: string
        }
      ) => Promise<QAResponse>

      checkAnalysisDeps: () => Promise<{
        whisperAvailable: boolean
        modelAvailable: boolean
        modelPath: string
      }>

      onAnalysisProgress: (callback: (data: {
        id: string
        stage: string
        percent: number
        overallPercent: number
        message: string
        elapsed: number
      }) => void) => void

      onAnalysisComplete: (callback: (data: any) => void) => void
      onAnalysisError: (callback: (data: { id: string; error: string }) => void) => void
    }
  }
}
