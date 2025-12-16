import { useState, useEffect, useRef } from 'react'
import {
  Download,
  FolderOpen,
  Music2,
  Link2,
  Terminal,
  ChevronDown,
  ChevronRight,
  XCircle // 新增取消图标
} from 'lucide-react'
import './assets/main.css'

// 引入拆分的组件
import { Toast } from './components/Toast'
import { CustomSelect } from './components/CustomSelect'
import { ConfirmModal } from './components/ConfirmModal'
import { CookieManager } from './components/CookieManager'
import { JSX } from 'react/jsx-runtime'

// --- 辅助工具函数：处理文件大小 ---

// 1. 将 "10.5 MiB" 这种字符串解析为 字节数值 (number)
const parseSizeToBytes = (sizeStr: string): number => {
  if (!sizeStr) return 0
  // 定义单位倍数
  const units: { [key: string]: number } = {
    B: 1,
    KB: 1024,
    MB: 1024 ** 2,
    GB: 1024 ** 3,
    TB: 1024 ** 4,
    KiB: 1024,
    MiB: 1024 ** 2,
    GiB: 1024 ** 3,
    TiB: 1024 ** 4
  }

  // 正则匹配数字和单位 (例如: 100.5 MiB)
  const match = sizeStr.match(/([\d\.]+)\s*([A-Za-z]+)/)
  if (match) {
    const val = parseFloat(match[1])
    const unit = match[2]
    const multiplier = units[unit] || 1
    return val * multiplier
  }
  return 0
}

// 2. 将字节数值格式化为易读字符串 (用于计算当前已下载大小)
const formatBytes = (bytes: number): string => {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  // 保留1位小数
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i]
}

function App(): JSX.Element {
  // --- 状态定义 ---
  const [url, setUrl] = useState('')
  const [savePath, setSavePath] = useState('')
  const [mode, setMode] = useState<'video' | 'audio'>('video')
  const [logs, setLogs] = useState<string[]>([])

  // 进度条状态：包含百分比、总大小字符串、当前大小字符串
  const [progressData, setProgressData] = useState({ percent: 0, totalSize: '', currentSize: '' })

  const [isDownloading, setIsDownloading] = useState(false)
  const [showLogs, setShowLogs] = useState(false)

  const [isModalOpen, setIsModalOpen] = useState(false)
  const [isAnalyzing, setIsAnalyzing] = useState(false)
  const [videoData, setVideoData] = useState<any>(null)

  const [sessData, setSessData] = useState('')
  const [toast, setToast] = useState({ show: false, message: '', type: 'success' })

  const logEndRef = useRef<HTMLDivElement>(null)

  // --- 初始化与配置加载 ---
  useEffect(() => {
    const loadConfig = async () => {
      // @ts-ignore
      const path = await window.electron.getSavedPath()
      if (path) setSavePath(path)

      // @ts-ignore
      const cookie = await window.electron.getCookie()
      if (cookie) setSessData(cookie)
    }
    loadConfig()
  }, [])

  // --- 交互处理函数 ---

  const showToastMsg = (msg: string, type: 'success' | 'error' = 'success') => {
    setToast({ show: true, message: msg, type })
  }

  const handleSelectFolder = async () => {
    // @ts-ignore
    const path = await window.electron.selectFolder()
    if (path) setSavePath(path)
  }

  const handleLogin = async () => {
    // @ts-ignore
    const cookie = await window.electron.openLoginWindow()
    if (cookie) {
      setSessData(cookie)
      showToastMsg('🎉 B站登录成功！Cookie 已更新')
    }
  }

  // 点击“分析”按钮
  const handleAnalyze = async () => {
    if (!url) return showToastMsg('请先填写视频链接', 'error')
    if (!savePath) return showToastMsg('请先选择保存目录', 'error')

    setIsModalOpen(true)
    setIsAnalyzing(true)
    setVideoData(null)

    try {
      // @ts-ignore
      const data = await window.electron.analyzeUrl({ url, sessData })
      setVideoData(data)
    } catch (err) {
      showToastMsg('解析失败，请检查网络或链接', 'error')
      setIsModalOpen(false)
      setLogs((prev) => [...prev, `❌ 解析失败: ${err}`])
    } finally {
      setIsAnalyzing(false)
    }
  }

  // 点击“取消下载”按钮
  const handleCancel = async () => {
    if (!isDownloading) return
    try {
      // @ts-ignore
      await window.electron.cancelDownload()
      // 状态更新会在 onComplete (code!=0) 或这里手动处理
      setIsDownloading(false)
      setLogs((prev) => [...prev, '⚠️ 用户取消了下载任务'])
      showToastMsg('下载已取消', 'error')
      // 重置进度
      setProgressData({ percent: 0, totalSize: '', currentSize: '' })
    } catch (err) {
      console.error(err)
    }
  }

  // 模态框确认后，开始真实下载
  const startRealDownload = (formatId: string | null, isAudioOnly: boolean) => {
    setIsModalOpen(false)
    setIsDownloading(true)
    setLogs(['--- 开始下载任务 ---'])
    setProgressData({ percent: 0, totalSize: '', currentSize: '' }) // 重置进度
    setShowLogs(true)

    // @ts-ignore
    window.electron.startDownload(url, formatId, savePath, isAudioOnly, sessData)
  }

  // --- IPC 事件监听 ---
  useEffect(() => {
    // 监听进度
    // @ts-ignore
    window.electron.onProgress(({ log, percent, totalSize }) => {
      // 1. 更新日志
      if (log && log.trim()) setLogs((prev) => [...prev, log].slice(-100))

      // 2. 更新进度条与大小计算
      if (percent > 0) {
        let currentSizeStr = ''
        // 如果后端传回了总大小 (如 "100 MiB")，我们算出当前已下载大小
        if (totalSize) {
          const totalBytes = parseSizeToBytes(totalSize)
          const currentBytes = totalBytes * (percent / 100)
          currentSizeStr = formatBytes(currentBytes)
        }

        setProgressData({
          percent,
          totalSize: totalSize || '',
          currentSize: currentSizeStr
        })
      }

      // 3. 自动滚动日志
      if (showLogs) logEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    })

    // 监听完成
    // @ts-ignore
    window.electron.onComplete((code) => {
      setIsDownloading(false)

      if (code === 0) {
        // 成功：进度条补满
        setProgressData((prev) => ({ ...prev, percent: 100 }))
        showToastMsg('下载成功！文件已保存')
        setLogs((prev) => [...prev, '✨ 任务完成！'])
      } else {
        // 失败或取消
        // 如果是取消，通常由 handleCancel 处理提示，这里主要处理异常退出
        if (progressData.percent < 100) {
          // 此时如果不为0可能是报错
          // showToastMsg('下载未完成', 'error');
        }
        setLogs((prev) => [...prev, `❌ 进程结束 (代码: ${code})`])
      }
    })

    // 监听错误
    // @ts-ignore
    window.electron.onError((err) => setLogs((prev) => [...prev, `❌ 错误: ${err}`]))

    return () => {
      // @ts-ignore
      if (window.electron.removeListeners) window.electron.removeListeners()
    }
  }, [showLogs, progressData.percent]) // 依赖项加入 progressData.percent 并非必须，但有助于逻辑追踪

  return (
    <div className="container">
      {/* 1. 顶部标题 */}
      <div className="header">
        <Music2 size={32} color="#1db954" />
        <h1>Downloader Pro</h1>
      </div>

      {/* 2. 主操作卡片 */}
      <div className="input-card">
        {/* URL 输入 */}
        <div className="input-wrapper">
          <Link2 className="input-icon" size={18} />
          <input
            type="text"
            className="styled-input"
            placeholder="粘贴 Bilibili / YouTube 链接..."
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            disabled={isDownloading}
          />
        </div>

        {/* Cookie 管理组件 */}
        <CookieManager
          sessData={sessData}
          setSessData={setSessData}
          handleLogin={handleLogin}
          showToastMsg={showToastMsg}
        />

        {/* 选项栏：模式选择 + 目录选择 */}
        <div className="options-row">
          <div style={{ flex: 1 }}>
            <CustomSelect
              value={mode}
              onChange={setMode}
              options={[
                { value: 'video', label: '视频 (Video)' },
                { value: 'audio', label: '音频 (Audio Only)' }
              ]}
            />
          </div>
          <button className="icon-btn" onClick={handleSelectFolder} disabled={isDownloading}>
            <FolderOpen size={16} />
            <span>{savePath ? '更改目录' : '选择目录...'}</span>
          </button>
        </div>

        {savePath && <div className="path-text">保存至: {savePath}</div>}

        {/* 下载/取消 按钮区域 */}
        {isDownloading ? (
          <button
            className="download-btn"
            onClick={handleCancel}
            style={{ backgroundColor: '#e91429', color: 'white' }} // 红色样式
          >
            <XCircle size={20} />
            <span>取消下载 (Cancel)</span>
          </button>
        ) : (
          <button className="download-btn" onClick={handleAnalyze} disabled={isDownloading}>
            {mode === 'audio' ? 'Analyze Audio' : 'Analyze Video'}
            <Download size={20} />
          </button>
        )}
      </div>

      {/* 3. 进度条区域 (仅在有进度或下载中显示) */}
      {(progressData.percent > 0 || isDownloading) && (
        <div className="progress-section">
          <div className="progress-bar-bg">
            <div className="progress-bar-fill" style={{ width: `${progressData.percent}%` }} />
          </div>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              fontSize: '12px',
              marginTop: '4px',
              color: '#b3b3b3'
            }}
          >
            {/* 左侧：当前大小 / 总大小 */}
            <span>
              {progressData.totalSize
                ? `${progressData.currentSize} / ${progressData.totalSize}`
                : isDownloading
                  ? '准备中...'
                  : ''}
            </span>
            {/* 右侧：百分比 */}
            <span>{progressData.percent.toFixed(1)}%</span>
          </div>
        </div>
      )}

      {/* 4. 日志区域 (自适应高度) */}
      <div
        className="logs-container"
        style={{ flex: showLogs ? 1 : '0 0 auto', minHeight: showLogs ? '100px' : '0' }}
      >
        <div className="logs-header" onClick={() => setShowLogs(!showLogs)}>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <Terminal size={14} /> <span>运行日志</span>
          </div>
          {showLogs ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </div>
        <div
          className="logs-content"
          style={{ opacity: showLogs ? 1 : 0, display: showLogs ? 'block' : 'none' }}
        >
          {logs.map((log, i) => (
            <div key={i} style={{ whiteSpace: 'pre-wrap' }}>
              {log}
            </div>
          ))}
          <div ref={logEndRef} />
        </div>
      </div>

      {/* 5. 弹窗组件 */}
      <ConfirmModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        onConfirm={(fmtId) => startRealDownload(fmtId, mode === 'audio')}
        isLoading={isAnalyzing}
        data={videoData}
        mode={mode}
      />

      {/* 6. 全局提示 */}
      <Toast
        show={toast.show}
        message={toast.message}
        type={toast.type}
        onClose={() => setToast((prev) => ({ ...prev, show: false }))}
      />
    </div>
  )
}

export default App
