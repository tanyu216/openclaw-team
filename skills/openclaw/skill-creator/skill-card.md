## Description:

Guide for creating effective skills. This skill should be used when users want to create a new skill (or update an existing skill) that extends Claude's capabilities with specialized knowledge, workflows, or tool integrations.

This skill is ready for commercial/non-commercial use.

## Publisher:

[chindden](https://clawhub.ai/user/chindden)

### License/Terms of Use:

Apache 2.0

## Use Case:

Developers and skill authors use this skill to design, initialize, validate, package, and iterate on modular agent skills with concise instructions and supporting scripts or references.

### Deployment Geography for Use:

Global

## Known Risks and Mitigations:

Risk: The packaging helper can accidentally include sensitive local files through symlinks.

Mitigation: Review packaged contents before release, avoid packaging skill directories that contain symlinks, and run helper scripts in a sandbox or low-privilege workspace until the symlink and path-containment issues are fixed.

## Reference(s):

- [Output Patterns](references/output-patterns.md)
- [Workflow Patterns](references/workflows.md)

## Skill Output:

**Output Type(s):** [text, markdown, code, shell commands, configuration, guidance]

**Output Format:** [Markdown guidance with inline code blocks and generated skill files or shell commands when needed]

**Output Parameters:** [1D]

**Other Properties Related to Output:** [May produce or modify SKILL.md, reference documents, helper scripts, package files, and validation guidance.]

## Skill Version(s):

0.1.0 (source: server release metadata)

## Ethical Considerations:

Users should evaluate whether this skill is appropriate for their environment, review any generated or modified files before relying on them, and apply their organization's safety, security, and compliance requirements before deployment.
