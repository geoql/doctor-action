# Doctor — Vue / Nuxt Code Audit Action

> Run @geoql/doctor in CI: quality score, structured findings, SARIF, and dashboard push.

[![Marketplace](https://img.shields.io/badge/Marketplace-doctor--vue--nuxt--code--audit-green?logo=github)](https://github.com/marketplace/actions/doctor-vue-nuxt-code-audit)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

## What is this?

A GitHub Action that runs [`@geoql/vue-doctor`](https://www.npmjs.com/package/@geoql/vue-doctor) or [`@geoql/nuxt-doctor`](https://www.npmjs.com/package/@geoql/nuxt-doctor) against your codebase. It surfaces a 0-100 quality score, structured findings, and a SARIF report for GitHub Code Scanning, and can push results to your [the-doctor.report](https://app.the-doctor.report) dashboard. It audits Vue 3 and Nuxt 4 code for AI-generated anti-patterns, reactivity traps, performance issues, and correctness mistakes. It does not scaffold or rewrite. It critiques.

Listed on the Marketplace as [doctor-vue-nuxt-code-audit](https://github.com/marketplace/actions/doctor-vue-nuxt-code-audit).

## Ecosystem

| Repo | What | Link |
| --- | --- | --- |
| `geoql/doctor` | OSS CLIs + oxlint rule plugins | [github.com/geoql/doctor](https://github.com/geoql/doctor) |
| `geoql/doctor-action` (this repo) | GitHub Action wrapper | [github.com/geoql/doctor-action](https://github.com/geoql/doctor-action) |
| `the-doctor.report` | Hosted SaaS dashboard (private) | [app.the-doctor.report](https://app.the-doctor.report) |
| Docs | Rules, CLI, scoring reference | [docs.the-doctor.report](https://docs.the-doctor.report) |

## Quick start

### Vue 3 project

```yaml
- uses: geoql/doctor-action@v2
  with:
    framework: vue
    preset: recommended
    fail-on: warn
```

### Nuxt 4 project

```yaml
- uses: geoql/doctor-action@v2
  with:
    framework: nuxt
    preset: strict
    threshold: '80'
```

### Pinning

`@v2` floats to the latest v2 release. For supply-chain safety, pin the full commit SHA and keep the tag as a comment so Dependabot/Renovate can still bump it:

```yaml
# Floating major: picks up fixes automatically
- uses: geoql/doctor-action@v2

# SHA-pinned: immutable (resolve with `git ls-remote https://github.com/geoql/doctor-action v2.1.0`)
- uses: geoql/doctor-action@<full-40-char-sha> # v2.1.0
```

### PR review + SARIF upload

On a pull request, the action posts inline review comments on the changed lines that have findings and keeps one sticky summary comment up to date. `pull-requests: write` is required for both. Use `comment-mode` to choose `summary`, `review`, or `both` (the default).

Each `framework` + `working-directory` pair keeps its own summary comment. A workflow that runs the action twice (for example, a Nuxt job in `apps/web` and a Vue job in `packages/ui`) gets two comments, and each job updates only its own. When the working directory is not the repo root, the comment title shows the directory.

```yaml
permissions:
  contents: read
  pull-requests: write
  security-events: write

jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - id: doctor
        uses: geoql/doctor-action@v2
        with:
          framework: vue
          pr-comment: 'true'
          comment-mode: both # summary | review | both
      - uses: github/codeql-action/upload-sarif@v4
        if: always()
        with:
          sarif_file: doctor.sarif
      - run: echo "Score: ${{ steps.doctor.outputs.score }}"
```

Set `comment-on-clean: 'false'` to skip the summary comment when a scan is clean. An existing summary comment is still updated, so a PR that goes clean shows it.

Inline comments only land on lines added or changed in the PR diff (a GitHub constraint); findings elsewhere are rolled into the summary instead. The step degrades to summary-only — never failing the build — when it is not a pull request, when `token` is absent, or when a comment cannot be placed.

### Push findings to your dashboard

Generate an API key in your [the-doctor.report](https://app.the-doctor.report) dashboard, store it as a repo secret (`DOCTOR_API_KEY`), and the action pushes every run.

```yaml
jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: geoql/doctor-action@v2
        with:
          framework: nuxt
          api-key: ${{ secrets.DOCTOR_API_KEY }}
          # project defaults to owner/repo; override if your slug differs
          # project: my-team/my-app
```

The push runs even when the gate fails, so a regression still lands on your trend chart.

### Scope pull requests to the change

Set `scope` to report and gate only part of a pull request. The action compares the PR head with its base, so base-branch commits the PR does not contain are never counted.

| `scope` | Reports |
| --- | --- |
| `full` (default) | Every finding in the project. |
| `files` | Every finding in the files the PR changed. |
| `changed` | Only findings the PR introduced. The CLI audits the base version of each changed file and matches findings by file and rule, so moved or reformatted code does not count. |
| `lines` | Findings on the lines the PR changed. |
| `contextual` | Findings on changed lines, plus findings in an edited element, function, component, or file. |

```yaml
- uses: actions/checkout@v7
- uses: geoql/doctor-action@v2
  with:
    framework: vue
    scope: changed
    pr-comment: 'true'
```

A non-full scope applies to `pull_request` and `pull_request_target` events only. On other events the action scans the full project and logs a notice. The action deepens a shallow checkout until the merge-base of the PR head and base resolves; if it cannot, the step fails and asks for `fetch-depth: 0` on `actions/checkout`. The score always covers every finding in the changed files; only the listed findings, the severity counts, and the gate are narrowed. With `scope: changed`, the `new-count` and `fixed-count` outputs, the job summary, and the PR comment show how many findings the PR added and removed.

`scope`, `baseline`, and `warning-exit-code` need `@geoql/vue-doctor` 1.8.0 or `@geoql/nuxt-doctor` 1.9.0 or later. The action fails before the audit with a clear message when the resolved CLI is older.

`diff: 'true'` is deprecated. It still works with any CLI version and reports the same set as `scope: files`.

### Gate only new findings with a baseline

A baseline is a saved JSON report. With `baseline`, only findings that are new relative to it are reported and gated. Use it to adopt doctor on a codebase with existing findings. The score still covers every finding.

Save the report on every push to `main` and restore the newest one on pull requests. A pull request can restore caches that its base branch saved:

```yaml
on:
  push:
    branches: [main]
  pull_request:

jobs:
  doctor:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7

      # Pull requests: restore the newest baseline saved on main.
      - if: github.event_name == 'pull_request'
        id: baseline
        uses: actions/cache/restore@v6
        with:
          path: doctor-baseline.json
          key: doctor-baseline-${{ github.sha }}
          restore-keys: doctor-baseline-

      - id: doctor
        uses: geoql/doctor-action@v2
        with:
          framework: vue
          # Only gate new findings when a baseline was restored.
          baseline: ${{ steps.baseline.outputs.cache-matched-key != '' && 'doctor-baseline.json' || '' }}
          # main: write this run's full report as the next baseline.
          save-baseline: ${{ github.event_name == 'push' && 'doctor-baseline.json' || '' }}
          pr-comment: 'true'

      - if: always() && github.event_name == 'push'
        uses: actions/cache/save@v6
        with:
          path: doctor-baseline.json
          key: doctor-baseline-${{ github.sha }}

      - run: echo "${{ steps.doctor.outputs.new-count }} new, ${{ steps.doctor.outputs.fixed-count }} fixed"
```

To use an artifact instead of the cache, upload `doctor-baseline.json` with `actions/upload-artifact` on `main` and download it on the pull request with an action that can read artifacts from another workflow run.

The CLI rejects a baseline (exit 2) that came from a run with different finding settings: rules, preset, category or dimension filters, include and exclude globs, or enabled passes. It also rejects a scoped, baseline-compared, or incomplete report. Save the baseline from a full-scope run without `baseline`, and let `main` write a new one after you change the settings. `save-baseline` logs a warning when the report it saves cannot be used as a baseline.

### Exit with a separate code on warnings

`warning-exit-code` makes a run that finds warnings but no errors exit with that code (2-255) instead of 0 or 1. The `exit-code` output carries it, so a later step can treat "passed with warnings" differently. The job still fails on that code; add `continue-on-error: true` to the step if warnings must not fail the job. The input is ignored with `fail-on: none`.

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `framework` | `vue` | Which doctor to run: `vue` or `nuxt`. |
| `preset` | `recommended` | Base rule preset: `minimal` \| `recommended` \| `strict` \| `all`. |
| `threshold` | `0` | Minimum passing score (0-100). The job fails below this value. |
| `fail-on` | `error` | Exit non-zero on this severity or worse: `error` \| `warn` \| `none`. |
| `version` | `latest` | CLI version or range. `latest` runs the project's installed `@geoql/<framework>-doctor` via its package manager, else the range in `package.json`, else the latest release. Any other value always overrides. |
| `scope` | `full` | What to report on a PR: `full` \| `files` \| `changed` \| `lines` \| `contextual`. See [Scope pull requests](#scope-pull-requests-to-the-change). Other events always scan the full project. |
| `baseline` | `''` | Path (relative to `working-directory`) to a saved JSON report. Only findings new relative to it are reported and gated. |
| `save-baseline` | `''` | Path (relative to `working-directory`) to copy this run's JSON report to, for upload as a cache or artifact. |
| `warning-exit-code` | `''` | Exit with this code (2-255) when the gate finds warnings but no errors. |
| `diff` | `false` | **Deprecated**, use `scope: files`. Only report findings in changed files. On a PR: the PR head vs its base. Elsewhere: changes vs `HEAD`. Ignored when `scope` is not `full`. |
| `pr-comment` | `false` | On a PR, post inline review comments + a sticky summary comment. |
| `comment-mode` | `both` | What to post when `pr-comment` is on: `summary` \| `review` \| `both`. |
| `comment-on-clean` | `true` | Create a summary comment on a clean scan. `false` skips it; an existing comment is still updated. |
| `token` | `${{ github.token }}` | Token used to post PR comments. Needs `pull-requests: write`. |
| `working-directory` | `.` | Directory to run the audit in (the project root). |
| `api-key` | `''` | the-doctor.report API key (`doc_…`). When set, results push to your dashboard. Pass via secrets, never inline. |
| `project` | `${{ github.repository }}` | Project slug for the dashboard. Defaults to the GitHub `owner/repo`. |
| `push-mode` | `full` | How to push: `full` (CLI streams privacy-stripped findings in one call) or `score` (action posts only the score via curl). |
| `push-url` | `https://app.the-doctor.report/api/v1/findings` | Findings endpoint, used when `push-mode` is `full`. Override for self-hosted. |

## Outputs

| Output | Description |
| --- | --- |
| `score` | The integer quality score (0-100). |
| `findings-count` | The total number of diagnostics reported. |
| `error-count` | The number of `error` diagnostics. |
| `warning-count` | The number of `warn` diagnostics. |
| `info-count` | The number of `info` diagnostics. |
| `affected-files` | The number of distinct files with at least one diagnostic. |
| `new-count` | Findings new relative to the baseline or the PR base. Set with `baseline` or `scope: changed`, empty otherwise. |
| `fixed-count` | Baseline or PR-base findings that no longer occur. Set with `baseline` or `scope: changed`, empty otherwise. |
| `exit-code` | The doctor exit code: `0` pass, `1` gate failed, `2` crash or bad input, or the `warning-exit-code`. |

Every run also writes a job summary (`$GITHUB_STEP_SUMMARY`) with the score, counts by severity, and the top rules by finding count. With a non-full `scope` or a `baseline`, the summary and the PR comment also show the scope and the new and fixed counts.

## How it works

The action picks the CLI to run. If the project has `@geoql/vue-doctor` or `@geoql/nuxt-doctor` installed (in `dependencies` or `devDependencies`, at the working directory or a parent up to the repo root), it runs that copy through the project's package manager (pnpm, yarn, bun, or npm, detected from `packageManager` or the lockfile). Otherwise it resolves an exact version from the npm registry (an explicit `version`, the declared range, or latest), installs it into a toolchain directory, and caches that directory keyed by the resolved version. It then runs the audit once and writes JSON (driving the outputs and the gate exit code) and SARIF (for Code Scanning) from that one run. This needs `@geoql/vue-doctor` 1.9.0 or `@geoql/nuxt-doctor` 1.10.0 or later (`--sarif-output`). With an older CLI, the action runs the audit a second time to get SARIF. When `pr-comment` is `true` on a pull request, it maps each finding to its position in the PR diff and posts the findings as one batched review (inline comments on changed lines) plus a single sticky summary comment that it creates once and updates in place on every later run, located via a hidden `<!-- doctor-action:<framework>:<working-directory> -->` marker (for example `<!-- doctor-action:nuxt:apps/web -->`, or `<!-- doctor-action:vue:. -->` at the repo root). Comments from v2.1.1 and earlier carry the old `<!-- geoql-doctor-report -->` marker. Only a job at the repo root adopts such a comment, and it rewrites the comment with its new marker, so a single-job repo keeps updating its existing comment and two jobs never share one.

When `api-key` is set, results flow to [the-doctor.report](https://app.the-doctor.report). With `push-mode: full` (the default), the CLI streams privacy-stripped findings to `https://app.the-doctor.report/api/v1/findings` in a single call. The payload carries rule IDs, severities, file paths, line and column numbers, and message templates only. No source code, no file contents, no secrets. With `push-mode: score`, the action falls back to a curl-based score-only POST to `https://app.the-doctor.report/api/v1/score`.

With a non-full `scope` on a pull request, the action passes `--scope <scope> --base <ref>`. The ref is the first parent of the merge-ref checkout, or `merge-base(base, head)` when the PR head is checked out. With the deprecated `diff: 'true'`, the action passes `--changed-files-from` with the same ref (CLI 1.5.0 or later), or falls back to `--diff` if the base commit cannot be resolved. `baseline` maps to `--baseline` and `warning-exit-code` to `--warning-exit-code`.

The gate (threshold and `fail-on`) is enforced last, so the findings push and PR comment always run first, even on a failing score.

## License

MIT © [geoql](https://github.com/geoql)
