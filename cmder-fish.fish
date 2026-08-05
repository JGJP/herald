# bot-cmder: signal `$command` completion to the controller from fish itself,
# instead of the controller appending a status-writing sentinel to each command.
# Active only in a cmder shell window (CMDER_SHELL is set on that window at spawn),
# so it is a no-op in normal shells and in the claude window. The controller polls
# the .cmd file's mtime to know the command has actually exited.
function __cmder_cmd_done --on-event fish_postexec
	set -l st $status
	test -n "$CMDER_SHELL" -a -n "$CMDER_LABEL"; or return
	set -l dir $CMDER_STATE
	test -n "$dir"; or set dir "$HOME/_dev/bot-cmder/state"
	echo $st >"$dir/$CMDER_LABEL.cmd"
end
