# Integration tests

Tests that need a real PostgreSQL. They do not run with `pnpm test`, and
nothing in CI runs them today.

## Why they exist separately

`lib/billing/transition.test.ts` checks the transition layer against a fake
client: the order of its steps, which branch writes what, which refusal it
returns. What it cannot check is what two transactions do when they reach the
same unique index at the same moment — a mock has no unique index and no
transactions. That is the question a billing webhook depends on, because
providers redeliver and deliveries overlap, so it is asked here against a real
server.

## Running them

You need a disposable PostgreSQL. Production runs **18.x**, so use 18 here; the
`compose.yaml` database is 17 and is for `pnpm dev`, not for this.

```sh
docker run -d --name billing-test-db \
  -e POSTGRES_USER=billingtest \
  -e POSTGRES_PASSWORD=billingtest \
  -e POSTGRES_DB=billing_test \
  -p 55432:5432 postgres:18
```

Create the schema with the real migration chain — the suite refuses to run
against hand-made tables, and checks the billing constraints before its first
case:

```sh
BILLING_TEST_DATABASE_URL=postgresql://billingtest:billingtest@localhost:55432/billing_test \
  pnpm exec prisma migrate deploy
```

`prisma migrate deploy` reads `DATABASE_URL`, so pass it that way for this one
command, or export `DATABASE_URL` in a shell you will not use for anything else.

Then:

```sh
BILLING_TEST_DATABASE_URL=postgresql://billingtest:billingtest@localhost:55432/billing_test \
  pnpm test:billing:postgres
```

Afterwards, throw the database away:

```sh
docker rm -f billing-test-db
```

## Never point them at production

These tests write. They create accounts, subscriptions, usage periods and
billing events, and they delete rows between cases.

- The URL comes from `BILLING_TEST_DATABASE_URL` and from nowhere else. There
  is deliberately **no fallback to `DATABASE_URL`**, which is set wherever the
  application runs.
- `integration/test-database.ts` inspects the URL before anything connects. It
  refuses hosted-provider hostnames outright, and what remains must either be on
  this machine or be a database whose name says it is for testing.
- The variable's name is not the safety. Setting it to a production URL is
  still refused.

## Adding one

Name the file `*.integration.ts`, not `*.test.ts`. Default Vitest discovery
matches the second and not the first, which is what keeps `pnpm test` free of a
database dependency.
