# Release setup

CodexTask uses a path-filtered push-to-release workflow. A push to `main` creates a patch version only when it changes runtime code, runtime dependencies/build inputs, or runtime assets shipped with the npm package. The release commit then publishes the package and creates a `vX.Y.Z` tag.

Automatic release paths:

```text
src/**
package.json
package-lock.json
tsconfig.json
tsconfig.build.json
scripts/service/**
skills/**
.codex-plugin/plugin.json
```

README, `docs/**`, tests, examples, screenshots, and ordinary workflow-only changes do not create an npm release by themselves. They remain in GitHub and will be included the next time a core change is published. Use the `Bump patch on main` workflow's `workflow_dispatch` button when a non-core change must be released immediately.

## GitHub repository settings

1. Create `wangyendt/codex-task` and push this repository.
2. Add repository variable `AUTO_PUBLISH_NPM=true` when automatic npm publishing should be active.
3. Add secret `GH_PAT` with the minimum repository contents permission required to push the generated release commit and tag.
4. Protect `main` as desired, while allowing the release identity to push the version commit.

`GH_PAT` is required because commits pushed with the default `GITHUB_TOKEN` do not trigger a second workflow run. The workflow refuses to pretend publishing is active when the variable is enabled but the PAT is missing.

## npm Trusted Publishing

Configure npm Trusted Publishing for package `codex-task`:

```text
GitHub owner:    wangyendt
Repository:      codex-task
Workflow:        publish-npm.yml
Environment:     (leave empty unless you add one later)
```

No long-lived `NPM_TOKEN` is required. The publish job uses GitHub OIDC and npm provenance.

## Workflow sequence

```text
push core change to main
  → offline verification
  → npm version patch
  → sync plugin manifest
  → release commit
  → offline verification again
  → npm publish with provenance
  → annotated vX.Y.Z tag
```

The release commit starts with `chore(release):` and is excluded from another bump, preventing a loop. Live Direct endpoint tests require `RUN_DIRECT_E2E=1` and are never enabled by these workflows.
