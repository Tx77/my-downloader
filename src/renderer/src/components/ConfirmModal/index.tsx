import { useState, useEffect, useMemo } from 'react'
import { X, Film, Music, Captions } from 'lucide-react'
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

interface SubtitleTrack {
  lang: string
  name?: string
  type: 'manual' | 'auto'
  formats: string[]
}

export interface SubtitleOptions {
  mode: 'none' | 'subtitle-only' | 'with-media'
  languages: string[]
  format: 'srt' | 'vtt'
  includeAuto: boolean
  includeManual: boolean
}

interface VideoData {
  title: string
  thumbnail: string
  duration: string
  formats: Format[]
  subtitles?: SubtitleTrack[]
}

interface ConfirmModalProps {
  isOpen: boolean
  onClose: () => void
  onConfirm: (payload: { formatId: string | null; subtitleOptions: SubtitleOptions }) => void
  data: VideoData | null
  mode: 'video' | 'audio'
}

const preferredLangs = ['zh-Hans', 'zh-CN', 'zh', 'zh-Hant', 'en']

export function ConfirmModal({ isOpen, onClose, onConfirm, data, mode }: ConfirmModalProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [subtitleMode, setSubtitleMode] = useState<SubtitleOptions['mode']>('none')
  const [subtitleFormat, setSubtitleFormat] = useState<SubtitleOptions['format']>('srt')
  const [includeManual, setIncludeManual] = useState(true)
  const [includeAuto, setIncludeAuto] = useState(true)
  const [selectedLangs, setSelectedLangs] = useState<string[]>([])

  const formatsToShow = useMemo(() => {
    if (!data?.formats) return []
    return data.formats.filter((f) => {
      if (mode === 'audio') {
        return f.vcodec === 'none' && f.acodec && f.acodec !== 'none'
      }
      return f.vcodec !== 'none'
    })
  }, [data, mode])

  const subtitleTracks = useMemo(() => data?.subtitles || [], [data])
  const subtitleLangs = useMemo(() => {
    const langs = Array.from(new Set(subtitleTracks.map((item) => item.lang).filter(Boolean)))
    return langs.sort((a, b) => {
      const ai = preferredLangs.indexOf(a)
      const bi = preferredLangs.indexOf(b)
      if (ai >= 0 || bi >= 0) return (ai >= 0 ? ai : 999) - (bi >= 0 ? bi : 999)
      return a.localeCompare(b)
    })
  }, [subtitleTracks])
  const hasSubtitleTracks = subtitleLangs.length > 0

  useEffect(() => {
    if (isOpen && formatsToShow.length > 0) {
      setSelectedId(formatsToShow[0].format_id)
    } else {
      setSelectedId(null)
    }
  }, [isOpen, formatsToShow])

  useEffect(() => {
    if (!isOpen) return

    setSubtitleMode('none')
    setSubtitleFormat('srt')
    setIncludeManual(true)
    setIncludeAuto(true)

    const defaults = preferredLangs.filter((lang) => subtitleLangs.includes(lang))
    setSelectedLangs(defaults.length ? defaults.slice(0, 2) : subtitleLangs.slice(0, 2))
  }, [isOpen, subtitleLangs])

  useEffect(() => {
    if (!hasSubtitleTracks && subtitleMode !== 'none') {
      setSubtitleMode('none')
    }
  }, [hasSubtitleTracks, subtitleMode])

  if (!isOpen || !data) return null

  const toggleLang = (lang: string) => {
    setSelectedLangs((prev) =>
      prev.includes(lang) ? prev.filter((item) => item !== lang) : [...prev, lang]
    )
  }

  const handleConfirm = () => {
    const languages = selectedLangs.length ? selectedLangs : preferredLangs
    const shouldIncludeManual = includeManual || !includeAuto
    const safeSubtitleMode = hasSubtitleTracks ? subtitleMode : 'none'
    onConfirm({
      formatId: formatsToShow.length > 0 ? selectedId : null,
      subtitleOptions: {
        mode: safeSubtitleMode,
        languages,
        format: subtitleFormat,
        includeAuto,
        includeManual: shouldIncludeManual
      }
    })
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

        {subtitleMode !== 'subtitle-only' && (
          <>
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
                <div style={{ color: 'var(--text-secondary)', fontSize: 13, padding: 12 }}>
                  未检测到可选分辨率，将使用默认最佳质量下载。
                </div>
              )}
            </div>
          </>
        )}

        <div className="subtitle-panel">
          <div className="subtitle-title">
            <Captions size={16} />
            <span>字幕</span>
          </div>

          <div className="subtitle-mode-row">
            {[
              { value: 'none', label: '不下载' },
              { value: 'with-media', label: '同时下载' },
              { value: 'subtitle-only', label: '仅字幕' }
            ].map((item) => (
              <label
                key={item.value}
                className={`subtitle-mode ${subtitleMode === item.value ? 'selected' : ''} ${
                  !hasSubtitleTracks && item.value !== 'none' ? 'disabled' : ''
                }`}
              >
                <input
                  type="radio"
                  name="subtitle-mode"
                  checked={subtitleMode === item.value}
                  disabled={!hasSubtitleTracks && item.value !== 'none'}
                  onChange={() => setSubtitleMode(item.value as SubtitleOptions['mode'])}
                />
                <span>{item.label}</span>
              </label>
            ))}
          </div>

          {subtitleMode !== 'none' && (
            <div className="subtitle-options">
              <div className="subtitle-check-row">
                <label>
                  <input
                    type="checkbox"
                    checked={includeManual}
                    onChange={(e) => setIncludeManual(e.target.checked)}
                  />
                  官方字幕
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={includeAuto}
                    onChange={(e) => setIncludeAuto(e.target.checked)}
                  />
                  自动字幕
                </label>
              </div>

              <div className="subtitle-check-row">
                <label>
                  <input
                    type="radio"
                    name="subtitle-format"
                    checked={subtitleFormat === 'srt'}
                    onChange={() => setSubtitleFormat('srt')}
                  />
                  SRT
                </label>
                <label>
                  <input
                    type="radio"
                    name="subtitle-format"
                    checked={subtitleFormat === 'vtt'}
                    onChange={() => setSubtitleFormat('vtt')}
                  />
                  VTT
                </label>
              </div>

              <div className="subtitle-lang-list">
                {subtitleLangs.length > 0 ? (
                  subtitleLangs.map((lang) => (
                    <button
                      key={lang}
                      type="button"
                      className={`subtitle-lang ${selectedLangs.includes(lang) ? 'selected' : ''}`}
                      onClick={() => toggleLang(lang)}
                    >
                      {lang}
                    </button>
                  ))
                ) : (
                  <span className="subtitle-empty">
                    未检测到可下载字幕。B 站弹幕不是字幕，不能用于访谈整理。
                  </span>
                )}
              </div>
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
