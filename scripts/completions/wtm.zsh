#compdef wtm

_wtm() {
    local cur prev
    cur=${words[CURRENT]}
    prev=${words[CURRENT-1]}

    if (( CURRENT == 2 )); then
        _values 'command' init completions workspace gui
        return
    fi

    case ${words[2]} in
        completions)
            if (( CURRENT == 3 )); then
                _values 'subcommand' generate suggest
                return
            fi
            case ${words[3]} in
                generate)
                    if (( CURRENT == 4 )); then
                        _values 'shell' bash zsh
                    fi
                    ;;
                suggest)
                    if [[ $prev == --shell ]]; then
                        _values 'shell' bash zsh
                        return
                    fi
                    if [[ $prev == --contains ]]; then
                        return
                    fi
                    if [[ $cur == --* ]]; then
                        _values 'option' --contains --shell --json
                        return
                    fi
                    if (( CURRENT == 4 )); then
                        _values 'domain' branches
                        return
                    fi
                    ;;
            esac
            ;;
        workspace)
            if (( CURRENT == 3 )); then
                _values 'subcommand' list create attach delete move telemetry
                return
            fi
            case ${words[3]} in
                list)
                    _values 'option' --json
                    ;;
                create)
                    if [[ $prev == --from ]]; then
                        _message 'upstream reference'
                        return
                    fi
                    if [[ $prev == --path ]]; then
                        _files -/
                        return
                    fi
                    if [[ $cur == --* ]]; then
                        _values 'option' --from --path --json
                        return
                    fi
                    if (( CURRENT == 4 )); then
                        __wtm_zsh_branch_suggestions "$cur"
                        return
                    fi
                    ;;
                attach)
                    if [[ $prev == --path ]]; then
                        _files -/
                        return
                    fi
                    if [[ $cur == --* ]]; then
                        _values 'option' --path --json
                        return
                    fi
                    if (( CURRENT == 4 )); then
                        __wtm_zsh_branch_suggestions "$cur"
                        return
                    fi
                    ;;
                delete)
                    if [[ $cur == --* ]]; then
                        _values 'option' --name --branch --path --force --json
                        return
                    fi
                    ;;
                move)
                    if [[ $prev == --to ]]; then
                        _files -/
                        return
                    fi
                    if [[ $cur == --* ]]; then
                        _values 'option' --name --branch --path --to --force --json
                        return
                    fi
                    ;;
                telemetry)
                    if [[ $cur == --* ]]; then
                        _values 'option' --name --branch --path --json --no-status --no-size
                        return
                    fi
                    ;;
            esac
            ;;
    esac
}

__wtm_zsh_branch_suggestions() {
    local query=$1
    local -a suggestions
    if [[ -z $query ]]; then
        suggestions=(${(f)$(wtm completions suggest branches --shell zsh 2>/dev/null)})
    else
        suggestions=(${(f)$(wtm completions suggest branches --shell zsh --contains "$query" 2>/dev/null)})
    fi
    _describe 'branch' suggestions
}

compdef _wtm wtm
