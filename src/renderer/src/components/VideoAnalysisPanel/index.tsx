import { useState, useEffect, useRef, JSX } from 'react'
import {
  Play, Square, AlertCircle, Activity, FolderOpen, Copy, CheckCircle2,
  Clock, Settings, FileText, ChevronDown, ChevronRight, ExternalLink
} from 'lucide-react'
import {
  SummaryContent,
  KeyPointsContent,
  MindMapContent,
  type KeyPoint,
  type MindMapNode,
  type SummaryResult
} from '../AnalysisResultCard'
import './index.css'

interface AnalysisProgress {
  id: string; stage: string; percent: number; overallPercent: number
  message: string; elapsed: number
}

interface WhisperSegment {
  start: number; end: number; text: string
}

interface AnalysisResult {
  id: string; title: string; url: string
  subtitleSource: 'external' | 'asr' | 'ocr' | 'none'
  transcript: { fullText: string; segments: WhisperSegment[]; language: string; processingTime: number }
  outputFiles: { txt: string; json: string; readme?: string; analysisMd?: string; promptMd?: string }
  savePath: string
  summary?: SummaryResult
  keyPoints?: KeyPoint[]
  mindMap?: MindMapNode
  llmProvider?: LLMProvider
  llmModel?: string
  error?: string
}

type LLMProvider = 'deepseek' | 'openai' | 'codex-cli'
type ContentAnalysisType = 'summary' | 'key-points' | 'mind-map'

interface ExistingTranscriptCandidate {
  path: string
  name: string
  kind: 'transcript' | 'readme'
  recommended: boolean
}

interface DepsStatus {
  whisperAvailable: boolean; modelAvailable: boolean; modelPath: string
}

interface Props {
  savePath: string
  sessData: string
  onLog?: (message: string) => void
}

const STAGES = ['fetching-info', 'downloading', 'extracting-audio', 'transcribing', 'cross-validating', 'analyzing', 'done'] as const
const STAGE_LABELS: Record<string, string> = {
  'checking-deps': '检查依赖',
  'fetching-info': '获取信息',
  'downloading': '下载视频',
  'extracting-audio': '提取音频',
  'transcribing': '语音识别',
  'cross-validating': 'ASR+OCR 校验',
  'analyzing': 'AI 内容分析',
  'done': '完成'
}

type ResultTab = 'article' | 'summary' | 'key-points' | 'mind-map' | 'transcript'

export function VideoAnalysisPanel({ savePath, sessData, onLog }: Props): JSX.Element {
  const log = (msg: string) => { onLog?.(msg) }
  const [url, setUrl] = useState('')
  const [strategy, setStrategy] = useState<'asr-only' | 'ocr'>('asr-only')
  const [model, setModel] = useState<'tiny' | 'base' | 'small' | 'medium' | 'large-v3'>('medium')
  const [language, setLanguage] = useState('zh')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [llmProvider, setLlmProvider] = useState<LLMProvider>('deepseek')
  const [llmModel, setLlmModel] = useState('deepseek-chat')
  const [llmApiKey, setLlmApiKey] = useState('')
  const [saveApiKey, setSaveApiKey] = useState(false)
  const [analysisTypes, setAnalysisTypes] = useState<ContentAnalysisType[]>(['summary', 'key-points', 'mind-map'])
  const [existingFolderPath, setExistingFolderPath] = useState('')
  const [existingCandidates, setExistingCandidates] = useState<ExistingTranscriptCandidate[]>([])
  const [selectedTranscriptPath, setSelectedTranscriptPath] = useState('')

  const [analyzing, setAnalyzing] = useState(false)
  const [progress, setProgress] = useState<AnalysisProgress | null>(null)
  const [result, setResult] = useState<AnalysisResult | null>(null)
  const [deps, setDeps] = useState<DepsStatus | null>(null)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)

  // Unified tab state
  const [activeTab, setActiveTab] = useState<ResultTab>('article')
  const [analysisArticle, setAnalysisArticle] = useState('')
  const [articleLoading, setArticleLoading] = useState(false)
  const [showFileDetails, setShowFileDetails] = useState(false)

  const currentIdRef = useRef<string>('')
  const resultRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    window.electron.checkAnalysisDeps?.().then(setDeps).catch(() => {})
    window.electron.getLlmSettings?.().then((settings) => {
      setLlmProvider(settings.provider)
      setLlmModel(settings.model)
      setLlmApiKey(settings.apiKey || '')
      setSaveApiKey(settings.saveApiKey)
    }).catch(() => {})
  }, [])

  useEffect(() => {
    let lastStage = ''
    window.electron.onAnalysisProgress((data: AnalysisProgress) => {
      if (data.id === currentIdRef.current) {
        setProgress(data)
        // Emit log on stage change or at meaningful percent milestones
        if (data.stage !== lastStage) {
          lastStage = data.stage
          log(`[${STAGE_LABELS[data.stage] || data.stage}] ${data.message}`)
        } else if (data.percent % 25 === 0 && data.percent > 0) {
          log(`  ${STAGE_LABELS[data.stage] || data.stage} ${data.percent}%`)
        }
      }
    })
    window.electron.onAnalysisComplete((data: AnalysisResult) => {
      if (data.id === currentIdRef.current) {
        setAnalyzing(false)
        setProgress(null)
        if (data.error) {
          setError(data.error)
          log(`❌ 分析失败: ${data.error}`)
        } else {
          log(`✅ 分析完成: ${data.title} · ${data.transcript.segments.length}段 · ${data.subtitleSource === 'external' ? '外挂字幕' : data.subtitleSource === 'ocr' ? 'ASR+OCR 校验' : 'GPU ASR'}`)
          if (data.llmProvider) log(`  LLM: ${data.llmProvider}/${data.llmModel}`)
          setResult(data)
          // Load analysis.md content
          if (data.outputFiles.analysisMd) {
            setArticleLoading(true)
            setActiveTab('article')
            window.electron.readAnalysisFile(data.outputFiles.analysisMd)
              .then((content) => { setAnalysisArticle(content); setArticleLoading(false) })
              .catch(() => { setArticleLoading(false) })
          }
        }
      }
    })
    window.electron.onAnalysisError((data: { id: string; error: string }) => {
      if (data.id === currentIdRef.current) {
        setAnalyzing(false); setProgress(null); setError(data.error)
        log(`❌ 分析错误: ${data.error}`)
      }
    })
    return () => {
      window.electron.onAnalysisProgress(() => {})
      window.electron.onAnalysisComplete(() => {})
      window.electron.onAnalysisError(() => {})
    }
  }, [])

  // Scroll into result view
  useEffect(() => { resultRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [result])

  const handleProviderChange = (provider: LLMProvider) => {
    setLlmProvider(provider)
    if (provider === 'deepseek') setLlmModel('deepseek-chat')
    else setLlmModel('gpt-5.5')
    if (provider === 'codex-cli') {
      setLlmApiKey('')
      setSaveApiKey(false)
    }
  }

  const toggleAnalysisType = (type: ContentAnalysisType) => {
    setAnalysisTypes((current) =>
      current.includes(type) ? current.filter((item) => item !== type) : [...current, type]
    )
  }

  const saveCurrentLlmSettings = async () => {
    await window.electron.saveLlmSettings?.({
      provider: llmProvider,
      model: llmModel,
      apiKey: llmApiKey,
      saveApiKey
    })
  }

  const handleStart = async () => {
    if (!url.trim()) return
    if (!savePath) { setError('请先在左侧面板选择保存目录'); return }

    setError(''); setResult(null); setAnalyzing(true)
    const id = crypto.randomUUID()
    currentIdRef.current = id
    log(`🚀 开始视频分析: ${url.trim()}`)

    try {
      await saveCurrentLlmSettings()
      const res = await window.electron.startAnalysis({
        id,
        url: url.trim(),
        savePath,
        sessData,
        strategy,
        model,
        language,
        llmProvider,
        llmModel,
        llmApiKey: llmApiKey.trim() || undefined,
        analysisTypes
      })
      if (res?.error) { setError(res.error); setAnalyzing(false) }
      else if (res?.transcript) { setResult(res); setAnalyzing(false) }
    } catch (e: any) {
      setError(e?.message || String(e)); setAnalyzing(false)
    }
  }

  const handleSelectExistingFolder = async () => {
    const folder = await window.electron.selectAnalysisFolder()
    if (!folder) return

    setExistingFolderPath(folder)
    setSelectedTranscriptPath('')
    setExistingCandidates([])
    setError('')

    try {
      const candidates = await window.electron.listExistingTranscripts(folder)
      setExistingCandidates(candidates)
      setSelectedTranscriptPath(candidates[0]?.path || '')
      if (!candidates.length) {
        setError('没有找到候选转录文件：请使用 transcript.txt、transcript.md、transcript.llm.md，或包含"## 转录文本"的 README.md。')
      }
    } catch (e: any) {
      setError(e?.message || String(e))
    }
  }

  const handleAnalyzeExisting = async () => {
    if (!existingFolderPath) { setError('请先选择已有文章文件夹'); return }
    if (!selectedTranscriptPath) { setError('请先选择要分析的转录文件'); return }

    setError(''); setResult(null); setAnalyzing(true)
    const id = crypto.randomUUID()
    currentIdRef.current = id
    log(`📂 已有文本分析: ${existingFolderPath} (${selectedTranscriptPath.split(/[/\\]/).pop()})`)

    try {
      await saveCurrentLlmSettings()
      const res = await window.electron.analyzeExistingFolder({
        id,
        folderPath: existingFolderPath,
        transcriptPath: selectedTranscriptPath,
        llmProvider,
        llmModel,
        llmApiKey: llmApiKey.trim() || undefined,
        analysisTypes,
        language
      })
      if (res?.error) { setError(res.error); setAnalyzing(false) }
      else if (res?.transcript) { setResult(res); setAnalyzing(false) }
    } catch (e: any) {
      setError(e?.message || String(e)); setAnalyzing(false)
    }
  }

  const handleCancel = async () => {
    if (currentIdRef.current) {
      await window.electron.cancelAnalysis(currentIdRef.current)
      setAnalyzing(false); setProgress(null)
      log('⏹ 已取消分析')
    }
  }

  const handleCopy = async (text: string) => {
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const handleOpenFile = (filePath?: string) => {
    if (filePath) window.electron.showItemInFolder(filePath)
  }

  const formatTime = (ms: number) => {
    const total = Math.floor(ms / 1000)
    const m = Math.floor(total / 60)
    const s = total % 60
    return `${m}:${String(s).padStart(2, '0')}`
  }

  const formatElapsed = (sec: number) => {
    if (sec < 60) return `${sec}s`
    return `${Math.floor(sec / 60)}m ${sec % 60}s`
  }

  const getStageIndex = (stage: string) => {
    const idx = STAGES.indexOf(stage as any)
    return idx >= 0 ? idx : (stage === 'checking-deps' ? -1 : STAGES.length)
  }

  const handleSeekTranscript = (seconds: number) => {
    setActiveTab('transcript')
    // Scroll to segment after a tick
    setTimeout(() => {
      const targetMs = seconds * 1000
      const node = contentRef.current?.querySelector<HTMLElement>(`[data-start-ms="${targetMs}"]`)
        || contentRef.current?.querySelector<HTMLElement>('[data-segment-row]')
      node?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }, 50)
  }

  // Simple markdown → HTML line-by-line renderer (handles tables, lists, code blocks)
  const renderMarkdown = (md: string): string => {
    const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

    const lines = md.split('\n')
    const result: string[] = []
    let inTable = false
    let inCodeBlock = false
    let inList = false
    let tableRows: string[] = []

    const inlineFormat = (text: string): string => {
      return escapeHtml(text)
        .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.+?)\*/g, '<em>$1</em>')
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>')
    }

    const flushTable = () => {
      if (!tableRows.length) return
      result.push('<table>')
      tableRows.forEach((row, idx) => {
        const cells = row.split('|').map(c => c.trim()).filter(c => c !== '')
        if (cells.every(c => /^[-:\s]+$/.test(c))) return // skip separator row
        const tag = idx === 0 ? 'th' : 'td'
        result.push(`<tr>${cells.map(c => `<${tag}>${inlineFormat(c)}</${tag}>`).join('')}</tr>`)
      })
      result.push('</table>')
      tableRows = []
      inTable = false
    }

    const flushList = () => {
      if (inList) { result.push('</ul>'); inList = false }
    }

    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i]
      const trimmed = raw.trim()

      // Code block toggle
      if (trimmed.startsWith('```')) {
        flushTable(); flushList()
        inCodeBlock = !inCodeBlock
        result.push(inCodeBlock ? '<pre><code>' : '</code></pre>')
        continue
      }
      if (inCodeBlock) {
        result.push(escapeHtml(raw))
        continue
      }

      // Table
      if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
        flushList()
        if (!inTable) { inTable = true }
        tableRows.push(trimmed)
        continue
      } else if (inTable) {
        flushTable()
      }

      // Horizontal rule
      if (/^[-*_]{3,}$/.test(trimmed)) {
        flushList()
        result.push('<hr/>')
        continue
      }

      // Headers
      if (trimmed.startsWith('#### ')) { flushList(); result.push(`<h4>${inlineFormat(trimmed.slice(5))}</h4>`); continue }
      if (trimmed.startsWith('### ')) { flushList(); result.push(`<h3>${inlineFormat(trimmed.slice(4))}</h3>`); continue }
      if (trimmed.startsWith('## ')) { flushList(); result.push(`<h2>${inlineFormat(trimmed.slice(3))}</h2>`); continue }
      if (trimmed.startsWith('# ')) { flushList(); result.push(`<h1>${inlineFormat(trimmed.slice(2))}</h1>`); continue }

      // Unordered list items
      if (/^[-*] /.test(trimmed)) {
        if (!inList) { result.push('<ul>'); inList = true }
        result.push(`<li>${inlineFormat(trimmed.slice(2))}</li>`)
        continue
      } else {
        flushList()
      }

      // Empty line
      if (!trimmed) { result.push('<br/>'); continue }

      // Paragraph
      result.push(`<p>${inlineFormat(trimmed)}</p>`)
    }

    flushTable()
    flushList()
    if (inCodeBlock) result.push('</code></pre>')

    return result.join('\n')
  }

  // Available tabs based on result data
  const availableTabs: { key: ResultTab; label: string }[] = []
  if (analysisArticle || result?.outputFiles?.analysisMd) {
    availableTabs.push({ key: 'article', label: '分析文章' })
  }
  if (result?.summary) availableTabs.push({ key: 'summary', label: '摘要' })
  if (result?.keyPoints?.length) availableTabs.push({ key: 'key-points', label: '要点' })
  if (result?.mindMap) availableTabs.push({ key: 'mind-map', label: '思维导图' })
  availableTabs.push({ key: 'transcript', label: '转录文本' })

  return (
    <div className="analysis-panel">
      {/* 依赖状态 */}
      {deps && (!deps.whisperAvailable || !deps.modelAvailable) && (
        <div className="deps-warning">
          <h4>GPU 依赖未就绪</h4>
          <div>whisper-cli: {deps.whisperAvailable ? '✅' : '❌'} | 模型: {deps.modelAvailable ? '✅' : '❌'}</div>
        </div>
      )}

      {/* === 控制栏 === */}
      <div className="analysis-controls">
        <div className="control-group" style={{ flex: 1, minWidth: 240 }}>
          <label>视频链接</label>
          <input
            type="text" className="styled-input"
            placeholder="粘贴 B站 / YouTube 链接..."
            value={url} onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleStart()}
            disabled={analyzing} style={{ width: '100%' }}
          />
        </div>
        <div className="control-group">
          <label>策略</label>
          <select value={strategy} onChange={(e) => setStrategy(e.target.value as any)} disabled={analyzing}>
            <option value="asr-only">ASR 转录</option>
            <option value="ocr">ASR+OCR 交叉验证</option>
          </select>
        </div>
        <div className="control-group">
          <label>模型</label>
          <select value={model} onChange={(e) => setModel(e.target.value as any)} disabled={analyzing}>
            <option value="large-v3">large-v3 (最准 ~3GB)</option>
            <option value="medium">medium (推荐 ~1.5GB)</option>
          </select>
        </div>
        <div className="control-group">
          <label>语言</label>
          <select value={language} onChange={(e) => setLanguage(e.target.value)} disabled={analyzing}>
            <option value="zh">中文</option><option value="en">English</option>
            <option value="ja">日本語</option><option value="auto">自动</option>
          </select>
        </div>
        {analyzing ? (
          <button className="analysis-btn cancel" onClick={handleCancel}><Square size={14} /> 取消</button>
        ) : (
          <button className="analysis-btn" onClick={handleStart} disabled={!url.trim() || !savePath}>
            <Play size={14} /> 分析
          </button>
        )}
      </div>

      {/* === 已有文本分析 === */}
      <div className="existing-analysis-panel">
        <div className="existing-header">
          <div>
            <div className="existing-title">已有文本分析</div>
            <div className="existing-subtitle">只读取 transcript.txt / transcript.md / transcript.llm.md / README.md</div>
          </div>
          <button className="icon-btn" onClick={handleSelectExistingFolder} disabled={analyzing}>
            <FolderOpen size={14} /> 选择文件夹
          </button>
        </div>
        {existingFolderPath && (
          <div className="existing-controls">
            <input className="styled-input existing-path" value={existingFolderPath} readOnly />
            <select
              value={selectedTranscriptPath}
              onChange={(e) => setSelectedTranscriptPath(e.target.value)}
              disabled={analyzing || !existingCandidates.length}
            >
              {existingCandidates.length ? existingCandidates.map((candidate) => (
                <option key={candidate.path} value={candidate.path}>
                  {candidate.name}{candidate.recommended ? ' (推荐)' : ''}
                </option>
              )) : (
                <option value="">未找到候选文件</option>
              )}
            </select>
            <button
              className="analysis-btn"
              onClick={handleAnalyzeExisting}
              disabled={analyzing || !selectedTranscriptPath}
            >
              <Play size={14} /> 分析已有文本
            </button>
          </div>
        )}
      </div>

      {/* === LLM 设置 === */}
      <div className="llm-settings">
        <button className="settings-toggle" onClick={() => setSettingsOpen(!settingsOpen)} type="button">
          <Settings size={14} /> LLM 设置
        </button>
        {settingsOpen && (
          <div className="llm-settings-body">
            <div className="control-group">
              <label>Provider</label>
              <select value={llmProvider} onChange={(e) => handleProviderChange(e.target.value as LLMProvider)} disabled={analyzing}>
                <option value="deepseek">DeepSeek v4</option>
                <option value="openai">GPT 5.5</option>
                <option value="codex-cli">Codex CLI</option>
              </select>
            </div>
            <div className="control-group">
              <label>模型</label>
              <select value={llmModel} onChange={(e) => setLlmModel(e.target.value)} disabled={analyzing}>
                {llmProvider === 'deepseek' ? (
                  <>
                    <option value="deepseek-chat">deepseek-chat (pro)</option>
                    <option value="deepseek-chat-flash">deepseek-chat (flash)</option>
                  </>
                ) : (
                  <option value="gpt-5.5">gpt-5.5</option>
                )}
              </select>
            </div>
            {llmProvider !== 'codex-cli' && (
              <div className="control-group api-key-group">
                <label>API Key</label>
                <input
                  type="password"
                  className="styled-input"
                  value={llmApiKey}
                  onChange={(e) => setLlmApiKey(e.target.value)}
                  placeholder={llmProvider === 'deepseek' ? 'DEEPSEEK_API_KEY' : 'OPENAI_API_KEY'}
                  disabled={analyzing}
                />
              </div>
            )}
            {llmProvider !== 'codex-cli' && (
              <label className="save-key-option">
                <input
                  type="checkbox"
                  checked={saveApiKey}
                  onChange={(e) => setSaveApiKey(e.target.checked)}
                  disabled={analyzing}
                />
                保存 API key
              </label>
            )}
            <div className="analysis-type-options">
              <label><input type="checkbox" checked={analysisTypes.includes('summary')} onChange={() => toggleAnalysisType('summary')} disabled={analyzing} /> 摘要</label>
              <label><input type="checkbox" checked={analysisTypes.includes('key-points')} onChange={() => toggleAnalysisType('key-points')} disabled={analyzing} /> 要点</label>
              <label><input type="checkbox" checked={analysisTypes.includes('mind-map')} onChange={() => toggleAnalysisType('mind-map')} disabled={analyzing} /> 思维导图</label>
            </div>
          </div>
        )}
      </div>

      {/* === 进度面板 === */}
      {progress && (
        <div className="analysis-progress">
          <div className="progress-top">
            <div>
              <div className="progress-stage-name">
                {STAGE_LABELS[progress.stage] || progress.stage}
              </div>
              <div className="progress-stage-detail">
                阶段进度 {progress.percent}%
              </div>
            </div>
            <div className="progress-right">
              <div className="progress-pct">{progress.overallPercent}%</div>
              <div className="progress-elapsed">
                <Clock size={10} style={{ verticalAlign: 'middle', marginRight: 2 }} />
                {formatElapsed(progress.elapsed)}
              </div>
            </div>
          </div>

          <div className="stage-indicator">
            {STAGES.map((s) => {
              const si = STAGES.indexOf(s)
              const currentIdx = getStageIndex(progress.stage)
              let cls = ''
              if (si < currentIdx) cls = 'done'
              else if (si === currentIdx) cls = 'active'
              return <div key={s} className={`stage-dot ${cls}`} style={{ flex: 1 }} title={STAGE_LABELS[s]} />
            })}
          </div>

          {progress.stage !== 'done' && (
            <div className="progress-bar-bg" style={{ marginTop: 10 }}>
              <div className="progress-bar-fill" style={{ width: `${progress.percent}%` }} />
            </div>
          )}

          <div className="progress-msg">{progress.message}</div>
        </div>
      )}

      {/* === 错误 === */}
      {error && (
        <div className="error-banner">
          <AlertCircle size={16} style={{ flexShrink: 0, marginTop: 1 }} />
          <span>{error}</span>
        </div>
      )}

      {/* === 完成提示 (redesigned: compact) === */}
      {result && (
        <div className="completion-banner">
          <span className="completion-icon">✅</span>
          <div className="completion-summary">
            <strong>分析完成</strong>
            <span className="completion-meta">
              · {result.transcript.segments.length} 段
              · {result.subtitleSource === 'external' ? '外挂字幕' : result.subtitleSource === 'ocr' ? 'ASR+OCR 校验' : 'GPU 语音识别'}
              {result.llmProvider && <> · {result.llmProvider} / {result.llmModel}</>}
            </span>
          </div>
          <div className="completion-actions">
            <button className="completion-btn primary" onClick={() => handleOpenFile(result.outputFiles.analysisMd)} title="打开分析文章">
              <FileText size={14} /> 分析文章
            </button>
            <button className="completion-btn" onClick={() => handleOpenFile(result.savePath || result.outputFiles.analysisMd)} title="打开文件夹">
              <FolderOpen size={14} /> 文件夹
            </button>
            {result.outputFiles.promptMd && (
              <button className="completion-btn" onClick={() => handleOpenFile(result.outputFiles.promptMd)} title="查看 Prompt">
                <ExternalLink size={14} /> Prompt
              </button>
            )}
            <button className="completion-btn" onClick={() => handleCopy(result.transcript.fullText)} title="复制全文">
              {copied ? <CheckCircle2 size={14} color="#1db954" /> : <Copy size={14} />}
              {copied ? '已复制' : '复制'}
            </button>
          </div>
          <button
            className="file-details-toggle"
            onClick={() => setShowFileDetails(!showFileDetails)}
            title={showFileDetails ? '收起路径' : '显示文件路径'}
          >
            {showFileDetails ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            文件路径
          </button>
          {showFileDetails && (
            <div className="file-details">
              {result.outputFiles.analysisMd && (
                <div className="file-detail-row">
                  <span className="file-label">分析文章</span>
                  <code className="file-path-code">{result.outputFiles.analysisMd}</code>
                </div>
              )}
              {result.outputFiles.promptMd && (
                <div className="file-detail-row">
                  <span className="file-label">Prompt</span>
                  <code className="file-path-code">{result.outputFiles.promptMd}</code>
                </div>
              )}
              <div className="file-detail-row">
                <span className="file-label">数据</span>
                <code className="file-path-code">{result.outputFiles.json}</code>
              </div>
              <div className="file-detail-row">
                <span className="file-label">转录</span>
                <code className="file-path-code">{result.outputFiles.txt}</code>
              </div>
            </div>
          )}
        </div>
      )}

      {/* === 结果面板 (unified tabs) === */}
      {result && (
        <div className="analysis-result" ref={resultRef}>
          <div className="result-header">
            <div className="result-title-row">
              <span className="result-title">{result.title}</span>
              <span className={`result-badge ${result.subtitleSource === 'asr' ? 'asr' : ''}`}>
                {result.subtitleSource === 'external' ? '📝 字幕' : result.subtitleSource === 'ocr' ? '🔍 ASR+OCR 校验' : '🎙 GPU ASR'} · {model}
              </span>
            </div>
            <div className="result-actions">
              <button className="icon-btn" onClick={() => handleOpenFile(result.outputFiles.analysisMd)} title="打开分析文章">
                <FileText size={14} /> 分析文章
              </button>
              <button className="icon-btn" onClick={() => handleOpenFile(result.savePath || result.outputFiles.analysisMd)} title="打开文件位置">
                <FolderOpen size={14} /> 文件夹
              </button>
            </div>
          </div>

          {/* Unified tab bar */}
          <div className="result-tabs">
            {availableTabs.map((tab) => (
              <button
                key={tab.key}
                className={`result-tab ${activeTab === tab.key ? 'active' : ''}`}
                onClick={() => setActiveTab(tab.key)}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* Single-scroll content area */}
          <div className="result-content" ref={contentRef}>
            {activeTab === 'article' && (
              <div className="analysis-article">
                {articleLoading ? (
                  <div className="article-loading">加载分析文章中...</div>
                ) : analysisArticle ? (
                  <div className="markdown-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(analysisArticle) }} />
                ) : (
                  <div className="article-empty">
                    <p>分析文章尚未生成。</p>
                    <button className="analysis-btn" onClick={() => handleOpenFile(result.outputFiles.analysisMd)}>
                      <FileText size={14} /> 打开文件
                    </button>
                  </div>
                )}
              </div>
            )}

            {activeTab === 'summary' && result.summary && (
              <SummaryContent summary={result.summary} />
            )}

            {activeTab === 'key-points' && !!result.keyPoints?.length && (
              <KeyPointsContent keyPoints={result.keyPoints} onSeek={handleSeekTranscript} />
            )}

            {activeTab === 'mind-map' && result.mindMap && (
              <MindMapContent mindMap={result.mindMap} />
            )}

            {activeTab === 'transcript' && (
              <div className="transcript-content">
                {result.transcript.segments.length === 0 ? (
                  <div style={{ color: '#555', textAlign: 'center', padding: 40 }}>无内容</div>
                ) : (
                  result.transcript.segments.map((seg, i) => (
                    <div key={i} className="segment" data-segment-row data-start-ms={seg.start}>
                      <span className="segment-time">{formatTime(seg.start)}</span>
                      <span className="segment-text">{seg.text}</span>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* === 空状态 === */}
      {!analyzing && !result && !error && (
        <div className="empty-state">
          <Activity size={48} strokeWidth={1} className="icon" />
          <div style={{ fontSize: 14 }}>粘贴视频链接，点击"分析"</div>
          <div style={{ fontSize: 11, color: '#2a2a2a' }}>
            支持 B站 / YouTube · GPU 加速 (Vulkan)
          </div>
        </div>
      )}
    </div>
  )
}
