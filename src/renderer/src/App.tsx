import { useState, useEffect, useRef, JSX } from 'react'
import {
  Download,
  FolderOpen,
  Music2,
  Link2,
  Terminal,
  Settings,
  CheckCircle2,
  AlertCircle,
  Clock,
  X,
  Trash2,
  Film
} from 'lucide-react'
import './assets/base.css'
import './assets/App.css'
import { Toast } from './components/Toast'
import { CustomSelect } from './components/CustomSelect'
import { ConfirmModal } from './components/ConfirmModal'
import { ConfirmDeleteModal } from './components/ConfirmDeleteModal'
import { CookieManager } from './components/CookieManager'

interface DownloadTask {
  id: string
  url: string
  title: string
  status: 'queued' | 'downloading' | 'completed' | 'error' | 'canceled'
  percent: number
  totalSize: string
  formatId: string | null
  isAudioOnly: boolean
  savePath: string
  ext: string
  log: string

  // ✅ 新增：记录真实落盘路径（含 .part / 合并后的 mp4 / 中间文件）
  files: string[]
}

function App(): JSX.Element {
  const [savePath, setSavePath] = useState('')
  const [sessData, setSessData] = useState('')
  const [maxConcurrent, setMaxConcurrent] = useState(5)

  const [url, setUrl] = useState('')
  const [mode, setMode] = useState<'video' | 'audio'>('video')
  const [isAnalyzing, setIsAnalyzing] = useState(false)
  const [videoData, setVideoData] = useState<any>(null)
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [toast, setToast] = useState({ show: false, message: '', type: 'success' })
  const [tab, setTab] = useState<'all' | 'active' | 'completed'>('all')

  const [tasks, setTasks] = useState<DownloadTask[]>([])

  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false)
  const [taskToDelete, setTaskToDelete] = useState<DownloadTask | null>(null)

  const [globalLogs, setGlobalLogs] = useState<string[]>([])
  const logEndRef = useRef<HTMLDivElement>(null)
  const persistTimerRef = useRef<any>(null)
  const tasksLoadedRef = useRef(false)

  const [deleteTargets, setDeleteTargets] = useState<DownloadTask[]>([])
  const [deleteMode, setDeleteMode] = useState<'single' | 'bulk'>('single')

  useEffect(() => {
    const init = async () => {
      // @ts-ignore
      const savedTasks = await window.electron.getTasks?.()
      if (Array.isArray(savedTasks) && savedTasks.length) {
        // 重启后，未完成任务统一标记为中断
        const fixed = savedTasks.map((t) => {
          if (t.status === 'downloading' || t.status === 'queued') {
            return { ...t, status: 'error', log: '应用重启，任务中断' }
          }
          return t
        })
        setTasks(fixed)
      }

      const path = await window.electron.getSavedPath()
      if (path) setSavePath(path)

      const cookie = await window.electron.getCookie()
      if (cookie) setSessData(cookie)

      tasksLoadedRef.current = true
    }
    init()

    // ✅ 记录真实路径
    window.electron.onFile(({ id, path }) => {
      setTasks((prev) =>
        prev.map((t) => {
          if (t.id !== id) return t
          if (t.files.includes(path)) return t
          return { ...t, files: [...t.files, path] }
        })
      )
    })

    // 进度：已取消的不再覆盖状态
    window.electron.onProgress(({ id, log, percent, totalSize }) => {
      setTasks((prev) =>
        prev.map((t) => {
          if (t.id !== id) return t
          if (t.status === 'canceled') return t
          return {
            ...t,
            percent,
            totalSize: totalSize || t.totalSize,
            log,
            status: 'downloading'
          }
        })
      )

      if (log && log.trim()) {
        setGlobalLogs((prev) => [...prev, log].slice(-50))
      }
      logEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    })

    // 完成：已取消的不再覆盖
    // @ts-ignore
    window.electron.onComplete(({ id, code }) => {
      setTasks((prev) =>
        prev.map((t) => {
          if (t.id === id) {
            const ok = code === 0

            // 🔥 修复逻辑：如果是“计算中...”或“等待中...”，则强制改为“已完成”或保持原样
            let finalSize = t.totalSize
            if (ok) {
              if (t.totalSize === '计算中...' || t.totalSize === '等待中...') {
                finalSize = '未知大小' // 或者可以直接显示 '已完成'
              }
            }

            return {
              ...t,
              status: ok ? 'completed' : 'error',
              percent: ok ? 100 : t.percent,
              totalSize: finalSize, // 使用修正后的大小
              log: ok ? '下载成功' : '下载失败'
            }
          }
          return t
        })
      )
    })

    // 错误
    window.electron.onError(({ id, error }) => {
      setTasks((prev) =>
        prev.map((t) => {
          if (t.id !== id) return t
          if (t.status === 'canceled') return t
          return { ...t, status: 'error', log: `❌ 错误: ${error}` }
        })
      )
      showToastMsg('任务下载失败，请检查日志', 'error')
    })

    // ✅ 取消确认（并提示清理了多少 .part）
    window.electron.onCanceled(({ id, removed }) => {
      setTasks((prev) =>
        prev.map((t) => (t.id === id ? { ...t, status: 'canceled', log: '任务已取消' } : t))
      )
      if (removed > 0) {
        setGlobalLogs((prev) => [...prev, `🧹 已清理临时文件: ${removed} 个`].slice(-50))
      }
    })

    return () => {
      window.electron.removeListeners && window.electron.removeListeners()
    }
  }, [])

  // ✅ 新增：tasks 变化时持久化（单独一个 useEffect）
  useEffect(() => {
    if (!window.electron.setTasks) return
    if (!tasksLoadedRef.current) return

    if (persistTimerRef.current) clearTimeout(persistTimerRef.current)
    persistTimerRef.current = setTimeout(() => {
      window.electron.setTasks(tasks)
    }, 500)

    return () => {
      if (persistTimerRef.current) clearTimeout(persistTimerRef.current)
    }
  }, [tasks])

  // --- 调度器 ---
  useEffect(() => {
    const activeCount = tasks.filter((t) => t.status === 'downloading').length
    const nextTask = tasks.find((t) => t.status === 'queued')

    if (activeCount < maxConcurrent && nextTask) {
      startTask(nextTask)
    }
  }, [tasks, maxConcurrent])

  const startTask = (task: DownloadTask) => {
    setTasks((prev) =>
      prev.map((t) =>
        t.id === task.id
          ? {
              ...t,
              status: 'downloading',
              log: '正在连接...',
              totalSize: '计算中...' // 确保开始时重置
            }
          : t
      )
    )

    window.electron.startDownload(
      task.url,
      task.formatId,
      task.savePath,
      task.isAudioOnly,
      sessData,
      task.id
    )
  }

  const showToastMsg = (msg: string, type: 'success' | 'error' = 'success') => {
    setToast({ show: true, message: msg, type: type as any })
  }

  const handleAnalyze = async () => {
    if (!url) return showToastMsg('请填写链接', 'error')
    if (!savePath) return showToastMsg('请选择目录', 'error')

    setIsAnalyzing(true)
    setVideoData(null)
    try {
      const data = await window.electron.analyzeUrl({ url, sessData })
      setVideoData(data)
      setIsModalOpen(true)
    } catch (err) {
      showToastMsg('解析失败', 'error')
      setGlobalLogs((prev) => [...prev, `❌ 解析失败: ${err}`])
    } finally {
      setIsAnalyzing(false)
    }
  }

  const handleConfirmDownload = (formatId: string | null) => {
    setIsModalOpen(false)

    const selectedFormat = videoData?.formats.find((f: any) => f.format_id === formatId)
    if (!selectedFormat) {
      return showToastMsg('未选择格式或格式无效', 'error')
    }

    const newTask: DownloadTask = {
      id: crypto.randomUUID(),
      url,
      title: videoData?.title || url,
      status: 'queued',
      percent: 0,
      totalSize: '等待中...',
      formatId,
      isAudioOnly: mode === 'audio',
      savePath,
      ext: selectedFormat.ext,
      log: '等待调度...',
      files: [] // ✅ 新增
    }

    setTasks((prev) => [...prev, newTask])
    showToastMsg('已加入下载队列')
    setUrl('')
  }

  const handleDeleteClick = (task: DownloadTask) => {
    setDeleteMode('single')
    setDeleteTargets([task])
    setIsDeleteModalOpen(true)
  }

  const handleDeleteAllClick = () => {
    if (tasks.length === 0) return
    setDeleteMode('bulk')
    setDeleteTargets([...tasks]) // 或者用 visibleTasks：只删除当前筛选页
    setIsDeleteModalOpen(true)
  }

  const handleConfirmDelete = async (deleteLocal: boolean) => {
    if (!deleteTargets.length) return

    // ✅ 先关弹窗
    setIsDeleteModalOpen(false)

    const targets = [...deleteTargets]
    setDeleteTargets([])

    // 1) 先取消所有 downloading/queued（不删除记录也可以，但批量一般直接清）
    const needCancel = targets.filter((t) => t.status === 'downloading' || t.status === 'queued')
    await Promise.allSettled(needCancel.map((t) => window.electron.cancelDownload(t.id)))

    // 2) 删除本地文件（只删 completed；你想 error/canceled 也删的话可加条件）
    if (deleteLocal) {
      // 汇总路径（优先用 files，最精准）
      const paths: string[] = []
      for (const t of targets) {
        if (t.status !== 'completed') continue

        if (Array.isArray(t.files) && t.files.length > 0) {
          for (const p of t.files) {
            paths.push(p)
            // 顺手删 .part（如果存在）
            if (!p.endsWith('.part')) paths.push(`${p}.part`)
          }
        } else {
          // 兜底：老的按 title/ext（可能命不中，但不影响主流程）
          // @ts-ignore
          await window.electron.deleteLocalFile(t.savePath, t.title, t.ext)
        }
      }

      const uniq = Array.from(new Set(paths)).filter(Boolean)

      // 如果你有 deleteLocalFiles（推荐）
      if (uniq.length && window.electron.deleteLocalFiles) {
        await window.electron.deleteLocalFiles(uniq)
      }
    }

    // 3) 从列表移除（批量=清空；单个=移除一个）
    const removeIds = new Set(targets.map((t) => t.id))
    setTasks((prev) => prev.filter((t) => !removeIds.has(t.id)))

    showToastMsg(deleteMode === 'bulk' ? '已删除全部任务记录' : '任务已移除', 'success')
  }

  const handleCancelTask = async (id: string) => {
    try {
      const ok = await window.electron.cancelDownload(id)
      if (!ok) {
        showToastMsg('取消失败：未找到下载进程', 'error')
        return
      }
      setTasks((prev) =>
        prev.map((t) => (t.id === id ? { ...t, status: 'canceled', log: '任务已取消' } : t))
      )
      showToastMsg('任务已取消', 'error')
    } catch (e: any) {
      showToastMsg(`取消失败: ${String(e)}`, 'error')
    }
  }

  const handleSelectFolder = async () => {
    const path = await window.electron.selectFolder()
    if (path) setSavePath(path)
  }

  const visibleTasks = tasks
    .filter((t) => {
      if (tab === 'active') return t.status === 'downloading' || t.status === 'queued'
      if (tab === 'completed')
        return t.status === 'completed' || t.status === 'canceled' || t.status === 'error'
      return true
    })

    .sort((a, b) => {
      const statusOrder: any = { downloading: 1, queued: 2, error: 3, canceled: 4, completed: 5 }
      return (statusOrder[a.status] || 9) - (statusOrder[b.status] || 9)
    })

  function getStatusText(status: string) {
    switch (status) {
      case 'queued':
        return '排队中'
      case 'downloading':
        return '下载中'
      case 'completed':
        return '完成'
      case 'error':
        return '错误'
      case 'canceled':
        return '已取消'
      default:
        return ''
    }
  }

  function getStatusIcon(status: string) {
    switch (status) {
      case 'queued':
        return <Clock size={12} />
      case 'downloading':
        return <Download size={12} />
      case 'completed':
        return <CheckCircle2 size={12} />
      case 'error':
        return <AlertCircle size={12} />
      case 'canceled':
        return <X size={12} />
      default:
        return null
    }
  }

  function getStatusColor(status: string) {
    if (status === 'error' || status === 'canceled') return '#e91429'
    if (status === 'completed') return '#1db954'
    if (status === 'queued') return '#b3b3b3'
    return '#1db954'
  }

  return (
    <div className="app-layout">
      <div className="left-panel">
        <div className="header">
          <Music2 size={32} color="#1db954" />
          <h1 style={{ fontSize: '24px', margin: 0 }}>Downloader Pro</h1>
        </div>

        <div className="input-card">
          <div className="input-wrapper">
            <Link2 className="input-icon" size={18} />
            <input
              type="text"
              className="styled-input"
              placeholder="输入链接..."
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
          </div>

          {url && url.includes('bilibili') ? (
            <CookieManager
              sessData={sessData}
              setSessData={setSessData}
              handleLogin={async () => {
                const c = await window.electron.openLoginWindow()
                if (c) {
                  setSessData(c)
                  showToastMsg('登录成功')
                }
              }}
              showToastMsg={showToastMsg}
            />
          ) : null}

          <div className="options-row">
            <div style={{ flex: 1 }}>
              <CustomSelect
                value={mode}
                onChange={setMode}
                options={[
                  { value: 'video', label: '视频' },
                  { value: 'audio', label: '音频' }
                ]}
              />
            </div>
            <button className="icon-btn" onClick={handleSelectFolder}>
              <FolderOpen size={16} /> 目录
            </button>
          </div>

          <button
            className="download-btn"
            onClick={handleAnalyze}
            disabled={isAnalyzing || !savePath}
            style={{ marginTop: '15px' }}
          >
            {isAnalyzing ? '正在解析...' : '解析链接'} <Download size={20} />
          </button>
          <span style={{ fontSize: '12px', color: savePath ? '#999' : 'var(--error)' }}>
            {savePath ? `保存至: ${savePath}` : '请先选择保存目录'}
          </span>
        </div>

        <div className="logs-container" style={{ flex: 1, marginTop: '20px', minHeight: '150px' }}>
          <div className="logs-header">
            <Terminal size={14} /> <span>全局日志</span>
          </div>
          <div className="logs-content">
            {globalLogs.map((log, i) => (
              <div key={i}>{log}</div>
            ))}
            <div ref={logEndRef} />
          </div>
        </div>

        <div className="settings-row">
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              marginBottom: '10px',
              fontSize: '14px',
              color: '#ccc'
            }}
          >
            <span style={{ display: 'flex', gap: '5px', alignItems: 'center' }}>
              <Settings size={14} /> 最大并发数
            </span>
            <span>{maxConcurrent} / 10</span>
          </div>
          <input
            type="range"
            min="1"
            max="10"
            value={maxConcurrent}
            onChange={(e) => setMaxConcurrent(parseInt(e.target.value))}
            className="range-input"
          />
        </div>
      </div>

      <div className="right-panel">
        <div className="tabs">
          <button
            className={`tab-btn ${tab === 'all' ? 'active' : ''}`}
            onClick={() => setTab('all')}
          >
            全部 ({tasks.length})
          </button>
          <button
            className={`tab-btn ${tab === 'active' ? 'active' : ''}`}
            onClick={() => setTab('active')}
          >
            进行中 (
            {tasks.filter((t) => t.status === 'downloading' || t.status === 'queued').length})
          </button>
          <button
            className={`tab-btn ${tab === 'completed' ? 'active' : ''}`}
            onClick={() => setTab('completed')}
          >
            历史 ({tasks.filter((t) => t.status !== 'downloading' && t.status !== 'queued').length})
          </button>

          <button
            className="tab-btn"
            onClick={handleDeleteAllClick}
            disabled={tasks.length === 0}
            style={{
              marginLeft: 'auto',
              border: '1px solid var(--border)',
              color: 'var(--error)'
            }}
          >
            删除全部
          </button>
        </div>

        <div className="download-list">
          {visibleTasks.length === 0 && (
            <div style={{ textAlign: 'center', marginTop: '100px', color: '#555' }}>
              <div style={{ fontSize: '40px', marginBottom: '10px' }}>📭</div>
              {tab === 'all' && '没有任务，快去解析一个链接吧！'}
              {tab === 'active' && '当前没有任务正在下载或排队。'}
              {tab === 'completed' && '历史任务列表为空。'}
            </div>
          )}

          {visibleTasks.map((task) => (
            <div key={task.id} className="download-item">
              <div className="item-icon" style={{ backgroundColor: getStatusColor(task.status) }}>
                {task.isAudioOnly ? (
                  <Music2 size={20} color="black" />
                ) : (
                  <Film size={20} color="black" />
                )}
              </div>

              <div className="item-info">
                <div className="item-title" title={task.title}>
                  {task.title}
                </div>
                <div className="item-meta">
                  <span
                    style={{
                      display: 'flex',
                      gap: '5px',
                      alignItems: 'center',
                      color: getStatusColor(task.status)
                    }}
                  >
                    {getStatusIcon(task.status)}
                    {getStatusText(task.status)} ({task.percent.toFixed(1)}%)
                  </span>
                  <span>{task.totalSize}</span>
                </div>

                <div className="item-progress-bg">
                  <div
                    className="item-progress-fill"
                    style={{
                      width: `${task.percent}%`,
                      backgroundColor: getStatusColor(task.status)
                    }}
                  />
                </div>

                <div
                  style={{
                    fontSize: '12px',
                    color: '#666',
                    marginTop: '4px',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap'
                  }}
                >
                  {task.log}
                </div>
              </div>

              <div>
                {task.status === 'downloading' || task.status === 'queued' ? (
                  <button
                    onClick={() => handleCancelTask(task.id)}
                    className="icon-btn"
                    style={{ backgroundColor: 'var(--error)', padding: '8px' }}
                  >
                    <X size={18} color="white" />
                  </button>
                ) : (
                  <button
                    onClick={() => handleDeleteClick(task)}
                    className="icon-btn"
                    style={{
                      backgroundColor: 'transparent',
                      border: '1px solid var(--border)',
                      padding: '8px'
                    }}
                  >
                    <Trash2 size={18} color="var(--text-sub)" />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      <ConfirmModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        onConfirm={handleConfirmDownload}
        data={videoData}
        mode={mode}
      />

      <ConfirmDeleteModal
        isOpen={isDeleteModalOpen}
        onClose={() => setIsDeleteModalOpen(false)}
        onConfirm={handleConfirmDelete}
        taskTitle={deleteMode === 'single' ? deleteTargets[0]?.title || '未知任务' : undefined}
        isBatch={deleteMode === 'bulk'}
        count={deleteMode === 'bulk' ? deleteTargets.length : 0}
      />

      <Toast {...toast} onClose={() => setToast((p) => ({ ...p, show: false }))} />
    </div>
  )
}

export default App
