import { ipcMain, BrowserWindow } from 'electron'
import { join } from 'path'
import { spawn, type ChildProcess } from 'child_process'
import * as fs from 'fs/promises'
import { getBinaryPath, getProxyArgs } from './utils'
import { createCookieFile, cleanupCookieFile } from './cookie'
import iconv from 'iconv-lite'

function decodeYtDlpOutput(buf: Buffer) {
  // Windows 下 yt-dlp 输出常见是 CP936(GBK)
  if (process.platform === 'win32') {
    return iconv.decode(buf, 'cp936')
  }
  return buf.toString('utf8')
}

// 🔥 使用 Map 存储多个进程，Key 是任务 ID
const activeDownloads = new Map<string, ChildProcess>()

// 🔥 标记被取消的任务
const canceledIds = new Set<string>()

// 🔥 记录每个任务产生/触达过的真实文件路径（用于取消清理 .part / 删除本地文件）
const taskFiles = new Map<string, Set<string>>()

function normalizePath(p: string) {
  return p.replace(/^"+|"+$/g, '').trim()
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

// 取消时只清理临时文件（.part/.ytdl 等）
async function cleanupTaskTempFiles(id: string) {
  const set = taskFiles.get(id)
  if (!set) return 0
  let removed = 0

  for (const p of set) {
    const lower = p.toLowerCase()
    if (
      lower.endsWith('.part') ||
      lower.endsWith('.ytdl') ||
      lower.endsWith('.temp') ||
      lower.endsWith('.tmp')
    ) {
      if (await safeUnlink(p)) removed++
    }
  }

  // 取消任务后，路径记录没必要留着
  taskFiles.delete(id)
  return removed
}

// 🔥 杀进程树（Windows: taskkill；mac/linux: kill process group）
function killTree(child: ChildProcess) {
  if (!child?.pid) return

  if (process.platform === 'win32') {
    spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
  } else {
    try {
      // 需要 detached 才能保证进程组可用
      process.kill(-child.pid, 'SIGTERM')
    } catch {
      try {
        child.kill('SIGTERM')
      } catch {}
    }
  }
}

export function setupDownloadHandlers(mainWindow: BrowserWindow) {
  const capturePaths = (id: string, output: string) => {
    const normalize = (p: string) =>
      p
        .replace(/\r/g, '')
        .replace(/^"+|"+$/g, '')
        .trim()

    const destMatch = output.match(/\[download\]\s+Destination:\s+(.+)\s*$/m)
    if (destMatch?.[1]) {
      const p = normalize(destMatch[1])
      mainWindow.webContents.send('download-file', { id, path: p })
    }

    const mergeMatch = output.match(/\[ffmpeg\]\s+Merging formats into\s+"(.+?)"/)
    if (mergeMatch?.[1]) {
      const p = normalize(mergeMatch[1])
      mainWindow.webContents.send('download-file', { id, path: p })
    }

    const partMatch = output.match(/([A-Za-z]:\\[^\r\n"]+?\.part)\b/)
    if (partMatch?.[1]) {
      const p = normalize(partMatch[1])
      mainWindow.webContents.send('download-file', { id, path: p })
    }
  }

  // 1. 取消下载 (需要传入 id)
  ipcMain.handle('cancel-download', (_event, id: string) => {
    canceledIds.add(id)

    const child = activeDownloads.get(id)
    if (child) {
      console.log(`[Download] Canceling task: ${id}, pid=${child.pid}`)
      killTree(child)
      return true
    }
    return false
  })

  // 2. 开始下载 (接收 id)
  ipcMain.on('start-download', (event, { id, url, formatId, savePath, isAudioOnly, sessData }) => {
    const ytDlpPath = getBinaryPath('yt-dlp')
    const ffmpegPath = getBinaryPath('ffmpeg')

    console.log(`[Download] Start Task [${id}]: ${url}`)
    const cookieFilePath = createCookieFile(sessData)

    const args = [
      url,
      '--ffmpeg-location',
      ffmpegPath,
      '-o',
      join(savePath, '%(title)s.%(ext)s'),
      '--no-playlist',
      '--rm-cache-dir',
      '--newline',
      '--print',
      'after_move:filepath',
      '--user-agent',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      ...getProxyArgs(url)
    ]

    if (cookieFilePath) args.push('--cookies', cookieFilePath)

    if (isAudioOnly && formatId && formatId !== 'best') {
      args.push('-f', formatId)
    } else if (isAudioOnly) {
      // audio 模式：best -> 提取 mp3
      args.push('-x', '--audio-format', 'mp3')
    } else if (formatId) {
      // video 模式：指定 formatId + bestaudio 合并
      args.push('-f', `${formatId}+bestaudio/best`, '--merge-output-format', 'mp4')
    } else {
      args.push('-f', 'bestvideo+bestaudio/best', '--merge-output-format', 'mp4')
    }

    const downloadProcess = spawn(ytDlpPath, args, {
      detached: process.platform !== 'win32'
    })

    activeDownloads.set(id, downloadProcess)

    downloadProcess.stdout?.on('data', (data) => {
      const output = decodeYtDlpOutput(data as Buffer)

      for (const line of output.split(/\r?\n/)) {
        const p = line.trim()
        if (!p) continue
        if (/^[A-Za-z]:\\/.test(p) || p.startsWith('/')) {
          mainWindow.webContents.send('download-file', { id, path: p })
        }
      }
      capturePaths(id, output)

      // ====== 解析真实文件路径（用于取消清理 / 删除本地文件）======
      // 1) [download] Destination: C:\...\xxx.webm
      const destMatch = output.match(/\[download\]\s+Destination:\s+(.+)\s*$/m)
      if (destMatch?.[1]) {
        const p = normalizePath(destMatch[1])
        addTaskFile(id, p)
        mainWindow.webContents.send('download-file', { id, path: p })
      }

      // 2) [ffmpeg] Merging formats into "C:\...\xxx.mp4"
      const mergeMatch = output.match(/\[ffmpeg\]\s+Merging formats into\s+"(.+?)"/)
      if (mergeMatch?.[1]) {
        const p = normalizePath(mergeMatch[1])
        addTaskFile(id, p)
        mainWindow.webContents.send('download-file', { id, path: p })
      }

      // 3) 直接抓一把 .part 路径（有时不走 Destination）
      const partMatch = output.match(/([A-Za-z]:\\[^\r\n"]+?\.part)\b/)
      if (partMatch?.[1]) {
        const p = normalizePath(partMatch[1])
        addTaskFile(id, p)
        mainWindow.webContents.send('download-file', { id, path: p })
      }

      // ====== 你的进度解析逻辑（保持原样）======
      try {
        const match = output.match(/(\d+(?:\.\d+)?)%\s+of\s+(?:~)?\s*([\d\.]+\s*[KMGTP]i?B)/)
        if (match) {
          const percent = parseFloat(match[1])
          const totalSize = match[2].replace(/[~\s]/g, '')
          mainWindow.webContents.send('download-progress', { id, log: output, percent, totalSize })
        } else {
          const percentOnly = output.match(/(\d+(?:\.\d+)?)%/)
          if (percentOnly) {
            mainWindow.webContents.send('download-progress', {
              id,
              log: output,
              percent: parseFloat(percentOnly[1]),
              totalSize: '计算中...'
            })
          }
        }
      } catch {}
    })

    downloadProcess.stderr?.on('data', (d) => {
      const log = decodeYtDlpOutput(d as Buffer)
      capturePaths(id, log)
      if (log.toLowerCase().includes('error')) {
        console.error(`[Task ${id} Error]:`, log)
        mainWindow.webContents.send('download-error', { id, error: log })
      }
    })

    downloadProcess.on('close', async (code) => {
      console.log(`[Task ${id}] Finished code: ${code}`)

      activeDownloads.delete(id)
      cleanupCookieFile(cookieFilePath)

      // ✅ 如果是取消：发 canceled + 清理 .part 临时文件（并告诉前端清理了几个）
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
