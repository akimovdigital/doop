import type { CSSProperties, ReactNode } from 'react'
import {
  SECTION_BOUNDS_LIMIT,
  SECTION_FILL,
  SECTION_RADIUS,
  SECTION_STROKE,
  sectionAround,
  sectionContainsFrame,
  sectionSize,
} from '../../shared/sections'
import { pageFrames } from '../../shared/pages'
import type { CanvasSection } from '../../shared/types'
import { activeSections, changeSection } from '../lib/canvasSections'
import { useT } from '../lib/i18n'
import { useStore } from '../lib/store'
import { useTheme } from '../lib/theme'
import { cn } from '../lib/utils'
import { Button } from './ui/button'
import { SectionIcon } from './ui/icons'
import { Input } from './ui/input'
import { Panel, PanelBody, PanelClose, PanelHeader, type PanelSurface } from './ui/panel'
import { ColorField, SelectField } from './ui/property-field'
import { Switch } from './ui/switch'

type SectionValue = Partial<Omit<CanvasSection, 'id'>>

export function SectionInspector({
  section,
  surface,
  style,
}: {
  section: CanvasSection
  surface: PanelSurface
  style?: CSSProperties
}) {
  const t = useT()
  const canvasId = useStore((s) => s.canvas?.id)
  const pageId = useStore((s) => s.activePageId)
  const hasContents = useStore(
    (s) =>
      !!s.canvas &&
      !!s.activePageId &&
      (pageFrames(s.canvas, s.activePageId).some((frame) => sectionContainsFrame(section, frame)) ||
        activeSections(s).some(
          (child) =>
            child.id !== section.id &&
            (child.width < section.width || child.height < section.height) &&
            sectionContainsFrame(section, child),
        )),
  )
  const setInspectorOpen = useStore((s) => s.setInspectorOpen)
  const { resolved } = useTheme()
  const fill = section.fill === undefined ? SECTION_FILL[resolved] : section.fill
  const stroke = section.stroke === undefined ? SECTION_STROKE[resolved] : section.stroke
  function update(patch: SectionValue) {
    if (canvasId && pageId) void changeSection(canvasId, pageId, { type: 'patch', section, patch })
  }
  function position(a: 'x' | 'y', value: number) {
    if (canvasId && pageId) void changeSection(canvasId, pageId, { type: 'position', section, [a]: value })
  }
  function fitContents() {
    const state = useStore.getState()
    if (!state.canvas || !pageId) return
    const boxes = [
      ...pageFrames(state.canvas, pageId),
      ...activeSections(state).filter(
        (item) => item.id !== section.id && (item.width < section.width || item.height < section.height),
      ),
    ].filter((item) => sectionContainsFrame(section, item))
    const fit = sectionAround(boxes, 16)
    if (fit) update(fit)
  }
  return (
    <Panel
      surface={surface}
      data-section-inspector=""
      className={cn(
        surface === 'floating' && 'top-2.5 bottom-3.5 w-[244px] transition-[right] duration-150',
        surface === 'docked' && 'w-[244px] border-l',
      )}
      style={style}
    >
      <PanelHeader className="pl-2.5">
        <SectionIcon size="rail" className="flex-none text-ink-faint" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-label font-medium text-ink">{section.name}</span>
        <PanelClose onClick={() => setInspectorOpen(false)} />
      </PanelHeader>
      <PanelBody onKeyDown={(event) => event.stopPropagation()}>
        <PropertyGroup title={t('canvas.sectionLayout')}>
          <Input
            key={section.name}
            inputSize="sm"
            aria-label={t('canvas.sectionName')}
            defaultValue={section.name}
            maxLength={100}
            onBlur={(event) => {
              const name = event.currentTarget.value.trim() || section.name
              event.currentTarget.value = name
              if (name !== section.name) update({ name })
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') event.currentTarget.value = section.name
              if (event.key === 'Enter' || event.key === 'Escape') event.currentTarget.blur()
            }}
          />
          <div className="grid grid-cols-2 gap-1.5">
            <Numeric
              label="X"
              value={section.x}
              min={-SECTION_BOUNDS_LIMIT}
              onCommit={(value) => position('x', value)}
            />
            <Numeric
              label="Y"
              value={section.y}
              min={-SECTION_BOUNDS_LIMIT}
              onCommit={(value) => position('y', value)}
            />
            <Numeric
              label={t('canvas.sectionWidth')}
              value={section.width}
              min={1}
              onCommit={(width) => update(sectionSize(section, 'width', width))}
            />
            <Numeric
              label={t('canvas.sectionHeight')}
              value={section.height}
              min={1}
              onCommit={(height) => update(sectionSize(section, 'height', height))}
            />
            <Numeric
              label={t('canvas.sectionRadius')}
              value={section.cornerRadius ?? SECTION_RADIUS}
              onCommit={(cornerRadius) => update({ cornerRadius })}
            />
          </div>
          <label className="flex items-center justify-between gap-2 py-1 text-label text-ink-soft">
            <span>{t('canvas.sectionLockRatio')}</span>
            <Switch
              size="sm"
              checked={section.lockAspectRatio ?? false}
              onCheckedChange={(lockAspectRatio) => update({ lockAspectRatio })}
            />
          </label>
          <Button variant="default" size="sm" disabled={!hasContents} onClick={fitContents}>
            {t('canvas.sectionFitContents')}
          </Button>
        </PropertyGroup>
        <PropertyGroup title={t('canvas.sectionFill')}>
          <div className="flex min-w-0">
            <ColorField
              label={t('canvas.sectionFillColor')}
              value={fill}
              onCommit={(value) => update({ fill: value })}
            />
          </div>
          <Numeric
            label={t('canvas.sectionFillOpacity')}
            unit="%"
            max={100}
            value={section.fillOpacity ?? 100}
            onCommit={(fillOpacity) => update({ fillOpacity })}
          />
        </PropertyGroup>
        <PropertyGroup title={t('canvas.sectionStroke')}>
          <div className="flex min-w-0">
            <ColorField
              label={t('canvas.sectionStrokeColor')}
              value={stroke}
              onCommit={(value) => update({ stroke: value })}
            />
          </div>
          <Numeric
            label={t('canvas.sectionStrokeWidth')}
            max={1000}
            value={section.strokeWidth ?? 1}
            onCommit={(strokeWidth) => update({ strokeWidth })}
          />
          <Numeric
            label={t('canvas.sectionStrokeOpacity')}
            unit="%"
            max={100}
            value={section.strokeOpacity ?? 100}
            onCommit={(strokeOpacity) => update({ strokeOpacity })}
          />
          <SelectField
            label={t('canvas.sectionStrokeAlign')}
            value={section.strokeAlign ?? 'inside'}
            options={[
              { value: 'inside', label: t('canvas.sectionStrokeInside') },
              { value: 'center', label: t('canvas.sectionStrokeCenter') },
              { value: 'outside', label: t('canvas.sectionStrokeOutside') },
            ]}
            onChange={(strokeAlign) => update({ strokeAlign })}
          />
        </PropertyGroup>
        <div className="px-3 py-2">
          <Button variant="bare" size="sm" onClick={() => useStore.getState().focusSection(section.id)}>
            {t('canvas.sectionFit')}
          </Button>
        </div>
      </PanelBody>
    </Panel>
  )
}

function PropertyGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="grid gap-1.5 border-b border-line-soft px-3 py-2">
      <h3 className="py-0.5 text-label font-medium text-ink-soft">{title}</h3>
      {children}
    </section>
  )
}

function Numeric({
  label,
  value,
  onCommit,
  min = 0,
  max = SECTION_BOUNDS_LIMIT,
  unit = 'px',
}: {
  label: string
  value: number
  onCommit: (value: number) => void
  min?: number
  max?: number
  unit?: string
}) {
  return (
    <label className="grid min-w-0 gap-1 text-micro text-ink-soft">
      <span>
        {label} · {unit}
      </span>
      <Input
        key={value}
        type="number"
        inputSize="sm"
        aria-label={label}
        defaultValue={value}
        min={min}
        max={max}
        step="any"
        onBlur={(event) => {
          const parsed = event.currentTarget.valueAsNumber
          const next = Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : value
          event.currentTarget.value = String(next)
          if (next !== value) onCommit(next)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') event.currentTarget.value = String(value)
          if (event.key === 'Escape' || event.key === 'Enter') event.currentTarget.blur()
        }}
      />
    </label>
  )
}
