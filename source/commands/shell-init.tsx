import { argument } from "pastel";
import { z } from "zod/v4";

export const args = z.tuple([
	z
		.enum(["zsh", "bash"])
		.default("zsh")
		.describe(argument({ name: "shell", description: "Shell type (zsh or bash)" })),
]);

type Props = {
	args: z.infer<typeof args>;
};

const ZSH_INIT = `# Santree shell integration
# Add to your .zshrc: eval "$(santree shell-init zsh)"

function santree() {
    # Check if current directory exists (might have been deleted by clean/remove)
    if [[ ! -d "$(pwd 2>/dev/null)" ]]; then
        local current_path="$(pwd 2>/dev/null)"
        if [[ "$current_path" == */.santree/worktrees/* ]]; then
            local main_repo="\${current_path%%/.santree/worktrees/*}"
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

    # create/switch need output capture for cd
    if [[ "$1" == "create" || "$1" == "switch" || "$1" == "sw" ]]; then
        local output
        output=$(command santree "$@" 2>&1)
        local exit_code=$?

        if [[ "$output" == *SANTREE_CD:* ]]; then
            echo "$output" | grep -v "SANTREE_CD:" | grep -v "SANTREE_WORK:"
            local target_dir=$(echo "$output" | sed 's/\\x1b\\[[0-9;]*m//g' | grep "SANTREE_CD:" | sed 's/.*SANTREE_CD://')
            if [[ -n "$target_dir" && -d "$target_dir" ]]; then
                cd "$target_dir" && echo "Switched to: $target_dir"
            fi

            if [[ "$output" == *SANTREE_WORK:* ]]; then
                local work_mode=$(echo "$output" | sed 's/\\x1b\\[[0-9;]*m//g' | grep "SANTREE_WORK:" | sed 's/.*SANTREE_WORK://')
                [[ "$work_mode" == "plan" ]] && command santree work --plan || command santree work
            fi
        else
            echo "$output"
        fi
        return $exit_code
    fi

    command santree "$@"
}
`;

const BASH_INIT = `# Santree shell integration
# Add to your .bashrc: eval "$(santree shell-init bash)"

function santree() {
    # Check if current directory exists (might have been deleted by clean/remove)
    if [[ ! -d "$(pwd 2>/dev/null)" ]]; then
        local current_path="$(pwd 2>/dev/null)"
        if [[ "$current_path" == */.santree/worktrees/* ]]; then
            local main_repo="\${current_path%%/.santree/worktrees/*}"
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

    # create/switch need output capture for cd
    if [[ "$1" == "create" || "$1" == "switch" || "$1" == "sw" ]]; then
        local output
        output=$(command santree "$@" 2>&1)
        local exit_code=$?

        if [[ "$output" == *SANTREE_CD:* ]]; then
            echo "$output" | grep -v "SANTREE_CD:" | grep -v "SANTREE_WORK:"
            local target_dir=$(echo "$output" | sed 's/\\x1b\\[[0-9;]*m//g' | grep "SANTREE_CD:" | sed 's/.*SANTREE_CD://')
            if [[ -n "$target_dir" && -d "$target_dir" ]]; then
                cd "$target_dir" && echo "Switched to: $target_dir"
            fi

            if [[ "$output" == *SANTREE_WORK:* ]]; then
                local work_mode=$(echo "$output" | sed 's/\\x1b\\[[0-9;]*m//g' | grep "SANTREE_WORK:" | sed 's/.*SANTREE_WORK://')
                [[ "$work_mode" == "plan" ]] && command santree work --plan || command santree work
            fi
        else
            echo "$output"
        fi
        return $exit_code
    fi

    command santree "$@"
}
`;

export default function ShellInit({ args }: Props) {
	const [shell] = args;
	const script = shell === "zsh" ? ZSH_INIT : BASH_INIT;
	console.log(script);
	return null;
}
