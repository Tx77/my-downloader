/**
 * 视频分析流水线 — 编排 下载→提取→转录 流程
 *
 * 策略:
 *   subtitle-first: 优先外挂字幕, 没有则下载视频做 ASR
 *   asr-only:       下载视频 → 提取音频 → 转录
 */

import { BrowserWindow, ipcMain } from 'electron'
import { spawn, type ChildProcess } from 'child_process'
import { basename, join } from 'path'
import * as fs from 'fs/promises'
import Store from 'electron-store'
import { getBinaryPath, getProxyArgs } from './utils'
import { createCookieFile, cleanupCookieFile } from './cookie'
import { extractAudio } from './audio-extractor'
import { transcribe, checkWhisperDeps, type TranscriberResult } from './transcriber'
import { extractSubtitles, type OcrSegment } from './ocr-extractor'
import {
  askQuestion,
  analyzeTranscript,
  generateAnalysisArticle,
  getDefaultModel,
  type AnalysisResults,
  type AnalysisType,
  type AnalysisPreset,
  type ContentClassification,
  type LLMProvider,
  type TranscriptSegment as AnalyzerTranscriptSegment
} from './content-analyzer'
import iconv from 'iconv-lite'

const store = new Store()

// ===== 类型 =====

export interface AnalysisRequest {
  id: string
  url: string
  savePath: string
  sessData?: string
  strategy?: 'subtitle-first' | 'asr-only' | 'ocr'
  model?: 'medium' | 'large-v3'
  language?: string
  llmProvider?: LLMProvider
  llmModel?: string
  llmApiKey?: string
  llmApiBase?: string
  analysisTypes?: AnalysisType[]
  analysisPreset?: AnalysisPreset
}

export type AnalysisStage =
  | 'checking-deps'
  | 'fetching-info'
  | 'downloading'
  | 'extracting-audio'
  | 'transcribing'
  | 'cross-validating'
  | 'analyzing'
  | 'done'

export interface AnalysisProgress {
  id: string
  stage: AnalysisStage
  percent: number
  overallPercent: number
  message: string
  /** 已耗时 (秒) */
  elapsed: number
}

export interface AnalysisResult {
  id: string
  title: string
  url: string
  subtitleSource: 'external' | 'asr' | 'ocr' | 'none'
  transcript: TranscriberResult
  /** 输出文件路径 */
  outputFiles: {
    txt: string
    json: string
    readme?: string
    analysisMd?: string
    promptMd?: string
  }
  /** 文件保存目录 */
  savePath: string
  summary?: AnalysisResults['summary']
  keyPoints?: AnalysisResults['keyPoints']
  mindMap?: AnalysisResults['mindMap']
  llmProvider?: LLMProvider
  llmModel?: string
  analysisPreset?: AnalysisPreset
  classification?: ContentClassification
  error?: string
}

export interface ExistingTranscriptCandidate {
  path: string
  name: string
  kind: 'transcript' | 'readme'
  recommended: boolean
}

export interface ExistingAnalysisRequest {
  id: string
  folderPath: string
  transcriptPath?: string
  llmProvider?: LLMProvider
  llmModel?: string
  llmApiKey?: string
  llmApiBase?: string
  analysisTypes?: AnalysisType[]
  language?: string
  analysisPreset?: AnalysisPreset
}

// ===== 进程追踪 (修复取消bug: 之前只追踪yt-dlp, 漏了ffmpeg和whisper) =====

const activeTasks = new Map<string, Set<ChildProcess>>()
const completedAnalyses = new Map<string, { result: AnalysisResult; request: AnalysisRequest }>()

function registerProcess(id: string, proc: ChildProcess) {
  let set = activeTasks.get(id)
  if (!set) {
    set = new Set()
    activeTasks.set(id, set)
  }
  set.add(proc)
  proc.on('close', () => set?.delete(proc))
}

function getProcessSet(id: string): Set<ChildProcess> {
  let set = activeTasks.get(id)
  if (!set) {
    set = new Set()
    activeTasks.set(id, set)
  }
  return set
}

function getStoredApiKey(provider: LLMProvider): string {
  return String(store.get(`llm.apiKeys.${provider}`) || '')
}

function setStoredApiKey(provider: LLMProvider, apiKey: string) {
  if (!apiKey.trim()) {
    store.delete(`llm.apiKeys.${provider}`)
    return
  }
  store.set(`llm.apiKeys.${provider}`, apiKey.trim())
}

function killAllProcesses(id: string) {
  const set = activeTasks.get(id)
  if (!set) return
  for (const child of set) {
    try {
      if (child?.pid) {
        if (process.platform === 'win32') {
          spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
        } else {
          try { process.kill(-child.pid, 'SIGTERM') } catch {
            try { child.kill('SIGTERM') } catch {}
          }
        }
      }
    } catch {}
  }
  set.clear()
  activeTasks.delete(id)
}

function decodeOutput(buf: Buffer): string {
  if (process.platform === 'win32') return iconv.decode(buf, 'cp936')
  return buf.toString('utf8')
}

function sendProgress(mainWindow: BrowserWindow, progress: AnalysisProgress) {
  mainWindow.webContents.send('analysis-progress', progress)
}

function safeFilename(title: string): string {
  return title.replace(/[<>:"/\\|?*]/g, '_').trim().slice(0, 80)
}

function nowUTC8(): string {
  const d = new Date()
  // UTC+8
  const offset = 8 * 60
  const local = new Date(d.getTime() + (offset - d.getTimezoneOffset()) * 60000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())} ${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}`
}

async function saveAnalysisFiles(
  savePath: string,
  safeTitle: string,
  videoInfo: { title: string; url: string },
  subtitleSource: string,
  model: string,
  language: string,
  transcript: TranscriberResult
): Promise<{ txt: string; json: string; readme: string; articleDir: string }> {
  const articleDir = join(savePath, 'article', safeTitle)
  await fs.mkdir(articleDir, { recursive: true })

  const txtPath = join(articleDir, 'transcript.txt')
  const jsonPath = join(articleDir, 'transcript.json')
  const readmePath = join(articleDir, 'README.md')

  // 纯文本
  await fs.writeFile(txtPath, transcript.fullText, 'utf8')

  // JSON
  await fs.writeFile(jsonPath, JSON.stringify({
    title: videoInfo.title,
    url: videoInfo.url,
    analyzedAt: nowUTC8(),
    subtitleSource,
    model: `ggml-${model}.bin`,
    language,
    processingTime: transcript.processingTime,
    segmentCount: transcript.segments.length,
    fullText: transcript.fullText,
    segments: transcript.segments.map(s => ({ start: s.start, end: s.end, text: s.text }))
  }, null, 2), 'utf8')

  // README.md
  const duration = transcript.segments.length > 0
    ? formatDuration(transcript.segments[transcript.segments.length - 1].end)
    : '0:00'

  const readmeContent = [
    `# ${videoInfo.title}`,
    '',
    `- **URL**: ${videoInfo.url}`,
    `- **分析时间**: ${nowUTC8()} (UTC+8)`,
    `- **字幕来源**: ${subtitleSource === 'external' ? '外挂字幕' : 'GPU 语音识别 (ASR)'}`,
    `- **模型**: ggml-${model}.bin (Vulkan GPU)`,
    `- **语言**: ${language}`,
    `- **时长**: ${duration}`,
    `- **分段数**: ${transcript.segments.length}`,
    `- **处理耗时**: ${(transcript.processingTime / 1000).toFixed(0)}s`,
    '',
    '## 转录文本',
    '',
    transcript.fullText,
    ''
  ].join('\n')

  await fs.writeFile(readmePath, readmeContent, 'utf8')

  return { txt: txtPath, json: jsonPath, readme: readmePath, articleDir }
}

function formatDuration(ms: number): string {
  const total = Math.floor(ms / 1000)
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

// ===== 流水线核心 =====

function toAnalyzerSegments(transcript: TranscriberResult): AnalyzerTranscriptSegment[] {
  return transcript.segments.map((segment) => ({
    start: segment.start,
    end: segment.end,
    text: segment.text
  }))
}

function formatSeconds(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

function appendMindMapLines(lines: string[], node: NonNullable<AnalysisResults['mindMap']>, depth: number) {
  const indent = '  '.repeat(depth)
  lines.push(`${indent}- ${node.topic}`)
  for (const child of node.children || []) appendMindMapLines(lines, child, depth + 1)
}

async function appendAnalysisToReadme(readmePath: string, results: AnalysisResults) {
  const lines: string[] = []

  if (results.summary) {
    lines.push('', '## AI 摘要', '', results.summary.text.trim(), '')
  }

  if (results.keyPoints?.length) {
    lines.push('', '## 关键要点', '')
    for (const point of results.keyPoints) {
      lines.push(`- **[${formatSeconds(point.timestamp)}] ${point.title}**: ${point.description}`)
    }
    lines.push('')
  }

  if (results.mindMap) {
    lines.push('', '## 思维导图', '')
    appendMindMapLines(lines, results.mindMap, 0)
    lines.push('')
  }

  if (lines.length) await fs.appendFile(readmePath, lines.join('\n'), 'utf8')
}

async function mergeAnalysisIntoJson(
  jsonPath: string,
  results: AnalysisResults,
  provider: LLMProvider,
  llmModel: string,
  extra?: { analysisPreset?: AnalysisPreset; classification?: ContentClassification }
) {
  try {
    const raw = await fs.readFile(jsonPath, 'utf8')
    const json = JSON.parse(raw)
    json.llmProvider = provider
    json.llmModel = llmModel
    json.analysis = results
    if (extra?.analysisPreset) json.analysisPreset = extra.analysisPreset
    if (extra?.classification) json.classification = extra.classification
    await fs.writeFile(jsonPath, JSON.stringify(json, null, 2), 'utf8')
  } catch {}
}

async function writeReadableAnalysisFiles(
  articleDir: string,
  title: string,
  llm: { article: string; prompt: string; provider: LLMProvider; model: string }
): Promise<{ analysisMd: string; promptMd: string }> {
  const analysisMd = join(articleDir, 'analysis.md')
  const promptMd = join(articleDir, 'analysis.prompt.md')
  const header = [
    `# ${title}｜视频内容分析`,
    '',
    `- **LLM Provider**: ${llm.provider}`,
    `- **LLM Model**: ${llm.model}`,
    `- **生成时间**: ${nowUTC8()} (UTC+8)`,
    '',
    '---',
    ''
  ].join('\n')

  await fs.writeFile(analysisMd, `${header}${llm.article.trim()}\n`, 'utf8')
  await fs.writeFile(promptMd, llm.prompt, 'utf8')
  return { analysisMd, promptMd }
}

async function runLlmAnalysis(
  request: AnalysisRequest,
  transcript: TranscriberResult,
  processSet: Set<ChildProcess>,
  emitProgress: (stage: AnalysisStage, percent: number, overallPercent: number, message: string) => void
): Promise<{ results: AnalysisResults; provider: LLMProvider; model: string; article: string; prompt: string; preset: AnalysisPreset; classification?: ContentClassification }> {
  const analysisTypes = request.analysisTypes || ['summary', 'key-points', 'mind-map']
  const provider = request.llmProvider || 'deepseek'
  const llmModel = request.llmModel || getDefaultModel(provider)

  if (!analysisTypes.length) return { results: {}, provider, model: llmModel, article: '', prompt: '', preset: 'generic' as AnalysisPreset }

  const totalTypes = analysisTypes.length
  let completedTypes = 0
  emitProgress('analyzing', 0, 90, `开始 LLM 内容分析 (${analysisTypes.join(', ')})...`)

  const results = await analyzeTranscript(
    transcript.fullText,
    toAnalyzerSegments(transcript),
    analysisTypes,
    {
      provider,
      model: llmModel,
      apiKey: request.llmApiKey || getStoredApiKey(provider),
      apiBase: request.llmApiBase,
      language: request.language || 'auto',
      processSet,
      onProgress: (message) => {
        // Track completed types by message pattern
        if (message.includes('完成') || message.includes('complete')) completedTypes += 0.5
        const pct = Math.min(90, Math.round((completedTypes / totalTypes) * 100))
        emitProgress('analyzing', pct, 90 + Math.round(pct * 0.08), message)
      }
    }
  )

  emitProgress('analyzing', 100, 98, 'LLM 内容分析完成')
  const article = await generateAnalysisArticle(
    request.url || '已有转录文本',
    transcript.fullText,
    toAnalyzerSegments(transcript),
    {
      provider,
      model: llmModel,
      apiKey: request.llmApiKey || getStoredApiKey(provider),
      apiBase: request.llmApiBase,
      language: request.language || 'auto',
      processSet,
      onProgress: (message) => emitProgress('analyzing', 95, 97.5, message)
    },
    request.analysisPreset ?? 'auto'
  )

  return { results, provider, model: llmModel, article: article.markdown, prompt: article.prompt, preset: article.preset, classification: article.classification }
}

function plainTextToTranscript(text: string): TranscriberResult {
  const blocks = text
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)

  const source = blocks.length ? blocks : text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const segments = source.map((line, index) => ({
    start: index * 1000,
    end: (index + 1) * 1000,
    text: line
  }))

  return {
    fullText: text.trim(),
    segments,
    language: 'zh',
    processingTime: 0
  }
}

function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s\r\n\t]+/g, '')
    .replace(/[.,!?;:'"`~，。！？；：""''、（）()\[\]{}<>《》【】|\/\\_-]/g, '')
}

function charSetSimilarity(a: string, b: string): number {
  const left = new Set([...a])
  const right = new Set([...b])
  if (!left.size || !right.size) return 0
  let intersection = 0
  for (const ch of left) { if (right.has(ch)) intersection += 1 }
  return intersection / (left.size + right.size - intersection)
}

function editSimilarity(a: string, b: string): number {
  if (!a && !b) return 1
  if (!a || !b) return 0
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  const curr = new Array<number>(b.length + 1)
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i
    for (let j = 1; j <= b.length; j++) {
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j]
  }
  return 1 - prev[b.length] / Math.max(a.length, b.length)
}

function textSimilarity(a: string, b: string): number {
  const left = normalizeForMatch(a)
  const right = normalizeForMatch(b)
  if (!left || !right) return 0
  if (left.includes(right) || right.includes(left)) {
    return Math.min(left.length, right.length) / Math.max(left.length, right.length)
  }
  return Math.max(charSetSimilarity(left, right), editSimilarity(left, right))
}

function shouldUseOcrCorrection(asrText: string, ocrText: string, score: number): boolean {
  if (score < 0.78) return false
  const asr = normalizeForMatch(asrText)
  const ocr = normalizeForMatch(ocrText)
  if (!asr || !ocr) return false
  const lengthRatio = ocr.length / asr.length
  if (lengthRatio < 0.6 || lengthRatio > 1.6) return false
  if (/https?:\/\/|www\.|\.com|\.cn|\.jp|\.html|\.co\.jp/i.test(ocrText)) return false
  if (/^@\w+/.test(ocrText.trim())) return false
  const badChars = (ocrText.match(/�|锟/g) || []).length
  if (badChars > ocrText.length * 0.1) return false
  const asrUsefulChars = (asrText.match(/[\p{Script=Han}\p{Letter}\p{Number}]/gu) || []).length
  const ocrUsefulChars = (ocrText.match(/[\p{Script=Han}\p{Letter}\p{Number}]/gu) || []).length
  return ocrUsefulChars >= asrUsefulChars
}

function crossValidate(
  asrSegments: TranscriberResult['segments'],
  ocrSegments: OcrSegment[],
  threshold = 0.5,
  windowMs = 3000
): {
  merged: TranscriberResult['segments']
  stats: { asrOnly: number; ocrOnly: number; matched: number; corrected: number }
} {
  const merged = asrSegments.map((segment) => ({ ...segment }))
  const matchedAsrIndexes = new Set<number>()
  let matched = 0; let ocrOnly = 0; let corrected = 0

  for (const ocr of ocrSegments) {
    const candidates = asrSegments
      .map((segment, index) => ({ segment, index }))
      .filter(({ segment }) => segment.end >= ocr.start - windowMs && segment.start <= ocr.end + windowMs)
    const windowText = candidates.map(({ segment }) => segment.text).join('')
    let bestScore = textSimilarity(ocr.text, windowText)
    let bestIndex = candidates[0]?.index ?? -1
    for (const candidate of candidates) {
      const score = textSimilarity(ocr.text, candidate.segment.text)
      if (score > bestScore) { bestScore = score; bestIndex = candidate.index }
    }
    if (bestScore >= threshold && bestIndex >= 0) {
      matched += 1
      matchedAsrIndexes.add(bestIndex)
      if (shouldUseOcrCorrection(merged[bestIndex].text, ocr.text, bestScore)) {
        merged[bestIndex].text = ocr.text.trim()
        corrected += 1
      }
    } else { ocrOnly += 1 }
  }
  return {
    merged,
    stats: {
      asrOnly: Math.max(0, asrSegments.length - matchedAsrIndexes.size),
      ocrOnly, matched, corrected
    }
  }
}

function isReadableTranscript(transcript: TranscriberResult): boolean {
  const text = transcript.fullText.replace(/\s+/g, '')
  if (text.length < 20 || transcript.segments.length === 0) return false
  const badChars = (text.match(/锟絻Error/g) || []).length
  if (badChars > text.length * 0.08) return false
  const readableChars = (text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Letter}\p{Number}]/gu) || []).length
  if (readableChars / text.length < 0.55) return false
  const avgSegmentLength = text.length / Math.max(transcript.segments.length, 1)
  return avgSegmentLength >= 2
}

function extractTranscriptFromReadme(content: string): string {
  const lines = content.replace(/\r/g, '').split('\n')
  const start = lines.findIndex((line) => /^##\s+/.test(line) && /(转录文本|Transcript|transcript)/i.test(line))
  if (start < 0) return ''

  const collected: string[] = []
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) break
    collected.push(lines[i])
  }
  return collected.join('\n').trim()
}

async function readExistingTranscript(candidatePath: string): Promise<string> {
  const content = await fs.readFile(candidatePath, 'utf8')
  if (basename(candidatePath).toLowerCase() === 'readme.md') {
    const transcript = extractTranscriptFromReadme(content)
    if (!transcript) throw new Error('README.md 中没有找到“## 转录文本”或“## Transcript”段落。')
    return transcript
  }
  return content.trim()
}

async function listExistingTranscriptCandidates(folderPath: string): Promise<ExistingTranscriptCandidate[]> {
  const entries = await fs.readdir(folderPath, { withFileTypes: true })
  const files = new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name))
  const exactNames: Array<{ name: string; kind: 'transcript' | 'readme' }> = [
    { name: 'transcript.txt', kind: 'transcript' },
    { name: 'transcript.md', kind: 'transcript' },
    { name: 'transcript.llm.md', kind: 'transcript' },
    { name: 'README.md', kind: 'readme' }
  ]

  return exactNames
    .filter((item) => files.has(item.name))
    .map((item, index) => ({
      path: join(folderPath, item.name),
      name: item.name,
      kind: item.kind,
      recommended: index === 0
    }))
}

async function runExistingFolderAnalysis(
  mainWindow: BrowserWindow,
  request: ExistingAnalysisRequest
): Promise<AnalysisResult> {
  const pipelineStart = Date.now()
  const emitProgress = (stage: AnalysisStage, percent: number, overallPercent: number, message: string) => {
    const elapsed = Math.floor((Date.now() - pipelineStart) / 1000)
    sendProgress(mainWindow, { id: request.id, stage, percent, overallPercent, message, elapsed })
  }

  emitProgress('fetching-info', 0, 5, '正在读取已有转录文件...')
  const candidates = await listExistingTranscriptCandidates(request.folderPath)
  if (!candidates.length) {
    throw new Error('未找到候选转录文件。请使用 transcript.txt、transcript.md、transcript.llm.md，或包含“## 转录文本”的 README.md。')
  }

  const selected = request.transcriptPath
    ? candidates.find((candidate) => candidate.path === request.transcriptPath)
    : candidates[0]
  if (!selected) throw new Error('选择的转录文件不在当前文件夹候选列表中。')

  const text = await readExistingTranscript(selected.path)
  if (!text.trim()) throw new Error('转录文本为空，无法分析。')

  const transcript = plainTextToTranscript(text)
  const title = basename(request.folderPath)
  const readmePath = join(request.folderPath, 'README.md')
  const txtPath = selected.path
  const jsonPath = join(request.folderPath, 'analysis.json')

  emitProgress('fetching-info', 100, 10, `已读取 ${selected.name}`)
  const analysisRequest: AnalysisRequest = {
    id: request.id,
    url: '',
    savePath: request.folderPath,
    language: request.language || 'zh',
    llmProvider: request.llmProvider,
    llmModel: request.llmModel,
    llmApiKey: request.llmApiKey,
    llmApiBase: request.llmApiBase,
    analysisTypes: request.analysisTypes
  }
  const llm = await runLlmAnalysis(analysisRequest, transcript, getProcessSet(request.id), emitProgress)

  try {
    await fs.access(readmePath)
  } catch {
    await fs.writeFile(readmePath, [`# ${title}`, '', '## 转录文本', '', text, ''].join('\n'), 'utf8')
  }

  await appendAnalysisToReadme(readmePath, llm.results)
  const readableFiles = await writeReadableAnalysisFiles(request.folderPath, title, llm)
  await fs.writeFile(jsonPath, JSON.stringify({
    title,
    sourceFile: selected.path,
    analyzedAt: nowUTC8(),
    llmProvider: llm.provider,
    llmModel: llm.model,
    analysis: llm.results,
    ...(llm.preset ? { analysisPreset: llm.preset } : {}),
    ...(llm.classification ? { classification: llm.classification } : {})
  }, null, 2), 'utf8')

  killAllProcesses(request.id)
  emitProgress('done', 100, 100, `已有文本分析完成，已追加到 ${readmePath}`)

  return {
    id: request.id,
    title,
    url: '',
    subtitleSource: 'none',
    transcript,
    outputFiles: { txt: txtPath, json: jsonPath, readme: readmePath, ...readableFiles },
    savePath: request.folderPath,
    summary: llm.results.summary,
    keyPoints: llm.results.keyPoints,
    mindMap: llm.results.mindMap,
    llmProvider: llm.provider,
    llmModel: llm.model,
    analysisPreset: llm.preset,
    classification: llm.classification
  }
}

async function runPipeline(
  mainWindow: BrowserWindow,
  request: AnalysisRequest
): Promise<AnalysisResult> {
  const { id, url, savePath, sessData, strategy = 'subtitle-first', model = 'medium', language = 'auto' } = request
  const pipelineStart = Date.now()

  const emitProgress = (stage: AnalysisStage, percent: number, overallPercent: number, message: string) => {
    const elapsed = Math.floor((Date.now() - pipelineStart) / 1000)
    sendProgress(mainWindow, { id, stage, percent, overallPercent, message, elapsed })
  }

  // === Step 1: 获取视频信息 ===
  emitProgress('fetching-info', 0, 5, '正在获取视频信息...')

  const cookieFilePath = createCookieFile(sessData || '')

  const videoInfo = await new Promise<{ title: string; duration: number; hasSubtitles: boolean }>((resolve, reject) => {
    const ytDlpPath = getBinaryPath('yt-dlp')
    const args = [
      url, '-J', '--no-playlist', '--rm-cache-dir',
      ...getProxyArgs(url)
    ]
    if (cookieFilePath) args.push('--cookies', cookieFilePath)

    const proc = spawn(ytDlpPath, args)
    registerProcess(id, proc)

    let stdout = ''
    let stderr = ''

    proc.stdout?.on('data', (data: Buffer) => { stdout += data.toString() })
    proc.stderr?.on('data', (data: Buffer) => { stderr += data.toString() })

    proc.on('close', (code) => {
      cleanupCookieFile(cookieFilePath)
      if (code !== 0) return reject(new Error(`获取视频信息失败: ${stderr.slice(-200)}`))

      try {
        const json = JSON.parse(stdout)
        const hasSubtitles = !!(
          (json.subtitles && Object.keys(json.subtitles).length > 0) ||
          (json.automatic_captions && Object.keys(json.automatic_captions).length > 0)
        )
        resolve({
          title: json.title || '未知标题',
          duration: json.duration || 0,
          hasSubtitles
        })
      } catch (e) {
        reject(new Error(`解析视频信息失败: ${(e as Error).message}`))
      }
    })

    proc.on('error', (err) => reject(new Error(`无法启动 yt-dlp: ${err.message}`)))
  })

  const durationMin = Math.round((videoInfo.duration || 0) / 60)
  emitProgress('fetching-info', 100, 10, `视频: ${videoInfo.title} · ${durationMin}min · ${videoInfo.hasSubtitles ? '有字幕' : '无字幕'}`)

  // === Step 2: 尝试外挂字幕 (subtitle-first 策略) ===
  let subtitleResult: TranscriberResult | null = null

  if (strategy === 'subtitle-first' && videoInfo.hasSubtitles) {
    emitProgress('downloading', 0, 15, '检测到外挂字幕, 尝试下载...')

    try {
      subtitleResult = await downloadAndParseSubtitles(id, url, savePath, sessData, (msg) => {
        emitProgress('downloading', 50, 20, msg)
      })

      if (subtitleResult && isReadableTranscript(subtitleResult)) {
        killAllProcesses(id)

        const safeTitle = safeFilename(videoInfo.title)
        const files = await saveAnalysisFiles(savePath, safeTitle,
          { title: videoInfo.title, url },
          'external', model, language, subtitleResult)
        const llm = await runLlmAnalysis(request, subtitleResult, getProcessSet(id), emitProgress)
        await appendAnalysisToReadme(files.readme, llm.results)
        await mergeAnalysisIntoJson(files.json, llm.results, llm.provider, llm.model, { analysisPreset: llm.preset, classification: llm.classification })
        const readableFiles = await writeReadableAnalysisFiles(files.articleDir, videoInfo.title, llm)

        emitProgress('done', 100, 100, `字幕分析完成, 已保存到 article/${safeTitle}/`)
        return {
          id, title: videoInfo.title, url,
          subtitleSource: 'external',
          transcript: subtitleResult,
          outputFiles: { txt: files.txt, json: files.json, readme: files.readme, ...readableFiles },
          savePath: files.articleDir,
          summary: llm.results.summary,
          keyPoints: llm.results.keyPoints,
          mindMap: llm.results.mindMap,
          llmProvider: llm.provider,
          llmModel: llm.model,
          analysisPreset: llm.preset,
          classification: llm.classification
        }
      }
      emitProgress('downloading', 100, 25, '外挂字幕不可用, 切换到 ASR 模式')
    } catch {
      emitProgress('downloading', 100, 25, '字幕下载失败, 切换到 ASR 模式')
    }
  }

  // === OCR cross-validation branch ===
  if (strategy === 'ocr') {
    const procSet = getProcessSet(id)
    const audioPath = join(savePath, `analysis_${id}_audio.wav`)

    // Step 3: Download video
    emitProgress('downloading', 0, 25, '正在下载视频 (OCR模式)...')
    const videoFilenameOcr = `analysis_${id}_video`
    const videoPathOcr = join(savePath, `${videoFilenameOcr}.mp4`)

    await new Promise<void>((resolve, reject) => {
      const ytDlpPath = getBinaryPath('yt-dlp')
      const ffmpegPath = getBinaryPath('ffmpeg')
      const cookieFile = createCookieFile(sessData || '')
      const args = [
        url, '--ffmpeg-location', ffmpegPath,
        '-o', join(savePath, `${videoFilenameOcr}.%(ext)s`),
        '-f', 'bestvideo[height<=720]+bestaudio/best[height<=720]',
        '--merge-output-format', 'mp4',
        '--no-playlist', '--rm-cache-dir', '--newline',
        ...getProxyArgs(url)
      ]
      if (cookieFile) args.push('--cookies', cookieFile)
      const proc = spawn(ytDlpPath, args)
      registerProcess(id, proc)
      proc.stderr?.on('data', (data: Buffer) => {
        const text = decodeOutput(data)
        const pMatch = text.match(/(\d{1,3}(?:\.\d+)?)%/)
        if (pMatch) {
          const pct = parseFloat(pMatch[1])
          emitProgress('downloading', pct, 25 + (pct * 0.3), `下载中 ${pct.toFixed(1)}%`)
        }
      })
      proc.on('close', (code) => {
        cleanupCookieFile(cookieFile)
        code === 0 ? resolve() : reject(new Error(`视频下载失败, 退出码: ${code}`))
      })
      proc.on('error', (err) => reject(new Error(`无法启动 yt-dlp: ${err.message}`)))
    })
    emitProgress('downloading', 100, 55, '视频下载完成 (OCR模式)')

    // Run ASR and OCR in parallel
    emitProgress('extracting-audio', 0, 55, 'Starting ASR and OCR cross-validation...')

    const asrPromise = (async () => {
      const videoDurationSecOcr = videoInfo.duration || 0
      emitProgress('extracting-audio', 0, 55, `Extracting audio for ASR... (video ~${Math.round(videoDurationSecOcr)}s)`)
      await extractAudio(videoPathOcr, audioPath, {
        onProgress: (progress) => {
          const pct = videoDurationSecOcr > 0
            ? Math.round(Math.min(99, (progress.elapsed / videoDurationSecOcr) * 100))
            : Math.min(99, Math.round((progress.elapsed / 60) * 100))
          emitProgress('extracting-audio', pct, 55 + Math.round(pct * 0.1), `Extracting audio... ${progress.elapsed}s / ~${Math.round(videoDurationSecOcr)}s`)
        },
        processSet: procSet
      })
      emitProgress('extracting-audio', 100, 65, 'Audio extraction complete')
      emitProgress('transcribing', 0, 65, 'Running ASR for OCR verification...')
      const result = await transcribe(audioPath, {
        model, language,
        onProgress: (pct, msg) => emitProgress('transcribing', pct, 65 + (pct * 0.2), msg),
        processSet: procSet
      })
      emitProgress('transcribing', 100, 85, `ASR complete: ${result.segments.length} segments`)
      return result
    })()

    const ocrPromise = extractSubtitles({
      videoPath: videoPathOcr, language, fps: 1, cropBottom: true,
      onProgress: (status) => {
        emitProgress('extracting-audio', status.phasePercent, 55 + Math.round(status.phasePercent * 0.25), status.message)
      },
      processSet: procSet
    })

    const [asrResult, ocrResult] = await Promise.all([asrPromise, ocrPromise])

    emitProgress('cross-validating', 0, 85, 'Cross-validating ASR and OCR segments...')
    const validation = crossValidate(asrResult.segments, ocrResult.segments)
    const transcriptOcr: TranscriberResult = {
      fullText: validation.merged.map((segment) => segment.text).join(' '),
      segments: validation.merged,
      language: asrResult.language || language,
      processingTime: asrResult.processingTime + ocrResult.processingTime
    }
    emitProgress('cross-validating', 100, 90,
      `Cross-validation complete: matched ${validation.stats.matched}, corrected ${validation.stats.corrected}, discarded OCR-only ${validation.stats.ocrOnly}, kept ASR-only ${validation.stats.asrOnly}`)

    const safeTitleOcr = safeFilename(videoInfo.title)
    const filesOcr = await saveAnalysisFiles(savePath, safeTitleOcr,
      { title: videoInfo.title, url }, 'ocr', model, language, transcriptOcr)
    const llmOcr = await runLlmAnalysis(request, transcriptOcr, procSet, emitProgress)
    await appendAnalysisToReadme(filesOcr.readme, llmOcr.results)
    await mergeAnalysisIntoJson(filesOcr.json, llmOcr.results, llmOcr.provider, llmOcr.model, { analysisPreset: llmOcr.preset, classification: llmOcr.classification })
    const readableFilesOcr = await writeReadableAnalysisFiles(filesOcr.articleDir, videoInfo.title, llmOcr)

    try { await fs.unlink(videoPathOcr) } catch {}
    try { await fs.unlink(audioPath) } catch {}
    const entriesOcr = await fs.readdir(savePath).catch(() => [])
    for (const entry of entriesOcr) {
      if (entry.startsWith(`analysis_${id}_`)) {
        try { await fs.unlink(join(savePath, entry)) } catch {}
      }
    }

    killAllProcesses(id)
    emitProgress('done', 100, 100, `OCR cross-validated analysis complete, saved to article/${safeTitleOcr}/`)

    return {
      id, title: videoInfo.title, url,
      subtitleSource: 'ocr',
      transcript: transcriptOcr,
      outputFiles: { txt: filesOcr.txt, json: filesOcr.json, readme: filesOcr.readme, ...readableFilesOcr },
      savePath: filesOcr.articleDir,
      summary: llmOcr.results.summary,
      keyPoints: llmOcr.results.keyPoints,
      mindMap: llmOcr.results.mindMap,
      llmProvider: llmOcr.provider,
      llmModel: llmOcr.model,
      analysisPreset: llmOcr.preset,
      classification: llmOcr.classification
    }
  }

  // === Step 3: 下载视频 ===
  emitProgress('downloading', 0, 25, '正在下载视频...')

  const videoFilename = `analysis_${id}_video`
  const videoPath = join(savePath, `${videoFilename}.mp4`)

  await new Promise<void>((resolve, reject) => {
    const ytDlpPath = getBinaryPath('yt-dlp')
    const ffmpegPath = getBinaryPath('ffmpeg')
    const cookieFile = createCookieFile(sessData || '')

    const args = [
      url, '--ffmpeg-location', ffmpegPath,
      '-o', join(savePath, `${videoFilename}.%(ext)s`),
      '-f', 'bestvideo[height<=720]+bestaudio/best[height<=720]',
      '--merge-output-format', 'mp4',
      '--no-playlist', '--rm-cache-dir', '--newline',
      ...getProxyArgs(url)
    ]
    if (cookieFile) args.push('--cookies', cookieFile)

    const proc = spawn(ytDlpPath, args)
    registerProcess(id, proc)

    let stderr = ''
    proc.stderr?.on('data', (data: Buffer) => {
      const text = decodeOutput(data)
      stderr += text.slice(-500)  // keep last 500 chars for error context
      const pMatch = text.match(/(\d{1,3}(?:\.\d+)?)%/)
      if (pMatch) {
        const pct = parseFloat(pMatch[1])
        emitProgress('downloading', pct, 25 + (pct * 0.3), `下载中 ${pct.toFixed(1)}%`)
      }
    })

    proc.on('close', (code) => {
      cleanupCookieFile(cookieFile)
      code === 0 ? resolve() : reject(new Error(`视频下载失败, 退出码: ${code}${stderr ? ', ' + stderr.slice(-300) : ''}`))
    })

    proc.on('error', (err) => reject(new Error(`无法启动 yt-dlp: ${err.message}`)))
  })

  emitProgress('downloading', 100, 55, '视频下载完成')

  // === Step 4: 提取音频 ===
  const audioPath = join(savePath, `analysis_${id}_audio.wav`)

  // 获取进程集合，传给 extractAudio 以便追踪
  const procSet = getProcessSet(id)
  const videoDurationSec = videoInfo.duration || 0

  emitProgress('extracting-audio', 0, 55, `正在提取音频... (视频时长 ${Math.round(videoDurationSec)}s)`)

  await extractAudio(videoPath, audioPath, {
    onProgress: (progress) => {
      const pct = videoDurationSec > 0
        ? Math.round(Math.min(99, (progress.elapsed / videoDurationSec) * 100))
        : Math.min(99, Math.round((progress.elapsed / 60) * 100))
      emitProgress('extracting-audio', pct, 55 + Math.round(pct * 0.1), `提取音频中... ${progress.elapsed}s / ~${Math.round(videoDurationSec)}s`)
    },
    processSet: procSet  // ← 关键: 让 extractAudio 的 ffmpeg 进程可被取消
  })

  emitProgress('extracting-audio', 100, 65, '音频提取完成')

  // === Step 5: ASR 转录 ===
  emitProgress('transcribing', 0, 65, '正在语音识别...')

  const transcript = await transcribe(audioPath, {
    model,
    language,
    onProgress: (pct, msg) => {
      emitProgress('transcribing', pct, 65 + (pct * 0.25), msg)
    },
    processSet: procSet  // ← 关键: 让 transcribe 的 whisper-cli 进程可被取消
  })

  emitProgress('transcribing', 100, 90, `转录完成, ${transcript.segments.length} 个片段`)

  // === 保存到 article/ ===
  const safeTitle = safeFilename(videoInfo.title)
  const files = await saveAnalysisFiles(savePath, safeTitle,
    { title: videoInfo.title, url },
    'asr', model, language, transcript)
  const llm = await runLlmAnalysis(request, transcript, procSet, emitProgress)
  await appendAnalysisToReadme(files.readme, llm.results)
  await mergeAnalysisIntoJson(files.json, llm.results, llm.provider, llm.model, { analysisPreset: llm.preset, classification: llm.classification })
  const readableFiles = await writeReadableAnalysisFiles(files.articleDir, videoInfo.title, llm)

  // === 清理临时文件 ===
  try { await fs.unlink(videoPath) } catch {}
  try { await fs.unlink(audioPath) } catch {}
  const entries = await fs.readdir(savePath).catch(() => [])
  for (const entry of entries) {
    if (entry.startsWith(`analysis_${id}_`)) {
      try { await fs.unlink(join(savePath, entry)) } catch {}
    }
  }

  // === 完成 ===
  killAllProcesses(id)
  emitProgress('done', 100, 100, `分析完成, 已保存到 article/${safeTitle}/`)

  return {
    id, title: videoInfo.title, url,
    subtitleSource: 'asr',
    transcript,
    outputFiles: { txt: files.txt, json: files.json, readme: files.readme, ...readableFiles },
    savePath: files.articleDir,
    summary: llm.results.summary,
    keyPoints: llm.results.keyPoints,
    mindMap: llm.results.mindMap,
    llmProvider: llm.provider,
    llmModel: llm.model,
    analysisPreset: llm.preset,
    classification: llm.classification
  }
}

// ===== 字幕下载与解析 =====

async function downloadAndParseSubtitles(
  id: string, url: string, savePath: string, sessData: string | undefined,
  onMsg: (msg: string) => void
): Promise<TranscriberResult | null> {
  const ytDlpPath = getBinaryPath('yt-dlp')
  const cookieFile = createCookieFile(sessData || '')

  return new Promise((resolve) => {
    const subFile = join(savePath, `analysis_${id}_sub`)

    const args = [
      url, '--write-subs', '--write-auto-subs',
      '--sub-langs', 'zh.*,en.*',
      '--sub-format', 'vtt/best',
      '--skip-download',
      '-o', subFile,
      '--no-playlist', '--rm-cache-dir',
      ...getProxyArgs(url)
    ]
    if (cookieFile) args.push('--cookies', cookieFile)

    const proc = spawn(ytDlpPath, args)
    registerProcess(id, proc)

    proc.on('close', async (code) => {
      cleanupCookieFile(cookieFile)
      if (code !== 0) return resolve(null)

      const entries = await fs.readdir(savePath).catch(() => [])
      const subtitleFiles = entries.filter(f =>
        f.startsWith(`analysis_${id}_sub`) && /\.(vtt|srt)$/i.test(f)
      )

      if (!subtitleFiles.length) return resolve(null)

      const subPath = join(savePath, subtitleFiles[0])
      onMsg(`找到字幕: ${subtitleFiles[0]}`)

      const buf = await fs.readFile(subPath)
      const content = buf.toString('utf8').replace(/^﻿/, '')

      const segments: Array<{ start: number; end: number; text: string }> = []
      const blocks = content
        .replace(/^﻿?WEBVTT[^\n]*(?:\n|$)/, '')
        .replace(/\r/g, '')
        .split(/\n{2,}/)
        .map(b => b.trim())
        .filter(Boolean)

      for (const block of blocks) {
        const lines = block.split('\n').map(l => l.trim()).filter(Boolean).filter(l => !/^NOTE\b/.test(l))
        const timeIdx = lines.findIndex(l => l.includes('-->'))
        if (timeIdx < 0) continue

        const [startRaw, endRaw] = lines[timeIdx].split('-->').map(p => p.trim().split(/\s+/)[0])
        const text = lines.slice(timeIdx + 1).join(' ').replace(/<[^>]+>/g, '').trim()
        if (!text) continue

        const parseVttTime = (v: string) => {
          const m = v.trim().replace(',', '.').match(/(?:(\d+):)?(\d{2}):(\d{2})(?:\.(\d{1,3}))?/)
          if (!m) return 0
          return (Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000 + Number((m[4] || '0').padEnd(3, '0').slice(0, 3))
        }

        segments.push({
          start: parseVttTime(startRaw),
          end: parseVttTime(endRaw),
          text
        })
      }

      try { await fs.unlink(subPath) } catch {}

      if (!segments.length) return resolve(null)

      resolve({
        fullText: segments.map(s => s.text).join(' '),
        segments,
        language: 'zh',
        processingTime: 0
      })
    })

    proc.on('error', () => resolve(null))
  })
}

// ===== 清理 =====

async function cleanupAnalysisFiles(savePath: string, id: string) {
  const entries = await fs.readdir(savePath).catch(() => [])
  for (const entry of entries) {
    if (entry.includes(`analysis_${id}`)) {
      try { await fs.unlink(join(savePath, entry)) } catch {}
    }
  }
}

// ===== IPC 处理器 =====

export function setupAnalysisHandlers(mainWindow: BrowserWindow) {
  ipcMain.handle('start-analysis', async (_event, request: AnalysisRequest) => {
    try {
      const result = await runPipeline(mainWindow, request)
      if (!result.error) {
        completedAnalyses.set(request.id, { result, request })
        mainWindow.webContents.send('analysis-complete', result)
      }
      return result
    } catch (e) {
      const errorMsg = (e as Error).message
      mainWindow.webContents.send('analysis-error', { id: request.id, error: errorMsg })
      await cleanupAnalysisFiles(request.savePath, request.id)
      killAllProcesses(request.id)
      return { id: request.id, error: errorMsg }
    }
  })

  ipcMain.handle('cancel-analysis', async (_event, id: string) => {
    killAllProcesses(id)
    return true
  })

  ipcMain.handle('check-analysis-deps', async () => {
    return checkWhisperDeps('medium')
  })

  ipcMain.handle('list-existing-transcripts', async (_event, folderPath: string) => {
    return listExistingTranscriptCandidates(folderPath)
  })

  ipcMain.handle('analyze-existing-folder', async (_event, request: ExistingAnalysisRequest) => {
    try {
      const result = await runExistingFolderAnalysis(mainWindow, request)
      const syntheticRequest: AnalysisRequest = {
        id: request.id,
        url: '',
        savePath: request.folderPath,
        language: request.language,
        llmProvider: request.llmProvider,
        llmModel: request.llmModel,
        llmApiKey: request.llmApiKey,
        llmApiBase: request.llmApiBase,
        analysisTypes: request.analysisTypes
      }
      completedAnalyses.set(request.id, { result, request: syntheticRequest })
      mainWindow.webContents.send('analysis-complete', result)
      return result
    } catch (e) {
      const errorMsg = (e as Error).message
      mainWindow.webContents.send('analysis-error', { id: request.id, error: errorMsg })
      killAllProcesses(request.id)
      return { id: request.id, error: errorMsg }
    }
  })

  ipcMain.handle('read-analysis-file', async (_event, filePath: string) => {
    try {
      const content = await fs.readFile(filePath, 'utf8')
      return content
    } catch (e) {
      throw new Error(`无法读取文件: ${(e as Error).message}`)
    }
  })

  ipcMain.handle('get-llm-settings', async () => {
    const provider = String(store.get('llm.provider') || 'deepseek') as LLMProvider
    const model = String(store.get('llm.model') || getDefaultModel(provider))
    return {
      provider,
      model,
      apiKey: provider === 'codex-cli' ? '' : getStoredApiKey(provider),
      saveApiKey: !!getStoredApiKey(provider)
    }
  })

  ipcMain.handle('save-llm-settings', async (_event, settings: {
    provider: LLMProvider
    model?: string
    apiKey?: string
    saveApiKey?: boolean
  }) => {
    store.set('llm.provider', settings.provider)
    store.set('llm.model', settings.model || getDefaultModel(settings.provider))
    if (settings.provider !== 'codex-cli') {
      if (settings.saveApiKey) setStoredApiKey(settings.provider, settings.apiKey || '')
      else setStoredApiKey(settings.provider, '')
    }
    return true
  })

  ipcMain.handle('ask-question', async (_event, args: {
    analysisId: string
    question: string
    llmProvider?: LLMProvider
    llmModel?: string
    llmApiKey?: string
    llmApiBase?: string
  }) => {
    const entry = completedAnalyses.get(args.analysisId)
    if (!entry) throw new Error('Analysis result not found for this question.')

    const provider = args.llmProvider || entry.request.llmProvider || 'deepseek'
    const model = args.llmModel || entry.request.llmModel || getDefaultModel(provider)
    const response = await askQuestion(
      args.question,
      entry.result.transcript.fullText,
      toAnalyzerSegments(entry.result.transcript),
      {
        provider,
        model,
        apiKey: args.llmApiKey || entry.request.llmApiKey || getStoredApiKey(provider),
        apiBase: args.llmApiBase || entry.request.llmApiBase,
        language: entry.request.language || 'zh',
        processSet: getProcessSet(args.analysisId)
      }
    )
    return response
  })
}
