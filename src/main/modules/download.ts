import { ipcMain, BrowserWindow } from 'electron'
import { join } from 'path'
import { spawn, type ChildProcess } from 'child_process'
import { getBinaryPath, getProxyArgs } from './utils'
import { createCookieFile, cleanupCookieFile } from './cookie'

// 用于存储当前正在进行的下载进程，以便取消
let currentDownloadProcess: ChildProcess | null = null

export function setupDownloadHandlers(mainWindow: BrowserWindow) {
  // 1. 取消下载接口
  ipcMain.handle('cancel-download', () => {
    if (currentDownloadProcess) {
      console.log('[Download] 收到取消指令，正在终止进程...')
      // Windows 下有时候 kill 不彻底，可以考虑 tree-kill 库，但通常 .kill() 够用了
      currentDownloadProcess.kill()
      currentDownloadProcess = null
      return true
    }
    return false
  })

  // 2. 开始下载接口
  ipcMain.on('start-download', (_event, { url, formatId, savePath, isAudioOnly, sessData }) => {
    const ytDlpPath = getBinaryPath('yt-dlp')
    const ffmpegPath = getBinaryPath('ffmpeg')

    console.log(`[Download] Starting download: ${url}`)

    // 1. 生成 Cookie 文件
    const cookieFilePath = createCookieFile(sessData)

    // 2. 组装参数
    const args = [
      url,
      '--ffmpeg-location',
      ffmpegPath,
      '-o',
      join(savePath, '%(title)s.%(ext)s'),
      '--no-playlist',
      '--rm-cache-dir', // 强制清除缓存，防止读取旧数据
      // 伪装 User-Agent
      '--user-agent',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      ...getProxyArgs(url)
    ]

    // 注入 Cookie 文件
    if (cookieFilePath) {
      args.push('--cookies', cookieFilePath)
    }

    // 格式选择逻辑
    if (isAudioOnly && formatId && formatId !== 'best') {
      // 纯音频模式且选了特定格式 (如 m4a)
      args.push('-f', formatId)
    } else if (isAudioOnly) {
      // 纯音频模式，默认转 MP3
      args.push('-x', '--audio-format', 'mp3')
    } else if (formatId) {
      // 视频模式，指定画质 + 最佳音频
      args.push('-f', `${formatId}+bestaudio/best`, '--merge-output-format', 'mp4')
    } else {
      // 视频模式，自动最佳
      args.push('-f', 'bestvideo+bestaudio/best', '--merge-output-format', 'mp4')
    }

    console.log('[Download] Executing args:', args)

    // 3. 启动进程
    // ⚠️ PYTHONIOENCODING=utf-8 是解决中文乱码的关键
    currentDownloadProcess = spawn(ytDlpPath, args, {
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
    })

    // 4. 监听标准输出 (进度条)
    currentDownloadProcess.stdout?.on('data', (data) => {
      const output = data.toString()

      // 正则解析：匹配百分比和总大小 (支持 MiB, GiB 等)
      // 输出示例: [download]  23.5% of 10.00MiB at 2.00MiB/s
      const match = output.match(/(\d+\.\d+)%\s+of\s+(?:~)?([\d\.]+[KMGTP]i?B)/)

      if (match) {
        const percent = parseFloat(match[1])
        const totalSize = match[2]
        mainWindow.webContents.send('download-progress', { log: output, percent, totalSize })
      } else {
        // 部分直播流或特殊情况可能没有总大小
        mainWindow.webContents.send('download-progress', { log: output, percent: 0, totalSize: '' })
      }
    })

    // 5. 监听错误输出
    currentDownloadProcess.stderr?.on('data', (d) => {
      // yt-dlp 的警告也会走 stderr，这里发给前端显示在日志里即可
      mainWindow.webContents.send('download-error', d.toString())
    })

    // 6. 监听进程结束
    currentDownloadProcess.on('close', (code) => {
      console.log(`[Download] Process finished with code: ${code}`)
      currentDownloadProcess = null

      // 清理临时 Cookie 文件
      cleanupCookieFile(cookieFilePath)

      // 通知前端
      mainWindow.webContents.send('download-complete', code)
    })
  })
}
