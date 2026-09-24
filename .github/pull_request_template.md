## Summary

<!-- Write a short description about your PR -->

## Test plan

<!-- Include the steps to test your PR -->
<!-- Any PR that requires a complex setup to test MUST include this -->

## Screenshots

<!-- Include screenshots/videos (if any) of how the PR works -->
<!-- Please include this if CLI/frontend behaviour has changed, can be skipped for backend changes -->

## Checklist

<!--- Go over all the following points, and put an `x` in all the boxes that apply. -->
<!--- If you're unsure about any of these, don't hesitate to ask. We're here to help! -->

- [ ] My code follows the code style of this project and passes
      `bun run lint:backend && bun run lint`.
- [ ] My change requires a change to the documentation.
- [ ] I have [updated the documentation](https://github.com/Cap-go/website)
      accordingly.
- [ ] My change has adequate E2E test coverage.
- [ ] I have tested my code manually, and I have provided steps how to reproduce
      my tests
- [ ] No GHSA ids, unpublished advisory bodies or PoCs, or embargoed exploit detail in this public PR (title, body, commits, branch name).
- [ ] Security-sensitive authz / OTA / SQL / webhook / path changes reviewed against `docs/agent-security-regressions.md`.
