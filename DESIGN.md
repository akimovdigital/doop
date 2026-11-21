# Doop Dev

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
