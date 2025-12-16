import { useState, useEffect, useRef } from 'react'
import { Film, Headphones, ChevronDown, Check } from 'lucide-react'

export const CustomSelect = ({ value, onChange, options }: any) => {
  const [isOpen, setIsOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handleClickOutside = (event: any) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setIsOpen(false)
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const selectedLabel = options.find((o: any) => o.value === value)?.label

  return (
    <div className="custom-select-container" ref={ref}>
      <div className="custom-select-trigger" onClick={() => setIsOpen(!isOpen)}>
        {value === 'video' ? <Film size={16} /> : <Headphones size={16} />}
        <span>{selectedLabel}</span>
        <ChevronDown size={14} className={`select-arrow ${isOpen ? 'open' : ''}`} />
      </div>
      {isOpen && (
        <div className="custom-select-dropdown">
          {options.map((opt: any) => (
            <div
              key={opt.value}
              className={`custom-option ${value === opt.value ? 'selected' : ''}`}
              onClick={() => {
                onChange(opt.value)
                setIsOpen(false)
              }}
            >
              {opt.value === 'video' ? <Film size={14} /> : <Headphones size={14} />}
              {opt.label}
              {value === opt.value && <Check size={14} style={{ marginLeft: 'auto' }} />}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
