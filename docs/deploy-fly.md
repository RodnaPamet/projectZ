## Continuous deploy

`.github/workflows/deploy.yml` deploys `main` after CI passes. It needs one
secret:

```bash
fly tokens create deploy --app playerz-bg     # then paste into:
gh secret set FLY_API_TOKEN --repo RodnaPamet/projectZ
```

A **deploy token**, not a personal one: it is scoped to this app, so a leak
cannot reach the rest of the organisation.

The workflow waits for CI and checks out the commit CI actually tested —
`workflow_run` fires on failure too, so there is an explicit conclusion guard,
and `main` may have moved on by the time it runs.
