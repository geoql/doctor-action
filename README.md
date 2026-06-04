# Doctor — Vue 3 / Nuxt 4 Code Audit Action

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

## Outputs

| Output | Description |
| --- | --- |
| `score` | The integer quality score (0-100). |
| `findings-count` | The total number of diagnostics reported. |

## How it works

The action installs the matching doctor CLI (`@geoql/vue-doctor` or `@geoql/nuxt-doctor`) globally with pnpm, runs the audit once to JSON (to drive the outputs and the gate exit code), then emits a SARIF report from the same arguments for GitHub Code Scanning. When `pr-comment` is enabled, it posts a sticky Markdown comment to the pull request.

## License

MIT © [geoql](https://github.com/geoql)
