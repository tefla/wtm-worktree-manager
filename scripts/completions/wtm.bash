# bash completion for wtm
if ! type _init_completion >/dev/null 2>&1; then
    if [ -f /usr/share/bash-completion/bash_completion ]; then
        . /usr/share/bash-completion/bash_completion
    fi
fi

_wtm()
{
    local cur prev words cword
    _init_completion -n = || return

    if (( cword == 1 )); then
        COMPREPLY=( $(compgen -W "init completions workspace gui" -- "$cur") )
        return
    fi

    prev="${words[$cword-1]}"
    case "${words[1]}" in
        init|gui)
            return
            ;;
        completions)
            if (( cword == 2 )); then
                COMPREPLY=( $(compgen -W "generate suggest" -- "$cur") )
                return
            fi
            case "${words[2]}" in
                generate)
                    if (( cword == 3 )); then
                        COMPREPLY=( $(compgen -W "bash zsh" -- "$cur") )
                    fi
                    ;;
                suggest)
                    if [[ "$prev" == "--shell" ]]; then
                        COMPREPLY=( $(compgen -W "bash zsh" -- "$cur") )
                        return
                    fi
                    if [[ "$prev" == "--contains" ]]; then
                        return
                    fi
                    if [[ "$cur" == --* ]]; then
                        COMPREPLY=( $(compgen -W "--contains --shell --json" -- "$cur") )
                        return
                    fi
                    if (( cword == 3 )); then
                        COMPREPLY=( $(compgen -W "branches" -- "$cur") )
                        return
                    fi
                    ;;
            esac
            ;;
        workspace)
            if (( cword == 2 )); then
                COMPREPLY=( $(compgen -W "list create attach delete move telemetry" -- "$cur") )
                return
            fi
            case "${words[2]}" in
                list)
                    if [[ "$cur" == --* ]]; then
                        COMPREPLY=( $(compgen -W "--json" -- "$cur") )
                    fi
                    ;;
                create)
                    if [[ "$prev" == "--from" || "$prev" == "--path" ]]; then
                        return
                    fi
                    if [[ "$cur" == --* ]]; then
                        COMPREPLY=( $(compgen -W "--from --path --json" -- "$cur") )
                    else
                        COMPREPLY=( $(__wtm_branch_suggestions "$cur") )
                    fi
                    ;;
                attach)
                    if [[ "$prev" == "--path" ]]; then
                        return
                    fi
                    if [[ "$cur" == --* ]]; then
                        COMPREPLY=( $(compgen -W "--path --json" -- "$cur") )
                    else
                        COMPREPLY=( $(__wtm_branch_suggestions "$cur") )
                    fi
                    ;;
                delete)
                    if [[ "$cur" == --* ]]; then
                        COMPREPLY=( $(compgen -W "--name --branch --path --force --json" -- "$cur") )
                    fi
                    ;;
                move)
                    if [[ "$prev" == "--to" ]]; then
                        return
                    fi
                    if [[ "$cur" == --* ]]; then
                        COMPREPLY=( $(compgen -W "--name --branch --path --to --force --json" -- "$cur") )
                    fi
                    ;;
                telemetry)
                    if [[ "$cur" == --* ]]; then
                        COMPREPLY=( $(compgen -W "--name --branch --path --json --no-status --no-size" -- "$cur") )
                    fi
                    ;;
            esac
            ;;
    esac
}

__wtm_branch_suggestions()
{
    local query="$1"
    if [[ -z "$query" ]]; then
        wtm completions suggest branches --shell bash 2>/dev/null
    else
        wtm completions suggest branches --shell bash --contains "$query" 2>/dev/null
    fi
}

complete -F _wtm wtm
