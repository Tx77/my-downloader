import { ipcMain, dialog, BrowserWindow } from 'electron'
import { spawn } from 'child_process'
import Store from 'electron-store'
import * as fs from 'fs/promises'
import { join } from 'path'
import { getBinaryPath, getProxyArgs } from './utils'
import { createCookieFile, cleanupCookieFile } from './cookie'

const store = new Store()

// 🔍 暴力获取清晰度字符串
const getQualityString = (f: any): string => {
  if (f.format_note && f.format_note !== 'tiny' && f.format_note !== 'undefined') {
    return f.format_note
  }
  if (f.resolution) return f.resolution
  if (f.height) return `${f.height}p`

  if (f.format) {
    const match = f.format.match(/-(\d{3,4}p)/)
    if (match) return match[1]
  }

  if (f.vcodec && f.vcodec !== 'none') return 'Video (Unknown)'
  return 'Audio Only'
}

export function setupIpcHandlers(mainWindow: BrowserWindow) {
  // --- 基础配置 ---
  ipcMain.handle('get-saved-path', () => store.get('downloadPath', ''))
  ipcMain.handle('get-cookie', () => store.get('sessData', ''))
  ipcMain.handle('set-cookie', (_event, val) => store.set('sessData', val))

  ipcMain.handle('select-folder', async () => {
    const { filePaths } = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    if (filePaths[0]) {
      store.set('downloadPath', filePaths[0])
      return filePaths[0]
    }
    return null
  })

  // --- 登录窗口 (B站专用) ---
  ipcMain.handle('open-login-window', async () => {
    const loginWin = new BrowserWindow({
      width: 500,
      height: 600,
      autoHideMenuBar: true,
      title: 'Login Bilibili',
      webPreferences: {
        partition: 'persist:bilibili',
        nodeIntegration: false,
        contextIsolation: true
      }
    })
    loginWin.loadURL('https://passport.bilibili.com/login')

    return new Promise((resolve) => {
      let isLogged = false
      const interval = setInterval(async () => {
        if (loginWin.isDestroyed()) {
          clearInterval(interval)
          resolve(null)
          return
        }
        try {
          const cookies = await loginWin.webContents.session.cookies.get({ domain: 'bilibili.com' })
          const sessData = cookies.find((c) => c.name === 'SESSDATA')
          const biliJct = cookies.find((c) => c.name === 'bili_jct')
          if (sessData && biliJct) {
            clearInterval(interval)
            isLogged = true
            const cookieString = cookies.map((c) => `${c.name}=${c.value}`).join('; ')
            store.set('sessData', cookieString)
            loginWin.close()
            resolve(cookieString)
          }
        } catch {}
      }, 1500)

      loginWin.on('closed', () => {
        clearInterval(interval)
        if (!isLogged) resolve(null)
      })
    })
  })

  ipcMain.handle(
    'delete-local-file',
    async (_event, filePath: string, title: string, ext: string) => {
      try {
        // 1) 生成多个候选标题（Windows 非法字符处理）
        const sanitize = (s: string) => s.replace(/[<>:"/\\|?*\u0000-\u001F]/g, '').trim()
        const t1 = title.trim()
        const t2 = sanitize(title)

        const exts = new Set([ext, 'mp4', 'webm', 'm4a', 'mp3'])
        const candidates: string[] = []

        for (const t of new Set([t1, t2])) {
          if (!t) continue
          for (const e of exts) {
            candidates.push(join(filePath, `${t}.${e}`))
            candidates.push(join(filePath, `${t}.${e}.part`))
          }
        }

        // 2) 先按候选精确删
        for (const p of candidates) {
          try {
            await fs.unlink(p)
          } catch (e: any) {
            if (e?.code !== 'ENOENT') {
            }
          }
        }

        // 3) 再扫描目录：删除 “以标题开头” 的文件（含 .part）
        //    这是为了覆盖 yt-dlp 清洗标题 / 合并输出 mp4 / 中间文件名变化
        const files = await fs.readdir(filePath)
        const prefixes = new Set([t1, t2].filter(Boolean))

        for (const f of files) {
          for (const prefix of prefixes) {
            if (f.startsWith(prefix)) {
              // 只删常见媒体与临时后缀，避免误伤
              const lower = f.toLowerCase()
              if (
                lower.endsWith('.mp4') ||
                lower.endsWith('.webm') ||
                lower.endsWith('.m4a') ||
                lower.endsWith('.mp3') ||
                lower.endsWith('.part') ||
                lower.endsWith('.ytdl')
              ) {
                try {
                  await fs.unlink(join(filePath, f))
                } catch (e: any) {
                  if (e?.code !== 'ENOENT') {
                  }
                }
              }
            }
          }
        }

        return true
      } catch (e) {
        console.error('[delete-local-file] failed:', e)
        return false
      }
    }
  )

  // ✅ 新接口：按“真实路径数组”删除（用于删除 .part / 合并后的 mp4 / 中间文件）
  ipcMain.handle('delete-local-files', async (_event, paths: string[]) => {
    if (!Array.isArray(paths) || paths.length === 0) return true

    const norm = (p: string) =>
      p
        .replace(/\r?\n/g, '')
        .replace(/^"+|"+$/g, '')
        .trim()

    let ok = true
    for (const raw of paths) {
      const p = norm(raw)
      try {
        await fs.unlink(p)
      } catch (e: any) {
        if (e?.code !== 'ENOENT') ok = false
      }
    }
    return ok
  })

  // --- 核心解析逻辑 ---
  ipcMain.handle('analyze-url', async (_event, { url, sessData }) => {
    const ytDlpPath = getBinaryPath('yt-dlp')
    const cookieFilePath = createCookieFile(sessData)

    return new Promise((resolve, reject) => {
      const args = [
        url,
        '-J',
        '--no-playlist',
        '--rm-cache-dir',
        '--user-agent',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        ...getProxyArgs(url)
      ]
      if (cookieFilePath) args.push('--cookies', cookieFilePath)

      const child = spawn(ytDlpPath, args)
      let stdoutData = ''
      let stderrData = ''

      child.stdout.on('data', (data) => {
        stdoutData += data
      })
      child.stderr.on('data', (data) => {
        stderrData += data
      })

      child.on('close', (code) => {
        cleanupCookieFile(cookieFilePath)

        if (code === 0) {
          try {
            const json = JSON.parse(stdoutData)

            const formats = json.formats
              .filter((f: any) => f.ext !== 'mhtml')
              .map((f: any) => {
                const sizeBytes = f.filesize || f.filesize_approx
                const sizeStr = sizeBytes ? (sizeBytes / 1024 / 1024).toFixed(1) + ' MB' : 'N/A'
                const resolutionStr = getQualityString(f)

                return {
                  format_id: f.format_id,
                  ext: f.ext,
                  resolution: resolutionStr,
                  quality: f.quality,
                  filesize: sizeStr,
                  vcodec: f.vcodec,
                  acodec: f.acodec, // ✅ 新增：ConfirmModal 用来区分 audio/video
                  abr: f.abr,
                  tbr: f.tbr || 0
                }
              })
              .sort((a: any, b: any) => b.tbr - a.tbr)

            resolve({
              title: json.title,
              thumbnail: json.thumbnail,
              duration: json.duration_string,
              formats
            })
          } catch (e) {
            console.error('JSON Parse Error:', e)
            reject('解析失败: 返回数据格式错误')
          }
        } else {
          reject(stderrData || '解析进程异常退出')
        }
      })
    })
  })
}
