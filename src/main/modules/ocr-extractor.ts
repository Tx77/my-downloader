/**
 * OCR 硬字幕提取模块
 *
 * 流程: ffmpeg 抽帧 → 感知哈希 (pHash) 去重 → PaddleOCR Python 子进程识别 → 合并文本
 *
 * 依赖: ffmpeg.exe (已捆绑), Python 3.8+ + paddleocr
 * 进程追踪: 所有子进程注册到 processSet，支持外部取消
 */

import { spawn, type ChildProcess } from 'child_process'
import * as fs from 'fs/promises'
import { app } from 'electron'
import { join } from 'path'
import * as os from 'os'
import * as zlib from 'zlib'
import { getBinaryPath } from './utils'

// ===== 类型 =====

export interface OcrOptions {
  /** 视频文件路径 */
  videoPath: string
  /** OCR 语言 (ch / en / ch_en) */
  language?: string
  /** 抽帧间隔 (fps)，默认 1 */
  fps?: number
  /** 是否只识别画面底部 1/3 */
  cropBottom?: boolean
  /** 进度回调 — status.message 显示文本, status.phasePercent 是 OCR 阶段内部进度 (0-100) */
  onProgress?: (status: { message: string; phasePercent: number }) => void
  /** 子进程追踪集合 */
  processSet?: Set<ChildProcess>
}

export interface OcrSegment {
  start: number   // 毫秒
  end: number     // 毫秒
  text: string
}

export interface OcrResult {
  fullText: string
  segments: OcrSegment[]
  /** 总抽帧数 */
  frameCount: number
  /** 去重后帧数 */
  uniqueFrameCount: number
  /** 处理耗时 (ms) */
  processingTime: number
  /** OCR 语言 */
  language: string
}

// ===== PNG 解码 (无外部依赖) =====

interface PngInfo {
  pixels: Uint8Array
  width: number
  height: number
}

function decodePng(buf: Buffer): PngInfo {
  // 验证 PNG 签名
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  if (Buffer.compare(buf.subarray(0, 8), sig) !== 0) {
    throw new Error('不是有效的 PNG 文件')
  }

  let width = 0
  let height = 0
  let colorType = 2
  const idatChunks: Buffer[] = []

  let pos = 8
  while (pos < buf.length - 4) {
    const length = buf.readUInt32BE(pos)
    const type = buf.subarray(pos + 4, pos + 8).toString('ascii')
    const data = buf.subarray(pos + 8, pos + 8 + length)

    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      colorType = data.readUInt8(9)
    } else if (type === 'IDAT') {
      idatChunks.push(data)
    } else if (type === 'IEND') {
      break
    }

    pos += 12 + length
  }

  if (width === 0 || height === 0) throw new Error('PNG 解析失败: 未找到 IHDR')

  // 解压 IDAT
  const compressed = Buffer.concat(idatChunks)
  const decompressed = zlib.inflateSync(compressed)

  // 计算每行字节数
  const bytesPerPixel = colorType === 2 ? 3 : colorType === 6 ? 4 : 3
  const rawRowBytes = width * bytesPerPixel
  const rowBytes = rawRowBytes + 1 // +1 for filter byte

  const pixels = new Uint8Array(width * height * 4) // 统一输出 RGBA

  for (let y = 0; y < height; y++) {
    const filterType = decompressed[y * rowBytes]
    const rowData = decompressed.subarray(y * rowBytes + 1, (y + 1) * rowBytes)
    const unfiltered = unfilterRow(filterType, rowData, y > 0 ? pixels.subarray((y - 1) * width * 4, y * width * 4) : null, bytesPerPixel, width)

    for (let x = 0; x < width; x++) {
      const srcOff = x * bytesPerPixel
      const dstOff = (y * width + x) * 4
      pixels[dstOff] = unfiltered[srcOff]       // R
      pixels[dstOff + 1] = unfiltered[srcOff + 1] ?? unfiltered[srcOff] // G
      pixels[dstOff + 2] = unfiltered[srcOff + 2] ?? unfiltered[srcOff] // B
      pixels[dstOff + 3] = bytesPerPixel >= 4 ? unfiltered[srcOff + 3] : 255 // A
    }
  }

  return { pixels, width, height }
}

function unfilterRow(
  filterType: number,
  row: Buffer,
  prevRow: Uint8Array | null,
  bpp: number,
  width: number
): Uint8Array {
  const out = new Uint8Array(width * bpp)

  for (let i = 0; i < out.length; i++) {
    const a = i >= bpp ? out[i - bpp] : 0
    const b = prevRow ? prevRow[i] : 0
    const c = (prevRow && i >= bpp) ? prevRow[i - bpp] : 0

    let val = row[i]
    switch (filterType) {
      case 0: break // None
      case 1: val += a; break // Sub
      case 2: val += b; break // Up
      case 3: val += Math.floor((a + b) / 2); break // Average
      case 4: val += paethPredictor(a, b, c); break // Paeth
      default: break
    }
    out[i] = val & 0xff
  }

  return out
}

function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

// ===== 感知哈希 (pHash) =====

function toGrayscaleMatrix(pixels: Uint8Array, width: number, height: number): number[][] {
  const m: number[][] = []
  for (let y = 0; y < height; y++) {
    m[y] = []
    for (let x = 0; x < width; x++) {
      const off = (y * width + x) * 4
      m[y][x] = 0.299 * pixels[off] + 0.587 * pixels[off + 1] + 0.114 * pixels[off + 2]
    }
  }
  return m
}

function resizeBilinear(
  src: number[][], srcW: number, srcH: number,
  dstW: number, dstH: number
): number[][] {
  const dst: number[][] = []
  for (let y = 0; y < dstH; y++) {
    dst[y] = []
    for (let x = 0; x < dstW; x++) {
      const sx = (x + 0.5) * srcW / dstW - 0.5
      const sy = (y + 0.5) * srcH / dstH - 0.5
      const x0 = Math.max(0, Math.floor(sx))
      const y0 = Math.max(0, Math.floor(sy))
      const x1 = Math.min(x0 + 1, srcW - 1)
      const y1 = Math.min(y0 + 1, srcH - 1)
      const fx = sx - x0
      const fy = sy - y0
      dst[y][x] =
        src[y0][x0] * (1 - fx) * (1 - fy) +
        src[y0][x1] * fx * (1 - fy) +
        src[y1][x0] * (1 - fx) * fy +
        src[y1][x1] * fx * fy
    }
  }
  return dst
}

function dct2D(matrix: number[][], size: number): number[][] {
  const out: number[][] = Array.from({ length: size }, () => Array(size).fill(0))
  for (let u = 0; u < size; u++) {
    for (let v = 0; v < size; v++) {
      let sum = 0
      for (let x = 0; x < size; x++) {
        for (let y = 0; y < size; y++) {
          sum += matrix[x][y] *
            Math.cos(((2 * x + 1) * u * Math.PI) / (2 * size)) *
            Math.cos(((2 * y + 1) * v * Math.PI) / (2 * size))
        }
      }
      out[u][v] = sum
    }
  }
  return out
}

function computeHash(pixels: Uint8Array, width: number, height: number): string {
  const hashSize = 32
  const gray = toGrayscaleMatrix(pixels, width, height)
  const resized = resizeBilinear(gray, width, height, hashSize, hashSize)
  const dct = dct2D(resized, hashSize)

  // 取左上角 8x8 低频分量
  const topLeft: number[] = []
  for (let i = 0; i < 8; i++) {
    for (let j = 0; j < 8; j++) {
      topLeft.push(dct[i][j])
    }
  }

  // 排除 DC 分量 (索引 0) 计算均值
  const acValues = topLeft.slice(1)
  const mean = acValues.reduce((a, b) => a + b, 0) / acValues.length

  // 生成 64-bit 哈希
  let hash = ''
  for (const val of topLeft) {
    hash += val > mean ? '1' : '0'
  }
  return hash
}

function hammingDistance(h1: string, h2: string): number {
  let dist = 0
  for (let i = 0; i < Math.min(h1.length, h2.length); i++) {
    if (h1[i] !== h2[i]) dist++
  }
  return dist
}

// ===== 核心: OCR 硬字幕提取 =====

export async function extractSubtitles(options: OcrOptions): Promise<OcrResult> {
  const {
    videoPath,
    language = 'ch',
    fps = 1,
    cropBottom = false,
    onProgress,
    processSet
  } = options

  const startTime = Date.now()

  // 检查 Python 可用性
  await checkPython()

  // 创建临时目录
  const tempDir = join(os.tmpdir(), `ocr_frames_${Date.now()}`)
  await fs.mkdir(tempDir, { recursive: true })

  const cleanupTemp = async () => {
    try { await fs.rm(tempDir, { recursive: true, force: true }) } catch {}
  }

  try {
    // === Step 1: ffmpeg 抽帧 ===
    onProgress?.({ message: '正在提取视频帧...', phasePercent: 5 })

    const framePattern = join(tempDir, 'frame_%06d.png')
    const ffmpegPath = getBinaryPath('ffmpeg')

    const vfParts: string[] = [`fps=${fps}`]
    if (cropBottom) {
      // 只保留底部 1/3 用于 OCR
      vfParts.push('crop=iw:ih/3:0:ih*2/3')
    }
    const vfFilter = vfParts.join(',')

    await runFfmpeg(ffmpegPath, [
      '-i', videoPath,
      '-vf', vfFilter,
      framePattern,
      '-y'
    ], (elapsedSec) => {
      // ffmpeg 实时进度: 0-14% of OCR phase
      const phasePct = Math.min(14, Math.round((elapsedSec / Math.max(1, 60)) * 14))
      onProgress?.({ message: `正在提取视频帧... 已处理 ${elapsedSec}s`, phasePercent: phasePct })
    }, processSet)

    // 收集帧文件
    const entries = await fs.readdir(tempDir)
    const frameFiles = entries
      .filter(f => f.endsWith('.png'))
      .map(f => ({ name: f, path: join(tempDir, f) }))
      .sort((a, b) => a.name.localeCompare(b.name))

    const frameCount = frameFiles.length
    if (frameCount === 0) {
      throw new Error('ffmpeg 抽帧结果为空，请检查视频文件')
    }

    onProgress?.({ message: `抽帧完成: ${frameCount} 帧，正在去重...`, phasePercent: 15 })

    // === Step 2: pHash 去重 ===
    const HAMMING_THRESHOLD = 12 // 汉明距离阈值，< 12 视为重复帧

    const uniqueFrames: Array<{ path: string; index: number; hash: string }> = []
    let lastHash = ''

    for (let i = 0; i < frameFiles.length; i++) {
      const buf = await fs.readFile(frameFiles[i].path)
      const { pixels, width, height } = decodePng(buf)
      const hash = computeHash(pixels, width, height)

      if (i === 0 || hammingDistance(hash, lastHash) > HAMMING_THRESHOLD) {
        uniqueFrames.push({ path: frameFiles[i].path, index: i, hash })
        lastHash = hash
      }

      if ((i + 1) % 100 === 0) {
        const pct = 15 + Math.round(((i + 1) / frameCount) * 20)
        onProgress?.({ message: `去重中... ${i + 1}/${frameCount}`, phasePercent: pct })
      }
    }

    const uniqueFrameCount = uniqueFrames.length
    onProgress?.({ message: `去重完成: ${frameCount} → ${uniqueFrameCount} 帧，正在 OCR 识别...`, phasePercent: 35 })

    // === Step 3: PaddleOCR 识别 ===
    // 先检查 Python 和 paddleocr
    const pythonPath = await findPython()
    const workerPath = findOcrWorker()

    const ocrProc = spawn(pythonPath, [workerPath, '--lang', language], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' }  // 关键: Windows 下 pipe 默认 GBK，必须设 UTF-8
    })
    processSet?.add(ocrProc)

    let workerError = ''
    let workerExited = false
    ocrProc.stderr?.on('data', (data: Buffer) => {
      workerError += data.toString()
    })
    ocrProc.on('exit', (code) => {
      workerExited = true
      if (code !== 0) {
        onProgress?.({ message: `Python worker 异常退出 (code ${code}): ${workerError.slice(-200)}`, phasePercent: 0 })
      }
    })

    // 等待 ready 信号 — OCR 引擎初始化时会往 stdout 打印日志，
    // 循环读取跳过非 JSON 行，直到收到 {"ready": true}
    let readyLang = language
    for (let attempt = 0; attempt < 30; attempt++) {
      if (workerExited) {
        throw new Error(`OCR worker 意外退出:\n${workerError.slice(-300)}`)
      }
      const line = await readLine(ocrProc.stdout!, 15000)
      try {
        const msg = JSON.parse(line)
        if (msg.error) throw new Error(`OCR 初始化失败: ${msg.error}`)
        if (msg.ready) {
          readyLang = msg.lang || language
          const gpuTag = msg.gpu ? 'DirectML GPU' : 'CPU'
          onProgress?.({ message: `OCR 引擎就绪 (${readyLang}, ${msg.mode}, ${gpuTag})`, phasePercent: 40 })
          break
        }
      } catch (e: any) {
        if (e.message?.includes('OCR 初始化失败') || e.message?.includes('OCR worker')) throw e
        // 跳过 OCR 引擎初始化日志，继续读下一行
        onProgress?.({ message: `OCR 加载中... (${line.slice(0, 40)})`, phasePercent: 36 + Math.min(attempt, 4) })
      }
    }

    if (workerExited) {
      throw new Error(`OCR worker 在初始化阶段退出:\n${workerError.slice(-300)}`)
    }

    // 批量 OCR — 一次发送全部帧，消除 N-1 次 IPC 往返
    const ocrResults: Array<{ index: number; text: string; lines: string[]; timeMs: number }> = []

    onProgress?.({ message: `开始 OCR 识别 ${uniqueFrameCount} 帧...`, phasePercent: 40 })

    const batchRequest = JSON.stringify({
      ids: uniqueFrames.map((_, i) => i),
      paths: uniqueFrames.map(f => f.path)
    }) + '\n'

    ocrProc.stdin!.write(batchRequest)

    // 批量响应只读一次
    let totalTimeMs = 0
    const batchTimeout = Math.max(120000, uniqueFrameCount * 5000) // 每帧至少 5s 超时

    // 读取批量响应 (可能跨多行 JSON，但应该是一行)
    for (;;) {
      const line = await readLine(ocrProc.stdout!, batchTimeout)
      try {
        const resp = JSON.parse(line)
        if (resp.results) {
          for (const r of resp.results) {
            const frame = uniqueFrames[r.id]
            ocrResults.push({
              index: frame?.index ?? r.id,
              text: r.text || '',
              lines: r.lines || [],
              timeMs: r.time_ms || 0
            })
          }
          totalTimeMs = resp.total_time_ms || 0
          break
        }
        if (resp.error) {
          throw new Error(`批量 OCR 失败: ${resp.error}`)
        }
      } catch (e: any) {
        if (e.message?.includes('批量 OCR')) throw e
        if (workerExited) throw new Error(`OCR worker 在批处理中退出:\n${workerError.slice(-300)}`)
        // 跳过非 JSON，继续读
      }
    }

    const avgMs = ocrResults.length > 0 ? Math.round(totalTimeMs / ocrResults.length) : 0
    onProgress?.({ message: `OCR 完成: ${ocrResults.filter(r => r.text).length}/${uniqueFrameCount} 帧有文本 (均 ${avgMs}ms/帧, 总 ${(totalTimeMs/1000).toFixed(1)}s)`, phasePercent: 98 })

    // 关闭 stdin 让 Python 退出
    ocrProc.stdin!.end()
    processSet?.delete(ocrProc)

    // === Step 4: 合并结果并生成时间轴 segments ===
    const segmentIntervalMs = (1 / fps) * 1000
    const segments: OcrSegment[] = []

    // 按帧序号填充时间轴
    // 每个独特帧代表从 frameIndex 开始的片段
    for (let i = 0; i < ocrResults.length; i++) {
      const ocr = ocrResults[i]
      if (!ocr.text.trim()) continue

      const nextIndex = i + 1 < ocrResults.length
        ? ocrResults[i + 1].index
        : frameCount

      const startMs = Math.round(ocr.index * segmentIntervalMs)
      const endMs = Math.round(nextIndex * segmentIntervalMs)

      segments.push({
        start: startMs,
        end: endMs,
        text: ocr.text.trim()
      })
    }

    // 合并相邻相同文本 (常见于字幕持续多帧)
    const mergedSegments = mergeSimilarSegments(segments)

    const fullText = mergedSegments.map(s => s.text).join(' ')

    onProgress?.({ message: `OCR 完成: ${mergedSegments.length} 个片段`, phasePercent: 100 })

    const processingTime = Date.now() - startTime

    return {
      fullText,
      segments: mergedSegments,
      frameCount,
      uniqueFrameCount,
      processingTime,
      language
    }

  } finally {
    await cleanupTemp()
  }
}

// ===== 辅助函数 =====

function runFfmpeg(
  ffmpegPath: string,
  args: string[],
  onFrameProgress: (elapsedSec: number) => void,
  processSet?: Set<ChildProcess>
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args, { windowsHide: true })
    processSet?.add(proc)

    let stderr = ''

    proc.stderr?.on('data', (data: Buffer) => {
      const text = data.toString()
      stderr += text

      // 解析 ffmpeg 时间进度: "time=00:00:30.15" → 已处理 30 秒
      const timeMatch = text.match(/time=(\d{2}):(\d{2}):(\d{2})\.\d{2}/)
      if (timeMatch) {
        const elapsed = parseInt(timeMatch[1]) * 3600 + parseInt(timeMatch[2]) * 60 + parseInt(timeMatch[3])
        onFrameProgress(elapsed)
      }
    })

    proc.on('close', (code) => {
      processSet?.delete(proc)
      if (code === 0) {
        resolve()
      } else {
        const tail = stderr.split('\n').filter(l => l.trim()).slice(-5).join('\n')
        reject(new Error(`ffmpeg 抽帧失败 (退出码 ${code}):\n${tail}`))
      }
    })

    proc.on('error', (err) => {
      processSet?.delete(proc)
      reject(new Error(`无法启动 ffmpeg: ${err.message}`))
    })
  })
}

function readLine(stream: NodeJS.ReadableStream, timeoutMs: number = 30000): Promise<string> {
  return new Promise((resolve) => {
    let buf = ''
    const onData = (chunk: Buffer) => {
      buf += chunk.toString()
      const idx = buf.indexOf('\n')
      if (idx >= 0) {
        stream.removeListener('data', onData)
        resolve(buf.slice(0, idx).trim())
      }
    }
    stream.on('data', onData)
    // 超时保护
    setTimeout(() => {
      stream.removeListener('data', onData)
      resolve(buf.trim() || '{}')
    }, timeoutMs)
  })
}

async function checkPython(): Promise<void> {
  try {
    await findPython()
  } catch {
    throw new Error(
      'Python 未找到。OCR 功能需要 Python 3.8+。\n' +
      '请安装 Python 并运行: pip install paddlepaddle paddleocr'
    )
  }
}

async function findPython(): Promise<string> {
  // 尝试 python3, python
  for (const cmd of ['python', 'python3']) {
    const result = await new Promise<string | null>((resolve) => {
      const proc = spawn(cmd, ['--version'], { windowsHide: true })
      let out = ''
      proc.stdout?.on('data', (d: Buffer) => { out += d.toString() })
      proc.stderr?.on('data', (d: Buffer) => { out += d.toString() })
      proc.on('close', (code) => resolve(code === 0 ? cmd : null))
      proc.on('error', () => resolve(null))
    })
    if (result) return result
  }
  throw new Error('未找到 Python')
}

function findOcrWorker(): string {
  // 开发环境: <project>/resources/ocr/ocr_worker.py
  // 打包后: process.resourcesPath/ocr/ocr_worker.py
  if (app.isPackaged) {
    return join(process.resourcesPath, 'ocr', 'ocr_worker.py')
  }
  return join(app.getAppPath(), 'resources', 'ocr', 'ocr_worker.py')
}

function mergeSimilarSegments(segments: OcrSegment[]): OcrSegment[] {
  if (segments.length <= 1) return segments

  const merged: OcrSegment[] = [segments[0]]

  for (let i = 1; i < segments.length; i++) {
    const prev = merged[merged.length - 1]
    const curr = segments[i]

    // 相同文本合并
    if (curr.text === prev.text) {
      prev.end = curr.end
    } else {
      merged.push(curr)
    }
  }

  // 过滤非字幕文本: URL、日期时间、纯数字符号、社交账号等
  return merged.filter((seg) => {
    const t = seg.text
    if (t.length < 2) return false                         // 太短
    if (/^[\d\s.,:;%+\-*/=<>()[\]{}|&^~@#!?]+$/.test(t)) return false  // 纯数字符号
    if (/https?:\/\/|www\.|\.com|\.cn|\.jp|\.html|\.co\.jp/i.test(t)) return false  // URL
    if (/^@\w+/.test(t)) return false                     // 社交账号
    // 至少包含一个 CJK 字符
    if (!/[一-鿿㐀-䶿]/.test(t)) return false
    // 替换字符 (U+FFFD) 过多说明 OCR 失败
    const badChars = (t.match(/�/g) || []).length
    if (badChars > t.length * 0.3) return false
    return true
  })
}
