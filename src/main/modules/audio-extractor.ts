/**
 * 音频提取模块 — 从视频文件提取 16kHz 单声道 WAV (Whisper 最佳输入)
 * 依赖: ffmpeg (已在 resources/bin/ 中)
 */

import { spawn, type ChildProcess } from 'child_process'
import * as fs from 'fs/promises'
import { getBinaryPath } from './utils'

export interface AudioExtractProgress {
  elapsed: number
  speed: number
}

export interface ExtractAudioOptions {
  onProgress?: (progress: AudioExtractProgress) => void
  /** 收集子进程的 Set，用于外部取消 */
  processSet?: Set<ChildProcess>
}

/**
 * 从视频提取音频为 16kHz 单声道 PCM WAV
 */
export function extractAudio(
  videoPath: string,
  outputPath: string,
  options: ExtractAudioOptions = {}
): Promise<string> {
  const { onProgress, processSet } = options
  const ffmpegPath = getBinaryPath('ffmpeg')

  return new Promise((resolve, reject) => {
    const dir = outputPath.replace(/[/\\][^/\\]+$/, '')
    fs.mkdir(dir, { recursive: true }).catch(() => {})

    const args = [
      '-i', videoPath,
      '-vn',
      '-acodec', 'pcm_s16le',
      '-ar', '16000',
      '-ac', '1',
      '-y',
      '-progress', 'pipe:1',
      outputPath
    ]

    const proc: ChildProcess = spawn(ffmpegPath, args)

    // 注册到外部的进程集合，用于取消
    processSet?.add(proc)

    if (onProgress) {
      proc.stderr?.on('data', (data: Buffer) => {
        const text = data.toString()
        const timeMatch = text.match(/time=(\d{2}):(\d{2}):(\d{2})\.(\d{2})/)
        const speedMatch = text.match(/speed=\s*([\d.]+)x/)
        if (timeMatch) {
          const elapsed =
            parseInt(timeMatch[1]) * 3600 +
            parseInt(timeMatch[2]) * 60 +
            parseInt(timeMatch[3])
          const speed = speedMatch ? parseFloat(speedMatch[1]) : 0
          onProgress({ elapsed, speed })
        }
      })
    }

    proc.on('close', (code) => {
      processSet?.delete(proc)
      code === 0 ? resolve(outputPath) : reject(new Error(`ffmpeg 音频提取失败, 退出码: ${code}`))
    })

    proc.on('error', (err) => {
      processSet?.delete(proc)
      reject(new Error(`无法启动 ffmpeg: ${err.message}`))
    })
  })
}
