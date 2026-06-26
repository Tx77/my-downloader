/**
 * ASR 转录模块 — 使用 whisper.cpp 进行语音转文字
 * 依赖: whisper-cli.exe + 模型文件 (resources/bin/models/)
 */

import { spawn, type ChildProcess } from 'child_process'
import * as fs from 'fs/promises'
import * as os from 'os'
import { join } from 'path'
import { getBinaryPath, getModelDir } from './utils'
import iconv from 'iconv-lite'

// ===== 类型 =====

export interface TranscriberOptions {
  model?: 'medium' | 'large-v3'
  language?: string
  onProgress?: (percent: number, message: string) => void
  /** 收集子进程的 Set，用于外部取消 */
  processSet?: Set<ChildProcess>
}

export interface WhisperSegment {
  start: number    // 毫秒
  end: number      // 毫秒
  text: string
}

export interface TranscriptParagraph {
  startMs: number       // 段落起始毫秒
  endMs: number         // 段落结束毫秒
  text: string           // 段内 segments 拼接后的文本 (无时间戳前缀)
}

export interface TranscriptTranslation {
  targetLanguage: string
  paragraphs: string[]   // 与 paragraph[] 一一对应
  processingTimeMs: number
  error?: string
}

export interface TranscriberResult {
  fullText: string
  segments: WhisperSegment[]
  language: string
  processingTime: number
  paragraphs?: TranscriptParagraph[]
  translation?: TranscriptTranslation
}

// ===== 转录文本格式化 =====

export interface FormatTranscriptOptions {
  /**
   * 相邻 segment 间隔超过此值(秒)视为段落边界。
   * 默认 2.0s — 说话中的自然停顿。
   * 对于字幕来源(无真实停顿间隔), 可设为 Infinity 以禁用段落分割。
   */
  paragraphGapSec?: number
  /** 是否在段落开头插入时间戳, 默认 true */
  timestamps?: boolean
  /**
   * 句末标点触发段落边界的最小句子数。
   * 当 segment gap 不足以分段时（字幕常见），每积累 N 个句子后遇句末标点就分段。
   * 默认 2 — 大约 2-3 句话一个段落。
   */
  sentencesPerParagraph?: number
}

/** 段落内至少要有这么多句末标点才允许句末分段（防开头就断） */
const MIN_SENTENCE_BREAK_COUNT = 1

const SENTENCE_END_RE = /[。！？.!?]$/

/**
 * 将 segments 按时间间隔 + 句末标点分组为段落数组。
 *
 * 双策略自动适应：
 * - 对话/ASR（gap 大）→ 段落边界由时间间隔决定
 * - 字幕（gap 近零）→ 段落边界由句末标点决定（每 N 句分段）
 */
export function groupTranscriptParagraphs(
  segments: WhisperSegment[],
  options: FormatTranscriptOptions = {}
): TranscriptParagraph[] {
  const { paragraphGapSec = 2.0, sentencesPerParagraph = 2 } = options

  if (!segments.length) return []

  const paragraphs: TranscriptParagraph[] = []
  let currentSegs: WhisperSegment[] = []
  let sentenceEndCount = 0

  function flushParagraph() {
    if (currentSegs.length > 0) {
      paragraphs.push({
        startMs: currentSegs[0].start,
        endMs: currentSegs[currentSegs.length - 1].end,
        text: currentSegs.map(s => s.text).join(' ')
      })
    }
    currentSegs = []
    sentenceEndCount = 0
  }

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]
    const prevSeg = i > 0 ? segments[i - 1] : null
    const gap = prevSeg ? (seg.start - prevSeg.end) / 1000 : Infinity

    if (gap > paragraphGapSec) {
      flushParagraph()
      currentSegs = [seg]
      if (SENTENCE_END_RE.test(seg.text)) sentenceEndCount++
      continue
    }

    if (
      sentencesPerParagraph > 0 &&
      sentenceEndCount >= MIN_SENTENCE_BREAK_COUNT &&
      sentenceEndCount >= sentencesPerParagraph &&
      SENTENCE_END_RE.test(seg.text)
    ) {
      currentSegs.push(seg)
      flushParagraph()
      continue
    }

    currentSegs.push(seg)
    if (SENTENCE_END_RE.test(seg.text)) sentenceEndCount++
  }

  flushParagraph()
  return paragraphs
}

/**
 * 将 whisper/subtitle 的平铺 segments 格式化为有段落结构的可读文本。
 *
 * 内部调用 groupTranscriptParagraphs() 后 join。
 */
export function formatTranscript(
  segments: WhisperSegment[],
  options: FormatTranscriptOptions = {}
): string {
  const { timestamps = true } = options
  const paragraphs = groupTranscriptParagraphs(segments, options)
  return paragraphs
    .map(p => timestamps ? `[${formatTimestampMs(p.startMs)}] ${p.text}` : p.text)
    .join('\n\n')
}

/** 毫秒 → HH:MM:SS / MM:SS 字符串 */
export function formatTimestampMs(ms: number): string {
  const total = Math.floor(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

// ===== 模型路径 =====

function getModelPath(model: string): string {
  return join(getModelDir(), `ggml-${model}.bin`)
}

// ===== 转写 =====

export async function transcribe(
  audioPath: string,
  options: TranscriberOptions = {}
): Promise<TranscriberResult> {
  const { model = 'medium', language = 'auto', onProgress, processSet } = options

  const whisperPath = getBinaryPath('whisper-cli')
  const modelPath = getModelPath(model)

  // 检查文件存在
  try { await fs.stat(whisperPath) } catch {
    throw new Error('whisper-cli.exe 未找到，请将其放到 resources/bin/ 目录')
  }
  try { await fs.stat(modelPath) } catch {
    // 确保模型目录存在
    const modelDir = getModelDir()
    try { await fs.mkdir(modelDir, { recursive: true }) } catch {}
    throw new Error(
      `模型文件不存在:\n  ${modelPath}\n\n` +
      `请从 https://huggingface.co/ggerganov/whisper.cpp 下载 ggml-${model}.bin\n` +
      `放到: ${modelDir}\n\n` +
      `可用模型: ggml-medium.bin (1.5GB) 或 ggml-large-v3.bin (2.9GB)`
    )
  }

  const startTime = Date.now()
  onProgress?.(0, '正在加载模型...')

  // 自动检测 CPU 核心数: 用物理核心数
  // 线程过多会导致模型加载阶段内存争抢，反而更慢
  const cpuCores = os.cpus().length
  const threads = Math.min(16, Math.max(8, Math.floor(cpuCores / 2)))
  // 对于 7950X (32 逻辑核心 / 16 物理核): threads = 16

  return new Promise((resolve, reject) => {
    const args = [
      '-m', modelPath,
      '-f', audioPath,
      '-l', language,
      '-t', String(threads),    // CPU 线程数
      '-p', String(Math.ceil(threads / 2)),  // 处理器数
      '-oj',                    // JSON 输出到文件 ({audio}.json)
      '-ojf',                   // 输出完整 JSON (含 offsets 毫秒时间戳)
      '--print-progress',       // 进度输出到 stderr
      '--no-timestamps'         // stdout 中不混合时间戳文本
    ]

    const proc: ChildProcess = spawn(whisperPath, args)
    processSet?.add(proc)
    let stdout = ''
    let stderr = ''

    proc.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString()
    })

    proc.stderr?.on('data', (data: Buffer) => {
      const text = decodeOutput(data)
      stderr += text

      // 解析进度: "progress = 45%"
      const match = text.match(/progress\s*=\s*(\d+)%/)
      if (match) {
        const pct = parseInt(match[1])
        onProgress?.(pct, `转录中... ${pct}%`)
      }
    })

    proc.on('close', async (code) => {
      processSet?.delete(proc)
      if (code !== 0) {
        const errors = stderr.split('\n').filter(l => l.trim()).slice(-5)
        return reject(new Error(`whisper 转录失败:\n${errors.join('\n')}`))
      }

      // -oj 将 JSON 写入 {audioPath}.json 文件，而非 stdout
      const jsonPath = audioPath + '.json'

      try {
        const jsonRaw = await fs.readFile(jsonPath, 'utf8')
        const json = JSON.parse(jsonRaw)
        const processingTime = Date.now() - startTime

        const segments: WhisperSegment[] = (json.transcription || []).map((seg: any) => ({
          start: parseTimestamp(seg.timestamps?.from || seg.offsets?.from || 0),
          end: parseTimestamp(seg.timestamps?.to || seg.offsets?.to || 0),
          text: (seg.text || '').trim()
        }))

        // 从 whisper JSON 提取检测到的语言
        const detectedLanguage = json.result?.language || language

        onProgress?.(100, '转录完成')

        // 清理 JSON 文件
        try { await fs.unlink(jsonPath) } catch {}

        resolve({
          fullText: formatTranscript(segments),
          segments,
          language: detectedLanguage,
          processingTime,
          paragraphs: groupTranscriptParagraphs(segments)
        })
      } catch (e) {
        // 清理 JSON 文件（如果存在）
        try { await fs.unlink(jsonPath) } catch {}
        // 提供诊断信息：stdout 尾部 + JSON 文件路径
        const stdoutTail = stdout.slice(-200).replace(/\s+/g, ' ').trim()
        reject(new Error(
          `whisper 输出解析失败: ${(e as Error).message}\n` +
          `JSON 文件: ${jsonPath}\n` +
          `stdout 尾部: ${stdoutTail || '(空)'}`
        ))
      }
    })

    proc.on('error', (err) => {
      processSet?.delete(proc)
      reject(new Error(`无法启动 whisper-cli: ${err.message}`))
    })
  })
}

// ===== 检查依赖 =====

export async function checkWhisperDeps(model: string = 'medium'): Promise<{
  whisperAvailable: boolean
  modelAvailable: boolean
  modelPath: string
}> {
  const whisperPath = getBinaryPath('whisper-cli')
  const modelPath = getModelPath(model)

  const [whisperStat, modelStat] = await Promise.allSettled([
    fs.stat(whisperPath),
    fs.stat(modelPath)
  ])

  return {
    whisperAvailable: whisperStat.status === 'fulfilled',
    modelAvailable: modelStat.status === 'fulfilled',
    modelPath
  }
}

// ===== 辅助 =====

function parseTimestamp(ts: number | string): number {
  if (typeof ts === 'number') return ts
  // "00:00:02,500" 或 "00:00:02.500" → 毫秒
  const match = String(ts).match(/(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/)
  if (!match) return 0
  return (
    parseInt(match[1]) * 3600000 +
    parseInt(match[2]) * 60000 +
    parseInt(match[3]) * 1000 +
    parseInt(match[4])
  )
}

function decodeOutput(buf: Buffer): string {
  if (process.platform === 'win32') {
    return iconv.decode(buf, 'cp936')
  }
  return buf.toString('utf8')
}
