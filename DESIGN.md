# Doop Dev

The shared palette, typography and component primitives come from [the upstream Doop design guide](.context/DESIGN.md).
This file describes the interface specific to Doop Dev.

## Desktop canvas tabs

The 38 px rail is a desktop-app control. It appears on Home and in the signed-in canvas editor, but never in the web/browser UI or the prototype player. The native macOS controls keep their own space at the left. The Home button starts 18 px from the available left edge, matching the expanded dashboard brand inset of 12 px plus 6 px. Add Canvas follows the tabs and stays in view when the row scrolls. The rest of the rail is a window drag area. Home content keeps the same 38 px top inset as the editor, and the desktop shell retains its title-bar controls.

| Role                    | Light                  | Dark                      |
| ----------------------- | ---------------------- | ------------------------- |
| Rail                    | `--paper-deep` #f0f0f0 | #2a2a2a                   |
| Active tab and menu     | `--surface` #ffffff    | #1c1c1c                   |
| Hover                   | `--sub` #f7f7f7        | #242424                   |
| Primary label           | `--ink` #111111        | #f2f2f2                   |
| Secondary label         | `--ink-soft` #5f5e5b   | #a9a8a5                   |
| Selection line and icon | `--brand` #0177d3      | #3a9bef                   |
| Separators              | `--line` #dcdcdc       | rgba(255, 255, 255, 0.13) |
| Keyboard focus          | `--ring` #9c9b99       | #7a7976                   |

Labels use Inter with the app's fallback stack. Ordinary tabs use 12.5 px text on a 30 px button with a 6 px radius. Their slots shrink from 188 px to 84 px. The text truncates first and the full name remains available by tooltip and to assistive technology. Pinned canvases use a 32 px slot and the same 30 px pill as an ordinary tab. The active tab is the surface fill, with no blue underline. The close button is visible on active, hovered or keyboard-focused ordinary tabs.

The tabs stay in one scrolling row, with pinned canvases first. The selected tab scrolls into view. Arrow keys move focus, and Enter or Space opens the focused canvas. Saved tabs retain their canvas, page and pin state. Tabs from previous groups appear in the same row.

The tab menu uses the shared surface and border tokens with a 12 px radius. It includes inline renaming, pinning, window actions and closing. Dragging reorders tabs within the pinned or unpinned portion of the row. Split view shows two labelled editors side by side. See `src/components/DesktopTabs.tsx`, `src/lib/desktop.ts` and `src/App.tsx`.

## Home canvas menus

On Home, right-click and the tile's overflow button open the same action groups in grid and list view.
Both use Doop's Radix menu primitives, `--surface` for the menu, `--line-soft` for separators and the danger
tone for Move to trash. The overflow menu is 220 px wide where space permits. The pointer-anchored menu
shrinks on narrow screens to fit beside the pointer. Both menus scroll vertically when space is limited.

Add to sidebar uses checked rows for Pinned and the desktop-only Tab bar. Pinned canvases appear between
the library scopes and Workspaces in the rail. Show in folder scrolls the corresponding tile into view
with a temporary `--brand` outline. Rename replaces the canvas title with an inline input.

## Layers and sections

The left rail has Layers and Framework tabs. Pages, Sections and Layers appear in that order in the Layers
tab. Sections has its own disclosure, add control and scrolling area. In the Layers tree, Shift-click selects
a range, and selected layers can be dragged together. The primary row is revealed by scrolling the tree
inside the panel. See `src/components/LayersPanel.tsx` and `src/components/ui/panel.tsx`.

The canvas tool strip is a 36px pill: `h-9`, `rounded-[10px]`, horizontal padding 4px, the same
height and radius as the title and Import/Export pills (`data-slot="bar-pill"`). It does not use the
generic toolbar's 5px padding or 12px radius. The floating page chip is not on the stage. PageUp/PageDown,
the View menu, Layers and the empty-canvas context menu still switch pages. See `src/components/Stage.tsx`
and `src/components/TopBar.tsx`.

| Default section paint | Light     | Dark      |
| --------------------- | --------- | --------- |
| Fill                  | `#ebedf2` | `#30343c` |
| Stroke                | `#c3c9d3` | `#535b69` |

Sections default to an opaque fill, a 1 px inside stroke and an 8 px radius. A section sits behind its frames
and smaller sections it contains. Its screen-space title sits above the region. Selection adds the brand
outline and four handles. At 5% zoom or less, the selected section keeps its title visible over the frames.

The inspector uses the shared property panel, 244 px wide on desktop, with a sheet on mobile. It edits the
name, position, size, aspect ratio, radius and paints. Fill and stroke each have an opacity control. The
stroke also has a placement control. Clearing a paint field removes that paint. Moving a section moves its
contained objects. A frame selection can be wrapped in a section from its context menu. The section menu
offers a direct link and removal of the boundary. See `src/components/CanvasSections.tsx`,
`src/components/SectionInspector.tsx` and `shared/sections.ts`.

## Framework

Framework uses shared panel and form primitives. Compared with upstream's separate Components and Tokens
tabs, Dev shows Overview and Tokens inside Framework. Overview shows palette swatches and samples for
typography, spacing and radii. Tokens opens the shared theme selector and editable groups.

| Role            | Light                 | Dark                      |
| --------------- | --------------------- | ------------------------- |
| Panel           | `--surface` #ffffff   | #1c1c1c                   |
| Subdued surface | `--sub` #f7f7f7       | #242424                   |
| Subdued border  | `--line-soft` #ececec | rgba(255, 255, 255, 0.08) |
| Primary text    | `--ink` #111111       | #f2f2f2                   |
| Secondary text  | `--ink-soft` #5f5e5b  | #a9a8a5                   |

Source names use the label size. Variable names use the micro size and code type. Values use tabular
numerals. Import previews tokens from CSS, JSON, HTML, YAML, structured Markdown and the selected frame.
Confirmation adds new names and keeps existing values. Export includes CSS, JSON, DESIGN.md and an
HTML/CSS ZIP suitable for Instatic. See `src/components/FrameworkPanel.tsx` and `src/lib/frameworkFiles.ts`.

## Canvas rendering

HTML frames show live content with scripts, animation and media. On busy pages, visible documents are
admitted in batches and already loaded documents stay mounted as the camera moves. Overview previews
preserve the frame's theme and render at a density suited to the canvas zoom. While a document
loads, its surface uses `--sub` (#f7f7f7 light, #242424 dark). Once ready, transparent HTML sits on white
artboard paper. The floating HTML frame toolbar is temporarily opt-in with `doop:html-frame-toolbar`.
On macOS Chromium, live HTML on the editing canvas shows finite CSS and Web Animations effects at
their completed state. Repeating effects rest at a fixed phase and CSS state changes apply immediately.
Hover, selection and editing keep this static presentation. Present and the separate HTML Preview
document play the authored motion.
On macOS Chromium, a previously visible HTML frame returning to view uses
`--paper-deep` (#f0f0f0 light, #2a2a2a dark) behind the live document until its runtime reports
two animation callbacks. Zooming out to half the gesture's peak scale keeps neutral paper under
live frames for 1.5 seconds after the last zoom-out update, while the browser paints newly visible
parts of the document. The iframe draws as soon as the browser paints it. Transparent artboards return to
white paper after the guard. On a wide macOS Chromium overview, at most two new visible documents
start per animation tick until a boot slot is freed. Subsequent ticks can start up to three while
the same in-flight document and HTML limits apply.
Present opens the interactive prototype player. Its toolbar and page-frame pager sit above and
below the measured playback viewport. Hiding them keeps the viewport size and current frame scale.
Frames on another page wait for that page's HTML before mounting the new screen. The editor uses the
same typed runtime in canvas frames and the Browser annotation proxy, with canvas-only motion holds.
See `src/components/frameAdmission.ts`,
`src/components/Stage.tsx` and `src/components/FrameView.tsx`.

The macOS Chromium editor experiment `doop:far-overview` is off by default. It enters at
6% and exits at 8%. The overview uses static blocks from a bounded sample of the rendered artboard,
with the existing surface, line and ink tokens. It keeps the artboard bounds, stacking and label in
place. Selection reveals the live document in the same iframe. Focused and active documents keep
their live surface. Preview, Present and Prototype mode use the normal canvas rendering.

Canvas dots fade as their on-screen spacing falls from 10 px to 4 px. At overview zoom, the page colour
shows through. When canvas chrome is hidden, the bottom-right button and Escape bring it back.

## Prototype preview

The 36 px preview bar sits below the desktop strip and above the site viewport. It uses
Doop's solid dark `--surface`, a one-pixel `--line` divider and quiet 24 px Doop icon buttons. The 28 px address
field uses `--sub`, the 10 px pill radius and the shared focus ring. It truncates the preview
address and, where there is room, displays a muted frame name. The address suggestions and scaling
menu use the shared menu surface, radius and elevation. At Actual size the right scrollbar floats
over the site. Trackpad and wheel can still pan wide pages horizontally.

The editor can shrink the player into a centered 80% window with a 300 px minimum width where
space permits, a panel radius, an edge and `shadow-pop`. The 150 ms ease-out resize follows the
reduced-motion preference. The site and its overlays share a separately measured, clipped viewport
inside the window. Standalone preview keeps the same bar layout with its editor actions hidden. Full-window toolbars reserve 76 px on the left when macOS overlays the window controls.

The resizable Preview on the right leaves the editor, Layers and Agents visible in the remaining
space. Browser frames offer it from the Browser controls. The HTML frame toolbar offers it when
the experimental toolbar is enabled. Full-window Browser Present uses a solid paper backdrop.

## Development performance HUD

The opt-in HUD sits in the lower-right corner above the canvas toolbar and moves below the top chrome on narrow windows. It uses the surface, ink, line, panel-radius and caption tokens with tabular mono figures. It does not capture pointer input. Its styles load with the development HUD and do not ship in the production entry.

### Prototype annotations

Design Mode replaces the address and navigation cluster in the 36 px preview toolbar with an Exit icon and a brand-tinted hint. Holding Space over the preview restores page interaction until release. Hover and selection use 1 px brand outlines with tag badges at their top-right corners. The selection and note anchor follow changes to the element’s rendered bounds. A compact note pill sits below the selection and shows the Batch edits controls after typing. Numbered pins use 16 px brand circles at the top-right corners of their anchors and appear during Design Mode. The split Send pill stays in the toolbar while notes are pending. Its chevron anchors the queue popover. Text-only targets can be edited in the preview. The toolbar shows the save and cancel keys during an edit, and queued text edits carry a T marker. Single-element notes expose a sliders button that anchors a dark CSS inspector with a filter, inline values and changed properties first. Region notes open in move mode and add Draw, Ellipse, Rectangle and Arrow to the toolbar. Clicking the active tool returns to move mode. Markup uses 2 px brand strokes in page coordinates and stays visible with the region pin.

The note pill and queue use the toolbar's solid dark `--surface`, light `--ink`, a one-pixel `--line` border and `shadow-pop`. The queue is up to 300 px wide. Its header keeps the edit count and Clear All visible while notes scroll. Each row shows a label followed by the comment, with ellipses for long text. Pending, sent and resolved notes live in local storage per canvas. Sent pins are dimmed and resolved pins are hidden.

### Prototype chat capsule

At the bottom center of the preview, an 80 × 16 px button presents a textless 70 × 5 px grabber. The working indicator sits beside it while an agent is active. A short hover or click opens the shared draft composer, up to 560 px wide, with the latest reply and selected element when available. Pending notes are available in the expanded composer. The composer uses the same solid dark surface as the note pill and queue. It slides into place in 150 ms when motion is allowed.

Element and region chips sit above the draft in the preview capsule and the Agents composer. They use the shared row radius, brand tint and inset brand ring. The tooltip shows the selector, dimensions and component name when available. Draft chips have a remove button. Sent messages show the same chips above the note text. When a crop exists, its thumbnail appears inside the chip.

Dictate appears in the note's action row when it contains a comment, a text edit or CSS edits and in the capsule composer when speech recognition is available. A red recording indicator and a status hint appear while dictation is active. The indicator pulses when motion is allowed. Dictation errors appear below the input and dismiss after four seconds or on the next pointer or key press. When macOS Dictation is off, the notice includes an Open Settings action.

## Browser frame Design Mode

Present and side surfaces use the prototype's Annotate control and replace the address row with the selection hint during Design Mode. The existing accent ring, note card, numbered pins and send queue sit over the browser viewport. Exiting restores the website address and direct browsing.
