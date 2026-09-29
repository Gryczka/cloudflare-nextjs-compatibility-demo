## Summary

Describe the change and link the issue it addresses.

## What changed?

- [ ] Fixture build or compatibility behavior
- [ ] Worker API, session, quota, or cleanup behavior
- [ ] Fixed-template WfP example
- [ ] Documentation, tests, or tooling

## Verification

List the commands and scenarios you ran. Include `npm run check`; for container behavior, include `VERIFY_CONTAINER=1 npm run fixtures:verify`. Describe any checks requiring an account or Docker that you could not run.

## Checklist

- [ ] Behavior changes have meaningful test coverage and documentation
- [ ] I have not committed secrets, account IDs, customer data, or private URLs
- [ ] Public-demo operations still enforce ownership, quotas, and confirmed cleanup
- [ ] The WfP example still uploads only the fixed platform-owned template
