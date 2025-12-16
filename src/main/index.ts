import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import crypto from 'crypto'
import { autoUpdater } from 'electron-updater'

// 导入拆分后的业务模块
import { setupIpcHandlers } from './modules/ipc'
import { setupDownloadHandlers } from './modules/download'

// ==========================================
// 🚨 全局 Polyfill (修复 crypto 兼容性)
// ==========================================
// @ts-ignore
if (typeof global.crypto !== 'object') {
  // @ts-ignore
  global.crypto = {}
}
// @ts-ignore
if (!global.crypto.getRandomValues) {
  // @ts-ignore
  global.crypto.getRandomValues = function (buffer: any) {
    return crypto.randomFillSync(buffer)
  }
}

// ==========================================
// 🔄 自动更新逻辑
// ==========================================
function setupAutoUpdater(mainWindow: BrowserWindow) {
  // 开发环境通常跳过更新检测，除非你配置了 dev-app-update.yml
  if (is.dev) return

  // 设置日志（可选）
  // autoUpdater.logger = require("electron-log")
  // autoUpdater.logger.transports.file.level = "info"

  // 检查更新并通知（如果有更新会自动下载）
  autoUpdater.checkForUpdatesAndNotify()

  // 监听更新事件并转发给前端
  autoUpdater.on('checking-for-update', () => {
    // mainWindow.webContents.send('update-message', '正在检查更新...')
  })

  autoUpdater.on('update-available', (_info) => {
    mainWindow.webContents.send('update-available', _info)
  })

  autoUpdater.on('update-not-available', (_info) => {
    // mainWindow.webContents.send('update-message', '当前已是最新版本')
  })

  autoUpdater.on('error', (err) => {
    mainWindow.webContents.send('update-error', err.toString())
  })

  autoUpdater.on('download-progress', (progressObj) => {
    mainWindow.webContents.send('update-progress', progressObj)
  })

  autoUpdater.on('update-downloaded', (_info) => {
    // 下载完成后，通知前端，前端可以弹窗提示用户“重启安装”
    mainWindow.webContents.send('update-downloaded', _info)
  })

  // 监听前端发来的“立即安装”指令
  ipcMain.on('install-update', () => {
    autoUpdater.quitAndInstall()
  })
}

// ==========================================
// 🖥️ 窗口创建与初始化
// ==========================================
function createWindow(): void {
  // 创建浏览器窗口
  const mainWindow = new BrowserWindow({
    width: 1200, // 👈 调大宽度
    height: 800, // 👈 调大高度
    minWidth: 1000, // 设置最小宽度
    minHeight: 600,
    show: false, // 等待 ready-to-show 再显示，防止白屏
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false, // 允许使用 Node.js API
      contextIsolation: true // 推荐开启上下文隔离
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  // 处理外部链接打开请求（使用默认浏览器打开）
  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // 加载页面
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  // ✅ 初始化业务模块
  setupIpcHandlers(mainWindow) // 通用 IPC (Cookie, 路径选择, URL解析)
  setupDownloadHandlers(mainWindow) // 下载任务管理
  setupAutoUpdater(mainWindow) // 自动更新
}

// ==========================================
// 🚀 应用生命周期
// ==========================================
app.whenReady().then(() => {
  // 设置 App ID (用于 Windows 通知等)
  electronApp.setAppUserModelId('com.electron.downloader')

  // 默认优化：按 F12 打开开发者工具等快捷键
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  createWindow()

  // macOS: 点击 Dock 图标且无窗口时重新创建
  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// 所有窗口关闭时退出应用 (macOS 除外)
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
