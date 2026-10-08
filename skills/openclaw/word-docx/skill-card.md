## Description:

Create, inspect, and edit Microsoft Word documents and DOCX files while preserving styles, numbering, tracked changes, tables, sections, fields, and round-trip compatibility.

This skill is ready for commercial/non-commercial use.

## Publisher:

[ivangdavila](https://clawhub.ai/user/ivangdavila)

### License/Terms of Use:

MIT-0

## Use Case:

Developers, editors, and document-heavy teams use this skill to create, inspect, review, or modify Microsoft Word and DOCX files while preserving document structure and reducing formatting drift.

### Deployment Geography for Use:

Global

## Known Risks and Mitigations:

Risk: Word documents can contain tracked changes, comments, deleted text, legal text, or sensitive business content that may still exist in document internals.

Mitigation: Use the skill only with documents the user is comfortable letting an agent process, and review document metadata, comments, and revisions before sharing or delivering outputs.

Risk: OOXML edits can disrupt styles, numbering, fields, bookmarks, headers, footers, tables, or layout across Word, LibreOffice, Google Docs, and conversion tools.

Mitigation: Prefer structure-preserving edits, make minimal replacements in review workflows, and perform round-trip compatibility checks when layout or references matter.

Risk: DOCM files may contain macros and legacy DOC files may need conversion before DOCX assumptions are reliable.

Mitigation: Treat macro-bearing and legacy files as higher risk, avoid executing macros, and convert or inspect them with appropriate tooling before making DOCX-specific edits.

## Reference(s):

- [Word / DOCX ClawHub listing](https://clawhub.ai/ivangdavila/skills/word-docx)
- [Word / DOCX homepage](https://clawic.com/skills/word-docx)

## Skill Output:

**Output Type(s):** [text, markdown, code, shell commands, configuration, guidance, files]

**Output Format:** [Markdown or text guidance, often with code or shell command snippets]

**Output Parameters:** [1D]

**Other Properties Related to Output:** [May guide creation, inspection, repair, or compatibility checks for Word and DOCX artifacts.]

## Skill Version(s):

1.0.2 (source: server release and frontmatter)

## Ethical Considerations:

Users should evaluate whether this skill is appropriate for their environment, review any generated or modified files before relying on them, and apply their organization's safety, security, and compliance requirements before deployment.
