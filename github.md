repo: Tom-urbanXtracts/ux-os-agents
branch: main

## Last sync

date: 2026-08-24T23:59:00Z

### Updated in this project

- Built the wholesale portal prototype: role-based ordering, lot and COA access, internal operations layer.
- Wrote the Phase 1 architecture document and the dependency-sequenced build plan.
- Branded against the supplied uX mark; ink sampled from the logo file.
- Source repo carries no UI code, so nothing was recreated from it — its conventions and portal skills informed the vocabulary, gates and segregation rules.

## Screen map

| Project screen | Repo files |
|---|---|
| ux-portal-prototype.dc.html | plugins/urbanxtracts/references/ux-os-conventions.md, plugins/urbanxtracts/skills/urbanxtracts-design-store-portal/SKILL.md, plugins/urbanxtracts/skills/urbanxtracts-design-public-coa-lookup/SKILL.md |
| ux-portal-phase-1-architecture.dc.html | plugins/urbanxtracts/references/ux-os-conventions.md, plugins/urbanxtracts/skills/urbanxtracts-design-store-portal/SKILL.md |
| ux-portal-build-plan.dc.html | plugins/urbanxtracts/references/ux-os-conventions.md |

## Publishing this prototype

This project is not the agents repo. It lives in its own repository,
`Tom-urbanXtracts/UX-Portal`, and is served by GitHub Pages from `main` at the
repository root: https://tom-urbanxtracts.github.io/UX-Portal/

Both the repository and the Pages site are public. Pages requires `.nojekyll`
at the root — without it Jekyll drops every path beginning with `_`, which
removes `_ds/` and leaves the `.dc.html` documents unstyled.

## Supabase Auth settings that live outside this repository

Password reset is built into the portal, but the emailed link only lands on it
once these are set in Supabase → Authentication → URL Configuration. Until then
the link goes wherever **Site URL** points, which is what sent it to `localhost`.

| Setting | Value |
|---|---|
| Site URL | `https://tom-urbanxtracts.github.io/UX-Portal/dist/portal.html` |
| Redirect URLs | `https://tom-urbanxtracts.github.io/UX-Portal/**` plus any local origin used for development |

Supabase answers `200` to a reset request whether or not `redirect_to` is
allow-listed — it falls back to Site URL silently rather than failing — so a
successful request is not evidence the link will land in the right place.
Verified by sending one with `redirect_to=https://evil.example.com/x`, which
was also accepted.

Custom SMTP is live through SendGrid, sender `tom@urbanxtracts.com`, DKIM and
SPF passing. **SendGrid click tracking rewrites the reset link**, which puts a
one-time recovery token through a third-party redirector and exposes it to link
scanners that pre-fetch URLs; turning click tracking off for this traffic is
recommended and has not been done.

## Each created user gets their own profile

Adding a user writes a row to `public.portal_pending_profile`, keyed on their
address. When that account first appears, `handle_new_portal_user()` provisions
`portal_profile` from that row and then **deletes it**, so the record applies to
exactly one account and can never be inherited by a second. With no pending row
the old defaults still apply (`budtender` / `Unassigned`).

Nothing is shared: sign-in builds the identity only from the account's own
profile row. It no longer matches the address against the sample directory,
which previously let a matching address take that sample record's role and
locations instead of its own.

Who may add whom is enforced in the database, not the interface:

| Acting as | Adding | Result |
|---|---|---|
| Owner | buyer/budtender in its own organisation | allowed |
| Owner | an internal account | denied |
| Owner | anyone in another organisation | denied |
| Budtender | anyone | denied |
| Internal | any role, any organisation | allowed |
| Not signed in | anyone | denied (`42501`) |

Verified by executing each case under that account's own JWT claims. Note that
RLS decides which rows; the table `GRANT` decides whether the role may ask at
all — the first version of this table had policies but no grant, so every write
failed on permission before a policy was consulted.

## Leaked-password rejection without Supabase Pro

Supabase's own leaked-password protection is **Pro plan and above**, and this
org is on free, so the toggle is not available. The portal does the same check
itself, against the same source, on its password-set screen.

The browser SHA-1s the candidate password and sends **only the first five
characters** of that hash to `api.pwnedpasswords.com/range/`. The password and
its full hash never leave the page, and the endpoint cannot tell which of the
returned suffixes was being asked about. `Add-Padding: true` is sent so the
response size does not reveal how many real matches there were — measured at
roughly 2,000 suffixes returned per lookup regardless of the answer.

Measured behaviour:

| Password | Result |
|---|---|
| `password` | 52,372,427 hits — refused |
| `Summer2024!` | 3,614 hits — refused |
| random 40-char | 0 hits — accepted, proceeds to Supabase |
| endpoint unreachable | skipped, saved anyway, screen says so |

**It fails open by design.** A network problem at HaveIBeenPwned should not lock
somebody out of their own password reset, so the save proceeds and the screen
carries a CHECK SKIPPED note. If you would rather it fail closed, that is a
one-line change.

**Coverage is the portal's own reset screen only.** A password set through the
Supabase dashboard, or any future flow that calls GoTrue directly, bypasses this
— the check lives in the page, not in Auth. Only the Pro feature enforces it
inside Auth itself.

Two settings that are available on free and are not set from here: minimum
password length, and required character classes, both under
Authentication → Sign In / Providers → Email.

## Password length and required characters

Both are available on the free plan, and both live in project config rather than
in this repository — Authentication → Sign In / Providers → Email. Recommended:

| Setting | Value |
|---|---|
| Minimum password length | `12` (the docs call anything under 8 not recommended) |
| Required characters | digits, lower and uppercase letters, and symbols — the strongest option offered |

The allowed symbols, verbatim from the Supabase docs, are:

```
!@#$%^&*()_+-=[]{};'\:"|<>?,./`~
```

To do it from a terminal instead, get a token from
https://supabase.com/dashboard/account/tokens and **read the config first** —
the GET shows the exact format `password_required_characters` expects, which is
a colon-separated list of character sets rather than a friendly enum:

```bash
curl -s -X GET "https://api.supabase.com/v1/projects/cbhsavfbtcpdyxcvguay/config/auth" \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  | jq '{password_min_length, password_required_characters}'
```

Then PATCH the same endpoint with those two keys. Copy the character-set string
from the GET rather than typing one — a wrong value is rejected.

### What is actually enforced

Read off the API rather than the dashboard, since the config is not readable
from here: **minimum length 8**, and **all four character classes required**
(lowercase, uppercase, digits, symbols). Confirmed at the boundary — a
seven-character password is refused for length, `Passwo1!` is accepted.

### weak_password is not a failed sign-in

Raising the rules does **not** invalidate an existing weaker password, and
Supabase does **not** refuse the sign-in. It issues the session and reports the
weakness alongside it: a successful token response carries `access_token` and
`weak_password` **together**. On a compliant password the key is still present
but `null`.

This was got wrong once in both directions. First the portal treated
`weak_password` as a failed sign-in and said "that username and password do not
match an account" — untrue, and no way forward. The correction then keyed on the
presence of `weak_password`, which would have **locked out every account whose
password predates the rules change**, because the field is present on success.

What it does now: signs the account in, and shows a non-blocking banner carrying
Supabase's own message with a one-click reset. Verified against a live account,
all four cases:

| Sign-in | Result |
|---|---|
| Correct, no longer compliant | signed in, banner shown with Supabase's wording |
| Correct and compliant | signed in, no banner (`weak_password` is `null`) |
| Wrong password | refused, message does not say which half was wrong |
| Deactivated / no profile | unchanged |

## Why submissions were not reaching Monday

The published portal had no intake endpoint. `MAKE_WEBHOOK` came from
`window.UX_PORTAL_CONFIG.intakeUrl`, nothing on GitHub Pages ever set it, and
`post()` therefore recorded the submission locally and returned without sending.
Confirmed from both ends: the live build carried no webhook URL, and the Make
scenario's execution count had not moved since 06:31 UTC.

Worse, the order screen still said "SO-24191 submitted." The send path was
honest — it wrote "Held, no endpoint in this build" to the outbox — but the
toast was not, and the toast is what anybody actually reads.

### The fix, and why it is not a config file

A static page cannot hold a secret. Committing the Make URL and the shared
secret to make the live site post would publish both to a public repository,
which turns the secret into decoration.

Submissions now go to a Supabase Edge Function, `portal-intake`, which holds the
URL and secret server-side, checks the caller, stamps the submitter from the
verified token rather than trusting the payload, and forwards to Make.

| Caller | Result |
|---|---|
| No `Authorization` header | 401 at the platform gate |
| Publishable key as bearer | **401** — it passes `verify_jwt` but is not a person, so the function asks Auth and rejects it |
| Signed-in session | forwarded |
| No session, `kind: onboarding` | forwarded, flagged `unauthenticated: true` |

That second row is the reason the function asks `/auth/v1/user` rather than
trusting `verify_jwt`: the publishable key is a valid project JWT and is public.

"Request access" stays open by design — a store with no account has to be able
to ask for one. Those arrive flagged as unauthenticated, and are spammable
without a captcha; that is an open item, not a solved one.

### Two secrets have to be set on the function

Edge Functions → `portal-intake` → Secrets. Not settable from here:

| Secret | Value |
|---|---|
| `MAKE_WEBHOOK_URL` | the scenario's webhook URL |
| `MAKE_INTAKE_SECRET` | the shared secret the scenario's route filters already expect |

Until both are set the function answers `503 intake not configured`, and the
portal now says so in the toast rather than claiming the order was submitted.

### Failures are now visible where they happen

A rejection or an unreachable intake sets a `NOT SENT` toast carrying the
reason, as well as the outbox state. Previously only the outbox changed.
