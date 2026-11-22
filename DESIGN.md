# Doop Dev

The shared palette, typography and component primitives come from [the upstream Doop design guide](.context/DESIGN.md).
This file describes the interface specific to Doop Dev.

## macOS editor windows

Doop Dev starts in Local Dev. The native Window menu shows Local Dev and Doop Cloud, with a checkmark
for the focused mode. Choosing a mode brings its existing window forward, including when it is minimized.
The local canvas stays open with its current tab, selection and camera.

Doop Cloud first opens the hosted editor in an independent window with a standard macOS title bar.
Its label is Doop Cloud. It uses a separate website data store. Web links that request a new window
open in the system browser, and downloads use the native save panel. See `desktop/src-tauri/src/dev_modes.rs`.

## Desktop canvas tabs

The 38 px rail keeps the native macOS controls at the left, followed by Home, the group picker, and the canvas tabs. Add Canvas follows the tabs and stays in view when the row scrolls. The rest of the rail is a window drag area.

| Role                    | Light                  | Dark                      |
| ----------------------- | ---------------------- | ------------------------- |
| Rail                    | `--paper-deep` #f0f0f0 | #2a2a2a                   |
| Active tab and menu     | `--surface` #ffffff    | #1c1c1c                   |
| Hover and group picker  | `--sub` #f7f7f7        | #242424                   |
| Primary label           | `--ink` #111111        | #f2f2f2                   |
| Secondary label         | `--ink-soft` #5f5e5b   | #a9a8a5                   |
| Selection line and icon | `--brand` #0177d3      | #3a9bef                   |
| Separators              | `--line` #dcdcdc       | rgba(255, 255, 255, 0.13) |
| Keyboard focus          | `--ring` #9c9b99       | #7a7976                   |

Labels use Inter with the app's fallback stack. Group labels use 11 px medium text and a tabular count. Ordinary tabs use 12.5 px text on a 30 px button with a 6 px radius. Their slots shrink from 188 px to 84 px. The text truncates first and the full name remains available by tooltip and to assistive technology. Pinned canvases use 32 px slots with a centred icon. A blue underline identifies the active tab, including pinned tabs. The close button is visible on active, hovered or keyboard-focused ordinary tabs.

The group picker shows all tabs or switches to a named group. It can create an empty group, rename the current group, or ungroup its canvases. Empty groups show a zero count. The choice is saved per account. Pinned tabs stay available across the groups. The tabs remain in one scrolling row and the selected tab is brought into view. Arrow keys move focus, and Enter or Space opens the focused canvas. Existing groups, pins and ordering use the canvas tab store.

The browser reference informed the compact pins, group counts and single scrolling row. Doop uses its own icons, typography, neutral surfaces and blue selection line. See `src/components/DesktopTabs.tsx`, `src/lib/desktop.ts` and `src/styles.css`.

The tab menu uses the shared surface and border tokens with a 12 px radius. It includes inline renaming,
pinning, grouping, window actions and closing. Tabs can be reordered within their permitted group or pinned
row. Split view shows two labelled editors side by side. See `src/components/DesktopTabs.tsx` and `src/App.tsx`.

## Layers and sections

The left rail has Layers and Framework tabs. Pages, Sections and Layers appear in that order in the Layers
tab. Sections has its own disclosure, add control and scrolling area. In the Layers tree, Shift-click selects
a range, and selected layers can be dragged together. The primary row is revealed by scrolling the tree
inside the panel. See `src/components/LayersPanel.tsx` and `src/components/ui/panel.tsx`.

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
admitted in batches and already loaded documents stay mounted as the camera moves. While a document
loads, its surface uses `--sub` (#f7f7f7 light, #242424 dark). Once ready, transparent HTML sits on white
artboard paper. Present opens the interactive prototype player. See `src/components/frameAdmission.ts`,
`src/components/Stage.tsx` and `src/components/FrameView.tsx`.

Canvas dots fade as their on-screen spacing falls from 10 px to 4 px. At overview zoom, the page colour
shows through. When canvas chrome is hidden, the bottom-right button and Escape bring it back.
