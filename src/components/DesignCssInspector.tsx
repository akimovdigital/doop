import { useEffect, useRef, useState } from 'react'
import { useT } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import type { DesignCssEdit } from '../lib/designNotes'
import { Button } from './ui/button'
import { IconButton } from './ui/icon-button'
import { Input } from './ui/input'
import { PlusIcon, SearchIcon, XIcon } from './ui/icons'

interface Props {
  properties: Record<string, string>
  edits: DesignCssEdit[]
  above: boolean
  maxHeight: number
  onChange: (prop: string, value: string) => void
  onAdd: (prop: string) => Promise<boolean>
  onClose: () => void
}

const input =
  'min-w-0 rounded-row border border-line bg-surface px-1.5 text-caption text-ink md:text-caption outline-none focus:border-brand'

function CssValue({ prop, value, onChange }: { prop: string; value: string; onChange: Props['onChange'] }) {
  const [typed, setTyped] = useState<string>()
  return (
    <Input
      inputSize="auto"
      className={cn(input, 'h-6 w-full font-mono')}
      aria-label={prop}
      spellCheck={false}
      value={typed ?? value}
      onChange={(event) => {
        setTyped(event.target.value)
        onChange(prop, event.target.value)
      }}
      onBlur={() => setTyped(undefined)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && !event.nativeEvent.isComposing) event.currentTarget.blur()
      }}
    />
  )
}

export function DesignCssInspector({ properties, edits, above, maxHeight, onChange, onAdd, onClose }: Props) {
  const t = useT()
  const filterRef = useRef<HTMLInputElement>(null)
  const [filter, setFilter] = useState('')
  const [addition, setAddition] = useState<string>()
  const [invalid, setInvalid] = useState(false)
  const [editingOrder, setEditingOrder] = useState<ReadonlySet<string>>()
  const changed = new Map(edits.map((edit) => [edit.prop, edit.after]))
  const priority = editingOrder ?? changed
  const query = filter.trim().toLowerCase()
  const names = [...new Set([...Object.keys(properties), ...changed.keys()])]
    .filter((name) => name.toLowerCase().includes(query))
    .sort((a, b) => Number(priority.has(b)) - Number(priority.has(a)) || a.localeCompare(b))

  useEffect(() => filterRef.current?.focus(), [])

  async function addProperty() {
    const name = addition?.trim()
    if (!name) return
    const prop = name.startsWith('--') ? name : name.toLowerCase()
    if (!/^--[^\s:;]+$|^-?[a-z][a-z0-9-]*$/.test(prop) || !(await onAdd(prop))) {
      setInvalid(true)
      return
    }
    setAddition(undefined)
    setInvalid(false)
    setFilter(prop)
    filterRef.current?.focus()
  }

  return (
    <div
      data-design-css-inspector=""
      role="group"
      aria-label={t('panels.designCssEdit')}
      className={cn(
        'absolute inset-x-0 grid grid-rows-[auto_minmax(0,1fr)_auto] gap-1 rounded-control border border-line bg-surface p-1.5 text-ink shadow-pop',
        above ? 'bottom-full mb-1' : 'top-full mt-1',
      )}
      style={{ maxHeight }}
    >
      <div className="flex items-center gap-1">
        <SearchIcon size={12} className="shrink-0 text-ink-soft" />
        <Input
          inputSize="auto"
          ref={filterRef}
          aria-label={t('panels.designCssFilter')}
          placeholder={t('panels.designCssFilter')}
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          className={cn(input, 'h-6 flex-1')}
        />
        <IconButton size="sm" className="size-5" aria-label={t('panels.designCssClose')} onClick={onClose}>
          <XIcon size={12} />
        </IconButton>
      </div>
      <div
        className="grid min-h-0 content-start gap-0.5 overflow-y-auto overscroll-contain"
        data-design-css-properties=""
        onFocus={() => setEditingOrder(new Set(changed.keys()))}
        onBlur={() => setEditingOrder(undefined)}
      >
        {names.map((prop) => (
          <label key={prop} className="grid grid-cols-2 items-center gap-1 text-caption">
            <span title={prop} className={cn('truncate font-mono', changed.has(prop) ? 'text-brand' : 'text-ink-soft')}>
              {prop}
            </span>
            <CssValue prop={prop} value={changed.get(prop) ?? properties[prop] ?? ''} onChange={onChange} />
          </label>
        ))}
      </div>
      {addition === undefined ? (
        <Button size="pill" variant="bare" className="h-6 justify-self-start" onClick={() => setAddition('')}>
          <PlusIcon size={12} />
          {t('panels.designCssAdd')}
        </Button>
      ) : (
        <div className="flex items-center gap-1">
          <Input
            inputSize="auto"
            autoFocus
            className={cn(input, 'h-6 flex-1')}
            aria-label={t('panels.designCssName')}
            placeholder={t('panels.designCssName')}
            aria-invalid={invalid}
            value={addition}
            onChange={(event) => {
              setInvalid(false)
              setAddition(event.target.value)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) void addProperty()
            }}
          />
          <IconButton
            size="sm"
            className="size-5"
            aria-label={t('panels.designCssAdd')}
            onClick={() => void addProperty()}
          >
            <PlusIcon size={12} />
          </IconButton>
          {invalid && (
            <span role="alert" className="sr-only">
              {t('panels.designCssInvalid')}
            </span>
          )}
        </div>
      )}
    </div>
  )
}
