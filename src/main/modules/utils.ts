import { app } from 'electron'
import { join } from 'path'

export const getBinaryPath = (binaryName: string) => {
  const basePath = app.isPackaged
    ? join(process.resourcesPath, 'bin')
    : join(app.getAppPath(), 'resources', 'bin')
  const isWin = process.platform === 'win32'
  return join(basePath, `${binaryName}${isWin ? '.exe' : ''}`)
}

/** whisper 模型目录 — 打包后放在 userData 下，不随安装包分发 */
export const getModelDir = (): string => {
  if (app.isPackaged) {
    // app.getPath('userData') 基于 package.json 的 name 字段 (my-downloader)
    // 实际路径: %APPDATA%/my-downloader/whisper-models/
    return join(app.getPath('userData'), 'whisper-models')
  }
  // 开发: resources/bin/models/
  return join(app.getAppPath(), 'resources', 'bin', 'models')
}

export const getProxyArgs = (url: string) => {
  if (url.includes('youtube.com') || url.includes('youtu.be')) {
    return ['--proxy', 'http://127.0.0.1:6789']
  }
  return []
}
