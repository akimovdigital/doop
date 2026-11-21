import { useEffect, useMemo, useRef, useState } from 'react'
import {
  describeTokens,
  resolveToken,
  tokensCss,
  tokensMarkdown,
  type DesignToken,
  type DesignTokenInput,
} from '../../shared/designTokens'
import { api } from '../lib/api'
import { saveBlob } from '../lib/frameExport'
import { canEditOpenCanvas, useStore } from '../lib/store'
import { useT } from '@/lib/i18n'
import { TokensSection, TokenSwatch } from './TokensPanel'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Pressable } from './ui/pressable'
import { PanelBody, PanelIconTab, PanelTabs, PanelTabsRoot } from './ui/panel'
import { BracesIcon, GithubIcon, PaletteIcon } from './ui/icons'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './ui/dropdown-menu'

const EMPTY_TOKENS: DesignToken[] = []
const EMPTY_THEMES: string[] = []
type Source = { name: string; tokens: DesignTokenInput[] }
type FrameSource = Source & { frameId: string; html: string }
type FrameworkReader = typeof import('../lib/frameworkFiles')
const loadReader = (): Promise<FrameworkReader> => import('../lib/frameworkFiles')

export function FrameworkPanel() {
  const id = useStore((s) => s.canvas?.id)
  const tokens = useStore((s) => s.canvas?.tokens ?? EMPTY_TOKENS)
  const themes = useStore((s) => s.canvas?.tokenThemes ?? EMPTY_THEMES)
  const guidelines = useStore((s) => s.canvas?.guidelines)
  const readOnly = useStore((s) => !canEditOpenCanvas(s))
  const frame = useStore((s) => s.canvas?.frames.find((frame) => frame.id === s.selectedId))
  const [view, setView] = useState('overview')
  const [reader, setReader] = useState<FrameworkReader | null>(null)
  const [frameSource, setFrameSource] = useState<FrameSource | null>(null)
  const [fileSource, setFileSource] = useState<Source | null>(null)
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const t = useT()

  useEffect(() => {
    let mounted = true
    void loadReader()
      .then((module) => {
        if (mounted) setReader(module)
      })
      .catch(() => {
        if (mounted) setNotice(t('panels.frameworkReadFailed'))
      })
    return () => {
      mounted = false
    }
  }, [t])

  useEffect(() => {
    if (!reader || !frame?.html || view !== 'overview') return
    const timeout = window.setTimeout(() => {
      try {
        setFrameSource({
          frameId: frame.id,
          html: frame.html,
          name: frame.name,
          tokens: reader.readFrameFramework(frame.html),
        })
      } catch {
        setFrameSource(null)
        setNotice(t('panels.frameworkReadFailed'))
      }
    }, 180)
    return () => window.clearTimeout(timeout)
  }, [reader, frame?.id, frame?.name, frame?.html, view, t])

  const source =
    fileSource ??
    (frame && frameSource?.frameId === frame.id && frameSource.html === frame.html && frameSource.tokens.length
      ? frameSource
      : null)
  const known = useMemo(() => new Set(tokens.map((token) => token.name)), [tokens])
  const incoming = useMemo(
    () => (source && reader ? reader.orderFrameworkImports(source.tokens, known) : []),
    [reader, source, known],
  )
  const swatches = useMemo(() => tokens.filter((token) => token.type === 'color').slice(0, 10), [tokens])
  const guide = guidelines?.find((doc) => /^(design(?:\.md)?|design-system)$/i.test(doc.title ?? doc.name))
  const typography = tokens.filter((row) => row.type === 'fontFamily' || row.type === 'fontSize')
  const spacing = tokens.filter((row) => row.type === 'spacing' || row.type === 'radius')

  async function readFiles(files: File[]) {
    if (!files.length || !reader || busy) return
    setBusy(true)
    setNotice('')
    setFileSource(null)
    try {
      const picked = new Map<string, DesignTokenInput>()
      let skipped = 0
      for (const file of files) {
        try {
          if (file.size > reader.FRAMEWORK_FILE_LIMIT) throw new Error('file limit')
          const found = reader.readFrameworkFile(file.name, await file.text())
          if (!found.length) skipped++
          for (const token of found) if (!picked.has(token.name)) picked.set(token.name, token)
        } catch {
          skipped++
        }
      }
      if (picked.size) {
        const name = files.length === 1 ? files[0]!.name : t('panels.frameworkFiles', { count: files.length })
        setFileSource({ name, tokens: [...picked.values()] })
      }
      if (skipped) setNotice(t('panels.frameworkSkipped', { count: skipped }))
    } finally {
      setBusy(false)
    }
  }

  async function addTokens() {
    if (!id || readOnly || busy || !incoming.length) return
    setBusy(true)
    setNotice('')
    try {
      const { results, tokens } = await api.createTokens(id, incoming)
      const current = useStore.getState()
      if (current.canvas?.id === id) current.setTokensLocal(tokens, current.canvas.tokenThemes ?? [])
      const errors = results.filter((result) => result.result === 'error')
      const added = results.length - errors.length
      setNotice(
        t('panels.frameworkAdded', { count: added }) + (errors[0] ? ` · ${errors[0].name} — ${errors[0].message}` : ''),
      )
      if (!errors.length) setFileSource(null)
    } catch {
      setNotice(t('panels.frameworkWriteFailed'))
    } finally {
      setBusy(false)
    }
  }

  function download(format: 'css' | 'json' | 'md') {
    const css = tokensCss(tokens, themes)
    const contents =
      format === 'css'
        ? css + '\n'
        : format === 'json'
          ? JSON.stringify({ tokens: describeTokens(tokens) }, null, 2) + '\n'
          : [
              '# Design system',
              tokensMarkdown(tokens, themes),
              '```css\n' + css + '\n```',
              ...(guidelines ?? []).map((doc) => doc.markdown),
            ]
              .filter(Boolean)
              .join('\n\n') + '\n'
    const title = format === 'md' ? 'DESIGN.md' : `framework.${format}`
    saveBlob(
      new Blob([contents], {
        type: format === 'css' ? 'text/css' : format === 'json' ? 'application/json' : 'text/markdown',
      }),
      title,
    )
  }

  async function downloadSitePackage() {
    try {
      const { default: JSZip } = await import('jszip')
      const archive = new JSZip()
      archive.file('framework.css', tokensCss(tokens, themes) + '\n')
      archive.file(
        'index.html',
        '<!doctype html>\n<html lang="en"><meta charset="utf-8"><title>Design system</title><link rel="stylesheet" href="framework.css"><main><h1>Design system</h1></main></html>\n',
      )
      saveBlob(await archive.generateAsync({ type: 'blob' }), 'design-system.zip')
    } catch {
      setNotice(t('panels.frameworkExportFailed'))
    }
  }

  return (
    <PanelBody data-framework-panel="" className="flex flex-col pb-2">
      <PanelTabsRoot value={view} onValueChange={setView} className="mx-2 my-2 flex-none">
        <PanelTabs aria-label="Framework">
          <PanelIconTab value="overview" icon={<PaletteIcon />} title={t('panels.frameworkOverview')}>
            {t('panels.frameworkOverview')}
          </PanelIconTab>
          <PanelIconTab value="tokens" icon={<BracesIcon />} title={t('panels.layersTabTokens')}>
            {t('panels.layersTabTokens')}
          </PanelIconTab>
        </PanelTabs>
      </PanelTabsRoot>
      {view === 'tokens' ? (
        <TokensSection />
      ) : (
        <div className="flex min-w-0 flex-col gap-3 px-2.5">
          <div className="grid grid-cols-2 gap-1.5">
            <Input
              ref={input}
              hidden
              type="file"
              multiple
              accept=".css,.json,.md,.markdown,.yaml,.yml,.html,.htm"
              onChange={(e) => {
                void readFiles(Array.from(e.currentTarget.files ?? []))
                e.currentTarget.value = ''
              }}
            />
            <Button
              size="sm"
              variant="default"
              disabled={!reader || busy || readOnly}
              onClick={() => input.current?.click()}
            >
              {t('panels.frameworkImport')}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="default" disabled={!tokens.length}>
                  {t('panels.frameworkExport')}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuItem onSelect={() => download('css')}>CSS</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => download('json')}>JSON</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => download('md')}>DESIGN.md</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void downloadSitePackage()}>Instatic · HTML/CSS ZIP</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          {guide && !readOnly && (
            <Button
              size="sm"
              variant="bare"
              disabled={!reader || busy}
              onClick={() => {
                setNotice('')
                try {
                  const found = reader?.readFrameworkMarkdown(guide.markdown) ?? []
                  if (found.length) setFileSource({ name: guide.title ?? guide.name, tokens: found })
                  else setNotice(t('panels.frameworkNoTokens'))
                } catch {
                  setNotice(t('panels.frameworkReadFailed'))
                }
              }}
            >
              {t('panels.frameworkGuide')}
            </Button>
          )}
          {notice && (
            <p role="status" className="break-words text-label text-ink-soft">
              {notice}
            </p>
          )}
          {source && (
            <div className="min-w-0 rounded-control border border-line-soft bg-sub p-2.5" data-framework-source="">
              <div className="flex items-start justify-between gap-1">
                <div className="min-w-0">
                  <div className="truncate text-label font-medium text-ink" title={source.name}>
                    {source.name}
                  </div>
                  <div className="text-micro text-ink-soft">
                    {t('panels.frameworkFound', { count: incoming.length })}
                  </div>
                </div>
                {fileSource && (
                  <Button size="sm" variant="bare" onClick={() => setFileSource(null)}>
                    {t('common.close')}
                  </Button>
                )}
              </div>
              {incoming.length > 0 && (
                <ul className="my-2 max-h-32 space-y-1 overflow-y-auto" aria-label={source.name}>
                  {incoming.map((row) => (
                    <li key={row.name} className="flex items-center justify-between gap-2 text-micro">
                      <code className="min-w-0 truncate text-ink" title={row.name}>
                        {row.name}
                      </code>
                      <span className="min-w-0 truncate text-ink-soft" title={row.value}>
                        {row.value}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {!readOnly && incoming.length > 0 && (
                <Button size="sm" variant="primary" disabled={busy} onClick={() => void addTokens()}>
                  {t('panels.frameworkAdd')}
                </Button>
              )}
            </div>
          )}
          <Pressable
            onClick={() => setView('tokens')}
            className="flex flex-col gap-2 rounded-control border border-line-soft p-2.5 text-left hover:bg-sub"
          >
            <span className="text-label font-medium text-ink">{t('panels.frameworkSystem')}</span>
            {swatches.length > 0 && (
              <span className="flex flex-wrap gap-1.5">
                {swatches.map((row) => (
                  <span
                    key={row.name}
                    title={`${row.name} · ${resolveToken(tokens, row.name) ?? row.value}`}
                    className="flex"
                  >
                    <TokenSwatch token={row} tokens={tokens} size={16} />
                  </span>
                ))}
              </span>
            )}
            {tokens.length > 0 ? (
              <>
                <TokenPreview title={t('panels.frameworkType')} rows={typography} tokens={tokens} />
                <TokenPreview title={t('panels.frameworkSpacing')} rows={spacing} tokens={tokens} />
              </>
            ) : (
              <span className="text-micro text-ink-soft">{t('panels.frameworkEmpty')}</span>
            )}
          </Pressable>
          <a
            href="https://github.com/CoreBunch/Core-Framework"
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1.5 text-micro text-ink-soft hover:text-ink"
          >
            <GithubIcon className="size-3.5" /> Core Framework
          </a>
        </div>
      )}
    </PanelBody>
  )
}

function TokenPreview({ title, rows, tokens }: { title: string; rows: DesignToken[]; tokens: DesignToken[] }) {
  if (!rows.length) return null
  return (
    <span className="grid w-full gap-1 border-t border-line-soft pt-2 text-micro text-ink-soft">
      <span className="font-medium text-ink">{title}</span>
      {rows.slice(0, 4).map((row) => {
        const value = resolveToken(tokens, row.name) ?? row.value
        return (
          <span key={row.name} className="grid grid-cols-[1fr_minmax(0,45%)] gap-1.5">
            <code className="truncate" title={row.name}>
              {row.name}
            </code>
            <span className="truncate text-right tabular-nums" title={value}>
              {value}
            </span>
          </span>
        )
      })}
    </span>
  )
}
