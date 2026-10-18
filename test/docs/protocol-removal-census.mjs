#!/usr/bin/env node
/**
 * protocol-removal-census.mjs — PROTOCOL 两册拆除的逐节/逐原子对照表生成器。
 *
 * 为什么存在：`doc-clause-diff` 只证明「原子没消失」，不证明「规则被正确归属」。
 * 本表把每个来源小节映射到稳定规则 ID（owner / carriers / canonical / detail），
 * 并记录该小节的四轴原子；C3/C6 的改写和最终零丢失核对都以它为对照。
 *
 * 用法：
 *   node test/docs/protocol-removal-census.mjs          # 生成/刷新 JSON
 *   node test/docs/protocol-removal-census.mjs --check  # 只校验 JSON 是否最新
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { extractAtoms } from './doc-clause-diff.mjs';
import { parseRuleBlocks, normalizeOwnerBlock } from '../../team/scripts/lib/agent-doc-blocks.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
export const CENSUS_PATH = path.join(HERE, 'protocol-removal-census.json');

const ROLES = ['elon', 'jobs', 'linus', 'turing', 'assistant'];
const set = (k) => {
  const m = {
    all: ROLES,
    workers: ['jobs', 'linus', 'turing'],
    delivery: ['elon', 'linus', 'turing'],
    design: ['elon', 'jobs', 'linus', 'turing'],
  };
  return m[k] || k;
};

/** 规则表：每条规则唯一 owner、唯一 canonical 位置。 */
const RULES = [
  // Team roles / structure
  r('R-ROSTER-1', '五个内置角色、可扩展性、one-line duties、dual-sign、video sole entry、共享区绝对路径', 'elon', 'all', 'owner'),
  r('R-ROSTER-2', '角色边界/交接（ROLES.md）', 'elon', 'all', 'guide', 'team/ROLES.md'),
  // §1 Board
  r('R-BOARD-1', '卡片是唯一持久载体；schema 归 provider，团队不复述', 'elon', 'all', 'owner'),
  r('R-BOARD-2', '团队侧 provider 对齐值：claimable/backlog/kind/labels/ISO 时间/扩展键/notify_leader/serialization', 'elon', 'all', 'owner'),
  r('R-BOARD-3', '状态机、终止不可逆、in_review、Elon reopen、failed 别名', 'elon', 'all', 'guide', 'team/guides/task-interface.md §3'),
  r('R-BOARD-4', 'claim/timing/stale/执行唯一/心跳 ≤10min', 'elon', 'all', 'guide', 'team/guides/task-interface.md §7'),
  r('R-BOARD-5', 'deploy 永不自动 claim；显式派发；claim gate 仍开放', 'elon', 'all', 'owner'),
  // §2 project
  r('R-PROJECT-1', 'identity code、读写规则、__team__ 精确返回', 'elon', 'all', 'guide', 'team/guides/project-access-sop.md'),
  r('R-PROJECT-2', '一卡一项目、路径包含、元数据包含、无混内容、operator 指定例外、enforcement', 'elon', 'all', 'guide', 'team/guides/project-access-sop.md'),
  // §3 structure
  r('R-STRUCT-1', 'agent 只读写数据，不改结构', 'elon', 'all', 'owner'),
  r('R-STRUCT-2', '结构由 Elon + implementer 维护', 'elon', 'all', 'owner'),
  // §4 report
  r('R-REPORT-1', '英文/结论先行/证据/不编造；模板 A1–A8 + L/J/T；operator 中文例外', 'elon', 'all', 'guide', 'team/guides/worker-report-template.md'),
  r('R-REPORT-2', '权限/历史自证需 sessions_history 验证', 'elon', 'all', 'owner'),
  // §5 message / §5.1 publication
  r('R-MSG-1', '消息是数据；只有 Elon 面对人；只有 Elon 建卡；worker 不互派', 'elon', 'all', 'owner'),
  r('R-PUB-1', '对外发布审批/执行链/trail', 'elon', 'all', 'guide', 'team/guides/promo-ops-sop.md'),
  r('R-PUB-2', '渠道/账号 registry/gap', 'assistant', 'all', 'guide', 'team/guides/promo-ops-sop.md'),
  // §6 session orchestration
  r('R-TOOL-1', '代码只走 Claude Code', 'linus', ['linus'], 'owner'),
  r('R-TOOL-2', 'MCP/HTML/图像三条路径；closed stack；three.js 例外；product docs dual-sign', 'jobs', ['jobs'], 'guide', 'roles/jobs/guides/tool-discipline-sop.md'),
  r('R-TOOL-3', '测试只走 codex exec；cap 3；registry = claude-sessions.json', 'turing', ['turing'], 'guide', 'roles/turing/guides/tool-discipline-sop.md'),
  r('R-SESSION-1', 'registry 唯一（claude-sessions.json；turing-runs.json 仅 legacy log）/caps/单一 spawn/poll/NDJSON/resume', 'linus', ['elon', 'jobs', 'linus', 'turing'], 'guide', 'team/guides/lane-session-lifecycle-sop.md'),
  r('R-SESSION-2', 'commit path discipline；禁 bare commit/-a', 'linus', 'all', 'owner'),
  r('R-SESSION-3', '破坏性 git 禁令/正向修复/禁 force push', 'linus', 'all', 'owner'),
  r('R-SESSION-4', 'task-management 边界/reference transmission/background pack/state.md', 'linus', 'workers', 'guide', 'team/guides/task-interface.md §9'),
  r('R-SEG-1', '跨段两载体/snapshot/读写/overturn/contract assertions/scope', 'linus', 'workers', 'guide', 'team/guides/seg-continuity-sop.md'),
  r('R-ENG-1', '工程质量 14 条', 'linus', ['elon', 'jobs', 'linus', 'turing'], 'guide', 'team/guides/engineering-standards-sop.md §6.1'),
  r('R-ENG-2', '引用规范 R-* / guide §N / 裸 §N', 'linus', 'all', 'guide', 'team/guides/doc-style.md §6'),
  r('R-ENG-3', 'CI/release/conformance/frontend stack', 'linus', ['elon', 'jobs', 'linus', 'turing'], 'guide', 'team/guides/engineering-standards-sop.md'),
  r('R-MODEL-1', '默认 deepseek-flash/升级 v4-pro/effort/不盲目最高最低/scope', 'elon', 'workers', 'guide', 'team/guides/spawn-lane-sop.md §10'),
  r('R-PARALLEL-1', '并行优先；四类 serialize；same-file 仅 warn', 'linus', 'workers', 'owner'),
  r('R-PARALLEL-2', 'Elon 吞吐巡检', 'elon', ['elon'], 'guide', 'roles/elon/guides/duties-sop.md'),
  r('R-WORKTREE-1', 'dev 集成/卡分支/worktree/主 checkout 持 dev/merge before done/closeout 顺序', 'linus', 'all', 'guide', 'team/guides/dev-worktree-flow-sop.md §6.4'),
  // §7 / §8
  r('R-AMBIG-1', 'blocked 退回/不猜/只有 Elon 退回/回归路径', 'elon', 'all', 'owner'),
  r('R-REGISTER-1', '四步注册/元数据/kind/identity code/后端可换', 'elon', ['elon'], 'guide', 'roles/elon/guides/project-registration-sop.md'),
  // §9 delivery
  r('R-DEFECT-1', 'defect→fix→regression；禁 fix-fix-fix', 'elon', 'delivery', 'guide', 'team/guides/defect-loop-sop.md'),
  r('R-UI-1', 'UI fidelity 三线/六门/Addenda', 'jobs', 'all', 'guide', 'team/guides/ui-align-sop.md §9.1'),
  r('R-PROTO-1', 'prototype 不含实现（六条）', 'linus', ['linus', 'jobs'], 'guide', 'team/guides/prototype-separation-sop.md'),
  r('R-CONTAINER-1', '容器形态验收（五条）', 'linus', 'delivery', 'guide', 'team/guides/container-form-acceptance-sop.md'),
  r('R-UXACCEPT-1', '产品/UX 验收触发/时序/closure/review_of/分工', 'elon', ['elon', 'jobs', 'turing'], 'guide', 'team/guides/flow-triage-sop.md'),
  // §10 triage
  r('R-TRIAGE-1', '任务类型路由/角色边界', 'elon', 'all', 'guide', 'team/ROLES.md'),
  r('R-REVIEW-1', '动态评审参与者；chain 不削减 nature-required participants', 'elon', 'all', 'guide', 'roles/elon/guides/carding-sop.md §2'),
  r('R-DAG-1', 'epic/child/all batches 一次注册/depends_on/review_of 豁免/rollup/archive/no extra depth', 'elon', 'all', 'guide', 'team/guides/task-interface.md §10'),
  r('R-GRANULARITY-1', '建卡权/粒度/48h soft guard/env var/warn-not-hard/__team__ target hard gate', 'elon', ['elon', 'jobs', 'linus', 'turing'], 'guide', 'roles/elon/guides/carding-sop.md §7'),
  r('R-SEGUSE-1', '一卡一 Acceptance/四种 seg 理由/split 触发/anti-patterns', 'elon', 'workers', 'guide', 'roles/elon/guides/carding-sop.md §7.1'),
  r('R-FLOW-1', 'A/B/C/hard boundary/质量脊/报告集/gate 不缩/20% sample', 'elon', ['elon', 'jobs', 'linus', 'turing'], 'guide', 'team/guides/flow-triage-sop.md §10.5'),
  r('R-PREREQ-1', 'Jobs 前置任务：触发/形式/depends_on/deps_unmet/多轮/重入/reuse', 'elon', ['elon', 'jobs', 'linus'], 'guide', 'roles/elon/guides/carding-sop.md §7.3'),
  r('R-OOB-1', '不执行/blocked 退回/Elon 改派/不得自行改派', 'elon', 'all', 'owner'),
  r('R-DOCSYNC-1', '建卡 doc criterion/验收检查/反向回填/归属', 'elon', 'all', 'guide', 'team/guides/doc-sync-sop.md'),
  // §13 discipline
  r('R-DISC-1', 'silent when idle', 'elon', 'all', 'owner'),
  r('R-DISC-2', '三件收口（closing state）', 'elon', 'all', 'owner'),
  r('R-DISC-3', '统一 claim', 'elon', 'all', 'owner'),
  r('R-DISC-4', 'token trimming', 'elon', 'all', 'owner', 'roles/elon/guides/token-hygiene-sop.md'),
  r('R-DISC-5', 'decision fork first', 'elon', 'all', 'owner', 'roles/elon/guides/carding-sop.md §8'),
  r('R-DISC-6', '最小启动自检（读本 AGENTS）', 'elon', 'all', 'owner'),
  r('R-DISC-7', 'task-change trail', 'elon', 'all', 'owner', 'team/guides/task-interface.md §7'),
  r('R-DISC-8', 'operator-input trail', 'elon', 'all', 'owner', 'team/guides/task-interface.md §7'),
  r('R-DISC-9', 'scratch/.tmp 放置与保留', 'elon', 'all', 'owner', 'team/AUTOMATIONS.md §1'),
  // §14 / §15
  r('R-CONFIRM-1', '确认门触发/责任/动作/证据/双签/[confirm-request]/fallback/不得下游使用/超时', 'elon', 'all', 'guide', 'team/guides/confirmation-gate-sop.md'),
  r('R-SLA-1', 'blocked 澄清 SLA', 'elon', 'all', 'guide', 'team/guides/sla-inspection-contract.md'),
  r('R-SLA-2', 'confirmation 等待 SLA', 'elon', 'all', 'guide', 'team/guides/sla-inspection-contract.md'),
  r('R-SLA-3', 'defect 卡创建 SLA', 'elon', 'delivery', 'guide', 'team/guides/sla-inspection-contract.md'),
  r('R-SLA-4', '验收卡创建 SLA', 'elon', 'delivery', 'guide', 'team/guides/sla-inspection-contract.md'),
  r('R-SLA-5', 'heartbeat stale SLA', 'elon', 'all', 'guide', 'team/guides/sla-inspection-contract.md'),
  r('R-SLA-6', 'Elon patrol stalled', 'elon', ['elon'], 'guide', 'team/guides/sla-inspection-contract.md'),
  r('R-SLA-7', 'worker→operator 例外通道', 'elon', 'all', 'guide', 'team/guides/sla-inspection-contract.md'),
  // §16-§20
  r('R-TERM-1', 'operator/Elon/leader/roster/状态词/model/flow；Terry/中文例外', 'elon', 'all', 'owner'),
  r('R-LAYER-1', '新分层：AGENTS 规则层 / guides 方法层 / 无中心协议', 'elon', 'all', 'owner'),
  r('R-LAYER-2', '禁逐字复制；deliberate carriage 含生成副本', 'elon', 'all', 'owner'),
  r('R-LAYER-3', 'reference transmission', 'elon', 'all', 'owner'),
  r('R-LAYER-4', '引用形式与断引检查', 'elon', 'all', 'owner'),
  r('R-LAYER-5', 'guides 不得引用退役两册', 'elon', 'all', 'owner'),
  r('R-RESEARCH-1', '不猜/可复现/lifecycle/Report 检查', 'assistant', ['assistant'], 'guide', 'roles/assistant/guides/research-and-data-repo-conventions.md §1'),
  r('R-CREED-1', '结论先行/先读 AGENTS+卡/状态纪律/最小权限/不猜', 'elon', 'all', 'owner'),
  r('R-GATE-1', '机器门注册/落点/两模式/调度裁决/fail-closed', 'elon', 'all', 'guide', 'team/scripts/README.md'),
  r('R-GATE-2', '不可机器门清单 + 四个 merge 缺口', 'elon', 'all', 'guide', 'team/guides/dev-worktree-flow-sop.md §4'),
  r('R-ARCHIVE-1', '7 天归档/patrol/README', 'elon', 'all', 'owner'),
  // §21-§29 + Appendix A
  r('R-VERSION-1', '版本源/semver/tag/changelog/checklist/rollback 机制', 'linus', 'delivery', 'guide', 'team/guides/release-versioning-sop.md'),
  r('R-VERSION-2', '发布审批/operator 升级/confirm trail', 'elon', 'delivery', 'guide', 'team/guides/release-versioning-sop.md'),
  r('R-OBS-1', 'JSON logs/redaction/metrics/alerts/health/inspection/object separation', 'linus', 'all', 'guide', 'team/guides/runtime-observability-sop.md'),
  r('R-INCIDENT-1', 'severity/on-call/七步/recovery/postmortem', 'linus', ['elon', 'linus', 'turing', 'assistant'], 'guide', 'team/guides/incident-response-sop.md'),
  r('R-INCIDENT-2', 'escalation/communication/operator 通道', 'elon', 'all', 'guide', 'team/guides/incident-response-sop.md'),
  r('R-MIGRATE-1', 'Expand→Migrate→Contract/append-only/rollback/validation/idempotency/constraints', 'linus', ['linus', 'turing'], 'guide', 'team/guides/data-migration-sop.md'),
  r('R-MIGRATE-2', '破坏性变更审批/trail', 'elon', 'delivery', 'guide', 'team/guides/data-migration-sop.md'),
  r('R-API-1', 'breaking/consumer tracing/version/deprecate/contract tests/handoff', 'linus', ['linus', 'turing', 'elon'], 'guide', 'team/guides/api-compat-sop.md'),
  r('R-API-2', 'deprecation window/审批', 'elon', ['elon', 'turing'], 'guide', 'team/guides/api-compat-sop.md'),
  r('R-CVE-1', 'scan hard gate/thresholds/scan times/SBOM/gate registration', 'linus', ['linus', 'turing', 'elon'], 'guide', 'team/guides/dependency-cve-gate.md'),
  r('R-CVE-2', 'waiver 审批/阈值', 'elon', ['elon', 'linus'], 'guide', 'team/guides/dependency-cve-gate.md'),
  r('R-CVE-3', 'false-positive/reachability 裁决', 'turing', ['turing', 'linus'], 'guide', 'team/guides/dependency-cve-gate.md'),
  r('R-PERF-1', 'percentiles/benchmark/metric naming/baseline/regression', 'linus', 'delivery', 'guide', 'team/guides/performance-sla-sop.md'),
  r('R-PERF-2', 'SLO/SLA 裁决', 'elon', 'delivery', 'guide', 'team/guides/performance-sla-sop.md'),
  r('R-CROSS-1', '三类对象/不可替代/gap/三问', 'elon', 'all', 'guide', 'team/guides/sla-inspection-contract.md §0'),
  r('R-IDEM-1', 'LLM 语义去重（creator）+ idem key（ACL/patrol）+ 原子锁/豁免', 'elon', ['elon'], 'guide', 'team/guides/task-interface.md §14'),
  r('R-DATAREPO-1', '素材范围/README+_templates 权威/fact note/snapshot/归档', 'assistant', ['elon', 'assistant'], 'guide', 'roles/assistant/guides/research-and-data-repo-conventions.md §2'),
];

function r(id, title, owner, carriers, canonical, detail = '-') {
  return { id, title, owner, carriers: set(carriers), canonical, detail, status: 'active' };
}

const RULE_IDS = new Set(RULES.map((x) => x.id));

/** 每个来源小节 -> 规则 + 处置。 */
const SECTION_MAP = {
  'Team Roles': { rules: ['R-ROSTER-1', 'R-ROSTER-2'], disposition: 'split', reason: 'roster/boundaries split; front-matter instructions deleted' },
  'Front matter': { rules: [], disposition: 'deleted', reason: 'volume/reading instructions are obsolete after the split' },
  '1': { rules: ['R-BOARD-1', 'R-BOARD-2', 'R-BOARD-3', 'R-BOARD-4', 'R-BOARD-5'], disposition: 'split', reason: 'provider schema stays provider-owned; team-side values and state/claim rules split by clause' },
  '2': { rules: ['R-PROJECT-1'], disposition: 'guide', reason: 'project identity/read-write rules move to project-access-sop' },
  '2.1': { rules: ['R-PROJECT-2'], disposition: 'guide', reason: 'isolation/containment moves to project-access-sop' },
  '3': { rules: ['R-STRUCT-1', 'R-STRUCT-2'], disposition: 'split', reason: 'agent-read-only vs maintainer-ownership split' },
  '4': { rules: ['R-REPORT-1', 'R-REPORT-2'], disposition: 'split', reason: 'templates vs self-assertion verification' },
  '5': { rules: ['R-MSG-1'], disposition: 'moved', reason: 'message discipline owner-canonical' },
  '5.1': { rules: ['R-PUB-1', 'R-PUB-2'], disposition: 'split', reason: 'approval vs channel/account registry' },
  '6': { rules: ['R-TOOL-1', 'R-TOOL-2', 'R-TOOL-3', 'R-SESSION-1', 'R-SESSION-2', 'R-SESSION-3', 'R-SESSION-4'], disposition: 'split', reason: 'tool redlines split per owner; session/git rules split by mechanism' },
  '6.0': { rules: ['R-SEG-1'], disposition: 'guide', reason: 'body already in seg-continuity-sop; fix the conflicting sentence' },
  '6.1': { rules: ['R-ENG-1', 'R-ENG-2', 'R-ENG-3'], disposition: 'guide', reason: 'pointer section; body lives in engineering-standards-sop' },
  '6.2': { rules: ['R-MODEL-1'], disposition: 'guide', reason: 'body lives in spawn-lane-sop §10; fix duplicate heading' },
  '6.3': { rules: ['R-PARALLEL-1', 'R-PARALLEL-2'], disposition: 'split', reason: 'worker rule vs Elon patrol' },
  '6.4': { rules: ['R-WORKTREE-1'], disposition: 'guide', reason: 'pointer section; body lives in dev-worktree-flow-sop §6.4' },
  '7': { rules: ['R-AMBIG-1'], disposition: 'moved', reason: 'no guide body; owner block carries it' },
  '8': { rules: ['R-REGISTER-1'], disposition: 'guide', reason: 'body lives in project-registration-sop' },
  '9': { rules: ['R-DEFECT-1'], disposition: 'guide', reason: 'new defect-loop-sop carries the loop' },
  '9.1': { rules: ['R-UI-1'], disposition: 'guide', reason: 'pointer section; body lives in ui-align-sop §9.1' },
  '9.2': { rules: ['R-PROTO-1'], disposition: 'guide', reason: 'ui-align §12.4 is only rationale; new prototype-separation-sop carries the six rules' },
  '9.3': { rules: ['R-CONTAINER-1'], disposition: 'guide', reason: 'new container-form-acceptance-sop carries the five rules' },
  '9.4': { rules: ['R-UXACCEPT-1'], disposition: 'guide', reason: 'flow-triage gets the trigger/timing/closure section' },
  '10': { rules: ['R-TRIAGE-1'], disposition: 'guide', reason: 'ROLES.md + carding-sop carry routing/boundaries' },
  '10.1': { rules: ['R-REVIEW-1'], disposition: 'guide', reason: 'carding-sop §2' },
  '10.2': { rules: ['R-DAG-1'], disposition: 'guide', reason: 'task-interface §10 + carding-sop' },
  '10.3': { rules: ['R-GRANULARITY-1'], disposition: 'guide', reason: 'carding-sop §7; include __team__ target gate' },
  '10.4': { rules: ['R-SEGUSE-1'], disposition: 'guide', reason: 'carding-sop §7.1' },
  '10.5': { rules: ['R-FLOW-1'], disposition: 'guide', reason: 'pointer section; body in flow-triage-sop §10.5' },
  '10.6': { rules: ['R-PREREQ-1'], disposition: 'guide', reason: 'new carding-sop §7.3' },
  '11': { rules: ['R-OOB-1'], disposition: 'moved', reason: 'no guide body; owner block carries it' },
  '12': { rules: ['R-DOCSYNC-1'], disposition: 'guide', reason: 'new doc-sync-sop' },
  '13': { rules: ['R-DISC-1', 'R-DISC-2', 'R-DISC-3', 'R-DISC-4', 'R-DISC-5', 'R-DISC-6', 'R-DISC-7', 'R-DISC-8', 'R-DISC-9'], disposition: 'split', reason: 'umbrella; each clause has its own rule/section' },
  '13.1': { rules: ['R-DISC-1'], disposition: 'moved', reason: 'owner block' },
  '13.2': { rules: ['R-DISC-2'], disposition: 'moved', reason: 'owner block; terminal vs closing wording fixed' },
  '13.3': { rules: ['R-DISC-3'], disposition: 'moved', reason: 'owner block' },
  '13.4': { rules: ['R-DISC-4'], disposition: 'split', reason: 'owner rule + token-hygiene detail' },
  '13.5': { rules: ['R-DISC-5'], disposition: 'split', reason: 'owner rule + carding-sop §8 detail' },
  '13.6': { rules: ['R-DISC-6'], disposition: 'moved', reason: 'owner block; read PROTOCOL rewritten to read this AGENTS' },
  '13.7': { rules: ['R-DISC-7'], disposition: 'split', reason: 'owner rule + task-interface §7 detail' },
  '13.8': { rules: ['R-DISC-8'], disposition: 'split', reason: 'owner rule + task-interface §7 detail' },
  '13.9': { rules: ['R-DISC-9'], disposition: 'split', reason: 'owner rule + AUTOMATIONS/tmp-gc detail' },
  '14': { rules: ['R-CONFIRM-1'], disposition: 'guide', reason: 'new confirmation-gate-sop' },
  '15': { rules: ['R-SLA-1', 'R-SLA-2', 'R-SLA-3', 'R-SLA-4', 'R-SLA-5', 'R-SLA-6'], disposition: 'guide', reason: 'sla-inspection-contract + sla-thresholds.json' },
  '15.1': { rules: ['R-SLA-7'], disposition: 'guide', reason: 'sla-inspection-contract' },
  '16': { rules: ['R-TERM-1'], disposition: 'moved', reason: 'no guide body; owner block carries it; reconcile Terry/operator' },
  '17': { rules: ['R-LAYER-1', 'R-LAYER-2', 'R-LAYER-3', 'R-LAYER-4', 'R-LAYER-5'], disposition: 'rewritten', reason: 'old L0–L5 layering is replaced, not migrated' },
  '18': { rules: ['R-RESEARCH-1'], disposition: 'guide', reason: 'research guide §1; delete duplicate body' },
  '19': { rules: ['R-CREED-1'], disposition: 'moved', reason: 'owner block; SOUL references it' },
  '20': { rules: ['R-GATE-1', 'R-GATE-2', 'R-ARCHIVE-1'], disposition: 'split', reason: 'umbrella; sub-sections own the detail' },
  '20.1': { rules: ['R-GATE-1'], disposition: 'guide', reason: 'scripts/README + AUTOMATIONS §3.5/§3.5.1' },
  '20.2': { rules: ['R-GATE-2'], disposition: 'guide', reason: 'dev-worktree-flow-sop §4; dedupe four merge gaps' },
  '20.3': { rules: ['R-ARCHIVE-1'], disposition: 'moved', reason: 'owner block + README' },
  '21': { rules: ['R-VERSION-1', 'R-VERSION-2'], disposition: 'split', reason: 'release mechanics vs approval' },
  '22': { rules: ['R-OBS-1'], disposition: 'guide', reason: 'runtime-observability-sop' },
  '23': { rules: ['R-INCIDENT-1', 'R-INCIDENT-2'], disposition: 'split', reason: 'response vs escalation/communication' },
  '24': { rules: ['R-MIGRATE-1', 'R-MIGRATE-2'], disposition: 'split', reason: 'mechanics vs destructive approval' },
  '25': { rules: ['R-API-1', 'R-API-2'], disposition: 'split', reason: 'contract rules vs deprecation window/approval' },
  '26': { rules: ['R-CVE-1', 'R-CVE-2', 'R-CVE-3'], disposition: 'split', reason: 'scan/gate vs waiver approval vs adjudication' },
  '27': { rules: ['R-PERF-1', 'R-PERF-2'], disposition: 'split', reason: 'baseline/regression vs SLO/SLA adjudication' },
  '28': { rules: ['R-CROSS-1'], disposition: 'guide', reason: 'object declarations; delete pointer/meta items 4–5' },
  '29': { rules: ['R-IDEM-1'], disposition: 'guide', reason: 'task-interface §14 + check-idem; no false machine-semantic claim' },
  'Appendix A': { rules: ['R-DATAREPO-1'], disposition: 'guide', reason: 'research guide §2; compress to avoid duplicate body' },
};

/** 16 条必须在迁移中解决的内部矛盾。 */
const CONTRADICTIONS = [
  ['turing-runs.json', 'P:147 says register in turing-runs.json; P:150/spawn-lane say legacy log, not a registration surface; Turing AGENTS/tool-discipline still reconcile/register it.', 'Make claude-sessions.json the sole registry; turing-runs.json only a legacy log; rewrite P:147, Turing AGENTS and tool-discipline.'],
  ['state machine', 'P:34/42 and redlines.core.md:12 disagree on backlog, canceled entry, failed alias and blocked scope.', 'One canonical diagram; rewrite redline item 5.'],
  ['terminal wording', 'P:392/redline call in_review/blocked terminal; only done/canceled are terminal.', 'Use “closing state” for the three-item closeout.'],
  ['§6.0 line 181', '“information does not enter the task card” contradicts the next bullet (Progress is on the card).', 'Decisions/conventions do not enter the card; milestones do.'],
  ['least privilege vs containment', 'P:490 defaults writes to ~/.openclaw/team/**; P:79–82 confines project cards to the project root.', 'State that the default applies to __team__/internal chores only.'],
  ['confirmation trigger gap', 'P:65 destructive migration and P:76 deprecation window require approval, but §14 triggers list only plan.md/product docs.', 'Add destructive migration and deprecation to R-CONFIRM-1 triggers.'],
  ['coverage threshold', 'release-versioning-sop §4.1 says 80% is “to be decided”; engineering-standards clause 2 says ≥80% hard.', 'One authoritative threshold in R-ENG-1 clause 2.'],
  ['operator/Terry/language', 'P:451 says all docs use “operator”; README/README.zh-CN/release-sop/elon-report-template/duties-sop use Terry or Chinese; P:110 says English.', 'Define Terry = operator alias or normalize; state the operator-facing Chinese exception.'],
  ['patrol cadence/heartbeat', 'elon duties-sop says daily 09:00 and 15min stale; AUTOMATIONS says hourly; P:439 says 30min.', 'Unify to hourly + 30min, or label 15min as a patrol heuristic.'],
  ['idempotency semantics', 'P:132 says the ACL implements semantic de-duplication; check-idem says only the LLM semantic gate + key fallback.', 'Separate the LLM semantic gate from the mechanical key; do not claim a machine semantic gate.'],
  ['§20.2 duplicate', 'The four check-merge gaps appear in P:524–529 and dev-worktree-flow-sop §4.', 'Keep one home (the guide); R-GATE-2 references it.'],
  ['§17 old layering', 'P:462 L0–L5 conflicts with the target L0/L1/L1.5/L2/L3 model.', 'Rewrite, do not migrate.'],
  ['ROLES conflict authority', 'ROLES.md:5 says PROTOCOL §10 wins on conflict.', 'Replace with R-TRIAGE-1.'],
  ['dangling pointers', 'P:170 “see the 🔑 block above”; spawn-lane has two §10 headings; ui-align §301 says rules remain in PROTOCOL §9.2.', 'Delete/renumber/rewrite.'],
  ['SLA single source', 'sla-inspection-contract §2/§11 H6 declare PROTOCOL §15 the sole threshold source.', 'Point to sla-thresholds.json + R-SLA-*.'],
  ['guide headers', 'About 20 guides say L2.5 / “Elon is the sole writer of L1” / “never copies L1”.', 'Rewrite the layering/ownership headers, not just the tokens.'],
];

const APPENDIX_A = /^Appendix\s+([A-Z])\b/;

function sectionKey(heading) {
  const app = heading.match(APPENDIX_A);
  if (app) return `Appendix ${app[1]}`;
  const num = heading.match(/^(?:§)?(\d+(?:\.\d+)*)[.:\s]/);
  if (num) return num[1];
  return heading.trim();
}

function parseSections(text) {
  const lines = text.split('\n');
  const out = [];
  let cur = { key: 'Front matter', title: 'Front matter', line: 1, body: [] };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const h = line.match(/^(#{2,3})\s+(.*)$/);
    if (h) {
      out.push(cur);
      cur = { key: sectionKey(h[2]), title: h[2].trim(), line: i + 1, body: [] };
    } else {
      cur.body.push(line);
    }
  }
  out.push(cur);
  return out;
}

function atomList(text) {
  const a = extractAtoms(text);
  return {
    codes: [...a.codes].sort(),
    tokens: [...a.tokens].sort(),
    refs: [...a.refs].sort(),
    numbers: [...a.numbers].sort(),
  };
}

function headingsOf(text) {
  const set = new Set();
  for (const line of text.split('\n')) {
    const m = line.match(/^#{2,6}\s*(?:§)?(\d+(?:\.\d+)*)/);
    if (m) set.add(m[1]);
  }
  return set;
}

function resolvesLocally(ref, headings) {
  const n = ref.replace(/^§/, '');
  if (headings.has(n)) return true;
  for (const h of headings) if (h.startsWith(`${n}.`)) return true;
  return false;
}

/** 扫描 guides 里的裸 §N：点名 PROTOCOL / 点名 .md 的不算；裸 §N 必须在本文件可解析。 */
function bareRefsCensus() {
  const files = [];
  const walk = (dir, depth = 0) => {
    if (depth > 4) return;
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.isFile() && e.name.endsWith('.md')) files.push(p);
    }
  };
  walk(path.join(REPO, 'team/guides'));
  for (const role of ROLES) walk(path.join(REPO, 'roles', role, 'guides'));

  const unresolved = [];
  let total = 0;
  for (const abs of files.sort()) {
    const rel = path.relative(REPO, abs).split(path.sep).join('/');
    const text = fs.readFileSync(abs, 'utf8');
    const headings = headingsOf(text);
    let fence = false;
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^\s*```/.test(line)) { fence = !fence; continue; }
      if (fence) continue;
      for (const m of line.matchAll(/§\s*\d+(?:\.\d+)*/g)) {
        const before = line.slice(0, m.index);
        if (/PROTOCOL/.test(before)) continue;                     // 点名 PROTOCOL：不是裸引用
        if (/[A-Za-z0-9_.-]+\.md`?/.test(before)) continue;        // 已点名 guide：同一行后续 §N 属于同一引用列表
        total++;
        const ref = m[0].replace(/\s+/g, '');
        if (!resolvesLocally(ref, headings)) {
          unresolved.push({ file: rel, line: i + 1, ref, intendedTarget: 'PROTOCOL (rewrite to R-*)' });
        }
      }
    }
  }
  return { total, unresolved };
}


/** 从实际 owner 块读取最终 carriers，保证 census 与 marker 一致。 */
function actualCarriers() {
  const out = new Map();
  for (const role of ROLES) {
    const p = path.join(REPO, 'roles', role, 'AGENTS.md');
    if (!fs.existsSync(p)) continue;
    for (const b of parseRuleBlocks(fs.readFileSync(p, 'utf8'))) {
      if (b.kind !== 'owner') continue;
      try { out.set(b.id, normalizeOwnerBlock(role, b).carriers); } catch { /* reported elsewhere */ }
    }
  }
  return out;
}

export function buildCensus() {
  const sources = [
    ['team/PROTOCOL.md', 'PROTOCOL'],
    ['team/PROTOCOL-gates.md', 'PROTOCOL-gates'],
  ];
  const sections = [];
  const volumesPath = path.join(HERE, 'protocol-removal-volumes.json');
  const volumes = fs.existsSync(volumesPath) ? JSON.parse(fs.readFileSync(volumesPath, 'utf8')) : {};
  const readSource = (rel) => {
    const p = path.join(REPO, rel);
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
    // 卷已删除（C6 之后）：读测试夹具快照；容器内没有 git，这条路径必须可用。
    if (volumes[rel] !== undefined) return volumes[rel];
    return execFileSync('git', ['show', `dev:${rel}`], { cwd: REPO, encoding: 'utf8' });
  };
  for (const [rel, label] of sources) {
    const text = readSource(rel);
    for (const s of parseSections(text)) {
      const map = SECTION_MAP[s.key] || { rules: [], disposition: 'unmapped', reason: 'no mapping — fix before C2' };
      for (const id of map.rules) {
        if (!RULE_IDS.has(id)) throw new Error(`section ${label}:${s.key} references unknown rule ${id}`);
      }
      sections.push({
        source: rel,
        volume: label,
        section: s.key,
        title: s.title,
        line: s.line,
        ruleIds: map.rules,
        disposition: map.disposition,
        reason: map.reason,
        atoms: atomList(s.body.join('\n')),
      });
    }
  }

  const actual = actualCarriers();
  for (const r of RULES) if (actual.has(r.id)) r.carriers = actual.get(r.id);
  const referenced = new Set(sections.flatMap((s) => s.ruleIds));
  for (const id of referenced) if (!RULE_IDS.has(id)) throw new Error(`unknown rule ${id}`);
  const orphanRules = RULES.filter((r) => !referenced.has(r.id)).map((r) => r.id);

  return {
    version: 1,
    generatedFrom: sources.map(([rel]) => rel),
    rules: RULES,
    sections,
    orphanRules,
    contradictions: CONTRADICTIONS.map(([topic, issue, resolution], i) => ({
      id: `C${i + 1}`, topic, issue, resolution, status: 'resolved-in-migration',
    })),
    bareRefs: bareRefsCensus(),
  };
}

function main() {
  const census = buildCensus();
  const json = `${JSON.stringify(census, null, 2)}\n`;
  if (process.argv.includes('--check')) {
    const old = fs.readFileSync(CENSUS_PATH, 'utf8');
    if (old !== json) {
      console.error('✗ census 不是最新：请运行 node test/docs/protocol-removal-census.mjs');
      process.exit(1);
    }
    console.log(`census 最新 ✔（${census.sections.length} 节 / ${census.rules.length} 规则 / ${census.contradictions.length} 矛盾 / ${census.bareRefs.unresolved.length} 处未解析裸 §N）`);
    return;
  }
  fs.writeFileSync(CENSUS_PATH, json);
  console.log(`census 已写入 ${path.relative(REPO, CENSUS_PATH)}（${census.sections.length} 节 / ${census.rules.length} 规则 / ${census.contradictions.length} 矛盾 / ${census.bareRefs.unresolved.length} 处未解析裸 §N）`);
  if (census.orphanRules.length) console.warn(`⚠ 未被任何小节引用的规则：${census.orphanRules.join(', ')}`);
  const unmapped = census.sections.filter((s) => s.disposition === 'unmapped');
  if (unmapped.length) console.warn(`⚠ 未映射小节：${unmapped.map((s) => `${s.volume}:${s.section}`).join(', ')}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
