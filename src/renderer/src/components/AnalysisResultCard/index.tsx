import { JSX, useState } from 'react'
import { Brain, ChevronDown, ChevronRight, ListChecks, Sparkles } from 'lucide-react'
import './index.css'

export type AnalysisTab = 'summary' | 'key-points' | 'mind-map'

export interface SummaryResult {
  text: string
  style: 'concise' | 'detailed'
}

export interface KeyPoint {
  title: string
  description: string
  timestamp: number
  importance: 1 | 2 | 3 | 4 | 5
}

export interface MindMapNode {
  topic: string
  children: MindMapNode[]
}

// ── Pure content renderers (no wrapper, no tab bar) ──

export function SummaryContent({ summary }: { summary: SummaryResult }): JSX.Element {
  return <div className="summary-text">{summary.text}</div>
}

export function KeyPointsContent({
  keyPoints,
  onSeek
}: {
  keyPoints: KeyPoint[]
  onSeek?: (seconds: number) => void
}): JSX.Element {
  return (
    <div className="key-point-list">
      {keyPoints.map((point, index) => (
        <div className="key-point-row" key={`${point.timestamp}-${index}`}>
          <button
            className="key-point-time"
            onClick={() => onSeek?.(point.timestamp)}
            title="跳转到这个时间点"
          >
            {formatSeconds(point.timestamp)}
          </button>
          <div className="key-point-content">
            <div className="key-point-title">
              {point.title}
              <span className="importance">重要度 {point.importance}</span>
            </div>
            <div className="key-point-description">{point.description}</div>
          </div>
        </div>
      ))}
    </div>
  )
}

export function MindMapContent({ mindMap }: { mindMap: MindMapNode }): JSX.Element {
  return (
    <div className="mind-map-tree">
      <MindMapTree node={mindMap} defaultOpen />
    </div>
  )
}

// ── Tree renderer ──

export function MindMapTree({ node, defaultOpen = false }: { node: MindMapNode; defaultOpen?: boolean }): JSX.Element {
  const [open, setOpen] = useState(defaultOpen)
  const hasChildren = node.children?.length > 0

  return (
    <div className="mind-map-node">
      <div className="mind-map-label">
        {hasChildren ? (
          <button className="tree-toggle" onClick={() => setOpen(!open)} title={open ? '收起' : '展开'}>
            {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
        ) : (
          <span className="tree-spacer" />
        )}
        <span>{node.topic}</span>
      </div>
      {hasChildren && open && (
        <div className="mind-map-children">
          {node.children.map((child, index) => (
            <MindMapTree node={child} key={`${child.topic}-${index}`} />
          ))}
        </div>
      )}
    </div>
  )
}

// ── Legacy card wrapper (kept for backward compat) ──

interface CardProps {
  summary?: SummaryResult
  keyPoints?: KeyPoint[]
  mindMap?: MindMapNode
  onSeek?: (seconds: number) => void
}

export function AnalysisResultCard({ summary, keyPoints, mindMap, onSeek }: CardProps): JSX.Element | null {
  const tabs: AnalysisTab[] = []
  if (summary) tabs.push('summary')
  if (keyPoints?.length) tabs.push('key-points')
  if (mindMap) tabs.push('mind-map')

  const [activeTab, setActiveTab] = useState<AnalysisTab>(tabs[0] || 'summary')

  if (!tabs.length) return null

  return (
    <div className="analysis-result-card">
      <div className="ai-card-tabs">
        {tabs.includes('summary') && (
          <button className={activeTab === 'summary' ? 'active' : ''} onClick={() => setActiveTab('summary')}>
            <Sparkles size={14} /> 摘要
          </button>
        )}
        {tabs.includes('key-points') && (
          <button className={activeTab === 'key-points' ? 'active' : ''} onClick={() => setActiveTab('key-points')}>
            <ListChecks size={14} /> 要点
          </button>
        )}
        {tabs.includes('mind-map') && (
          <button className={activeTab === 'mind-map' ? 'active' : ''} onClick={() => setActiveTab('mind-map')}>
            <Brain size={14} /> 思维导图
          </button>
        )}
      </div>

      <div className="ai-card-body">
        {activeTab === 'summary' && summary && <SummaryContent summary={summary} />}
        {activeTab === 'key-points' && !!keyPoints?.length && (
          <KeyPointsContent keyPoints={keyPoints} onSeek={onSeek} />
        )}
        {activeTab === 'mind-map' && mindMap && <MindMapContent mindMap={mindMap} />}
      </div>
    </div>
  )
}

export function formatSeconds(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}
