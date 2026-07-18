#!/bin/bash
branches=(
    "monet/model-identity-shared"
    "claude/openrouter-exclusive-picker-rotation"
    "claude/money-path-followups-1701"
    "codex/admin-console-shell"
)

git fetch origin main

for branch in "${branches[@]}"; do
    echo "Updating $branch"
    # Get the worktree path if it exists
    wt_path=$(git worktree list | grep "\[$branch\]" | awk '{print $1}')
    if [ -n "$wt_path" ]; then
        echo "Found in worktree $wt_path, removing..."
        git worktree remove -f "$wt_path"
    fi
    
    # Check it out in a new worktree
    mkdir -p /tmp/pr-updates
    target_wt="/tmp/pr-updates/$(basename $branch)"
    rm -rf "$target_wt"
    git worktree add "$target_wt" "origin/$branch"
    
    cd "$target_wt"
    git fetch origin main
    git merge origin/main --no-edit
    
    if [ $? -ne 0 ]; then
        echo "MERGE CONFLICT IN $branch!"
        git status
        exit 1
    else
        git push origin HEAD:"$branch"
    fi
    cd /Users/jay/Code/Socratic.Trade
    git worktree remove -f "$target_wt"
done
