# Doctor — Vue / Nuxt Code Audit Action

A GitHub Action that runs [`@geoql/vue-doctor`](https://www.npmjs.com/package/@geoql/vue-doctor) or [`@geoql/nuxt-doctor`](https://www.npmjs.com/package/@geoql/nuxt-doctor) against your codebase and surfaces a quality score, structured findings, and a SARIF report for GitHub Code Scanning.

The doctor audits Vue 3 and Nuxt 4 code for AI-generated anti-patterns, reactivity traps, performance issues, and correctness mistakes. It does not scaffold or rewrite — it critiques.

## Usage

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

### With a PR comment and SARIF upload

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

### Push scores to your the-doctor.report dashboard

Track your project's health over time. Generate an API key in your
[the-doctor.report](https://the-doctor.report) dashboard, store it as a repo
secret (`DOCTOR_API_KEY`), and the action posts each run's score on every push.

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

The score is pushed even when the gate fails, so a regression still shows up on
your dashboard's trend chart.

### v2 push mode (privacy-stripped findings)

v2 swaps the legacy "score only" push for a full findings stream. When
`push-mode: full` (the default) and `api-key` is set, the doctor CLI
(`@geoql/vue-doctor` / `@geoql/nuxt-doctor`) POSTs the full set of findings
directly to the-doctor.report in a single call — the action's curl-based
"Push score" step is skipped.

The payload is **privacy-stripped**: rule IDs, severities, file paths, line
numbers, and message templates. **No source code, no file contents, no
secrets.** This is the only way the dashboard can render per-rule trends,
severity breakdowns, and the worst-offender file list without you ever
shipping source to a third party.

```yaml
jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: geoql/doctor-action@v1
        with:
          framework: vue
          api-key: ${{ secrets.DOCTOR_API_KEY }}
          # push-mode defaults to "full" — opt in explicitly or omit
          # push-mode: 'full'
          # push-url defaults to the SaaS endpoint; override for self-hosted
          # push-url: https://app.the-doctor.report/api/v1/findings
```

If you'd rather keep the legacy behavior (curl-based score-only push, no
network I/O from the CLI), set `push-mode: score`.

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `framework` | `vue` | Which doctor to run: `vue` or `nuxt`. |
| `preset` | `recommended` | Base rule preset: `minimal` \| `recommended` \| `strict` \| `all`. |
| `threshold` | `0` | Minimum passing score (0-100). The job fails when the score is below this value. |
| `fail-on` | `error` | Exit non-zero on this severity or worse: `error` \| `warn` \| `none`. |
| `diff` | `false` | Only report findings in files changed vs `HEAD`. |
| `pr-comment` | `false` | Emit a Markdown PR comment with the findings. |
| `working-directory` | `.` | Directory to run the audit in (the project root). |
| `api-key` | `''` | [the-doctor.report](https://the-doctor.report) API key (`doc_…`). When set, the score and findings are pushed to your dashboard. Pass via secrets, never inline. |
| `project` | `${{ github.repository }}` | Project slug for the dashboard. Defaults to the GitHub `owner/repo`. |
| `push-mode` | `full` | How to push results to the dashboard: `full` (v2, CLI streams privacy-stripped findings in one call) or `score` (legacy, action posts only the score via curl). |
| `push-url` | `https://app.the-doctor.report/api/v1/findings` | Endpoint for the findings push. Only used when `push-mode` is `full`. Override for self-hosted instances. |

## Outputs

| Output | Description |
| --- | --- |
| `score` | The integer quality score (0-100). |
| `findings-count` | The total number of diagnostics reported. |

## How it works

The action installs the matching doctor CLI (`@geoql/vue-doctor` or `@geoql/nuxt-doctor`) globally with pnpm, runs the audit once to JSON (to drive the outputs and the gate exit code), then emits a SARIF report from the same arguments for GitHub Code Scanning. When `pr-comment` is enabled, it posts a sticky Markdown comment to the pull request.

When `api-key` is set, results flow to [the-doctor.report](https://the-doctor.report). With `push-mode: full` (the default), the CLI streams privacy-stripped findings to the dashboard in a single call (no source code, no file contents — just rule IDs, severities, locations, message templates). With `push-mode: score`, the action falls back to the legacy curl-based score-only push.

The gate (threshold / `fail-on`) is enforced last, so the findings push and PR comment always run first — even on a failing score.

## License

MIT © [geoql](https://github.com/geoql)
