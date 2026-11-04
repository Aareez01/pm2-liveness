# Releasing

## Before the first publish

1. ~~Create the GitHub repository and set the URL fields~~ - **done.** The repository,
   bugs and homepage fields point at `github.com/Aareez01/pm2-liveness`. They were left
   absent until the repo existed, because a wrong URL in published metadata is worse
   than none. For reference, the command was:

   ```bash
   npm pkg set repository.type=git \
     repository.url="git+https://github.com/Aareez01/pm2-liveness.git" \
     bugs.url="https://github.com/Aareez01/pm2-liveness/issues" \
     homepage="https://github.com/Aareez01/pm2-liveness#readme"
   ```

2. **Confirm the author field.** It is currently `Aareez01`, taken from the git identity
   used for these commits. Change it if that is not the identity you want published.

3. `npm login` as the account that should own the package.

## Every release

Publishing happens in CI, not from a laptop. Pushing a `v*` tag runs
[`.github/workflows/release.yml`](./.github/workflows/release.yml), which builds, tests
and publishes with **provenance** - a signed attestation linking the tarball on npm back
to the commit it was built from. A hand-published package carries no such link: the
registry signs what it receives, which proves only that storage did not tamper with it.

```bash
npm ci
npm run build
npm test
npm pack --dry-run         # check what actually ships

npm version <patch|minor|major>
git push && git push --tags      # the tag is what triggers the publish
```

The workflow refuses to publish if the tag disagrees with `package.json`, or if the
version is already on the registry. npm versions are immutable once taken, so both
checks are cheaper than the mistake.

### One-time setup per package

Trusted publishing must be enabled on npmjs.com before the first CI publish, or the job
fails to authenticate:

1. npmjs.com -> the package -> **Settings** -> **Trusted Publisher**
2. Publisher: **GitHub Actions**
3. Organization or user: `Aareez01`, Repository: this repo
4. Workflow filename: `release.yml` (no path, just the filename)
5. Environment: leave blank

There is deliberately no `NODE_AUTH_TOKEN`. Authentication is a short-lived OIDC
exchange, so there is no long-lived credential in the repository to steal - which is the
point of doing it this way rather than storing a publish token.

## PM2_HOME must be short

PM2 binds `$PM2_HOME/rpc.sock`, and Linux caps unix socket paths at 107 characters. Over
that, the bind fails **silently**: no socket is created, every `pm2` command blocks
forever, and the orphaned daemon spins at 100% CPU. CI runners and containers are the
usual places this bites.

```bash
echo -n "$PM2_HOME/rpc.sock" | wc -c   # must be < 107
```

## Checklist

- [ ] `CHANGELOG.md` updated, version bumped
- [ ] `npm pack --dry-run` contains `dist/`, `README.md`, `LICENSE` and nothing else
- [ ] Unit **and** integration tests pass locally
- [ ] The suite lab (`pm2-ops-contract/lab`) passes - it is the only thing that exercises
      this module the way a user installs it, through `pm2 install`
- [ ] Trusted publishing configured on npmjs.com (first publish only)
- [ ] Repository/bugs/homepage set (first publish only)
- [ ] After the tag lands: the npm page shows a provenance attestation
