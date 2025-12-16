import { useState } from 'react'
import { X, AlertTriangle, Trash2 } from 'lucide-react'
// 注意：这个组件使用和 ConfirmModal 相似的 CSS 结构，但为了样式独立，
// 最好为它创建或复用一个 CSS 文件。这里我们使用 ConfirmModal.css。
import './index.css' // 暂时复用 ConfirmModal 的基础样式

interface ConfirmDeleteModalProps {
  isOpen: boolean
  onClose: () => void
  onConfirm: (deleteLocal: boolean) => void
  taskTitle: string // 要删除的任务名称
}

export function ConfirmDeleteModal({
  isOpen,
  onClose,
  onConfirm,
  taskTitle
}: ConfirmDeleteModalProps) {
  // 默认不删除本地文件
  const [deleteLocal, setDeleteLocal] = useState(false)

  if (!isOpen) return null

  const handleConfirm = () => {
    onConfirm(deleteLocal)
    setDeleteLocal(false) // 重置状态
  }

  const handleClose = () => {
    onClose()
    setDeleteLocal(false) // 重置状态
  }

  return (
    <div className="modal-overlay" onClick={handleClose}>
      <div
        className="modal-content"
        onClick={(e) => e.stopPropagation()}
        style={{ width: '400px' }}
      >
        {/* 头部：标题 + 关闭按钮 */}
        <div className="modal-header">
          <h3 className="modal-title" style={{ color: 'var(--error)' }}>
            <AlertTriangle size={24} style={{ marginRight: '10px' }} /> 确认删除任务
          </h3>
          <button className="close-btn" onClick={handleClose} title="关闭">
            <X size={20} />
          </button>
        </div>

        {/* 警告信息 */}
        <div style={{ marginBottom: '20px', fontSize: '14px', color: 'var(--text-sub)' }}>
          <p style={{ margin: '0 0 10px 0' }}>
            确定要删除任务：<b style={{ color: 'white' }}>{taskTitle}</b> 吗？
          </p>
          <p style={{ margin: 0, color: 'var(--error)' }}>此操作不可撤销！</p>
        </div>

        {/* 选项：是否删除本地资源 */}
        <div
          style={{
            marginBottom: '24px',
            padding: '10px 0',
            borderTop: '1px solid var(--border)',
            borderBottom: '1px solid var(--border)'
          }}
        >
          <label
            style={{ display: 'flex', alignItems: 'center', cursor: 'pointer', fontSize: '14px' }}
          >
            <input
              type="checkbox"
              checked={deleteLocal}
              onChange={(e) => setDeleteLocal(e.target.checked)}
              style={{
                width: '18px',
                height: '18px',
                marginRight: '10px',
                accentColor: 'var(--error)'
              }}
            />
            <Trash2 size={16} color="var(--error)" style={{ marginRight: '5px' }} />
            <b style={{ color: 'var(--error)' }}>同时删除本地文件</b>
            <span style={{ color: 'var(--text-sub)', marginLeft: '8px' }}>(谨慎操作)</span>
          </label>
        </div>

        {/* 底部按钮 */}
        <div className="modal-actions">
          <button className="modal-btn cancel" onClick={handleClose}>
            取消
          </button>
          <button
            className="modal-btn confirm"
            onClick={handleConfirm}
            style={{ backgroundColor: 'var(--error)' }}
          >
            确认删除
          </button>
        </div>
      </div>
    </div>
  )
}
