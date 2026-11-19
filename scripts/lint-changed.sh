#!/usr/bin/env bash
set -euo pipefail

base="${1:-origin/main}"
# git diff prints paths relative to the top level, git ls-files relative to the cwd.
top=$(git rev-parse --show-toplevel)
cd "$top"
mergebase=$(git merge-base "$base" HEAD)

# A file, not a process substitution, so a failing git command aborts the script.
list=$(mktemp)
trap 'rm -f "$list"' EXIT
{
  git diff -z --name-only --diff-filter=ACMR "$mergebase" -- '*.ts' '*.tsx' '*.mjs'
  git ls-files -z --others --exclude-standard -- '*.ts' '*.tsx' '*.mjs'
} >"$list"
sort -zu -o "$list" "$list"
mapfile -d '' files <"$list"

if [ "${#files[@]}" -eq 0 ]; then
  echo "no changed files to lint"
  exit 0
fi

# pnpm exec, so a direct run outside pnpm run still finds eslint.
pnpm exec eslint --max-warnings 0 --no-warn-ignored -- "${files[@]}"
