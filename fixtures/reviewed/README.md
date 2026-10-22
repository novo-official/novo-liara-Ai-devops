# Reviewed contract fixtures

Empty on purpose. Files appear here only after a human reviewed a sanitised recording from `fixtures/recorded/`
(see its `REVIEW.md`) and confirmed that nothing identifies a customer or contains a secret.

For each promoted file add a line below: `<file> — reviewed by <name> on <date> — <what was checked>`.
`tests/integration/contract.test.ts` automatically replays every file in this directory through the production
schemas, so promoted fixtures become deterministic regression tests.

_No fixtures have been promoted. No live API response has been reviewed yet._
