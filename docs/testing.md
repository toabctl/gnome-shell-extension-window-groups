# Testing

Four tiers, in descending order of how much you should trust a green result
and ascending order of what it costs to run.

```sh
make check        # tiers 1–2: lint, schema, 87 unit tests, 29 mutants (~7s)
make integration  # tier 3: 18 assertions against a real shell in a VM
```

The organising principle is that **every assertion must be capable of
failing.** Each wrong conclusion reached while building this came from an
oracle that could not:

- `cmd_shot` pulled a stale PNG when capture failed, so an unchanged
  screenshot read as proof a change had not applied.
- `wait_for_session` checked for a socket that outlives the session, so it
  reported success at the gdm greeter.
- A pixel scan measured the sidebar by walking to the first light pixel, which
  counts any dark window beside it as sidebar.
- Two test suites were green with the behaviour they named deleted.

## Tier 1 — pure units

`layouts.js`, `search.js` and `model.js` import nothing from GNOME, so
`node --test` covers them directly.

`layouts.js` is `(kind, count, area, state) → rects`. The fuzz test runs 3000
random combinations against a seeded PRNG, so a failure reproduces exactly.
Degenerate inputs are tested rather than avoided: 20×12px areas, twelve
windows, zero-weight ratios, `NaN` ratios, a ratios array of the wrong length.

`search.js` scores a window against a query. The position term is
`at / (at + 100)` — monotonic and provably in [0, 1) — so a title match can
never lose to an application-name match however long the title is. The
original `at * 0.01` crossed a field boundary past ~1000 characters.

## Tier 2 — the fake shell

`arranger.js` takes every shell binding through an injected `env`, so
`shell-stubs.mjs` can hand it fake windows, monitors, work areas and a
scheduler the test pumps by hand. Fakes record what was done to them, so tests
assert on behaviour — "this window was moved to that rect", "this one was
never touched" — rather than on pixels.

That covers, in milliseconds, the failures that previously needed a VM: laying
a group out against the wrong monitor, moving windows that must not be moved,
running a layout pass on every keystroke, a client that refuses to shrink
causing a correction loop, and leaking the pre-tile stash.

## The mutation gate

```sh
node mutants.mjs
```

Breaks the implementation 29 ways and requires each break to fail at least one
test. It has earned its place three times:

- The layout resize-clamp test passed with the clamp deleted, because
  `normalise()` repaired the negative ratio it produced.
- The search position-cap test never reached the regime it protected.
- `forget()`, which releases the pre-tile stash when a window closes, had no
  test at all — it could have been deleted and leaked every window ever tiled.

Extracting `Arranger` also surfaced a live bug the first fakes were too
permissive to catch: it called `win.unmaximize()` with no arguments, which the
real `Meta.Window` rejects. The flags now travel through `env`, pinned by both
a test and a mutant.

## Tier 3 — a real shell

`integration-test.sh` asserts through the extension's debug D-Bus interface,
never through pixels. It covers ten enable/disable cycles (a leak check), group
naming and colours, dissolving a group without closing windows, the full
auto-hide cycle including the parked-pointer regression, compact mode, and that
settings the extension does not own are restored.

It snapshots every setting it writes and restores them on exit. A run that
leaves the desktop configured differently from how it found it is
indistinguishable, later, from a bug — an earlier version left `auto-hide`
switched off and cost a round of "it stopped working".

## Running a shell you can break

```sh
./run-lxd.sh up          # Ubuntu 26.04 desktop VM, same GNOME as a 26.04 host
./run-lxd.sh console     # interactive desktop (needs virt-viewer)
./run-lxd.sh demo        # a window in every group, one per arrangement
./run-lxd.sh state       # what the extension believes, as JSON
./run-lxd.sh sync        # push changes and reload
./run-nested.sh          # sandboxed nested shell, no VM
./screenshot.sh out.png  # headless, invisible to your session
```

GNOME 50 removed `gnome-shell --nested`; `--devkit` is the replacement.

### What has to be isolated, and why

Both harnesses give the guest its own `XDG_CONFIG_HOME` (dconf), its own
`XDG_RUNTIME_DIR`, and its own session bus. The runtime directory matters more
than it looks — three things live there that collide with a live session:

| | |
| --- | --- |
| `gnome-shell-disable-extensions` | the crash guard. `org.gnome.Shell@.service` has `OnFailure=org.gnome.Shell-disable-extensions.service`, gated on this file existing. A nested shell that dies leaves it armed, so the *next* crash of your real shell switches off all your extensions. |
| `gvfs` | a live FUSE mount owned by a systemd user unit; the sandbox's gvfsd tries to mount over it. |
| `keyring` | the control socket of your running `gnome-keyring-daemon`. |

Wayland accepts an absolute path in `WAYLAND_DISPLAY`, so the runtime
directory can be moved aside while the nested shell still reaches the host
compositor. X sockets live in `/tmp` and cannot be redirected, so they are
snapshotted and reaped.

`--devkit` opens a render node with no mode setting and never calls logind
`TakeControl`, so it cannot acquire DRM master or take over your console.

### Driving the guest

`guest-input.py` creates uinput devices in the VM. GNOME Shell has no
scriptable input path and X11 tools only reach XWayland clients, so this is the
only way to exercise keybindings, hover and clicks from outside.

Three things it has to get right, each of which produced a silent "nothing
happens" while being debugged:

- **Two devices, not one.** libinput classifies a device declaring both a full
  keyboard and relative axes as a keyboard, and never gives it a pointer.
- **Exact stepping.** Moving 248px in 60 steps rounds to 4 each and lands on
  240; the remainder has to be carried.
- **Keep it alive.** Destroying the uinput device drops pointer focus, so a
  screenshot has to happen while the process still runs.

`spice-vdagentd` must be stopped for synthetic pointer motion: its absolute
tablet keeps asserting a position and overrides relative motion.

### If everything suddenly stops working

Check whether the guest locked. On the lock screen GNOME runs in
`unlock-dialog` session mode and user extensions are **INACTIVE** — the sidebar
disappears, the debug interface unexports, and every check fails in a way that
looks like a code bug. `gnome-extensions info` reporting `Enabled: Yes`
alongside `State: INACTIVE` is the giveaway. `run-lxd.sh` disables idle
blanking and unlocks before `demo` and `console`.

## What none of this covers

Visual correctness, the feel of a 320 ms animation, and client minimum-size
behaviour, which depends on the application. Those still need a human in
`./run-lxd.sh console`.
