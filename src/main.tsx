import React from 'react'
import ReactDOM from 'react-dom/client'
import { schedulePostHog } from './lib/posthog'
import { App } from './App'
import { initDesktopShell } from './lib/desktop'
import { TooltipProvider } from './components/ui/tooltip'
import { UpdateCard } from './components/UpdateCard'
import { initTheme } from './lib/theme'
import { initLocale } from './lib/i18n'
import { installTranslateGuard } from './lib/translateGuard'
import './styles.css'
import { loadPerfHud } from './perf/hudFlag'

installTranslateGuard()
initDesktopShell()
initTheme()

function Root() {
  React.useEffect(schedulePostHog, [])
  return (
    <TooltipProvider>
      <App />
      <UpdateCard />
    </TooltipProvider>
  )
}

/* the language is settled first, so the first paint already speaks it */
void initLocale().then(() => {
  if (import.meta.env.DEV) {
    const hud = loadPerfHud(location.search, localStorage, () => import('./perf/PerfHud'))
    if (hud) {
      return hud.then(({ PerfHud }) =>
        ReactDOM.createRoot(document.getElementById('root')!).render(
          <PerfHud>
            <React.StrictMode>
              <TooltipProvider>
                <App />
                <UpdateCard />
              </TooltipProvider>
            </React.StrictMode>
          </PerfHud>,
        ),
      )
    }
  }
  return ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <Root />
    </React.StrictMode>,
  )
})
