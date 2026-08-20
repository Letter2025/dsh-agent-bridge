# Runner example

Use this example only with a disposable directory outside the project. First,
use a trusted editor or non-shell file-writing tool to create the private brief
`/absolute/path/to/dsh-verification-brief.md` outside the fixture:

```sh
fixture="$(mktemp -d /tmp/dsh-agent-fixture.XXXXXX)"
printf 'before\n' > "$fixture/example.txt"
git -C "$fixture" init
git -C "$fixture" config user.name "DSH Fixture"
git -C "$fixture" config user.email "dsh-fixture@example.invalid"
git -C "$fixture" add example.txt
git -C "$fixture" commit -m baseline

node skill/dsh-agent/scripts/run_dsh.mjs \
  --cwd "$fixture" \
  --prompt-file /absolute/path/to/dsh-verification-brief.md

git -C "$fixture" status --short
git -C "$fixture" diff
git -C "$fixture" remote -v
```

This is an explicit real-DSH check, not part of the default test suite. Stop
on any failure or permission denial; never retry with a different permission
mode.
