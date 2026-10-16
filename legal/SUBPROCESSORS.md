# Triage Desk — Subprocessor List

> DRAFT — requires legal review before publication.
> Last updated: [DATE]. Customers on a DPA are notified of changes per DPA §7.

| Subprocessor | Purpose | Data processed | Location | Required? |
|---|---|---|---|---|
| Anthropic, PBC | AI analysis of tickets (model API) | Ticket text sent in the prompt (after redaction, if enabled for the workspace); screenshots if the user attaches them (not redacted) | [United States — confirm against Anthropic's current terms] | Only if AI analysis is used |
| Stripe, Inc. (and affiliates) | Subscription billing, invoices, customer portal | Workspace name, billing contact email, payment details (held by Stripe, not by us), subscription status | [confirm — Stripe entity/region used for your account] | Only on paid plans |
| [Resend / Postmark — delete one] | Transactional email: address confirmation, password reset, password-changed notice | Recipient email address, recipient name, message content (one-time link) | [confirm] | Only if email is enabled |
| [HOSTING PROVIDER] | Application hosting, database storage | All Customer Data | [REGION] | Yes |
| [BACKUP DESTINATION, e.g. AWS S3 / other] | Off-site database backups | All Customer Data (including password hashes), in backup copies | [REGION] | Yes, if off-site backups are enabled |

## Changes

| Date | Change |
|---|---|
| [DATE] | Initial list |
