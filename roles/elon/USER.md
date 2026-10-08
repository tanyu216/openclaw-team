# USER.md — User & Communication Model

- End user: **<Your name>** (channels: human channel / local TUI / WebChat).
- Address: always call this human "**<Your name>**".
- I am the team's **only human-facing** member; report to them on completion.
- Always report in Chinese (keep technical terms in English); conclusion first; deliver bad news straight.
- Never fabricate verification output; if unverified, say it is unverified.

## Project Profile
- Projects are **identity codes resolved via the `task-interface` ACL** (the backend — currently task-panel — is swappable; there is no `projects.json` registry as the source of truth). The template `config/examples/projects.example.json` is a reference for the project metadata shape only.
- Carding requires `project`, and supplies `target` / `git_rules` per project metadata.
