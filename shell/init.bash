# Santree Shell Integration for Bash
# ===================================
#
# This script provides a shell wrapper around the santree CLI to enable:
# 1. Automatic directory switching after `create` and `switch` commands
# 2. Automatic recovery when the current worktree directory is deleted
#
# Installation:
#   Add to your .bashrc: eval "$(santree shell-init bash)"
#
# How it works:
# -------------
# Since child processes cannot change the parent shell's directory, the CLI
# outputs special markers (SANTREE_CD:path) that this wrapper intercepts
# to perform the actual `cd` command in the current shell.
#
# The wrapper also handles the case where you're in a worktree directory
# that gets deleted (e.g., after `santree clean` or `santree remove`),
# automatically returning you to the main repository or home directory.

# Export marker so `santree doctor` can verify shell integration is loaded
export SANTREE_SHELL_INTEGRATION=1

function santree() {
    # -------------------------------------------------------------------------
    # STEP 1: Handle deleted directory recovery
    # -------------------------------------------------------------------------
    # If the current directory no longer exists (e.g., worktree was deleted),
    # navigate back to a safe location before running any command.
    if [[ ! -d "$(pwd 2>/dev/null)" ]]; then
        local current_path="$(pwd 2>/dev/null)"

        # Check if we were in a santree worktree directory
        if [[ "$current_path" == */.santree/worktrees/* ]]; then
            # Extract the main repo path (everything before /.santree/worktrees/)
            local main_repo="${current_path%%/.santree/worktrees/*}"
            if [[ -d "$main_repo" ]]; then
                echo "⚠ Worktree directory deleted. Returning to main repo."
                cd "$main_repo" || cd ~ || return 1
            else
                cd ~ || return 1
            fi
        else
            echo "⚠ Current directory no longer exists. Returning to home."
            cd ~ || return 1
        fi
    fi

    # -------------------------------------------------------------------------
    # STEP 2: Handle commands that need directory switching
    # -------------------------------------------------------------------------
    # The `create` and `switch` commands output SANTREE_CD:path markers
    # that we need to intercept to change the shell's directory.
    if [[ "$1" == "create" || "$1" == "switch" || "$1" == "sw" ]]; then
        local output
        output=$(command santree "$@" 2>&1)
        local exit_code=$?

        # Check if the output contains a directory change marker
        if [[ "$output" == *SANTREE_CD:* ]]; then
            # Print output without the marker lines
            echo "$output" | grep -v "SANTREE_CD:" | grep -v "SANTREE_WORK:"

            # Extract the target directory (strip ANSI color codes first)
            local target_dir=$(echo "$output" | sed 's/\x1b\[[0-9;]*m//g' | grep "SANTREE_CD:" | sed 's/.*SANTREE_CD://')

            # Change to the target directory if it exists
            if [[ -n "$target_dir" && -d "$target_dir" ]]; then
                cd "$target_dir" && echo "Switched to: $target_dir"
            fi

            # Check if we should also launch Claude (--work flag on create)
            if [[ "$output" == *SANTREE_WORK:* ]]; then
                local work_mode=$(echo "$output" | sed 's/\x1b\[[0-9;]*m//g' | grep "SANTREE_WORK:" | sed 's/.*SANTREE_WORK://')
                [[ "$work_mode" == "plan" ]] && command santree work --plan || command santree work
            fi
        else
            echo "$output"
        fi
        return $exit_code
    fi

    # -------------------------------------------------------------------------
    # STEP 3: Pass through all other commands
    # -------------------------------------------------------------------------
    command santree "$@"
}
