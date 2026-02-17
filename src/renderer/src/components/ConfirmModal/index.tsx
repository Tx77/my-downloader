import { useState, useEffect, useMemo } from 'react'
import { X, Film, Music } from 'lucide-react'
import './index.css'

interface Format {
  format_id: string
  ext: string
  resolution: string
  filesize: string
  vcodec: string
  acodec: string
  abr?: number
  tbr: number
}

interface VideoData {
  title: string
  thumbnail: string
  duration: string
  formats: Format[]
}

interface ConfirmModalProps {
  isOpen: boolean
  onClose: () => void
  onConfirm: (formatId: string | null) => void
  data: VideoData | null
  mode: 'video' | 'audio'
}

export function ConfirmModal({ isOpen, onClose, onConfirm, data, mode }: ConfirmModalProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const formatsToShow = useMemo(() => {
    if (!data?.formats) return []
    return data.formats.filter((f) => {
      if (mode === 'audio') {
        // 只展示“纯音频”
        return f.vcodec === 'none' && f.acodec && f.acodec !== 'none'
      }
      // video：只要不是明确“无视频流”，都允许展示（兼容部分站点字段缺失）
      return f.vcodec !== 'none'
    })
  }, [data, mode])

  useEffect(() => {
    if (isOpen && formatsToShow.length > 0) {
      setSelectedId(formatsToShow[0].format_id)
    } else {
      setSelectedId(null)
    }
  }, [isOpen, formatsToShow])

  if (!isOpen || !data) return null

  const handleConfirm = () => {
    onConfirm(formatsToShow.length > 0 ? selectedId : null)
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3 className="modal-title">{mode === 'video' ? '确认视频下载' : '确认音频下载'}</h3>
          <button className="close-btn" onClick={onClose} title="关闭">
            <X size={20} />
          </button>
        </div>

        <div className="video-info">
          <img
            src={data.thumbnail}
            alt={data.title}
            className="thumbnail"
            referrerPolicy="no-referrer"
          />
          <div className="info-text">
            <h4 className="video-title" title={data.title}>
              {data.title}
            </h4>
            <div className="video-meta">
              <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                {mode === 'video' ? <Film size={14} /> : <Music size={14} />}
                {mode === 'video' ? '视频' : '音频'}
              </span>
              <span>时长: {data.duration}</span>
            </div>
          </div>
        </div>

        <div className="format-section-title">选择画质 / 格式</div>

        <div className="format-list">
          {formatsToShow.length > 0 ? (
            formatsToShow.map((format) => (
              <label
                key={format.format_id}
                className={`format-item ${selectedId === format.format_id ? 'selected' : ''}`}
              >
                <input
                  type="radio"
                  name="format"
                  checked={selectedId === format.format_id}
                  onChange={() => setSelectedId(format.format_id)}
                />
                <div className="format-details">
                  <span className="format-resolution">{format.resolution}</span>

                  <div className="format-meta">
                    <span>{format.filesize}</span>
                    <span style={{ textTransform: 'uppercase' }}>{format.ext}</span>

                    {format.vcodec && format.vcodec !== 'none' && (
                      <span
                        title={format.vcodec}
                        style={{
                          maxWidth: 60,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap'
                        }}
                      >
                        {format.vcodec.split('.')[0]}
                      </span>
                    )}
                  </div>
                </div>
              </label>
            ))
          ) : (
            <div style={{ color: 'var(--text-secondary)', fontSize: 13 }}>
              未检测到可选分辨率，将使用默认最佳质量下载。
            </div>
          )}
        </div>

        <div className="modal-actions">
          <button className="modal-btn cancel" onClick={onClose}>
            取消
          </button>
          <button className="modal-btn confirm" onClick={handleConfirm}>
            开始下载
          </button>
        </div>
      </div>
    </div>
  )
}
