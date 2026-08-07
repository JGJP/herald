# herald: signal `$command` completion to the controller from zsh itself, instead
# of the controller appending a status-writing sentinel to each command. Sourced
# from ~/.zshrc but active only in a herald shell window (HERALD_SHELL is set on
# that window at spawn), so it is a no-op in normal shells and in the claude window.
# The controller polls the .cmd file's mtime to know the command has actually exited.
if [ -n "$HERALD_SHELL" ] && [ -n "$HERALD_LABEL" ]; then
	__herald_cmd_done() {
		local st=$?
		local dir="${HERALD_STATE:-$HOME/_dev/herald/state}"
		# HERALD_PANE (set on numbered shells, `$2`/`$$` …) suffixes the done-file so each
		# lane's shell reports independently; lane 1 (unset) keeps the bare `<label>.cmd`.
		echo "$st" >"$dir/$HERALD_LABEL${HERALD_PANE:+.$HERALD_PANE}.cmd"
	}
	# precmd runs before each prompt (i.e. after each command). Prepend ours so it
	# captures $? before any other precmd hook can change it.
	typeset -ga precmd_functions
	if (( ! ${precmd_functions[(Ie)__herald_cmd_done]} )); then
		precmd_functions=(__herald_cmd_done $precmd_functions)
	fi
fi
