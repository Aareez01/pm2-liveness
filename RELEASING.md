# Releasing

## Before the first publish

1. **Create the GitHub repository**, then set the URL fields — they are deliberately
   absent rather than guessed, because a wrong URL in published metadata is worse than
   none:

   ```bash
   npm pkg set repository.type=git \
     repository.url="git+https://github.com/<org>/pm2-liveness.git" \
     bugs.url="https://github.com/<org>/pm2-liveness/issues" \
     homepage="https://github.com/<org>/pm2-liveness#readme"
   ```

2. **Confirm the author field.** It is currently `Aareez01`, taken from the git identity
   used for these commits (`aareez@hypremia.com`), which differs from the account this
   work was done under. Change it if that is not the identity you want published.

3. `npm login` as the account that should own the package.

## Every release

```bash
npm ci
npm run build
npm test                   # unit
npm run test:integration   # needs a short PM2_HOME; see below
npm pack --dry-run         # check what actually ships
```

Then:

```bash
npm version <patch|minor|major>
npm publish                # publishConfig.access is already public
git push && git push --tags
```

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
- [ ] The suite lab (`pm2-ops-contract/lab`) passes — it is the only thing that exercises
      this module the way a user installs it, through `pm2 install`
- [ ] Repository/bugs/homepage set (first publish only)
