import { useState, type ReactNode } from 'react'
import { useT } from '../lib/i18n'
import { Input } from './ui/input'
import { NumberField, PropertySection } from './ui/property-field'

type BoxKey = 'x' | 'y' | 'width' | 'height'

export function InspectorBoxFields({
  box,
  minSize,
  limit = Infinity,
  sizeAction,
  onCommit,
  children,
}: {
  box: Record<BoxKey, number>
  minSize: number
  limit?: number
  sizeAction?: ReactNode
  onCommit: (key: BoxKey, value: number) => void
  children?: ReactNode
}) {
  const t = useT()
  const fields = {
    x: { label: t('inspector.xPosition'), prefix: 'X', min: -limit },
    y: { label: t('inspector.yPosition'), prefix: 'Y', min: -limit },
    width: { label: t('inspector.width'), prefix: 'W', min: minSize },
    height: { label: t('inspector.height'), prefix: 'H', min: minSize },
  }
  function field(key: BoxKey) {
    return (
      <NumberField
        {...fields[key]}
        unit="px"
        max={limit}
        value={box[key]}
        className="max-md:h-10 max-md:min-h-10"
        onCommit={(value) => onCommit(key, value)}
      />
    )
  }
  return (
    <>
      <PropertySection title={t('inspector.sectionPosition')}>
        <div className="grid grid-cols-2 gap-1.5">
          {field('x')}
          {field('y')}
        </div>
      </PropertySection>
      <PropertySection title={t('inspector.sectionLayout')} action={sizeAction}>
        <div className="grid grid-cols-2 gap-1.5">
          {field('width')}
          {field('height')}
          {children}
        </div>
      </PropertySection>
    </>
  )
}

export function InspectorName({
  label,
  value,
  maxLength,
  onCommit,
}: {
  label: string
  value: string
  maxLength?: number
  onCommit: (value: string) => void
}) {
  const [draft, setDraft] = useState(value)
  const [seen, setSeen] = useState(value)
  if (seen !== value) {
    setSeen(value)
    setDraft(value)
  }
  return (
    <Input
      variant="bare"
      inputSize="auto"
      aria-label={label}
      className="h-7 min-w-0 flex-1 truncate rounded-row px-1 text-body font-medium hover:bg-sub focus:bg-surface focus:shadow-elevation-1-focus md:text-body max-md:min-h-10"
      value={draft}
      maxLength={maxLength}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        const name = draft.trim() || value
        setDraft(name)
        if (name !== value) onCommit(name)
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur()
        if (event.key === 'Escape') {
          setDraft(value)
          event.preventDefault()
          event.stopPropagation()
        }
      }}
    />
  )
}

export function InspectorPaintRow({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-[minmax(0,1fr)_64px] gap-1.5">{children}</div>
}
