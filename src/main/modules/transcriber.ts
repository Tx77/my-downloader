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

export interface TranscriberResult {
  fullText: string
  segments: WhisperSegment[]
  language: string
  processingTime: number
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

        onProgress?.(100, '转录完成')

        // 清理 JSON 文件
        try { await fs.unlink(jsonPath) } catch {}

        resolve({
          fullText: segments.map(s => s.text).join(' '),
          segments,
          language,
          processingTime
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
