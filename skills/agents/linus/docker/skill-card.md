## Description:

Builds, debugs, hardens, and ships Docker containers, images, Compose stacks, and CI build steps, covering common container failures, networking, storage, registry, runtime, and security issues.

This skill is ready for commercial/non-commercial use.

## Publisher:

[ivangdavila](https://clawhub.ai/user/ivangdavila)

### License/Terms of Use:

MIT-0

## Use Case:

Developers and engineers use this skill to create, review, debug, harden, and operate Dockerfiles, Compose stacks, container images, registry workflows, and CI build steps. It is not intended for Kubernetes manifests or cluster scheduling.

### Deployment Geography for Use:

Global

## Known Risks and Mitigations:

Risk: Docker command execution can have host-level impact.

Mitigation: Review proposed Docker commands before execution, especially commands that mount host paths, alter the daemon, use privileged access, or delete containers, images, networks, or volumes.

Risk: Diagnostic output and pasted configuration can contain credentials, tokens, connection strings, or private keys.

Mitigation: Use redacted inspection output and store only secret pointers such as environment variable names, credential helper names, or file locations.

Risk: Debug ports and published service ports can expose sensitive interfaces when bound broadly.

Mitigation: Bind debug and administrative ports to localhost unless a secured tunnel or trusted network is explicitly in place.

Risk: Destructive cleanup or reset commands can remove named volumes and unrecoverable data.

Mitigation: Require explicit confirmation and name the affected resources before running prune, volume removal, or compose down commands with volume deletion.

## Reference(s):

- [ClawHub Docker skill page](https://clawhub.ai/ivangdavila/skills/docker)
- [Clawic Docker skill page](https://clawic.com/skills/docker)
- [Docker skill source](artifact/SKILL.md)
- [Security guidance](artifact/security.md)
- [Command reference](artifact/commands.md)

## Skill Output:

**Output Type(s):** [text, markdown, code, shell commands, configuration, guidance]

**Output Format:** [Markdown with inline code blocks and configuration snippets]

**Output Parameters:** [1D]

**Other Properties Related to Output:** [May include Dockerfiles, Compose YAML, daemon configuration, runbooks, diagnostic command sequences, and risk-focused review notes.]

## Skill Version(s):

1.0.10 (source: server release evidence and frontmatter)

## Ethical Considerations:

Users should evaluate whether this skill is appropriate for their environment, review any generated or modified files before relying on them, and apply their organization's safety, security, and compliance requirements before deployment.
