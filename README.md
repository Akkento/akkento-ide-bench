# akkento-ide-bench

**A reproducible startup, memory and workload benchmark for desktop code editors**, covering VS Code, the editors built on it, and Zed.

One file. Zero dependencies. No telemetry, no network calls. Node ≥ 20 on Linux, macOS and Windows.

> [!NOTE]
> **Disclosure.** This tool is published by Akkento, which develops Hyperlane, one of the editors it measures. The method, the raw data behind every number, and the choice of baseline are documented below, so results can be checked and reproduced independently.

## Quick start

```bash
git clone https://github.com/Akkento/akkento-ide-bench
cd akkento-ide-bench

node bench.mjs --list       # which editors did it find, and where?
node bench.mjs              # all three phases, startup then idle memory then workload
node bench.mjs --help       # every option
```

Nothing to install. The harness finds installed editors automatically, launches each one many times against throwaway profiles, and writes a report to `./reports/`.

- **Close every editor you have open first.** A running copy competes with every run that follows. The harness warns you when it sees one.
- **It does not start on its own.** It prints the plan and waits for Enter. `--yes` skips the prompt, and the prompt is skipped automatically when stdin is not a TTY.
- **Budget ~13 min per editor** for a full batch. `--no-workload` drops it to ~4.5 and `--no-memory --no-workload` to ~3.

## What it measures

| Signal | What it is | Where |
| --- | --- | --- |
| **startup** | Time to the editor reporting its own shell is on screen. **The primary metric**, with a seam described below. | all |
| **window** | Spawn until the window manager first lists a window in the process tree. One clock and both families, so it works as the cross-check. | Linux/X11 |
| **memory** | Whole process tree, a fixed 30 s after launch. The *empty window* number. | all |
| **workload** | A repository open and a file on screen, sampled every 5 s for 3 min. Reports **steady** memory, **peak**, time to **settle**, **CPU** burned getting there, and **idle CPU** once it has. | all |

**The startup seam.** Code-family editors self-report the span from main process start to workbench ready via `--prof-append-timers`, upstream VS Code instrumentation inherited unmodified by every fork. Zed has no equivalent, so the harness times exec until first frame rendered, taken from Zed's own log. Both stop on the editor's own claim that it drew its shell, but the two clocks start in different places, and Electron's bootstrap sits on Zed's side of the comparison rather than Code's. Within the Code family the numbers are directly comparable. Across families, `window` is the check. The seam is printed above every table and recorded per editor in the report.

Neither number can be taken the other way round. VS Code waits 15 s before writing its timers file and then exits, so when the harness *sees* that mark says nothing about startup. It is kept separately as `markSeenMs`, and it is why a launch costs about 15 s.

### The workload phase

A workload run opens a repository and a file, then **leaves the editor completely alone**. Nothing is typed or clicked. What is measured is the work it does after its window is up, walking the file tree, indexing, and starting a language server.

- **steady**, the median of the last third of the window rather than the final sample, which moves several per cent with GC timing
- **peak**, the largest single sample. An editor that spends 90 s at 2 GB and settles at 700 MB still asked your machine for 2 GB
- **settled after**, the first sample from which memory stayed inside a 5% band of steady. An editor that never does is reported as *never*
- **idle cpu**, CPU over the last third as a share of one core. Tens of per cent is something spinning

By default the repository is one the harness generates, with a fixed seed, no clock and no randomness, so it is byte-identical on every machine and fingerprinted into the report. It is committed to git, because an editor opening thousands of *untracked* files does source-control work no real checkout would ask of it, and it is restored to that commit between runs.

| `--workload-corpus` | modules | files | source | lines | fingerprint (corpus v3) |
| --- | ---: | ---: | ---: | ---: | --- |
| `ts-500` | 500 | 525 | 1.0 MB | ~34,000 | `03750934d83f5db2` |
| **`ts-2.5k`** (default) | 2,500 | 2,605 | 4.9 MB | ~171,000 | `55fe3f095a10876a` |
| `ts-10k` | 10,000 | 10,405 | 19.8 MB | ~681,000 | `11dbaa261111410b` |

`node bench.mjs --emit-corpus ./corpus` writes it out so you can see exactly what gets opened. `--workload-folder ~/src/repo --workload-open src/index.ts` swaps in a real checkout instead, which is more realistic at the cost of a number only you can reproduce. A folder you supply is never modified.

### Memory metric per platform

The most honest metric each OS exposes, and the output says which one you got. **Never compare memory across operating systems.**

| Platform | Metric | startup | window | workload | load gate |
| --- | --- | :-: | :-: | :-: | :-: |
| Linux | summed **PSS** (`smaps_rollup`) | ✓ | ✓ X11/XWayland | ✓ | ✓ |
| macOS | summed **RSS** (`ps`) | ✓ | | ✓ | ✓ |
| Windows | summed **private working set** | ✓ | | ✓ | |

## Requirements

Node 20+ and at least one editor installed.

- **Linux.** `wmctrl` and `xprop` power the `window` signal (`dnf install wmctrl xorg-x11-utils` or `apt install wmctrl x11-utils`). On Wayland use `--force-x11` or `--no-window`. A `performance` CPU governor gives the tightest numbers.
- **macOS.** Run on AC power with Low Power Mode off, and launch each editor once by hand first, or Gatekeeper's first-launch check lands inside run 1.
- **Windows.** Never point `editors.json` at `code.cmd` or the extensionless shims in an editor's `bin\`, because Node cannot spawn them and they hand off to a *detached* process. The defaults point at the `.exe`.
- **Flatpak and AppImage.** Relaunch indirection breaks process-tree tracking. Point at the real binary, or prefer the tarball, deb or rpm.
- **`git`.** Used by the workload phase to commit and restore the corpus. Without it the phase still runs, and says so.

## Editors it knows about

`vscode` (baseline), `vscodium`, `cursor`, `hyperlane`, `devin`, `windsurf`, `positron`, `void`, `kiro`, `trae`, `antigravity`, `zed`.

These short keys are what `--only` and the result tables use. Anything not installed is skipped with a note, and nothing is downloaded for you. Editors are auto-detected from `PATH` and the usual install locations, so edit [`editors.json`](./editors.json) to add an editor, a path, or per-editor `extraArgs`. **Any desktop VS Code fork works.** The first entry is the baseline every delta and p-value is measured against.

Two entries need care, and the defaults already handle both. Devin Desktop is Windsurf after the Cognition rebrand, so if the two resolve to the same executable the second is skipped rather than benchmarked twice. Zed must be pointed at the app binary (`libexec/zed-editor`, or the bundle on macOS) rather than `bin/zed`, which is a launcher that hands your paths to the app over a socket and exits.

## Reports

Every batch writes `akkento-ide-bench-<timestamp>-<platform>.json` holding every launch, every timing, every excluded row, every workload sample, exact editor versions and machine spec, alongside a `.md` of the same as a readable document. `--out` changes the directory and `--no-report` skips them.

**Nothing is sent anywhere, and the harness makes no network calls at all.** Your home directory is redacted to `~` in every path, and your hostname and username are never collected, so a report is shareable as it comes out.

### Reading results

- Prefer the **median** and check `min`/`max` for outliers. Absolute numbers are machine-specific, so only comparisons **within one batch** mean anything.
- The **p-value** beside each delta is a Mann-Whitney U test against the baseline editor. Deltas under about 15 ms need more runs and a quieter machine to mean anything.
- A row marked `TIMEOUT`, `EXITED`, `SPAWN-FAILED`, `SURVIVORS` or `LOAD-GATE-TIMEOUT` is **excluded from the statistics** but still written to the report. Fix the cause and rerun rather than trusting a polluted batch. `EXITED` usually means a handoff to a copy you already had open, and `TIMEOUT` on a Code-family editor usually means the fixed 15 s timers delay stretched by a loaded machine.
- `NO-PROCESSES` and `TOO-FEW-SAMPLES` are recorded as missing, never as a very good zero.
- The first batch after installing several editors is best treated as a rehearsal, because first-ever launches are cold-cache in ways warmups only partly absorb.

## How fairness is enforced

- **Interleaved round-robin with a rotating start order**, so machine drift is shared rather than charged to whoever ran last.
- **A load gate.** Runs wait for a quiet machine, and a run that never got one is recorded and excluded rather than silently averaged in.
- **A brand new throwaway profile per launch**, deleted afterwards. Your real profiles and extensions are never touched, and run 10 is as cold as run 1.
- **Warmups excluded.** With the profile wiped between launches, what they warm is the OS page cache for the application image.
- **One editor at a time**, and after each kill the harness verifies the process tree is gone, re-parented processes included, and says so loudly when it is not.
- **Every launch is recorded**, warmups and failures included, so every published statistic is recomputable.
- **The measurement is stated, not implied** wherever two families cannot share one definition of "started".

## License

GPL-2.0-only. Copyright © 2026 Akkento Pty Ltd. See [LICENSE](./LICENSE).

The harness is entirely original work with no third-party code and no dependencies, using only the Node standard library. Two published formulas are implemented from their definitions and cited in the source, Abramowitz & Stegun 7.1.26 for `erfc` and a standard linear congruential generator for the deterministic corpus.

Not affiliated with, endorsed by, or supported by Microsoft or any of the other editors it measures. All product names belong to their respective owners.
