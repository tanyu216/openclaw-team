# Jobs Tool Discipline & Prototype Stack (role-owned)

> Method home for the Tool Discipline section of `roles/jobs/AGENTS.md`. Load it before
> producing any design artifact; it carries the carrier routing, redlines and the closed prototype stack.

## Tool Discipline (mandatory, no detours)
> **Redlines (routed by carrier)**:
> - **MCP design-tool path**: any output of a design draft / PRD / plan / DESIGN.md / runnable prototype (**MCP design-tool carrier**) **must be produced via that MCP tool + this workspace's companion skills; native tools like exec/edit/apply_patch may not hand-write design artifacts**; Jobs hand-writing = overstepping/short-circuit.
> - **HTML path**: Jobs **may not use exec/edit to hand-write HTML/CSS/JS prototype code**; must ① produce a "detailed design requirements spec" (design-spec.md), ② **spawn Claude Code** to code per spec (Claude Code only edits code, takes no part in design; **closed tech stack = Tailwind CSS + daisyUI + jQuery, JS interactions must use jQuery; the 3D exception is three.js**), ③ Jobs verifies & reviews. Jobs hand-writing HTML/JS = overstepping/short-circuit.
> - **Image-design path**: Jobs **may not use exec/edit to directly produce images/drawing scripts**; must ① produce a "visual design brief" (image-brief.md), ② **spawn Claude Code** to produce images with the `canvas-design` skill (.png/.pdf + design-philosophy .md), ③ Jobs reviews. Jobs producing images directly = overstepping/short-circuit.
> - **Product design documents**: Jobs **may not hand-write product design documents himself** (must go via a Claude Code sub-session), and **the final document must be reviewed and confirmed by Elon** before it can serve as downstream input.
> The only exception: non-production actions (reading files, running commands, browser interaction certification, writing the "issue list"/Report/heartbeat, creating directories, writing design-spec.md) may be done directly with exec.

**Why the MCP design tool is mandatory**: it lands design in a real, renderable carrier (not prose) and makes "minimalist aesthetics" executable rules; deliverables are traceable (design-tool link or exported file); production (MCP) stays separated from Jobs's personal browser review (screenshots/click flow/key states) — neither oversteps; versions/history allow rolling back each revision round.

> **Tool scope**:
> - **MCP design-tool path**: always via that MCP tool (OpenClaw's MCP, configured in `mcp.servers` of `~/.openclaw/openclaw.json`); **do not spawn Claude Code/Codex**.
> - **HTML path**: **allowed and required** to spawn a **Claude Code** sub-session (only for HTML/JS code editing); orchestration discipline same as Linus (`claude-sessions.json`, concurrency <8, normalized cwd, output to files, poll to terminal state). **Codex is still outside Jobs's tool scope.**

### Prototype Tech-Stack Spec (long-term)
0. **Closed tech stack (mandatory)**: **the HTML high-fidelity prototype's tech stack is limited to the trio `Tailwind CSS` (styling) + `daisyUI` (components) + `jQuery` (interaction)** — **introducing any other CSS framework / UI component library / JS framework is forbidden** (e.g. Bootstrap, Element Plus, Vue/React, other in-house state libraries); **the only exception: `three.js` may be introduced for 3D scenes** (3D rendering only, **not to replace the trio**). If an exception stack is truly needed ⇒ **state the reason in the card and get Elon's approval**.
   > ⚠️ **Scope**: this clause **constrains only "Jobs's prototype design artifacts"** (HTML high-fidelity prototype = design deliverable); **it does not limit engineering implementation (Linus's real frontend/other implementations)** — that stack is set by project engineering definitions.
1. **The prototype must strictly use `Tailwind CSS` + `daisyUI`** (HTML path) — **forbidden** to use the old `base.css` / `styles.css` class systems (retired after migration); utility classes carry styling only.
2. **Interaction JS (jQuery mandatory)**: when building the **HTML high-fidelity prototype**, any JS interaction **must use `jQuery`** — replacing raw DOM manipulation; **forbidden** to use raw `document.querySelector`/`addEventListener` etc. (unless jQuery cannot express it and the reason is stated in writing).
3. **Hooks decoupled from styles (hard constraint)**: selectors that JS/tests depend on **use `data-*` semantic hooks** (e.g. `[data-rp-section]`), **never Tailwind class names** ⇒ prevent "class rename breaks JS/tests".
4. **Contract**: the prototype and the real frontend **share Tailwind theme tokens** (e.g. `--accent` #ecb206); the prototype's style source = build output (e.g. `tw.css`), not a CDN.
5. **Fidelity**: based on "structure (id/role/data-*) + tokens + key geometry", not class names (see the TW migration M1 convention).
