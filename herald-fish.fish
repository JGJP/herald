# herald: signal `$command` completion to the controller from fish itself,
# instead of the controller appending a status-writing sentinel to each command.
# Active only in a herald shell window (HERALD_SHELL is set on that window at spawn),
# so it is a no-op in normal shells and in the claude window. The controller polls
# the .cmd file's mtime to know the command has actually exited.
function __herald_cmd_done --on-event fish_postexec
	set -l st $status
	test -n "$HERALD_SHELL" -a -n "$HERALD_LABEL"; or return
	set -l dir $HERALD_STATE
	test -n "$dir"; or set dir "$HOME/_dev/herald/state"
	echo $st >"$dir/$HERALD_LABEL.cmd"
end
