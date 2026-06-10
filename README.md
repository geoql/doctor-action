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
- uses: geoql/doctor-action@v1
  with:
    framework: vue
    preset: recommended
    fail-on: warn
```

### Nuxt 4 project

```yaml
- uses: geoql/doctor-action@v1
  with:
    framework: nuxt
    preset: strict
    threshold: '80'
```

### PR comment + SARIF upload

```yaml
permissions:
  contents: read
  pull-requests: write
  security-events: write

jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - id: doctor
        uses: geoql/doctor-action@v1
        with:
          framework: vue
          pr-comment: 'true'
      - uses: github/codeql-action/upload-sarif@v3
        if: always()
        with:
          sarif_file: doctor.sarif
      - run: echo "Score: ${{ steps.doctor.outputs.score }}"
```

### Push findings to your dashboard

Generate an API key in your [the-doctor.report](https://app.the-doctor.report) dashboard, store it as a repo secret (`DOCTOR_API_KEY`), and the action pushes every run.

```yaml
jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: geoql/doctor-action@v1
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
| `diff` | `false` | Only report findings in files changed vs `HEAD`. |
| `pr-comment` | `false` | Emit a sticky Markdown PR comment with the findings. |
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

## How it works

The action resolves the exact CLI version from the npm registry, installs `@geoql/vue-doctor` or `@geoql/nuxt-doctor` globally, then runs the audit once to JSON (driving the outputs and the gate exit code) and again to SARIF for Code Scanning. When `pr-comment` is `true`, it posts a sticky Markdown comment via `marocchino/sticky-pull-request-comment`.

When `api-key` is set, results flow to [the-doctor.report](https://app.the-doctor.report). With `push-mode: full` (the default), the CLI streams privacy-stripped findings to `https://app.the-doctor.report/api/v1/findings` in a single call. The payload carries rule IDs, severities, file paths, line and column numbers, and message templates only. No source code, no file contents, no secrets. With `push-mode: score`, the action falls back to a curl-based score-only POST to `https://app.the-doctor.report/api/v1/score`.

The gate (threshold and `fail-on`) is enforced last, so the findings push and PR comment always run first, even on a failing score.

## License

MIT © [geoql](https://github.com/geoql)
