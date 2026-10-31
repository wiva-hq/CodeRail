# The CodeRail mark

Two rails sweep round into a C and close on a green dot: the line running out to your machine. Drawn on
a 24-unit grid, centred, with about two units clear on every side.

| File | What | Where |
|---|---|---|
| `coderail-mark.svg` | ink `#18181b`, dot `#16a34a` | light grounds, 32 px and up |
| `coderail-mark-dark.svg` | `#fafafa`, dot `#4ade80` | dark grounds, 32 px and up |
| `coderail-mark-mono.svg` | one colour, `currentColor` | the menu-bar template image, print, anywhere a single colour is set from outside |
| `coderail-mark-small.svg` | a heavier cut (thicker far ends, bigger dot), colours as `coderail-mark.svg` | 16 to 24 px: favicon, tabs, the app's top bar |

The dot is the app's green ("on"). In the app, colour it with `--accent` from `web/src/styles/theme.css`
(`#15803d` light, `#4ade80` dark) rather than the hex in these files.

Where the app uses it: `web/src/assets/mark.svg` and `mark-small.svg` (the in-app mark, `Mark.svelte`),
`web/public/favicon.svg` and the PNG icons, and `mac/icon.swift`, which redraws the same geometry for the Mac app
icon. Change the mark here first, then in those.
