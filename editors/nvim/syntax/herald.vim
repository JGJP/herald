" Vim/Neovim syntax for herald `.herald` control files. Grammar mirrors parse() in
" herald.ts and the Sublime grammar (herald.sublime-syntax): column-0 lines are session
" headers, tab-indented lines are queue items (prompt / $command / #barrier / show /
" [status marker]). Status markers are white-on-red (override with `hi heraldStatus …`).

if exists('b:current_syntax')
  finish
endif

" Session header: a column-0 (non-tab) line. A trailing `!` means "show it now".
syntax match heraldHeader /^[^\t].*$/ contains=heraldBang

" Human-action barrier (comment-like); a run of `#` or `#2`/`##` targets a lane.
syntax match heraldBarrier /^\t\+ *#\+\d*.*$/

" Prompt: `prompt:` or the `:` shorthand; `::`/`:2` select the lane. Only the sigil is
" highlighted (\zs starts the match after the indent); the text stays normal.
syntax match heraldPromptSigil /^\t\+ *\zs\c\%(prompt\)\?:\+\d*/

" Command: `$`/`$$`/`$2` sigil, then the shell command text.
syntax match heraldCommandSigil /^\t\+ *\zs\$\+\d*/ nextgroup=heraldCommandText
syntax match heraldCommandText /.*/ contained

" Show item: a bare `show` (any case) or a bare `!`.
syntax match heraldShow /^\t\+ *\c\%(show\|!\)\s*$/

" Status markers (controller-written): [EXECUTING] [DONE] [NEEDS ATTENTION] [NO DIR …] …
" A trailing `!` means "reveal now".
syntax match heraldStatus /^\t\+ *\[[^\]]*\]!\=\s*$/ contains=heraldBang

" A trailing `!` reveal/show-now marker, highlighted within a header or status line.
syntax match heraldBang /!/ contained

highlight default link heraldHeader       Identifier
highlight default link heraldBarrier      Comment
highlight default link heraldPromptSigil  Statement
highlight default link heraldCommandSigil Operator
highlight default link heraldCommandText  String
highlight default link heraldShow         Keyword
highlight default link heraldBang         Special
" White on red, matching the Sublime setup; `default` so a colorscheme can override.
highlight default heraldStatus guifg=#ffffff guibg=#dc0404 ctermfg=15 ctermbg=196

let b:current_syntax = 'herald'
