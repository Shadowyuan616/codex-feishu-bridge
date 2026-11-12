---
name: install-codex-feishu-bridge
description: Install, configure, and verify Codex Feishu Bridge on a user's development machine so a Feishu bot can control existing Codex sessions. Use for first installation, adding a machine, or repairing this bridge's setup; not for ordinary Codex tasks or generic Feishu automation.
---

# Install Codex Feishu Bridge

Deliver a working, privately configured bridge on the user's target development machine,
with verified Feishu input, output, fixed menus and persistent supervision.

Repository: https://github.com/Shadowyuan616/codex-feishu-bridge

## Locate the project and target

Use the user's existing checkout when available; otherwise clone the repository to an
appropriate target directory. This Skill may have been installed independently: its own
directory is not the bridge checkout. Read the checkout's `README.md` before executing
installation commands; it contains the maintained stages, permissions and CLI examples.

Reuse the user's specified SSH target, operating-system account, CLI profiles and project
directories. Discover existing setup read-only before asking for information. If still
missing, ask only for the target machine, allowed operator, project roots and suitable
local state storage. Do not infer a broad user or filesystem allowlist.

## Execute the installation

1. Read `docs/remote-preflight.md`. Check Node, Python, Codex and Feishu CLI paths,
   the actual daemon socket and the account owning existing sessions. Inspect service
   state without printing credentials or full process environments.
2. Build with `npm ci --ignore-scripts` and `npm run build`. Install only missing
   prerequisites. Do not upgrade an already running Codex service as an installation shortcut.
3. Follow README's daemon stage. Preserve active sessions and independent writers.
   Use the existing daemon/socket; only start a new daemon for an appropriate fresh setup.
4. Follow README's Feishu stage. Reuse the selected profile. For a new application,
   run the CLI's guided `config init --new --name ...`; return its official browser
   confirmation link to the user without requesting secrets in chat. The bridge uses bot
   identity; do not request unrelated user OAuth scopes.
5. Configure the three event/callback subscriptions and minimum scopes listed in README.
   Obtain the operator's open_id in this application through an authenticated private
   message or existing verified configuration; do not copy an ID from another application.
6. Use `npm run configure -- ...` to generate private files outside the checkout.
   Verify the selected state filesystem is suitable for SQLite WAL. Existing files are
   intentionally not overwritten; compare and update only within the user's requested scope.
7. Apply the generated individual menu file with the documented bot-menu API. Confirm
   four push-event entries and check the mobile floating layout. Preserve any existing
   menu unless replacement is part of the requested setup.
8. Run `--check-config`, then `--doctor`, then the foreground bridge. Follow
   `docs/acceptance.md` in a user-designated test session. Once verified, install one
   supervision option from `deploy/README.md`, using explicit paths and the same identity.

## Preserve the running environment

- Never kill a Codex process, restart the shared daemon, stop the shared Feishu event bus,
  widen model permissions, or overwrite shell/proxy/global Node configuration to finish setup.
- Keep App Secrets, tokens, user/app/chat/session IDs, runtime configuration, SQLite,
  logs and backup bundles out of Git and final reports. CLI credentials stay in the CLI's
  own storage. The generated config directory is 0700 and files are 0600.
- A configuration file can be on a persistent shared volume; an active SQLite WAL database
  cannot be assumed safe there. Worker crash recovery and machine-rebuild recovery are
  different checks. Do not describe nohup as a platform startup hook.
- For an existing deployment update, inspect pending approvals/instructions and take private
  backups before restarting only its bridge worker; follow `docs/operations.md`.
- User authorization to install covers ordinary setup work. Ask for a concrete missing
  authorization or browser/admin action only when the platform requires it, then continue
  independent setup. Do not equate elapsed waiting time with completed authorization.

## Verification and handoff

Verify all three consumers are ready, a real menu click reaches the selected session,
and a harmless test prompt receives the expected response in both Codex history and a
Feishu message read-back. Directory/session browsing must not resume or interrupt other
sessions. Use explicit test sessions for approval, steering and interrupt tests.

Run `npm run check`, `npm test`, and the Python supervisor tests when building or changing
code; a configuration-only repair can use relevant configuration and live checks.
Run `npm run privacy:check` before committing any setup changes.

Report what is installed, private configuration locations, the chosen supervision method,
and which live checks passed. Separate blocked user/browser steps or untested restart
boundaries from completed work. Never report fully connected solely because doctor or
simulated tests passed. Do not publish credentials or raw acceptance records.
