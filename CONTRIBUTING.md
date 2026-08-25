# Contributing to the Atlassian Copilot Marketplace library

Thank you for considering a contribution to this generic library of Atlassian
GitHub Copilot marketplace listings and plugins. The Jira Sprint Dashboard is
one plugin in this tree; new plugins belong under `plugins/` and `extensions/`.
Pull requests, issues and comments are welcome. For pull requests, please:

* Add tests for new features and bug fixes
* Follow the existing style
* Separate unrelated changes into multiple pull requests

See the existing issues for things to start contributing.

For bigger changes, please make sure you start a discussion first by creating an issue and explaining the intended change.

Please also follow our [Code of Conduct](CODE_OF_CONDUCT.md).

## Triage

Maintainers act on issues and contributions as they occur.

## Pull request requirements

Pull requests are required to merge to `main`. Each pull request must have **2 approvals** before it can be merged.

## Running tests

From `public/`:

```bash
node --check extensions/extension.mjs
node --check extensions/server/jira-client.mjs
node --check extensions/server/start-copilot.mjs
node --check extensions/ui/dashboard.mjs
node --test extensions/tests/*.test.mjs
```

## Continuous integration

CI runs on the `pull_request` event only. Workflows use `contents: read` permissions, do not use repository secrets, and do not use `pull_request_target`.

## Contributor License Agreement

Atlassian requires contributors to sign a Contributor License Agreement, known as a CLA. This serves as a record stating that the contributor is entitled to contribute the code/documentation/translation to the project and is willing to have it used in distributions and derivative works (or is willing to transfer ownership).

Prior to accepting your contributions we ask that you please follow the appropriate link below to digitally sign the CLA. The Corporate CLA is for those who are contributing as a member of an organization and the Individual CLA is for those contributing as an individual.

* [CLA for corporate contributors](https://opensource.atlassian.com/corporate)
* [CLA for individuals](https://opensource.atlassian.com/individual)
