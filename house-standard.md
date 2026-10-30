---
name: project-init
description: Scaffold a new project or add an entity using a strict layered folder structure with one file per entity per layer, loose coupling enforced by a machine check, circuit breakers at outbound boundaries, deny-by-default security, structured internal errors with helpful external messages, worst-case input handling, confirmation for critical actions, environment-driven feature flags, a no-emoji rule, and a ban on useless or always-passing tests. Use when the user asks to initialize, bootstrap, scaffold, or restructure a codebase, or to add a new entity following the house architecture.
---

# Project Init

## 1. Mission

Create or extend a project so that every entity is a vertical slice through five
layers, with one file per entity per layer. Each layer has exactly one
responsibility and may only depend inward.

The scaffold is secure by default, fail-loud internally and helpful externally,
resilient at every outbound boundary, tolerant of the worst plausible input, and
toggleable at runtime through typed feature flags declared in one place.

Design stance: assume the user is careless, never assume they are stupid. The
system absorbs mistakes; it does not punish them.

## 2. Folder structure

One file per entity per layer. Dependencies point inward only.

```
<root>/
  src/
    models/entities/        <entity>_model.<ext>      source of truth
    schemas/                <entity>_schema.<ext>     transport DTOs
    crud/                   <entity>_crud.<ext>       persistence, one entity each
    services/               <entity>_service.<ext>    business logic, one entity each
    routers/                <entity>_router.<ext>     transport, one entity each
    core/
      config.<ext>                                    settings, feature flag declarations
      database.<ext>                                  connection and pool lifecycle
      errors.<ext>                                    error hierarchy, correlation ID
      logging.<ext>                                   structured logger, redaction rules
      resilience.<ext>                                breaker, timeout, retry, bulkhead
      security.<ext>                                  hashing, tokens, authorization helpers
      container.<ext>                                 composition root
    middleware/
      correlation_middleware.<ext>
      security_headers_middleware.<ext>
      rate_limit_middleware.<ext>
      error_handler_middleware.<ext>
  tests/                    mirrors src/ exactly
  arch-check.<ext>
  .architecture
  .project-init-assumptions.md
```

If the project already uses different top-level names, keep theirs and map these
five layers onto it. Never rename an existing directory without being asked.

### Layer responsibilities

| Layer | Does | Never does |
|---|---|---|
| routers | Parse request, call one service, shape response | Any `if` that is not error mapping |
| services | Business logic, orchestration, authorization, cross-entity rules | Build raw queries, import a DB driver |
| crud | Persistence for one entity | Join across entities, import a service |
| schemas | Wire-format validation | Import repositories or services |
| entities | Domain types and invariants | Import schemas, repositories, services, frameworks |

### Hard rules

1. A router contains parse, call, respond. Nothing else.
2. A crud file touches one entity's storage. No cross-entity joins.
3. A service never imports a DB driver.
4. An entity imports nothing from your own project.
5. No module-level mutable singletons. Dependencies are injected from the
   composition root in `core/container`.
6. Cross-entity coordination lives in exactly one service, named after the use
   case, not the entity it starts from.
7. Two services never import each other. Extract the shared rule into a third.
8. Authorization is enforced in the service layer, not only in the router.
9. One file per entity per layer. Always.

### Naming

`user_model`, `user_schema`, `user_crud`, `user_service`, `user_router`. Class
names `UserModel`, `UserSchema`, `UserCrud`, `UserService`, `UserRouter`. The
layer suffix is redundant with the folder. Keep it anyway, it makes diffs and
grep honest.

Functions in `crud/`: `get_by_id`, `list`, `create`, `update`, `delete`. Return
entities, not raw rows. Functions in `services/`: named after the use case,
`register_user`, `deactivate_account`.

## 3. Language agnosticism

The architecture is invariant across languages. The syntax adapts. These are
separate concerns and must not be confused.

### Invariant across every language

- The five layers exist, always.
- Directory names are lowercase and use the same words:
  `models/entities`, `schemas`, `crud`, `services`, `routers`, `core`.
- One file per entity per layer. Always.
- The file is named `<entity>_<layer>` or `<Entity><Layer>`. The pattern is the
  same; the rendering follows the language.
- Imports point inward. Always.
- The composition root is at `core/container`. Always.
- Tests mirror `src/`. Always.

### What adapts

- **File extension.** `.py`, `.ts`, `.go`, `.java`, `.cs`, `.rs`, `.rb`.
- **Casing of identifiers.** A Python function is `snake_case`. A Go exported
  function is `PascalCase`. A Java class is `PascalCase`. A TypeScript file
  exporting a class may be `PascalCase.ts`.
- **Package and namespace declarations** at the top of each file, derived from
  the directory path. They do not change the directory path.

### What the agent must not do

- Do not flatten the structure because a framework prefers it. Next.js routes
  live in `app/` or `pages/` at the root. Django wants a project package. Rails
  wants `app/`. These live *alongside* the architecture, not instead of it.
  Routers call services; the framework's route file is a thin transport adapter
  in `routers/` imported from the framework's entry point.
- Do not invent a new top-level directory. Every file has a home in the layout.
  If it does not, stop and ask.
- Do not rename layers to match a framework's vocabulary. `repositories/` is an
  acceptable synonym for `crud/` if the project already uses it. Choose one and
  stick to it. Never both.
- Do not translate domain names. If the entity is `User`, the folder contains
  `user_*` files in every language.
- Do not skip a layer because the language "does not need it." A Go project
  still has a service layer even though it could call the repository directly.
  The separation is the point.

### Pin the decisions

Write `.architecture` at the project root on first init. It records:

- The five layer directory names chosen for this project.
- The file extension and casing convention.
- The name of the composition root.
- The name of the architecture check command.
- Any framework directories that coexist with the layout, and where they live.

A later agent reads this file first and conforms to it. It never re-derives the
layout from scratch and never "improves" a pinned decision.

### Strict mode

If the user wants the exact same casing across every language, that is supported
but must be requested explicitly. Set `strict_uniform_casing: true` in
`.architecture`. In strict mode, Python files are `UserModel.py`, Go files are
`UserModel.go`. This fights every language's linter and is off by default.

## 4. Naming

Write for a competent engineer in this language who has never seen this
codebase. They know the language and its idioms. They do not know your domain.
The code should be readable top to bottom without a comment explaining each
line.

Do not write down to a reader who does not know the language. Avoiding a
comprehension, a match statement, or a standard library call because it is "too
advanced" produces worse code, not clearer code. Clarity is not the same as
simplicity of syntax.

### Rules

1. Names say what the thing is or does. `calculate_invoice_total`, not
   `process`, not `handle_data`.
2. Use the domain's own vocabulary. If the business says "policy," the code says
   `policy`. Do not translate.
3. One concept, one word, everywhere. Pick `create` or `insert`. Never both.
4. Length scales with scope. A loop index is `i`. A module-level export is
   `active_subscription_renewal_service`.
5. Booleans read as predicates: `is_active`, `has_permission`, `can_publish`.
6. Functions are verb phrases. Types are noun phrases.
7. No abbreviations except universally understood ones: `id`, `url`, `http`,
   `api`. Write `repository`, not `repo`. Write `configuration`, not `cfg`.
8. No encodings. `payment_status`, not `status`, not `status_1`, not `type`.

### Banned as standalone names

`data`, `info`, `manager`, `helper`, `util`, `utils`, `common`, `misc`, `temp`,
`tmp`, `process`, `handle`, `do`, `thing`, `obj`, `val`.

If you reach for one of these, you have not decided what the thing is. Decide
first, then name it.

### Comments

The code explains what. Comments explain why.

- Every public function gets a docstring stating what it takes, what it returns,
  what it raises.
- Comments are for the non-obvious decision, the workaround, the business rule
  that is not visible in the code.
- Never leave a comment that restates the line below it.
- Never leave commented-out code. Delete it.

## 5. Do it where it belongs

Two failure modes, both common, both banned.

### 5a. Do not do in a service what the query can do

Filtering, sorting, pagination, aggregation, counting, existence checks, and
joins belong in the query. Pulling rows into memory to loop over them is a bug
waiting to happen and a performance cliff the moment the table grows.

Banned:

- `list_all()` then filter in a service. Pass the filter to the query.
- Fetching a collection to count it. Use a count query.
- Fetching a row to check existence. Use an existence query.
- Fetching a parent and then its children one by one. One query, a join, or a
  batched fetch.
- Fetching all rows and slicing in the service for pagination. Paginate in the
  query.
- Fetching all rows and summing, averaging, or grouping in a loop. Aggregate in
  the query.
- Any N+1 pattern. If a loop contains a query, that is an N+1.

The crud layer exposes exactly what the service needs: `list_users_by_status`,
`count_active_subscriptions`, `user_exists_by_email`. A service never works
around a missing query by fetching more than it needs and doing the query's job
in code.

Exception: if the logic is business policy — it might change for reasons
unrelated to the database, or you want to test it without a database — keep it
in the service and the query stays dumb. The test is: if this rule changed,
would it be a database change or a business change?

### 5b. Do not do what does not need doing

Before writing any function, ask: does this need to exist?

Banned:

- A helper with one caller that does not earn its name. Inline it.
- An abstraction with one implementation and no second implementation in sight.
- A base class with one subclass.
- A config value that never varies across environments. Hardcode it as a named
  constant.
- A feature flag for behavior that will never be toggled.
- A wrapper around a standard library call that adds nothing.
- A generic solution to a specific problem, built for a second use case that
  has not been requested.
- A layer of indirection that only forwards arguments.
- Dead code, unreachable branches, and unused exports.
- A `try` block whose only purpose is to log and re-raise the same error.
- Validation in both the schema and the entity when one place can own it.
- A manual reimplementation of something the language, framework, ORM, or
  database already does correctly.

If you are tempted to write one of these, stop and state in one sentence what
breaks if you do not write it. If there is no concrete answer, do not write it.

### 5c. Do not do what the domain does not say

Do not invent behavior, defaults, or rules the user did not ask for. If a rule
is unclear, ask. If a default is needed and unspecified, pick the least
surprising one, state it in the assumption ledger (§15), and mark it as an
assumption the user should confirm. Never silently invent policy.

## 6. Loose coupling

The import graph is the coupling. Enforce it with a machine, not with prose.

- Generate an architecture check in the same run. Python: `import-linter`.
  TypeScript: `dependency-cruiser`. Go: `go-arch-lint` or `depguard`. Java and
  Kotlin: ArchUnit. C#: NetArchTest.
- The check fails the build if any layer imports outward, if two services
  import each other, or if a crud file imports another entity's crud file.
- Wire the check into the default test command, not CI only. A developer must
  be able to reproduce a red build locally with one command.
- Talk to other modules through an interface or a typed boundary, never through
  a shared mutable object. If two modules need the same data, one passes it to
  the other as an argument.

## 7. Circuit breakers

Apply at outbound boundaries only: third-party HTTP APIs, LLM providers,
payment gateways, email and SMS, brokers, caches, remote databases.

For every outbound call:

1. Explicit non-infinite timeout.
2. Circuit breaker, one per dependency, not per call site. States closed, open,
   half-open. Configurable threshold, reset window, probe count.
3. Bulkhead: dedicated pool or concurrency limit per dependency.
4. Retry with jitter, idempotent operations only, bounded attempts.
5. Explicit typed fallback. Never a silent null.
6. Breaker state changes and fallback activations emit a metric and a
   structured log.

Forbidden: circuit breakers on in-process calls between your own layers. A
service calling its own repository is not a failure domain. A breaker there adds
latency and hides bugs behind "breaker open."

All primitives live in `core/resilience` and are injected. Never constructed ad
hoc inside a service.

## 8. Code hygiene

**No emojis. Ever. Anywhere in the codebase.**

This covers source files, comments, docstrings, log messages, error strings,
test names, commit messages, filenames, configuration, CLI output, README
diagrams, and generated scaffolding.

- Status output uses `[OK]`, `[FAIL]`, `[WARN]`, `[SKIP]`. Not checkmarks or
  colored symbols.
- Log level, not decoration, carries tone.
- No box-drawing, no ASCII art, no banner art.

The rule applies to the codebase, not to runtime user data. If the product is a
chat app, users may send emojis and the system must handle them. The prohibition
is on the engineering artifacts.

Add a lint rule or pre-commit hook that fails on emoji or non-ASCII characters
in source paths. Scope it away from test fixtures containing intentional
unicode.

## 9. Error reporting

The goal is that any failure is traceable to its exact cause by an engineer, and
helpful but non-revealing to everyone else. Achieved by splitting the error into
two views joined by a correlation ID.

### The two views

| View | Audience | Content |
|---|---|---|
| Internal (logs, traces, internal error objects) | Engineers, on-call | Full context. Operation, entity, identifier, layer, correlation ID, cause chain, the exact value that failed validation, the dependency that timed out. |
| External (HTTP response, CLI output, API payload) | Clients, users | A helpful human message, a domain identifier if useful, a reference for support. No internals. |

The internal view is never generic. "Something went wrong" and "operation
failed" are forbidden in logs and internal errors. Every internal error names:

- the operation (`register_user`)
- the entity and identifier if applicable (`user_id=8f3a...`)
- the layer that raised it (`service`, `crud`, `http_client`)
- the correlation ID
- the root cause, chained, not flattened

The external view reveals nothing internal:

- no stack traces, exception types, or framework internals
- no SQL, query fragments, or schema names
- no file paths, hostnames, or internal service names
- no indication of whether a user, email, or resource exists
- no timing that distinguishes "not found" from "wrong password"

Authentication failures say `invalid credentials`, never `user not found`.
Password reset says `if that account exists, a link has been sent`, always.
Signup on a taken email is the one common exception. Decide once, document it,
be consistent.

The external view is also never useless. See §10.

### The correlation ID

- Generated at the transport boundary (router, handler, CLI entry, job runner).
- Attached to the request context and threaded through every layer.
- Included in every log line and in the external error response as a secondary
  reference, clearly labeled. Never as the primary message.
- The user reports it. The engineer greps it. That is the entire bridge.

### Error hierarchy

- All errors descend from a single base in `core/errors`.
- Each layer raises its own typed errors. Repositories raise `NotFoundError` and
  `ConflictError`. Services raise domain errors. The transport layer maps them
  to status codes in one place, via the error-handler middleware.
- Every domain error has exactly one user-facing rendering.
- Never catch and swallow. `except: pass`, empty catch blocks, and `catch (e) {}`
  are forbidden. If you catch, handle it, log with full context, and re-raise
  or convert.
- Fail loud in development, fail safe in production. The same code path
  produces the same correlation ID in both. Only the external rendering differs.

### What must never be logged

Never write to a log, metric label, trace attribute, or error message:

- passwords, password hashes, API keys, tokens, session IDs, private keys
- full request or response bodies containing credentials
- PII beyond what is operationally required. Prefer identifiers over names and
  emails.
- full card numbers, SSNs, or any regulated data

When you must reference a sensitive value, log a stable hash or the last four
characters. Never the value. Redaction rules live in `core/logging` and are
applied by the logger itself, pattern-based on value shape as well as key name,
not by each call site.

## 10. User-facing messages

Every message a user sees is either actionable or it is noise. If it is noise,
it is a bug.

### The four parts of a good message

Every user-facing message answers, in this order:

1. What happened, in the user's words. Not "validation failed." Use "That email
   is already registered."
2. Why, only if knowable and useful. Skip if the reason would confuse or leak.
3. What to do next. Concrete. A link, a button, a field to change.
4. How to get help, only for errors the user cannot resolve. A reference they
   can quote. Not a correlation ID shoved in their face.

### Required

- State the fix, not the rule. "Passwords need at least 12 characters" is fine.
  "Invalid input" is not.
- Point at the field. If a form has six fields and one is wrong, the error is on
  that field, next to it, visually connected.
- Explain what the system did when the user's expectation might differ. "We
  saved your draft. You can come back to it from your dashboard."
- Name domain identifiers when they are useful. An order number, a ticket
  reference, an invoice number. They are what the user quotes to support and
  what the user searches for.
- Use the same noun the user uses. If the button says "Publish," the error says
  "We could not publish your post," not "Article state transition failed."
- Read it aloud. If it sounds like an engineer wrote it, rewrite it.

### Banned in user-facing output

- "Something went wrong."
- "An error occurred."
- "Invalid input."
- "Unknown error."
- "Error 500," "Error 404," or any HTTP status code shown as a message.
- A raw database primary key, UUID, or hash presented as if it means something
  to the user.
- A stack trace, exception class name, or framework name.
- A file path, hostname, internal service name, or internal URL.
- The word "null," "None," "undefined," or "NaN."
- An empty state that is a blank screen. Every empty state has a message and a
  next action.
- A message that blames the user. "You entered the wrong password" reads worse
  than "That password is not correct." The system states facts, it does not
  assign fault.
- A message in a language of error codes. "E_AUTH_003" alone is not a message.
  Pair every code with a human sentence, or do not show the code.
- A correlation ID as the primary message. It may appear as a secondary
  reference, clearly labeled "Reference for support," after the actionable text.

### Examples

Bad: `Error: 500`
Good: `We could not save your changes. Your draft is safe. Try again in a
moment. If it keeps happening, contact support and mention order 4821.`

Bad: `Invalid input`
Good: `That phone number looks short. Include the country code, like
+1 555 0100.`

Bad: `User with UUID 7f3a-... already exists`
Good: `That email is already registered. Sign in instead, or reset your
password if you have forgotten it.`

Bad: `Something went wrong`
Good: `We could not reach your bank to confirm the payment. Your order is
saved. We will retry automatically in 15 minutes, or you can try now.`

Bad: `NaN`
Good: `Enter a number for quantity.`

### Empty states

Every list, dashboard, or search result has a defined empty state with:

- One sentence saying what would appear here.
- One action the user can take to make something appear.
- No skeleton loaders that never resolve.

### Testing messages

For each user-facing message, the test asserts:

- It contains no banned phrase.
- It names a next action or a next step.
- If it references a domain identifier, the identifier exists and belongs to
  the user.

Add a test that greps the codebase for banned phrases. It is cheap and catches
regressions.

## 11. Security

Organized by attack class, not by feature. Secure by default. Every item is a
requirement. If a project cannot meet one, the reason is documented in the file
that would have implemented it.

### Identity and session

- Passwords hashed with Argon2id, or bcrypt as a fallback. Never MD5, SHA1, or
  unsalted anything.
- Session tokens have at least 128 bits of entropy, are single-use where
  applicable, and expire on a defined schedule.
- Password reset tokens are single-use, time-limited, and bound to the account.
- JWTs: algorithm is pinned on verification. `alg: none` and algorithm
  confusion are rejected. Claims are validated, not trusted.
- Logout invalidates the session server-side, not just the client cookie.
- Session ID rotates on privilege change.
- Cookies are `HttpOnly`, `Secure`, `SameSite=Lax` or stricter.
- CSRF protection on every state-changing request that relies on cookies.

### Authorization

- Deny by default. Every protected resource checks authorization explicitly.
- Object-level authorization, always. A request for `/invoices/123` checks that
  invoice 123 belongs to the caller. Never rely on an unguessable ID.
- Tenant isolation at the data layer. Every query that reads tenant data filters
  by tenant. Enforced in the repository, not the service, so a missing filter is
  impossible to forget.
- Authorization lives in the service layer, not only in the router.
- Mass assignment is prevented: input DTOs declare exactly which fields are
  settable. Never bind request data directly to an entity or a database model.
- Role and permission checks are on the action, not the role name. `can_publish`
  beats `is_editor` because it survives a redesign of who is what.
- Every authorization decision is logged with principal, resource, action, and
  outcome.

### Input

- All external input is validated at the transport boundary against an allowlist
  of known-good shapes. Never a denylist.
- Validation rejects unknown fields, not just invalid ones.
- Request body size limits are set. No endpoint accepts unbounded input.
- Content-Type is checked. A JSON endpoint does not parse form data.
- File uploads: extension and content-type validated against an allowlist,
  stored outside the web root, served through a handler that sets
  `Content-Disposition` and never serves with an executable content type.
- Path parameters that become file paths are normalized and confined to a base
  directory. Never concatenate user input into a filesystem path.
- SSRF: any URL supplied by a user is validated against an allowlist of schemes
  and hosts. Internal IP ranges (127.0.0.0/8, 10.0.0.0/8, 169.254.0.0/16,
  172.16.0.0/12, 192.168.0.0/16, ::1, fc00::/7) are rejected. Redirects are
  re-validated, not followed blindly.
- Deserialization of untrusted data uses a safe format and a strict schema.
  Never pickle, never Java native serialization, never eval.
- Regex used on user input is checked for catastrophic backtracking, or the
  engine's linear-time mode is used.

### Output

- All output is encoded for its destination. No raw interpolation into HTML,
  shell, SQL, or logs.
- Log injection: user-controlled values are structured, not interpolated. A
  newline in a username does not create a fake log line.
- Error responses reveal nothing internal.
- Content-Type is set explicitly on every response. The browser never sniffs.

### Data access

- Queries are parameterized, always. No string concatenation into SQL, NoSQL,
  shell, or template engines.
- The application database account has least privilege: no DDL, no access to
  other schemas, no superuser.
- Sensitive fields at rest use column-level encryption or are stored only as
  hashes.
- PII is minimized. Do not store a field the product does not use.
- Backups and read replicas inherit the same access controls as the primary.

### Resource limits

- Pagination is mandatory on any endpoint that returns a collection. No
  unbounded lists, ever.
- Maximum page size is capped server-side.
- Rate limits on: authentication, password reset, account creation, any
  endpoint that sends a message, any endpoint that costs money, any endpoint
  that calls a third party.
- Rate limits are per principal where a principal exists, not only per IP.
- Expensive operations have a timeout. A query that runs for 30 minutes is a
  denial-of-service vector.
- Recursion depth and loop iteration counts have sane bounds on user-influenced
  paths.

### Business logic

- Quantities, prices, and amounts are validated at the boundary: no negatives
  where negatives are meaningless, no zero where zero is meaningless, no absurd
  maximums.
- State transitions are validated. An order cannot go from `delivered` back to
  `pending_payment`.
- Race conditions on critical paths (inventory, balance, one-per-user) are
  handled with a transaction, a lock, or a unique constraint. Not with a
  read-then-write.
- Webhook payloads are verified by signature before being trusted.
- Anything that grants access, moves money, or sends a message has an audit log
  entry.

### Transport and runtime

- TLS enforced on every outbound call. Certificate validation never disabled,
  including in tests.
- Security headers on every HTTP response: HSTS, CSP, X-Content-Type-Options,
  X-Frame-Options, Referrer-Policy.
- CORS is an explicit allowlist. Never `*` with credentials.
- Dependencies pinned with a lockfile and scanned for known vulnerabilities. A
  critical finding fails the build.
- Secrets from environment or a secrets manager. Never committed, never logged,
  never in a URL. Every secret has a rotation path.

### Failure behavior

- Security checks fail closed. Authorization service unreachable: deny. Token
  validator timed out: deny. Never a "degraded" allow.
- Health checks expose liveness and readiness only. No version numbers, no
  dependency names, no configuration.

## 12. Worst-case input

Assume the user is careless, in a hurry, on a bad connection, using a screen
reader, pasting from a spreadsheet, and has never read the docs. Assume they
will double-click the submit button, hit the back button after paying, paste
10000 characters into a name field, submit an empty form, and navigate away
mid-operation.

### Input handling

- Empty and missing are different from invalid. An empty name field says "Tell
  us your name." It does not say "Invalid input."
- Type coercion is not validation. A string "123" submitted to a numeric field
  is not a number until it is validated as one. Never trust the client's type.
- Whitespace-only is empty. Trim before validating.
- Trim only outer whitespace. Never trim inner whitespace from a password, a
  code, or a formatted address.
- Bounds are explicit and tested at the boundary. Every string field has a min
  and max. Every number field has a min and max. Test with 0, -1, max, max plus
  one, and empty.
- Unicode is handled, not rejected. Names contain apostrophes, accents, and
  non-Latin scripts. Emoji in user data is valid. Control characters and
  bidirectional override characters in display fields are stripped.
- Normalization is explicit. Email is normalized to lowercase before
  comparison. Usernames have a stated case rule, applied consistently.
- Paste is expected. Fields accept paste with trailing newlines and tabs.
- Leading and trailing punctuation in identifiers is stripped. A phone number
  pasted with parentheses and hyphens yields the number they meant.
- Locale is not assumed. Date input accepts the user's locale, or accepts only
  ISO 8601 and says so in the label. Number input handles comma and period
  decimal separators, or rejects with a clear message.
- Timezones are explicit. Never store a naive timestamp. Never assume UTC
  without saying so.

### Actions

- Every submit is idempotent, or protected against double-submit. A
  double-clicked button creates one record, not two. A retried payment charges
  once. Use an idempotency key, a unique constraint, or both.
- Long-running actions show progress and can be cancelled or recovered.
- Failure is recoverable. Any operation that fails leaves the system in a state
  the user can retry from. Never a half-written record the user cannot see or
  fix.
- Navigation away mid-operation does not corrupt state. The back button is not
  an attack. The tab close is not an attack.
- Stale state is detected. A form submitted against data that changed underneath
  returns a clear message, not a silent overwrite.

### Degraded conditions

- Slow network. Timeouts have a message. A request that takes 30 seconds is
  reported as in-progress, not as a failure, until it actually fails.
- Offline. If the client can detect offline, it says so before attempting the
  request.
- Partial failure. If a batch of 10 items fails on 3, the user sees which 3 and
  can retry only those.
- Third-party down. A breaker open on a payment provider produces "Payments are
  temporarily unavailable. Your order is saved. Try again in a few minutes."
  Not a 502.
- Full disk, exhausted quota, revoked token. Each has a distinct user-facing
  message with a distinct next step.
- Concurrent edits. Two tabs editing the same record: the second save reports
  the conflict with what changed, not a generic error.

### The rule for handling any input

For every input path, answer three questions in a comment in the code:

1. What happens with valid input?
2. What happens with the worst plausible input? (empty, huge, wrong type,
   malformed, duplicated)
3. What happens with input that is trying to break the system?

If question 2 or 3 has no answer in the code, the input path is incomplete.

## 13. Confirmation for critical actions

A critical action is one that destroys data, moves money, changes access, or
sends something the user cannot unsend. Every critical action confirms before
it runs. No exceptions, no configuration flag to disable it.

### What counts as critical

- Deleting anything the user cannot recover.
- Changing a password, email, phone number, or payment method.
- Granting, revoking, or escalating access.
- Transferring, refunding, or charging money.
- Sending a message, email, invitation, or notification to someone else.
- Publishing something publicly that was private.
- Cancelling a subscription, closing an account, ending a contract.
- Any bulk operation affecting more than one record.
- Any operation whose effects cross a tenant or account boundary.

If an action is not on this list but feels adjacent to it, treat it as critical.

### What a confirmation must contain

1. The action, in plain words. "Delete this project." Not "Proceed?"
2. What will be affected, specifically. "This deletes the project and its 14
   documents. 3 collaborators will lose access."
3. Whether it can be undone, stated plainly. "This cannot be undone." or "You
   can restore this from Trash for 30 days."
4. The confirm button labeled with the action. "Delete project" not "OK."
   "Transfer funds" not "Confirm." A user scanning fast should be able to tell
   from the button alone what they are about to do.
5. The cancel button labeled "Cancel" and positioned safely.

### What a confirmation must not do

- Not be a generic "Are you sure?" with no detail.
- Not require typing the word "DELETE" unless the action is genuinely
  irreversible and high-stakes. Reserve this for the handful of actions where
  a mistake is catastrophic and rare.
- Not be dismissible by pressing Enter or Space by reflex. Default focus is
  Cancel.
- Not be the only protection. Confirmation is a pause, not a lock. The server
  still authorizes, still checks ownership, still validates state.
- Not be bypassable by a second submit. The confirm endpoint is idempotent, or
  the operation is, and a double-tap of the confirm button performs the action
  once.

### Two-step for the highest-stakes actions

Deleting an account, transferring money above a threshold, and revoking the last
admin on an account require a second step beyond a modal: re-authentication, a
typed confirmation of the account or amount, or a delayed action the user can
cancel from email. Pick one and state the reason in a comment.

### Irreversible actions

If an action cannot be undone, the confirmation says so explicitly in the
sentence, not in fine print. If the system can make the action reversible, do
that instead and skip the ceremony. Undo beats confirm every time it is possible.

### Server-side, not only client-side

Confirmation is a UI affordance. The server does not trust it. Every critical
endpoint independently verifies:

- The caller is authenticated.
- The caller is authorized for this specific object.
- The object is in a state where the action is legal.
- The action has not already been performed (idempotency key or state check).

A client that skips the modal and posts directly to the endpoint gets the same
outcome as the client that showed the modal. The modal is courtesy. The
authorization is security. Any confirmation implemented purely in the client is
a devtools away from being bypassed.

### Logging

Every critical action writes an audit entry: who, what, which object, when, from
where, and whether it succeeded. Separate from application logs, retained
longer.

## 14. Feature flags

Runtime toggles driven by environment variables. They decouple deploy from
release and provide a kill switch without a rollback.

### Declaration

- Every flag is declared in one place: the config module in `core/`.
- Each flag has a name, a type, a default, and a one-line description.
- Flags are read once at startup and injected. Never call `os.getenv`,
  `process.env`, or `os.Getenv` for a flag anywhere else in the codebase.

### Naming

`FEATURE_<DOMAIN>_<NAME>` in uppercase for the environment variable;
`feature_<domain>_<name>` in the config object.

```
FEATURE_BILLING_NEW_PRICING_ENGINE=true
FEATURE_AUTH_REQUIRE_MFA=false
FEATURE_SEARCH_SEMANTIC_RANKING=true
```

### Defaults

- New or unstable behavior: off by default.
- Stable, fully rolled-out behavior: on by default.
- Security controls default to the safe value and are never gated behind a flag.

### Hard rules

1. Never gate a security control behind a feature flag. Authentication,
   authorization, input validation, and rate limiting are always on. A flag
   that can disable them is a backdoor with a nice name.
2. Never gate error handling or logging behind a flag.
3. Flags are temporary. Every flag is documented with the date added and the
   condition for removal. A flag older than one release cycle without a removal
   plan is technical debt with a config entry.
4. Flag state is logged at startup, one line per flag, at INFO level.
5. No nested flags. A flag must not change the meaning of another flag.
6. Flags are booleans or enums. Never a free-form string or numeric threshold.
   If it needs a value, it is configuration, not a flag.

## 15. Tests

A test exists to catch a regression. If it cannot fail, it is not a test.

AI-written tests fail in a specific way: they pass regardless of what the code
does. They mock the thing under test, assert `is not None`, or check that a mock
was called. They look like tests and provide zero protection. This section
exists to make that impossible to ship.

### The only proof that matters

A test is only valid if it goes red when the code under test is broken.

Before reporting any test as written, verify it:

1. Break the code under test. Introduce a real bug, not a syntax error.
2. Run the test. It must fail.
3. Restore the code.
4. Run the test. It must pass.
5. Report both runs. If step 2 did not fail, delete the test and write a real
   one.

This is not optional and not a one-time check. It is how every test is validated
before it is reported as done. Coverage tools will not catch this. Only this
catches this.

If the project has a mutation testing tool available (mutmut, cosmic-ray,
Stryker, PIT, go-mutesting, cargo-mutants), run it on the code under test and
report the mutation score. Any mutation that survives is a test that does not
test. A surviving mutation in changed code fails the run.

### Required

- One test file per layer, per entity, mirroring `src/`.
- Test the layer's own responsibility. Mock only the layer directly beneath it.
- Each test name states the regression it catches.
  `test_register_user_rejects_duplicate_email`, not `test_register_user_2`.
- At least one happy-path test per use case.
- At least one failure-path test per use case: repository not-found, outbound
  timeout, breaker open, invalid input.
- At least one test asserting the external error response leaks nothing internal.
- A test for every branch a reader would be surprised by.
- A test that greps the codebase for banned user-facing phrases.

### Banned

- A test that asserts nothing, or asserts `is not None`, `!= null`, or
  truthiness where the value does not matter.
- A test that only asserts the code did not raise. If the assertion is "it did
  not crash," the test has no value.
- A test that mocks the thing under test.
- A test that mocks every dependency so heavily that it asserts the mocks were
  called, not that behavior is correct.
- A test that would pass no matter what the code does.
- A test asserting on log strings, exact error message wording, or
  implementation detail that is not part of the contract.
- A snapshot test of anything that changes on every run.
- A test per trivial getter or setter.
- A generated stub with a `pass` body.
- A commented-out test left in place.
- A test that duplicates another test's assertions without exercising a
  different path.
- A test that asserts on the shape of a mock's call arguments when a value
  assertion would do.
- Any test the agent did not verify fails when the code is broken.

### Coverage is not quality

Never report coverage as evidence of test quality. 100 percent coverage of
assertion-free tests is worse than 60 percent coverage of tests that catch real
regressions. Coverage measures lines reached, not behavior verified. Do not add
tests to raise coverage. Add tests to catch regressions.

### Anti-hallucination rules for tests

- Read the existing test file before writing a new one. Match its imports,
  fixtures, and style.
- Never reference a function, module, or API the agent has not read in the
  codebase or verified exists in the installed dependency.
- Never write a test for a function that does not exist yet and assume it will
  later.
- Run the test command. Never assume a test passes. Report actual output.
- If a test fails and the cause is unclear, stop and report. Do not adjust the
  assertion to make it pass.

## 16. Enforce it

Prose rules drift. Generate a machine check in the same run.

- **Architecture** — a layered dependency check that fails the build if any
  layer imports outward. Python: `import-linter` in `pyproject.toml`.
  TypeScript: `dependency-cruiser` with `forbidden` rules per layer. Go:
  `go-arch-lint` or a `depguard` config. Java and Kotlin: ArchUnit. C#:
  NetArchTest.
- **Emoji and non-ASCII ban** — a lint rule or pre-commit hook that fails on
  emoji or non-ASCII characters in source files. Scope it to codebase paths,
  away from test fixtures with intentional unicode and from user data.
- **Secret scanning** — `gitleaks`, `detect-secrets`, or equivalent, in a
  pre-commit hook and the CI build.
- **Dependency vulnerability scan** — fails the build on critical findings.
- **Banned names** — a lint rule rejecting the banned identifiers where the
  language's linter supports it.
- **Banned phrases** — a test that greps user-facing strings for the banned
  list.

Every check runs in the default test command, not just CI. A developer must be
able to reproduce a red build locally with one command.

## 17. Initialization procedure

Follow these steps in order. Do not skip. Do not batch silently.

### Pre-flight

Before writing any file, state in the report:

- The language, framework, package manager, test runner, and layout detected.
- The five layer directory names that will be used.
- The composition root path.
- Any framework directory that will coexist with the layout.
- Any ambiguity that will require a guess. If the guess is material, stop and
  ask before writing anything.

### Steps

1. Resolve language, framework, package manager, test runner, and existing
   layout. If the repo is non-empty, read it first.
2. Confirm which entities to scaffold. If the user says "just do it," scaffold
   one entity named `User` and say so.
3. If any target file already exists, stop and report. Never overwrite. Offer
   to merge instead.
4. Create the directory skeleton per §2, adapted per §3.
5. Write one complete vertical slice for the sample entity: entity, schema,
   crud, service, router. Real and runnable, no `# TODO` stubs.
6. Write `core/`: config with feature flag declarations, database lifecycle,
   error hierarchy and correlation ID, structured logger with redaction rules,
   resilience primitives, security helpers, composition root.
7. Write the middleware: correlation ID, security headers, rate limiting, error
   handler with external message mapping.
8. Wire the slice in the composition root and register the route.
9. Write `.architecture` with the pinned decisions.
10. Write the enforcement configs per §16.
11. Write tests per §15, mirroring the slice, including the break-the-code
    verification for each.
12. Run the test command, the architecture check, the secret scan, and the
    mutation testing tool if available. Report actual output. If any fails, fix
    it before reporting. Do not report success on a red build.
13. Report: files created, the profile assumed, the commands to run, the
    correlation ID header name, the declared feature flags, and any assumption
    the user should confirm.

### Assumption ledger

Every inference the agent makes that the user did not state is written to
`.project-init-assumptions.md` at the project root. One line per assumption:

    ASSUMPTION: <what was assumed> | REASON: <why> | CONFIRM: <what the user
    should check>

Do not bury assumptions in prose in the final report. The file is the ledger.
The user reviews it and deletes it once confirmed. If there are no assumptions,
write "No assumptions." in the file.

### Message and input audit

For every form, endpoint, or interactive surface scaffolded:

1. List every input field and its validation rules.
2. List the worst-case value for each field and what the system does with it.
3. List every user-facing message and check it against the banned list.
4. List every empty state and confirm it has a message and an action.
5. Confirm every domain error has a user-facing rendering.
6. List every critical action and confirm each has a confirmation matching §13
   and a server-side audit log entry.

### Verification pass

After writing all files and before reporting:

1. Re-read every file written.
2. For each rule in this skill, check whether the output violates it.
3. Report violations found and fix them.
4. Re-run the test command and the architecture check.
5. Report actual output of both.

Do not report success on a red build. Do not report "tests should pass" without
having run them.

### Stop conditions

Stop and ask before proceeding when:

- The language or framework cannot be confidently identified.
- The repo is non-empty and its existing layout does not obviously map to the
  five layers.
- A required behavior was not specified and the default is not obvious.
- A security decision would need to be made that the user did not state.
- A target file already exists.
- A rule in this skill cannot be satisfied by the language or framework without
  a workaround.
- The agent is about to invent a domain rule, a default, or a policy.

Do not guess past a stop condition. Every guess is a defect the user has to find
later.

## 18. Adding an entity later

1. Read `.architecture` first and conform to it. Do not re-derive the layout.
2. Read one existing vertical slice and copy its exact shape and idioms.
3. Create the five files.
4. Wire into the composition root.
5. Add tests per §15, including the break-the-code verification.
6. Run the architecture check, the test command, and the secret scan. Report.

Do not invent a new pattern. Do not refactor unrelated files. Do not add a
dependency without asking.

## 19. Reject on sight

**Architecture**

- Logic in a router beyond parse, call, respond.
- A crud file importing another crud file or a service.
- An entity importing a framework or transport type.
- Raw SQL outside `crud/`.
- A service returning an ORM object across a layer boundary.
- A global mutable singleton.
- Two services importing each other.
- A file named `utils`, `helpers`, or `common`.
- A file outside the five-layer layout with no stated reason.
- A framework directory used as a substitute for the layout instead of
  alongside it.
- A layer skipped because the language "does not need it."
- A layer renamed to match a framework's vocabulary without confirmation.
- Two names for the same layer in the same project.

**Doing what does not belong**

- A service that fetches rows to filter, count, sort, paginate, or aggregate
  them in code instead of in the query.
- A loop that contains a query.
- A crud function that returns more data than the caller needs.
- A helper with one caller.
- An abstraction with one implementation.
- A config value that never varies.
- A wrapper that only forwards arguments.
- A generic built for a second use case that was not requested.
- A `try` block that only logs and re-raises.
- Dead code, unused exports, unreachable branches.
- Validation duplicated across schema and entity with no stated reason.
- Any behavior, default, or rule the user did not specify and that was not
  reported as an assumption.

**Naming and hygiene**

- Any emoji, decorative symbol, or ASCII art in code, logs, comments, or output.
- A banned standalone name from §4.
- Two synonyms for the same concept in the same codebase.
- A comment that restates the code below it.
- Commented-out code left in place.
- Code written down to an imaginary reader who does not know the language.

**Errors and messages**

- A generic error message in a log (`"operation failed"`) with no operation,
  entity, identifier, or correlation ID.
- A user-facing message containing any banned phrase from §10.
- A user-facing message that shows an internal ID, UUID, stack trace, or file
  path.
- A generic external error with no next step.
- An empty state that is a blank screen.
- A message that blames the user.
- A user-facing message with an error code but no human sentence.
- `catch {}`, `except: pass`, or any silently swallowed error.
- Logging a secret, token, password, or unnecessary PII.
- A domain error with no user-facing rendering.

**Security**

- A string-concatenated query, shell command, or HTML fragment.
- An authorization check in a router but not in the service.
- A security control, validation step, or rate limit gated behind a feature
  flag.
- Certificate validation disabled anywhere, including tests.
- A secret with no rotation path.
- A critical endpoint that trusts the client to have shown the confirmation
  modal.
- A critical action with no audit log entry.
- An irreversible action whose confirmation does not say it is irreversible.

**Resilience and flags**

- A circuit breaker around an in-process call.
- A fallback returning null or None instead of a typed result.
- An outbound call with no timeout.
- A flag read via `os.getenv` outside the config module.
- A feature flag with no documented removal condition.
- A flag that changes the meaning of another flag.

**Input and confirmation**

- A form field that accepts unbounded input.
- A string, number, or collection field with no stated min and max.
- A submit action that is not idempotent and has no double-submit protection.
- A critical action without a confirmation that names the object and the
  consequence.
- A confirmation that says "Are you sure?" with no detail.
- A confirmation whose confirm button is labeled "OK," "Yes," or "Confirm."
- A confirmation that can be bypassed by a double submit.
- An input path with no comment answering the three worst-case questions.

**Tests**

- A test that was not verified to fail when the code is broken.
- A test added to raise coverage.
- A test asserting on log strings or exact error wording.
- A test that mocks the thing under test.
- A test that would pass if the function body were empty.
- A test with a `pass` body.
- A commented-out test left in place.
- A dependency referenced but not verified to exist.
- An assumption not written to the assumption ledger.
- An assumption in the final report that is not in the ledger.
