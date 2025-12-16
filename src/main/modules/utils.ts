import { app } from 'electron'
import { join } from 'path'

export const getBinaryPath = (binaryName: string) => {
  const basePath = app.isPackaged
    ? join(process.resourcesPath, 'bin')
    : join(app.getAppPath(), 'resources', 'bin')
  const isWin = process.platform === 'win32'
  return join(basePath, `${binaryName}${isWin ? '.exe' : ''}`)
}

export const getProxyArgs = (url: string) => {
  if (url.includes('youtube.com') || url.includes('youtu.be')) {
    return ['--proxy', 'http://127.0.0.1:7890']
  }
  return []
}
