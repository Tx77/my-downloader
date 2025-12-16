import { useEffect } from 'react'
import { AlertCircle, CheckCircle2 } from 'lucide-react'

export const Toast = ({ show, message, type, onClose }: any) => {
  useEffect(() => {
    if (show) {
      const timer = setTimeout(onClose, 3000)
      return () => clearTimeout(timer)
    }
    return undefined
  }, [show, onClose])

  if (!show) return null

  return (
    <div className={`toast-container ${type}`}>
      {type === 'success' ? <CheckCircle2 size={20} /> : <AlertCircle size={20} />}
      <span>{message}</span>
    </div>
  )
}
