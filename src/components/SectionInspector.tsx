import { useRef, type CSSProperties } from 'react'
import {
  SECTION_BOUNDS_LIMIT,
  SECTION_FILL,
  SECTION_RADIUS,
  SECTION_STROKE,
  sectionAround,
  sectionContents,
} from '../../shared/sections'
import { pageFrames } from '../../shared/pages'
import type { CanvasSection } from '../../shared/types'
import { activeSections, changeSection, copySectionLink } from '../lib/canvasSections'
import { useT } from '../lib/i18n'
import { useStore } from '../lib/store'
import { useTheme } from '../lib/theme'
import { cn } from '../lib/utils'
import { InspectorBoxFields, InspectorName, InspectorPaintRow } from './InspectorFields'
import { Button } from './ui/button'
import { DropletIcon, LinkIcon, RadiusIcon, SectionIcon, StrokeWidthIcon, UnlinkIcon } from './ui/icons'
import { Panel, PanelBody, PanelClose, PanelHeader, type PanelSurface } from './ui/panel'
import { ColorField, NumberField, PropertyScrubContext, PropertySection, SelectField } from './ui/property-field'
import { Tooltip } from './ui/tooltip'

type StoreState = ReturnType<typeof useStore.getState>

function contentsOf(state: StoreState, section: CanvasSection) {
  if (!state.canvas || !state.activePageId) return []
  const contents = sectionContents(activeSections(state), pageFrames(state.canvas, state.activePageId), [section])
  return [...contents.frames, ...contents.sections.filter((item) => item.id !== section.id)]
}

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
  // Keep geometry checks out of viewport/pointer-only Zustand updates.
  const frames = useStore((s) => s.canvas?.frames)
  const sections = useStore(activeSections)
  const canFit = (!!frames?.length || sections.length > 1) && contentsOf(useStore.getState(), section).length > 0
  const setInspectorOpen = useStore((s) => s.setInspectorOpen)
  const { resolved } = useTheme()
  const fill = section.fill === undefined ? SECTION_FILL[resolved] : section.fill
  const stroke = section.stroke === undefined ? SECTION_STROKE[resolved] : section.stroke
  type Change = Parameters<typeof changeSection>[2]
  const scrub = useRef<{ final?: Change } | null>(null)

  function save(change: Change) {
    if (canvasId && pageId) void changeSection(canvasId, pageId, change)
  }
  function commit(change: Change) {
    if (scrub.current) scrub.current.final = change
    else save(change)
  }
  function update(patch: Partial<Omit<CanvasSection, 'id'>>) {
    commit({ type: 'patch', section, patch })
  }
  function fitContents() {
    const fit = sectionAround(contentsOf(useStore.getState(), section), 16)
    if (fit) update(fit)
  }

  return (
    <Panel
      surface={surface}
      data-section-inspector=""
      className={cn(
        surface === 'floating' && 'top-2.5 bottom-3.5 w-[244px] transition-[right] duration-150',
        surface === 'docked' && 'w-[244px] border-l',
        'max-md:overflow-y-auto max-md:overscroll-contain',
      )}
      style={style}
    >
      <PanelHeader className="pl-2.5">
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          <SectionIcon size="rail" className="flex-none text-ink-faint" aria-hidden />
          <InspectorName
            label={t('canvas.sectionName')}
            value={section.name}
            maxLength={100}
            onCommit={(name) => update({ name })}
          />
        </span>
        <PanelClose onClick={() => setInspectorOpen(false)} />
      </PanelHeader>
      <PanelBody>
        <PropertyScrubContext.Provider
          value={{
            onStart: () => {
              scrub.current = {}
            },
            onEnd: (cancel) => {
              const change = scrub.current?.final
              scrub.current = null
              if (change && !cancel) save(change)
            },
          }}
        >
          <InspectorBoxFields
            box={section}
            minSize={1}
            limit={SECTION_BOUNDS_LIMIT}
            onCommit={(axis, value) =>
              axis === 'x' || axis === 'y'
                ? commit({ type: 'position', section, [axis]: value })
                : commit({ type: 'size', section, axis, value })
            }
            sizeAction={
              <Tooltip label={t(section.lockAspectRatio ? 'inspector.unlinkSize' : 'inspector.linkSize')}>
                <Button
                  variant="bare"
                  size="icon-sm"
                  className={cn(
                    'size-5 rounded-tag',
                    section.lockAspectRatio ? 'bg-ink text-paper hover:bg-ink/85 hover:text-paper' : 'text-ink-faint',
                  )}
                  aria-label={t('inspector.linkSize')}
                  aria-pressed={section.lockAspectRatio ?? false}
                  onClick={() => update({ lockAspectRatio: !section.lockAspectRatio })}
                >
                  {section.lockAspectRatio ? <LinkIcon size="rail" /> : <UnlinkIcon size="rail" />}
                </Button>
              </Tooltip>
            }
          >
            <NumberField
              label={t('inspector.cornerRadius')}
              prefix={<RadiusIcon size="rail" />}
              unit="px"
              max={SECTION_BOUNDS_LIMIT}
              value={section.cornerRadius ?? SECTION_RADIUS}
              onCommit={(cornerRadius) => update({ cornerRadius })}
            />
          </InspectorBoxFields>
          <PropertySection title={t('inspector.sectionFill')}>
            <InspectorPaintRow>
              <ColorField
                label={t('inspector.fillColor')}
                value={fill}
                onCommit={(value) => update({ fill: value, ...(!fill && value ? { fillOpacity: 100 } : {}) })}
              />
              <NumberField
                label={t('inspector.fillOpacity')}
                prefix={<DropletIcon size="rail" />}
                unit="%"
                max={100}
                slider={[0, 100]}
                value={fill ? (section.fillOpacity ?? 100) : 0}
                onCommit={(fillOpacity) => update({ fillOpacity })}
              />
            </InspectorPaintRow>
          </PropertySection>
          <PropertySection title={t('inspector.sectionStroke')}>
            <InspectorPaintRow>
              <ColorField
                label={t('inspector.borderColor')}
                value={stroke}
                onCommit={(value) => update({ stroke: value })}
              />
              <NumberField
                label={t('inspector.borderWidth')}
                prefix={<StrokeWidthIcon size="rail" />}
                unit="px"
                max={1000}
                value={section.strokeWidth ?? 1}
                onCommit={(strokeWidth) => update({ strokeWidth })}
              />
            </InspectorPaintRow>
            <div className="mt-1.5 grid grid-cols-2 gap-1.5">
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
              <NumberField
                label={t('canvas.sectionStrokeOpacity')}
                prefix={<DropletIcon size="rail" />}
                unit="%"
                max={100}
                value={section.strokeOpacity ?? 100}
                onCommit={(strokeOpacity) => update({ strokeOpacity })}
              />
            </div>
          </PropertySection>
        </PropertyScrubContext.Provider>
        <div className="flex flex-wrap gap-1 px-3 py-2">
          <Button variant="bare" size="sm" disabled={!canFit} onClick={fitContents}>
            {t('canvas.sectionFitContents')}
          </Button>
          <Button variant="bare" size="sm" onClick={() => useStore.getState().focusSection(section.id)}>
            {t('canvas.sectionFit')}
          </Button>
          <Button variant="bare" size="sm" onClick={() => void copySectionLink(section)}>
            {t('canvas.sectionCopyLink')}
          </Button>
        </div>
      </PanelBody>
    </Panel>
  )
}
