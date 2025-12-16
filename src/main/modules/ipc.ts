import { ipcMain, dialog, BrowserWindow } from 'electron'
import { spawn } from 'child_process'
import Store from 'electron-store'
import { getBinaryPath, getProxyArgs } from './utils'
import { createCookieFile, cleanupCookieFile } from './cookie'

const store = new Store()

export function setupIpcHandlers(_mainWindow: BrowserWindow) {
  // ==========================================
  // 1. 基础配置与路径管理
  // ==========================================
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

  // ==========================================
  // 2. B站扫码登录窗口
  // ==========================================
  ipcMain.handle('open-login-window', async () => {
    const loginWin = new BrowserWindow({
      width: 500,
      height: 600,
      autoHideMenuBar: true,
      title: '请登录 Bilibili (登录成功后自动关闭)',
      webPreferences: {
        partition: 'persist:bilibili', // 持久化 Session，保持登录状态
        nodeIntegration: false,
        contextIsolation: true
      }
    })

    loginWin.loadURL('https://passport.bilibili.com/login')

    return new Promise((resolve) => {
      let isLogged = false
      // 定时检查 Cookie
      const interval = setInterval(async () => {
        // 如果窗口被用户手动关闭，停止检查
        if (loginWin.isDestroyed()) {
          clearInterval(interval)
          resolve(null)
          return
        }

        try {
          // 获取 bilibili.com 下的所有 Cookie
          const cookies = await loginWin.webContents.session.cookies.get({ domain: 'bilibili.com' })

          const sessData = cookies.find((c) => c.name === 'SESSDATA')
          const biliJct = cookies.find((c) => c.name === 'bili_jct') // CSRF Token

          // 必须同时获取到 SESSDATA 和 bili_jct 才算成功
          if (sessData && biliJct) {
            clearInterval(interval)
            isLogged = true

            // 拼接完整 Cookie 字符串
            const cookieString = cookies.map((c) => `${c.name}=${c.value}`).join('; ')

            // 保存并关闭
            store.set('sessData', cookieString)
            loginWin.close()
            resolve(cookieString)
          }
        } catch (err) {
          // 忽略临时获取失败的错误
        }
      }, 1500)

      loginWin.on('closed', () => {
        clearInterval(interval)
        if (!isLogged) resolve(null)
      })
    })
  })

  // ==========================================
  // 3. URL 资源解析 (Analyze)
  // ==========================================
  ipcMain.handle('analyze-url', async (_event, { url, sessData }) => {
    const ytDlpPath = getBinaryPath('yt-dlp')
    console.log(`[Analyze] 正在解析: ${url}`)

    // 生成临时 Cookie 文件
    const cookieFilePath = createCookieFile(sessData)

    return new Promise((resolve, reject) => {
      const args = [
        url,
        '-J', // 输出 JSON 格式
        '--no-playlist', // 不解析列表
        '--rm-cache-dir', // 强制清除缓存 (关键！防止 4K 鉴权失败)
        // 伪装 User-Agent
        '--user-agent',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        ...getProxyArgs(url)
      ]

      // 注入 Cookie 文件路径
      if (cookieFilePath) {
        args.push('--cookies', cookieFilePath)
      }

      const process = spawn(ytDlpPath, args)
      let stdoutData = ''
      let stderrData = ''

      process.stdout.on('data', (data) => {
        stdoutData += data
      })
      process.stderr.on('data', (data) => {
        stderrData += data
      })

      process.on('close', (code) => {
        // 解析结束，清理临时文件
        cleanupCookieFile(cookieFilePath)

        if (code === 0) {
          try {
            const json = JSON.parse(stdoutData)

            // 提取并清洗格式列表
            const formats = json.formats
              .filter((f: any) => f.ext !== 'mhtml') // 过滤无效格式
              .map((f: any) => {
                // 🔥 修复：优先取 filesize，如果为 null 则取 filesize_approx (预估大小)
                // 很多流媒体(DASH)只有预估大小
                const sizeBytes = f.filesize || f.filesize_approx
                const sizeStr = sizeBytes ? (sizeBytes / 1024 / 1024).toFixed(1) + ' MB' : 'N/A'

                return {
                  format_id: f.format_id,
                  ext: f.ext,
                  resolution: f.resolution || 'audio only',
                  quality: f.quality, // 排序依据
                  filesize: sizeStr, // 显示大小
                  vcodec: f.vcodec,
                  acodec: f.acodec,
                  abr: f.abr, // 音频码率 (用于音频模式显示)
                  tbr: f.tbr // 总码率 (用于辅助排序)
                }
              })

            resolve({
              title: json.title,
              thumbnail: json.thumbnail,
              duration: json.duration_string,
              formats: formats
            })
          } catch (e) {
            console.error('JSON Parse Error:', e)
            reject('解析结果格式错误')
          }
        } else {
          // 失败时返回 stderr 信息
          reject(stderrData || '解析进程异常退出')
        }
      })
    })
  })
}
