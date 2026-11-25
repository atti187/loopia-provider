# Copilot instructions

This is a small, published npm package: a Pulumi dynamic provider for Loopia DNS zone records. Review pull requests with these rules in mind.

## What to enforce

- **Stable resource contract.** `LoopiaZoneRecord` must keep extending `pulumi.dynamic.Resource` directly, and its inputs, outputs, id format (`<domain>/<subdomain>/<record_id>`) and `additionalSecretOutputs` must not change in a compatible release. Changes there alter URNs or state in every consumer's stack.
- **Serializable provider.** Pulumi serializes the provider's functions. Everything they use must live inside the function bodies or be a `require`-able module. Flag module-level objects (such as a `Set` or class instances) captured by the provider, and anything that makes the compiled output need helper shims.
- **No secrets anywhere.** Credentials come from Pulumi config as secrets. Flag any real-looking credential, domain or account detail in code, tests, docs or logs, and any error message that could include request parameters. Tests and examples use placeholders such as `example.com` and `not-a-real-password`.
- **No real network calls in tests.** The Loopia API must be mocked.
- **Publishable package.** `files` stays a whitelist (`dist`), `@pulumi/pulumi` stays a peer dependency (never in `dependencies`), and `dist` is never committed.

## Review style

- Prioritize correctness and backwards compatibility over style.
- Briefly explain the risk of each issue you raise.
