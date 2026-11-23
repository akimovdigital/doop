import { Laptop, RotateCw, Smartphone, Tablet } from 'lucide-react'
import type { ComponentProps } from 'react'
import { browserAddress, browserDeviceSize } from '../../shared/browserFrame'
import {
  canAcquireFrameSource,
  captureChromeFrame,
  copyFrameAddress,
  framePreviewAddress,
  frameWebSource,
  importChromeFrame,
  nextHtmlDevice,
  resizeHtmlFrame,
} from '../lib/canvasFrameChrome'
import { useT } from '../lib/i18n'
import { FrameBrowserChrome } from './FrameBrowserChrome'
import { Button } from './ui/button'
import { IconButton } from './ui/icon-button'

const devices = {
  laptop: ['canvas.browserLaptop', Laptop],
  tablet: ['canvas.browserTablet', Tablet],
  phone: ['canvas.browserPhone', Smartphone],
} as const

export function HtmlFrameBrowserBar({
  frame,
  readOnly,
  onReload,
  ...props
}: Omit<
  ComponentProps<typeof FrameBrowserChrome>,
  'html' | 'address' | 'reload' | 'device' | 'onCapture' | 'onImport'
> & {
  readOnly: boolean
  onReload: () => void
}) {
  const t = useT()
  const source = frameWebSource(frame)
  const address = source ?? framePreviewAddress(frame)
  const next = nextHtmlDevice(frame)
  const [deviceLabel, DeviceIcon] = devices[next]
  return (
    <FrameBrowserChrome
      {...props}
      frame={frame}
      html
      address={
        <Button
          variant="bare"
          type="button"
          className="h-6 min-w-0 flex-1 justify-start overflow-hidden rounded-row px-1 text-label"
          title={address}
          aria-label={t(source ? 'canvas.chromeCopySource' : 'canvas.chromeCopyLink')}
          onClick={() => void copyFrameAddress(address)}
        >
          <span className="truncate">{browserAddress(address)}</span>
        </Button>
      }
      reload={
        <IconButton size="sm" aria-label={t('canvas.browserReload')} onClick={onReload}>
          <RotateCw size={14} />
        </IconButton>
      }
      device={
        !readOnly && (
          <IconButton
            size="sm"
            aria-label={t('canvas.chromeNextDevice', { ...browserDeviceSize(next, frame), device: t(deviceLabel) })}
            onClick={() => resizeHtmlFrame(frame, next)}
          >
            <DeviceIcon size={14} />
          </IconButton>
        )
      }
      onCapture={!readOnly ? (area) => void captureChromeFrame(frame, area) : undefined}
      onImport={
        !readOnly && source && canAcquireFrameSource(source) ? () => void importChromeFrame(frame, source) : undefined
      }
    />
  )
}
