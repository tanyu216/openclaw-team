## Description:

Skill Vetter helps agents review third-party skills before installation by checking source trust, permission scope, red flags, and suspicious behavior.

This skill is ready for commercial/non-commercial use.

## Publisher:

[spclaudehome](https://clawhub.ai/user/spclaudehome)

### License/Terms of Use:


## Use Case:

Developers and agent operators use this skill to vet skills from ClawHub, GitHub, or other sources before installation or execution. It guides source checks, full file review, permission review, risk classification, and a final install recommendation.

### Deployment Geography for Use:

Global

## Known Risks and Mitigations:

Risk: For GitHub-hosted skills, the skill may lead an agent to fetch public repository metadata and skill files from GitHub.

Mitigation: Run those checks only for sources the user intends to evaluate, and avoid submitting private or sensitive repository information.

Risk: The skill provides review guidance and a verdict, but an agent may still miss subtle malicious behavior or misleading metadata.

Mitigation: Use the report as a checklist, review all skill files before installation, and require human approval for high-risk findings such as credential access, destructive commands, or elevated permissions.

## Reference(s):

- [Skill Vetter ClawHub page](https://clawhub.ai/spclaudehome/skills/skill-vetter)
- [Publisher profile](https://clawhub.ai/user/spclaudehome)

## Skill Output:

**Output Type(s):** [guidance, markdown, shell commands]

**Output Format:** [Markdown report with checklist guidance and optional shell command examples]

**Output Parameters:** [1D]

**Other Properties Related to Output:** [Produces a structured skill vetting report with red flags, permissions, risk level, verdict, and notes.]

## Skill Version(s):

1.0.0 (source: frontmatter and server release metadata)

## Ethical Considerations:

Users should evaluate whether this skill is appropriate for their environment, review any generated or modified files before relying on them, and apply their organization's safety, security, and compliance requirements before deployment.
