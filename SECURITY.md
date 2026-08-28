# Security Policy

## Supported versions

Sokomind is currently developed as a static application before a stable 1.0
release. Security fixes target the latest state of the `main` branch; older
commits and deployments are not maintained as separate supported versions.

## Reporting a vulnerability

Please report suspected vulnerabilities privately through
[GitHub's private vulnerability reporting](https://github.com/Willpatpost/SokomindSolver/security/advisories/new).
Do not open a public issue or include exploit details in a public pull request
before the report has been assessed.

Include the affected route or component, reproduction steps, impact, and any
suggested mitigation you have. Remove tokens, personal data, and unrelated
browser storage from screenshots or logs.

This project is a client-side application with no first-party API or account
service. Reports about dependency supply-chain issues, unsafe persistence or
import behavior, service-worker cache boundaries, and solver-worker isolation
are still in scope when they affect this repository or its deployed site.
