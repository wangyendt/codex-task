# Release setup

CodexErrand intentionally follows the same push-to-release workflow as `skillmanager`: every non-release push to `main` creates a patch version. The release commit then publishes the package and creates a `vX.Y.Z` tag.

## GitHub repository settings

1. Create `wangyendt/codexerrand` and push this repository.
2. Add repository variable `AUTO_PUBLISH_NPM=true` when automatic npm publishing should be active.
3. Add secret `GH_PAT` with the minimum repository contents permission required to push the generated release commit and tag.
4. Protect `main` as desired, while allowing the release identity to push the version commit.

`GH_PAT` is required because commits pushed with the default `GITHUB_TOKEN` do not trigger a second workflow run. The workflow refuses to pretend publishing is active when the variable is enabled but the PAT is missing.

## npm Trusted Publishing

Configure npm Trusted Publishing for package `codexerrand`:

```text
GitHub owner:    wangyendt
Repository:      codexerrand
Workflow:        publish-npm.yml
Environment:     (leave empty unless you add one later)
```

No long-lived `NPM_TOKEN` is required. The publish job uses GitHub OIDC and npm provenance.

## Workflow sequence

```text
push main
  → offline verification
  → npm version patch
  → sync plugin manifest
  → release commit
  → offline verification again
  → npm publish with provenance
  → annotated vX.Y.Z tag
```

The release commit starts with `chore(release):` and is excluded from another bump, preventing a loop. Live Direct endpoint tests require `RUN_DIRECT_E2E=1` and are never enabled by these workflows.
