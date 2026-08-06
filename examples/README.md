# Runner example

Use this example only with a disposable directory outside the project:

```sh
fixture="$(mktemp -d /tmp/qoder-agent-fixture.XXXXXX)"
printf 'before\n' > "$fixture/example.txt"
git -C "$fixture" init
git -C "$fixture" config user.name "Qoder Fixture"
git -C "$fixture" config user.email "qoder-fixture@example.invalid"
git -C "$fixture" add example.txt
git -C "$fixture" commit -m baseline

node skill/qoder-agent/scripts/run_qoder.mjs \
  --cwd "$fixture" \
  --prompt "Add one line to example.txt, run a relevant check, and do not modify Git history."

git -C "$fixture" status --short
git -C "$fixture" diff
git -C "$fixture" remote -v
```

This is an explicit real-Qoder check, not part of the default test suite. Stop
on any failure or permission denial; never retry with a different permission
mode.
