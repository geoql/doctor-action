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

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `framework` | `vue` | Which doctor to run: `vue` or `nuxt`. |
| `preset` | `recommended` | Base rule preset: `minimal` \| `recommended` \| `strict` \| `all`. |
| `threshold` | `0` | Minimum passing score (0-100). The job fails below this value. |
| `fail-on` | `error` | Exit non-zero on this severity or worse: `error` \| `warn` \| `none`. |
| `version` | `latest` | CLI version or range. `latest` runs the project's installed `@geoql/<framework>-doctor` via its package manager, else the range in `package.json`, else the latest release. Any other value always overrides. |
| `diff` | `false` | Only report findings in changed files. On a PR: the PR head vs its base. Elsewhere: changes vs `HEAD`. |
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

Every run also writes a job summary (`$GITHUB_STEP_SUMMARY`) with the score, counts by severity, and the top rules by finding count.

## How it works

The action picks the CLI to run. If the project has `@geoql/vue-doctor` or `@geoql/nuxt-doctor` installed (in `dependencies` or `devDependencies`, at the working directory or a parent up to the repo root), it runs that copy through the project's package manager (pnpm, yarn, bun, or npm, detected from `packageManager` or the lockfile). Otherwise it resolves an exact version from the npm registry (an explicit `version`, the declared range, or latest), installs it into a toolchain directory, and caches that directory keyed by the resolved version. It then runs the audit once to JSON (driving the outputs and the gate exit code) and again to SARIF for Code Scanning. When `pr-comment` is `true` on a pull request, it maps each finding to its position in the PR diff and posts the findings as one batched review (inline comments on changed lines) plus a single sticky summary comment that it creates once and updates in place on every later run, located via a hidden `<!-- geoql-doctor-report -->` marker.

When `api-key` is set, results flow to [the-doctor.report](https://app.the-doctor.report). With `push-mode: full` (the default), the CLI streams privacy-stripped findings to `https://app.the-doctor.report/api/v1/findings` in a single call. The payload carries rule IDs, severities, file paths, line and column numbers, and message templates only. No source code, no file contents, no secrets. With `push-mode: score`, the action falls back to a curl-based score-only POST to `https://app.the-doctor.report/api/v1/score`.

With `diff: 'true'` on a pull request, the changed set is the PR head compared to its base. The action passes `--changed-files-from` with the first parent of the merge-ref checkout, or with `merge-base(base, head)` when the PR head is checked out. Base-branch commits that the PR does not contain are never included. This needs CLI 1.5.0 or later. If the base commit cannot be resolved, the action falls back to `--diff`.

The gate (threshold and `fail-on`) is enforced last, so the findings push and PR comment always run first, even on a failing score.

## License

MIT © [geoql](https://github.com/geoql)
