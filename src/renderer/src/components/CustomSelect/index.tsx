import { useState, useRef, useEffect } from 'react'
import { ChevronDown } from 'lucide-react'
import './index.css'

interface Option {
  value: string
  label: string
}

interface CustomSelectProps {
  value: string
  onChange: (val: any) => void
  options: Option[]
}

export function CustomSelect({ value, onChange, options }: CustomSelectProps) {
  const [isOpen, setIsOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  // 点击外部关闭下拉
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const selectedLabel = options.find((o) => o.value === value)?.label || value

  return (
    <div className="custom-select-container" ref={containerRef}>
      {/* 触发器 */}
      <div className="select-trigger" onClick={() => setIsOpen(!isOpen)}>
        <span>{selectedLabel}</span>
        <ChevronDown
          size={16}
          style={{
            transform: isOpen ? 'rotate(180deg)' : 'rotate(0)',
            transition: 'transform 0.2s'
          }}
        />
      </div>

      {/* 下拉菜单 (只在 isOpen 为 true 时显示) */}
      {isOpen && (
        <div className="select-dropdown">
          {options.map((option) => (
            <div
              key={option.value}
              className={`select-option ${option.value === value ? 'selected' : ''}`}
              onClick={() => {
                onChange(option.value)
                setIsOpen(false)
              }}
            >
              {option.label}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
