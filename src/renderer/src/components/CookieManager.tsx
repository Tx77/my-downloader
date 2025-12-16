import { useState } from 'react'
import { Key, ChevronRight, QrCode, Copy, LogOut, Eye, EyeOff } from 'lucide-react'

export const CookieManager = ({ sessData, setSessData, handleLogin, showToastMsg }: any) => {
  const [showCookie, setShowCookie] = useState(false)
  const [showPassword, setShowPassword] = useState(false)

  const handleLogout = () => {
    setSessData('')
    // @ts-ignore
    window.electron.setCookie('')
    showToastMsg('已清除 Cookie')
  }

  const copyCookie = () => {
    if (!sessData) return
    navigator.clipboard.writeText(sessData)
    showToastMsg('Cookie 已复制到剪贴板')
  }

  return (
    <div style={{ marginTop: '12px', background: '#222', padding: '10px', borderRadius: '6px' }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          cursor: 'pointer'
        }}
        onClick={() => setShowCookie(!showCookie)}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            fontSize: '13px',
            fontWeight: '500',
            color: sessData ? '#1db954' : '#b3b3b3'
          }}
        >
          <Key size={14} />
          <span>{sessData ? '大会员已授权 (Premium Active)' : '大会员授权 (推荐)'}</span>
        </div>
        <ChevronRight
          size={14}
          style={{
            transform: showCookie ? 'rotate(90deg)' : 'none',
            transition: 'all 0.2s',
            color: '#666'
          }}
        />
      </div>

      {showCookie && (
        <div style={{ marginTop: '10px', animation: 'slideUp 0.2s' }}>
          {!sessData ? (
            <button
              onClick={handleLogin}
              style={{
                width: '100%',
                background: '#FB7299',
                color: 'white',
                border: 'none',
                padding: '8px',
                borderRadius: '4px',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '8px',
                fontSize: '13px',
                fontWeight: 'bold',
                marginBottom: '10px'
              }}
            >
              <QrCode size={16} />
              <span>扫码一键获取 Cookie</span>
            </button>
          ) : (
            <div style={{ marginBottom: '10px', display: 'flex', gap: '10px' }}>
              <div
                style={{
                  flex: 1,
                  background: '#1a1a1a',
                  padding: '8px',
                  fontSize: '12px',
                  color: '#888',
                  borderRadius: '4px',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap'
                }}
              >
                {sessData.substring(0, 40)}...
              </div>
              <button onClick={copyCookie} className="icon-btn-small" title="复制">
                <Copy size={14} />
              </button>
              <button onClick={handleLogout} className="icon-btn-small" title="退出">
                <LogOut size={14} />
              </button>
            </div>
          )}

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', position: 'relative' }}>
            <span style={{ fontSize: '10px', color: '#555', whiteSpace: 'nowrap' }}>手动粘贴:</span>
            <div style={{ position: 'relative', width: '100%' }}>
              <input
                type={showPassword ? 'text' : 'password'}
                className="styled-input"
                placeholder="SESSDATA=..."
                value={sessData}
                onChange={(e) => {
                  setSessData(e.target.value)
                  // @ts-ignore
                  window.electron.setCookie(e.target.value)
                }}
                style={{ fontSize: '12px', padding: '8px 35px 8px 8px', width: '100%' }}
              />
              <div
                onClick={() => setShowPassword(!showPassword)}
                style={{
                  position: 'absolute',
                  right: '8px',
                  top: '50%',
                  transform: 'translateY(-50%)',
                  cursor: 'pointer',
                  color: '#888',
                  padding: '4px'
                }}
              >
                {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
