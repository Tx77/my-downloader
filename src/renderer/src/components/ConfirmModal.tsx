import { useState, useEffect } from 'react'
import { X, Music2 } from 'lucide-react'

export const ConfirmModal = ({ isOpen, onClose, onConfirm, data, isLoading, mode }: any) => {
  if (!isOpen) return null

  // 选中的 ID
  const [selectedId, setSelectedId] = useState('best')
  // 是否转换为 MP3 (仅在音频模式且未选特定格式时有效，或者作为附加选项)
  // const [convertToMp3, setConvertToMp3] = useState(true)

  // 1. 提取视频列表 (有视频编码的)
  const videoFormats =
    data?.formats?.filter((f: any) => f.vcodec !== 'none' && f.resolution !== 'audio only') || []

  // 2. 提取音频列表 (无视频编码，只有音频编码的)
  const audioFormats =
    data?.formats?.filter((f: any) => f.vcodec === 'none' && f.acodec !== 'none') || []

  // 视频排序
  const sortedVideoFormats = [...videoFormats].sort((a: any, b: any) => {
    const qA = a.quality || 0
    const qB = b.quality || 0
    if (qA !== qB) return qB - qA
    return (b.tbr || 0) - (a.tbr || 0)
  })

  // 音频排序 (按码率 abr 降序)
  const sortedAudioFormats = [...audioFormats].sort((a: any, b: any) => (b.abr || 0) - (a.abr || 0))

  // 默认选中
  useEffect(() => {
    if (mode === 'video' && sortedVideoFormats.length > 0) {
      setSelectedId(sortedVideoFormats[0].format_id)
    } else if (mode === 'audio') {
      // 音频模式默认选中 "best" (即自动转换MP3)
      setSelectedId('best')
    }
  }, [data, mode])

  const handleConfirm = () => {
    // 如果是音频模式
    if (mode === 'audio') {
      // 如果选的是 'best'，则传回 null，让后端走默认的 MP3 转换逻辑
      if (selectedId === 'best') {
        onConfirm('best') // 这里的 'best' 只是个标记，后端会看到 isAudioOnly=true
      } else {
        // 用户选了特定的音频流 (如 m4a)，直接下载该流
        onConfirm(selectedId)
      }
    } else {
      // 视频模式
      onConfirm(selectedId)
    }
  }

  const getLabel = (fmt: any) => {
    let tags: string[] = []
    if (fmt.vcodec?.includes('avc')) tags.push('AVC')
    else if (fmt.vcodec?.includes('hev') || fmt.vcodec?.includes('h265')) tags.push('HEVC')
    else if (fmt.vcodec?.includes('av01')) tags.push('AV1')
    if (fmt.dynamic_range === 'HDR') tags.push('HDR')
    const tagStr = tags.length > 0 ? ` (${tags.join(', ')})` : ''
    return `${fmt.resolution}${tagStr}`
  }

  const getAudioLabel = (fmt: any) => {
    // 显示格式和码率，例如: m4a (128k)
    const bitrate = fmt.abr ? `${Math.round(fmt.abr)}k` : 'N/A'
    return `${fmt.ext} (${bitrate})`
  }

  return (
    <div className="modal-overlay">
      <div className="modal-content" style={{ width: '600px', maxWidth: '95%' }}>
        <div className="modal-header">
          <h3>{mode === 'audio' ? '确认音频下载' : '确认视频下载'}</h3>
          <button className="close-btn" onClick={onClose}>
            <X size={20} />
          </button>
        </div>

        {isLoading ? (
          <div className="modal-loading">
            <div className="spinner"></div>
            <p>正在解析资源...</p>
          </div>
        ) : (
          <>
            <div className="video-info">
              {data.thumbnail && (
                <img
                  src={data.thumbnail}
                  alt="thumb"
                  className="modal-thumb"
                  referrerPolicy="no-referrer"
                />
              )}
              <div>
                <div className="video-title">{data.title}</div>
                <div className="video-meta">时长: {data.duration}</div>
              </div>
            </div>

            <div className="format-selection">
              <h4>{mode === 'audio' ? '选择音频格式' : '选择画质'}</h4>

              <div className="format-list">
                {mode === 'audio' ? (
                  <>
                    {/* 选项 1: 智能转换 MP3 */}
                    <label className={`format-item ${selectedId === 'best' ? 'active' : ''}`}>
                      <input
                        type="radio"
                        name="afmt"
                        value="best"
                        onChange={() => setSelectedId('best')}
                        checked={selectedId === 'best'}
                      />
                      <div style={{ display: 'flex', flexDirection: 'column' }}>
                        <span style={{ fontWeight: 'bold' }}>自动转换 MP3 (推荐)</span>
                        <span style={{ fontSize: '12px', color: '#888' }}>
                          下载最佳音质并转换为兼容性最好的 MP3
                        </span>
                      </div>
                      <Music2 size={16} color="#1db954" style={{ marginLeft: 'auto' }} />
                    </label>

                    {/* 分割线 */}
                    <div style={{ height: '1px', background: '#333', margin: '8px 0' }}></div>
                    <div
                      style={{
                        fontSize: '12px',
                        color: '#666',
                        marginBottom: '8px',
                        paddingLeft: '4px'
                      }}
                    >
                      原声音轨 (不转换):
                    </div>

                    {/* 选项 2...N: 原始音频流 */}
                    {sortedAudioFormats.map((fmt: any) => (
                      <label
                        key={fmt.format_id}
                        className={`format-item ${selectedId === fmt.format_id ? 'active' : ''}`}
                      >
                        <input
                          type="radio"
                          name="afmt"
                          value={fmt.format_id}
                          onChange={() => setSelectedId(fmt.format_id)}
                          checked={selectedId === fmt.format_id}
                        />
                        <span className="res-tag" style={{ width: 'auto', minWidth: '100px' }}>
                          {getAudioLabel(fmt)}
                        </span>
                        <span className="size-tag">{fmt.filesize}</span>
                        <span className="ext-tag">{fmt.acodec?.split('.')[0]}</span>
                      </label>
                    ))}
                  </>
                ) : (
                  <>
                    <label className={`format-item ${selectedId === 'best' ? 'active' : ''}`}>
                      <input
                        type="radio"
                        name="vfmt"
                        value="best"
                        onChange={() => setSelectedId('best')}
                        checked={selectedId === 'best'}
                      />
                      <span>自动选择最高画质 (推荐)</span>
                    </label>
                    {sortedVideoFormats.map((fmt: any) => (
                      <label
                        key={fmt.format_id}
                        className={`format-item ${selectedId === fmt.format_id ? 'active' : ''}`}
                      >
                        <input
                          type="radio"
                          name="vfmt"
                          value={fmt.format_id}
                          onChange={() => setSelectedId(fmt.format_id)}
                          checked={selectedId === fmt.format_id}
                        />
                        <span className="res-tag" style={{ width: 'auto', minWidth: '120px' }}>
                          {getLabel(fmt)}
                        </span>
                        <span className="size-tag">{fmt.filesize}</span>
                        <span className="ext-tag">{fmt.ext}</span>
                      </label>
                    ))}
                  </>
                )}
              </div>
            </div>

            <div className="modal-footer">
              <button className="cancel-btn" onClick={onClose}>
                取消
              </button>
              <button className="confirm-btn" onClick={handleConfirm}>
                {mode === 'audio' ? '下载音频' : '开始下载'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
