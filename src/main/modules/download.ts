import { ipcMain, BrowserWindow } from 'electron'
import { join } from 'path'
import { spawn, type ChildProcess } from 'child_process'
import * as fs from 'fs/promises'
import { getBinaryPath, getProxyArgs } from './utils'
import { createCookieFile, cleanupCookieFile } from './cookie'
import iconv from 'iconv-lite' // ⚠️ 必须引用

const activeDownloads = new Map<string, ChildProcess>()
const canceledIds = new Set<string>()
const taskFiles = new Map<string, Set<string>>()
// 记录任务状态，防止 UI 闪烁
const lastProgress = new Map<string, { percent: number; totalSize: string }>()

/**
 * 核心解码：强制 Windows 使用 cp936
 */
function decodeOutput(buf: Buffer): string {
  if (process.platform === 'win32') {
    return iconv.decode(buf, 'cp936')
  }
  return buf.toString('utf8')
}

function normalizePath(p: string) {
  return p
    .replace(/[\r\n]+/g, '')
    .replace(/^"+|"+$/g, '')
    .trim()
}

function addTaskFile(id: string, p: string) {
  const real = normalizePath(p)
  if (!real) return
  const set = taskFiles.get(id) ?? new Set<string>()
  set.add(real)
  taskFiles.set(id, set)
}

async function safeUnlink(p: string) {
  try {
    await fs.unlink(p)
    return true
  } catch {
    return false
  }
}

async function cleanupTaskTempFiles(id: string) {
  const set = taskFiles.get(id)
  if (!set) return 0
  let removed = 0
  for (const p of set) {
    const lower = p.toLowerCase()
    if (lower.endsWith('.part') || lower.endsWith('.ytdl') || lower.endsWith('.temp')) {
      if (await safeUnlink(p)) removed++
    }
  }
  return removed
}

function killTree(child: ChildProcess) {
  if (!child?.pid) return
  if (process.platform === 'win32') {
    spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
  } else {
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch {
      try {
        child.kill('SIGTERM')
      } catch {}
    }
  }
}

function stripAnsi(s: string) {
  return s.replace(/\x1b\[[0-9;]*m/g, '')
}

export function setupDownloadHandlers(mainWindow: BrowserWindow) {
  // 处理进度和日志的统一函数
  const handleProcessOutput = (id: string, rawChunk: Buffer, isErrorStream: boolean) => {
    // 1. 解码
    const text = decodeOutput(rawChunk)
    if (!text) return

    // 2. 捕获路径 (用于删除/清理)
    const lines = text.split(/\r?\n/)
    for (const line of lines) {
      const cleanLine = stripAnsi(line).trim()
      if (!cleanLine) continue

      // 捕获 .part 文件 或 目标文件
      // [download] Destination: D:\Downloads\video.mp4
      const destMatch = cleanLine.match(/\[download\]\s+Destination:\s+(.+)$/)
      if (destMatch?.[1]) addTaskFile(id, destMatch[1])

      // [ffmpeg] Merging formats into "..."
      const mergeMatch = cleanLine.match(/Merging formats into\s+"(.+?)"/)
      if (mergeMatch?.[1]) addTaskFile(id, mergeMatch[1])

      // 简单路径匹配
      if (cleanLine.includes('.part') && (cleanLine.includes(':\\') || cleanLine.startsWith('/'))) {
        // 简单的提取逻辑，尝试提取出路径部分
        const pathMatch = cleanLine.match(/([A-Za-z]:\\[^\s"]+?\.part)|(\/[^\s"]+?\.part)/)
        if (pathMatch) addTaskFile(id, pathMatch[0])
      }
    }

    // 3. 解析进度
    const cleanText = stripAnsi(text)
    const prev = lastProgress.get(id) ?? { percent: 0, totalSize: '计算中...' }

    let percent = prev.percent
    let totalSize = prev.totalSize

    // 正则：匹配 1.5%
    const pMatch = cleanText.match(/(\d{1,3}(?:\.\d+)?)%/)
    if (pMatch) {
      const val = parseFloat(pMatch[1])
      if (!isNaN(val)) percent = val
    }

    // 正则：匹配大小 (支持 ~ 100MiB 或 100MiB)
    // 这里的关键是忽略前面的乱码，只找 KiB/MiB/GiB 结尾的词
    const sMatch = cleanText.match(/of\s+(?:~\s*)?([\d.]+\s*[KMGTP]i?B)/i)
    if (sMatch?.[1]) {
      totalSize = sMatch[1].replace(/\s+/g, '') // 去除中间空格
    }

    // 更新缓存
    if (percent !== prev.percent || totalSize !== prev.totalSize) {
      lastProgress.set(id, { percent, totalSize })
    }

    // 4. 发送前端 (只要有日志就发，保证左下角日志滚动)
    mainWindow.webContents.send('download-progress', {
      id,
      log: text, // 发送原始解码后的文本，保持换行
      percent,
      totalSize
    })

    // 如果是错误流且包含 error 关键字，通知前端报错
    if (isErrorStream && text.toLowerCase().includes('error') && !text.includes('WARNING')) {
      mainWindow.webContents.send('download-error', { id, error: text })
    }
  }

  ipcMain.handle('cancel-download', (_event, id: string) => {
    canceledIds.add(id)
    const child = activeDownloads.get(id)
    if (child) {
      killTree(child)
      return true
    }
    return false
  })

  ipcMain.on('start-download', (_event, { id, url, formatId, savePath, isAudioOnly, sessData }) => {
    const ytDlpPath = getBinaryPath('yt-dlp')
    const ffmpegPath = getBinaryPath('ffmpeg')

    console.log(`[Download] Start: ${url}`)
    const cookieFilePath = createCookieFile(sessData)

    // 重置进度
    lastProgress.set(id, { percent: 0, totalSize: '计算中...' })

    const args = [
      url,
      '--ffmpeg-location',
      ffmpegPath,
      '-o',
      join(savePath, '%(title)s.%(ext)s'),
      '--no-playlist',
      '--rm-cache-dir',
      // 关键参数：强制换行，利于正则解析
      '--newline',
      // 打印路径，利于捕获
      // '--print',
      // 'after_move:filepath',
      '--progress',
      '--newline',
      '--user-agent',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      ...getProxyArgs(url)
    ]

    if (cookieFilePath) args.push('--cookies', cookieFilePath)

    if (isAudioOnly && formatId && formatId !== 'best') {
      args.push('-f', formatId)
    } else if (isAudioOnly) {
      args.push('-x', '--audio-format', 'mp3')
    } else if (formatId) {
      args.push('-f', `${formatId}+bestaudio/best`, '--merge-output-format', 'mp4')
    } else {
      args.push('-f', 'bestvideo+bestaudio/best', '--merge-output-format', 'mp4')
    }

    const downloadProcess = spawn(ytDlpPath, args, {
      detached: process.platform !== 'win32'
      // 注意：不要设置 stdio: 'inherit'，否则无法捕获
    })

    activeDownloads.set(id, downloadProcess)

    // 监听 stdout
    downloadProcess.stdout?.on('data', (data) => handleProcessOutput(id, data, false))

    // 监听 stderr
    downloadProcess.stderr?.on('data', (data) => handleProcessOutput(id, data, true))

    downloadProcess.on('close', async (code) => {
      activeDownloads.delete(id)
      cleanupCookieFile(cookieFilePath)
      lastProgress.delete(id)

      if (canceledIds.has(id)) {
        canceledIds.delete(id)
        const removed = await cleanupTaskTempFiles(id)
        mainWindow.webContents.send('download-canceled', { id, removed })
        return
      }

      mainWindow.webContents.send('download-complete', { id, code })
    })
  })
}
