#!/usr/bin/env bash
# Keep failure names and bounded diagnostics in the run summary, not file storage.
set -euo pipefail
{
  printf '## CI diagnostics\n\n'
  for root in "$@"; do
    [[ -e "$root" ]] || continue
    while IFS= read -r -d '' file; do
      printf '\n### %s\n\n' "$file"
      printf 'Failure/test-name lines (up to 200):\n```text\n'
      grep -Ei -B 2 'not ok|FAIL|Failed|Failure|Error:|✘|result="Failed"|status="failed"' "$file" | head -200 || true
      printf '\n```\nLast 50 lines:\n```text\n'
      tail -n 50 "$file"
      printf '\n```\n'
    done < <(find "$root" -type f \( -name '*.log' -o -name '*.txt' -o -name '*.xml' -o -name '*.md' \) -print0)
  done
} >> "$GITHUB_STEP_SUMMARY"
