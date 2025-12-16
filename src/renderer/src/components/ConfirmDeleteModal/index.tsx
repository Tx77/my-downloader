import { useState, useEffect } from 'react'
import { X, AlertTriangle, Trash2 } from 'lucide-react'
import './index.css'

interface ConfirmDeleteModalProps {
  isOpen: boolean
  onClose: () => void
  onConfirm: (deleteLocal: boolean) => void

  // 单个删除：传 taskTitle
  taskTitle?: string

  // 批量删除：传 count + isBatch
  count?: number
  isBatch?: boolean
}

export function ConfirmDeleteModal({
  isOpen,
  onClose,
  onConfirm,
  taskTitle,
  count = 0,
  isBatch = false
}: ConfirmDeleteModalProps) {
  const [deleteLocal, setDeleteLocal] = useState(false)

  // ✅ 每次打开都重置，避免继承上一次勾选状态
  useEffect(() => {
    if (isOpen) setDeleteLocal(false)
  }, [isOpen, taskTitle, count, isBatch])

  if (!isOpen) return null

  const handleConfirm = () => onConfirm(deleteLocal)
  const handleClose = () => onClose()

  const titleText = isBatch ? '确认批量删除任务' : '确认删除任务'
  const mainLine = isBatch
    ? `确定要删除全部任务（共 ${count} 个）吗？`
    : `确定要删除任务：${taskTitle || '未知任务'} 吗？`

  return (
    <div className="modal-overlay" onClick={handleClose}>
      <div
        className="modal-content"
        onClick={(e) => e.stopPropagation()}
        style={{ width: '420px' }}
      >
        <div className="modal-header">
          <h3 className="modal-title" style={{ color: 'var(--error)' }}>
            <AlertTriangle size={24} style={{ marginRight: '10px' }} /> {titleText}
          </h3>
          <button className="close-btn" onClick={handleClose} title="关闭">
            <X size={20} />
          </button>
        </div>

        <div style={{ marginBottom: '20px', fontSize: '14px', color: 'var(--text-sub)' }}>
          <p style={{ margin: '0 0 10px 0' }}>
            <b style={{ color: 'white' }}>{mainLine}</b>
          </p>
          <p style={{ margin: 0, color: 'var(--error)' }}>
            {isBatch ? '该操作将清空列表记录，且不可撤销！' : '此操作不可撤销！'}
          </p>
        </div>

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
            <b style={{ color: 'var(--error)' }}>
              {isBatch ? '同时删除本地文件（批量）' : '同时删除本地文件'}
            </b>
            <span style={{ color: 'var(--text-sub)', marginLeft: '8px' }}>(谨慎操作)</span>
          </label>
        </div>

        <div className="modal-actions">
          <button className="modal-btn cancel" onClick={handleClose}>
            取消
          </button>
          <button
            className="modal-btn confirm"
            onClick={handleConfirm}
            style={{ backgroundColor: 'var(--error)' }}
          >
            {isBatch ? '确认删除全部' : '确认删除'}
          </button>
        </div>
      </div>
    </div>
  )
}
