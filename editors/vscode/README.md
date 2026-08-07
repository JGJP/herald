# herald syntax for VS Code

Syntax highlighting for herald `.herald` control files.

Highlights session headers, `prompt:` / `:` lines (incl. numbered lanes `::`/`:2`),
`$command` lines (`$$`/`$2`), `#` barriers (`##`/`#2`), `show`/`!` items, and the
controller-written status markers (`[EXECUTING]`, `[DONE]`, `[NEEDS ATTENTION]`, …).

Colors come from your active theme via standard TextMate scopes, so no theme is bundled.
`[EXECUTING]` uses `constant.language`, `[DONE]` `markup.inserted`, `[NEEDS ATTENTION]`
`invalid.deprecated`, and other markers `invalid.illegal` — most themes render these
distinctly (a rough traffic light). To force your own, add to `settings.json`:

```jsonc
"editor.tokenColorCustomizations": {
  "textMateRules": [
    {
      "scope": [
        "constant.language.executing.herald",
        "markup.inserted.done.herald",
        "invalid.deprecated.attention.herald",
        "invalid.illegal.marker.herald"
      ],
      "settings": { "foreground": "#ffffff", "background": "#dc0404" }
    }
  ]
}
```

## Install

**From source (no packaging):** copy this `vscode/` folder into your VS Code extensions
dir as e.g. `herald-syntax`, then reload:

- macOS/Linux: `~/.vscode/extensions/herald-syntax/`
- Windows: `%USERPROFILE%\.vscode\extensions\herald-syntax\`

**Package a `.vsix`:** `npm i -g @vscode/vsce && vsce package`, then
`code --install-extension herald-syntax-0.1.0.vsix`.

The grammar (`syntaxes/herald.tmLanguage.json`) mirrors `herald.sublime-syntax` and
`parse()` in `herald.ts`.
