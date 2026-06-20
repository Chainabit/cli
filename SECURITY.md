# Security Policy

## Reporting a vulnerability

If you discover a security vulnerability in the Chainabit CLI, please report it
**privately**. Do **not** open a public GitHub issue.

- Email: **security@chainabit.com**

Please include:

- A description of the vulnerability and its impact
- Steps to reproduce (redact any real tokens or secrets)
- The CLI version (`chainabit --version`) and your environment

We aim to acknowledge reports within 3 business days and to provide a remediation
timeline after triage.

## Supported versions

Security fixes are provided for the latest published `chainabit` release. Please
update with `npm install -g chainabit@latest` before reporting.

## Handling secrets

The CLI stores credentials locally and uses tokens such as `cbt_live_...`. Never
share these values in issues, logs, or screenshots. Rotate any token you believe
has been exposed via `chainabit auth keys revoke <id>`.
