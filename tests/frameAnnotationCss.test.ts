import { Window } from 'happy-dom'
import { expect, it } from 'vitest'
import { FRAME_ANNOTATION_CSS_RUNTIME } from '../src/lib/frameAnnotationCss'

type PreviewTarget = { selector: string; properties: Record<string, string> }

function setup(html: string) {
  const { document, CSS } = new Window()
  document.body.innerHTML = html
  const sync = new Function(
    'document',
    'CSS',
    'styleTarget',
    'annotationChanged',
    FRAME_ANNOTATION_CSS_RUNTIME + '\nreturn syncAnnotationCss',
  )(
    document,
    CSS,
    (selector: string) => document.querySelector(selector),
    () => {},
  ) as (targets: PreviewTarget[]) => void
  return { sync, heading: document.querySelector('h1')! }
}

it('overrides authored important styles and restores the exact inline attribute when removed', () => {
  const authored = 'color: navy !important; padding: 2px 4px'
  const { heading, sync } = setup(`<h1 style="${authored}">Heading</h1>`)
  sync([{ selector: 'h1', properties: { color: 'red', 'padding-left': '8px' } }])
  expect(heading.style.getPropertyValue('color')).toBe('red')
  expect(heading.style.getPropertyPriority('color')).toBe('important')
  expect(heading.style.getPropertyValue('padding-left')).toBe('8px')
  sync([{ selector: 'h1', properties: { color: 'blue' } }])
  expect(heading.style.getPropertyValue('padding-left')).toBe('4px')
  sync([])
  expect(heading.getAttribute('style')).toBe(authored)
})

it('removes a preview-only style attribute on clear and preserves independent page changes', () => {
  const { heading, sync } = setup('<h1>Heading</h1>')
  const preview = [{ selector: 'h1', properties: { color: 'red' } }]
  sync(preview)
  expect(heading.style.getPropertyValue('color')).toBe('red')
  sync([])
  expect(heading.hasAttribute('style')).toBe(false)
  sync(preview)
  heading.style.setProperty('opacity', '0.5')
  sync([])
  expect(heading.style.getPropertyValue('color')).toBe('')
  expect(heading.style.getPropertyValue('opacity')).toBe('0.5')
})
