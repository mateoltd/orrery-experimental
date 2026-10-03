#!/usr/bin/env bash
# The unit count, with NO silent zeroes and NO HARDCODED PACKAGE LIST.
#
# ## WHY THIS EXISTS
#
# The sweep loop this replaces did `grep -oE 'Tests +[0-9]+ passed' | grep -oE '[0-9]+'` per package and
# added whatever came back, so a package whose output did not match contributed NOTHING and the total came
# out 55 short of reality with no error anywhere. A count that cannot detect a missing package is not a
# measurement.
#
# It then hardcoded a list of package names, which reintroduced the same failure one level up: adding a
# package and forgetting the script would under-report forever, silently. The list is DISCOVERED from
# whatever has a `test` script, and every discovered package is also compared against the list that was
# run, so a package that matched nothing is named rather than skipped.
#
# ## WHY IT IS IN `scripts/` AND NOT `.tmp/`
#
# It lived in `.tmp/`, where `.gitignore` admits only `.tmp/TRACKER.md`. Every unit total quoted in the
# tracker therefore rested on a script that existed on exactly one machine. A number in the record that
# nobody else can reproduce is a rumour.
set -uo pipefail
cd "$(dirname "$0")/.."

total=0
failed=0
ran=""

count_one() {
  # $1 = directory, $2 = label, $3 = extra vitest arguments
  local out n
  out=$(cd "$1" && timeout 900 ../../node_modules/.bin/vitest run ${3:-} 2>&1)
  n=$(printf '%s' "$out" | grep -oE 'Tests +[0-9]+ passed' | grep -oE '[0-9]+' | head -1)
  if [ -z "$n" ]; then
    echo "NO COUNT: $2"
    failed=1
    return
  fi
  total=$((total + n))
  ran="$ran $2"
}

# Discovered, not listed: any workspace directory with a `test` script.
for dir in packages/*/ apps/*/; do
  [ -f "$dir/package.json" ] || continue
  node -e '
    const p = require("./'"$dir"'package.json");
    process.exit(p.scripts && p.scripts.test ? 0 : 1);
  ' 2>/dev/null || continue
  count_one "$dir" "${dir%/}"
done

# `sims/` is deliberately NOT a workspace, so it is counted separately AND FROM THE REPOSITORY ROOT.
#
# Three things were wrong with counting it in place, and each failed silently as "NO COUNT":
#   - `sims/` has no `node_modules/.bin/vitest`; pnpm resolves binaries per workspace, so
#     `../../node_modules/.bin/vitest` does not exist (the root `.bin` has no vitest either).
#   - `pnpm exec vitest` from inside `sims/` DOES run, but it resolves a different root, so 133 tests
#     failed on `Validation Error Count: 1` -- and a regex looking for `Tests N passed` finds nothing
#     when a suite fails, which is why the guard reported a missing count rather than a failure.
#   - `sims/vitest.config.ts` names `sims/` as its root, so it must be passed from the repository root,
#     exactly as `pnpm test:sims` does.
sims_out=$(timeout 900 pnpm exec vitest run --config sims/vitest.config.ts 2>&1)
sims_n=$(printf '%s' "$sims_out" | grep -oE 'Tests +[0-9]+ passed' | grep -oE '[0-9]+' | head -1)
if [ -z "$sims_n" ]; then
  echo "NO COUNT: sims"
  failed=1
else
  total=$((total + sims_n))
  ran="$ran sims"
fi

echo "UNIT TOTAL: $total"
echo "COUNTED:$ran"
[ "$failed" -eq 0 ] || { echo "INCOMPLETE — the total above is NOT the whole suite"; exit 1; }
