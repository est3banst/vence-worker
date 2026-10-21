# vence-worker deploy

The narrow loop: test and deploy **only** this worker.

Run from the repo root (or anywhere — the play targets the implicit localhost,
so it needs no inventory):

```bash
ansible-playbook deploy/worker.yml                           # test, then deploy
ansible-playbook deploy/worker.yml --tags test               # tests only
ansible-playbook deploy/worker.yml -e apply_migrations=true  # migrations too
ansible-playbook deploy/worker.yml --check                   # dry run
```

It used to target a host from `inventory.ini`, which only loaded when the
working directory was `deploy/` — `ansible.cfg` is read from the working
directory, not from the playbook's. Run from anywhere else and the pattern
matched no hosts, which Ansible treats as a warning: the run exited 0 having
deployed nothing.

## Relationship to the full pipeline

`../../7vence/deploy/site.yml` is **authoritative**. It covers everything this
does, plus the web build and Pages upload, the mobile checks, and the
client/route parity check across both API clients. Use it to ship.

This playbook exists for the inner loop, when you are only touching the worker.
It deliberately leaves out:

- the web app entirely (no build, no Pages deploy)
- the mobile checks
- `check-api-parity.mjs`, which needs the web repo checked out

So it can go green while the web client has drifted from a route you changed.
Run the full pipeline before you consider a change shipped.

## Guards

Both block, rather than warn:

- **dirty worktree** — refuses to ship code that is in no commit (`-e allow_dirty=true` to override)
- **schema drift** — reads the live D1 table list and refuses to deploy code
  that queries a table the database does not have. This is the failure that is
  otherwise invisible: the bundle builds, the route answers, and every insert
  500s. Pair with `-e apply_migrations=true` to fix it in the same run.

Tests run before any deploy task and `any_errors_fatal` is on, so a red suite
cannot reach a deploy.

## Tags

Declared per task, never on an include — a tag on an include is added to every
task inside it, which is how an early version of the full pipeline deployed on a
`--tags test` run. Check a selection before trusting it:

```bash
ansible-playbook worker.yml --tags test --list-tasks   # must show no deploy task
```
