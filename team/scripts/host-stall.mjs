#!/usr/bin/env node
/**
 * host-stall.mjs — 「有界等待被击穿」不是「失败」的判别与重取（T-20261016-210926）
 *
 * 为什么存在：门禁里所有**有界子进程等待**（`spawnSync`/`execFileSync` 的 `timeout`、测试里的
 * 轮询上限）都在一个前提上工作——「到点没结果」＝「对方有问题」。宿主休眠与负载尖峰把这个前提打破：
 * 进程被冻结/饿死时，**有界等待的执法钟自己也停了**，于是到点返回的是一个**没有答案**的结论
 * （`status = null` / `e.status = null`），却被下游读成「失败」。实证（T-20261016-210926 慢段缓存）：
 *
 *   · 11:03:45Z（run 19.3s，未休眠）：`board-adapter.test.mjs` 5023ms `raw.status` **null !== 0**、
 *     `lane-reaper.test.mjs` 5025ms「stub 应自行退出」——两处都**恰好卡在 5s 上限**上返回；
 *   · 12:22:36Z（run 1150396ms ≈ 19.2 min ＝ 宿主休眠）：`check-all-gate.test.mjs` 1135929ms
 *     `red.exit` **null !== 1**、`lane-reaper.test.mjs` 1135046ms 同上。
 *
 * 判别的两条腿（**都必要，各自覆盖一种形态**）：
 *   ① **重取**（机制）：一次击穿不作数——换一个**新期限**重跑一次；两次皆击穿才判红。
 *      覆盖两种形态：宿主休眠（冻结结束后重取即成功）与负载尖峰（饿死是瞬时的）。**真失败仍红**：
 *      真挂死的子进程两次都击穿，真非零退出/真断言错**不经过本条**（见下「不改口」）。
 *   ② **越界读数**（诊断）：`describeBreach` 给出实际用时相对期限的**越界倍数**。返回用时远超期限本身
 *      （≥ 2×）说明**执法钟被冻结**——这是宿主休眠的特征，不是「子进程慢」。它只用于**说明原因**，
 *      **不参与判定**：短于 2× 的越界同样重取，因为负载尖峰正是那个形态（11:03 那两次）。
 *
 * **不改口（假绿防线）**：只有**击穿**（被问过但没拿到答案）才重取。**答案错**从不重取——
 * 非零退出、抛异常、断言不符、`ETIMEDOUT` 之外的 spawn 失败（`ENOENT` 等）一律**一次定终身**，
 * 照旧判红。因此重取不可能把「真失败」洗成绿，只可能把「没答上」重问一遍。
 *
 * 残余风险（写在这里而不是留给读者猜）：若某缺陷的表现是**间歇性**击穿（例如一半概率挂死），
 * 一次重取会把其中一半吃掉。故 `retries` 默认**恰好 1**，且每次重取都进 audit 供留痕/上报，
 * 不静默。
 */

/**
 * 越界倍数阈值：返回用时 ≥ 期限的该倍数 ⇒ 判为「执法钟被冻结」（宿主休眠特征）。
 * 取值理由是实证分档，不是理论常数：11:03 两次为 **1.005×**（负载尖峰，钟没停），
 * 12:22 那次为 **19×**（休眠，钟停了）。2× 把这两档分开，且对「恰好越过期限一点点」的中性地带
 * 保守地按**未判停**处理（仍重取，只是不宣称是休眠）。
 */
export const STALL_OVERSHOOT_RATIO = 2;

/**
 * 击穿读数（诊断用，**不参与判定**）。
 * @param {number} elapsedMs 本次等待实际用时
 * @param {number} budgetMs 本次等待的期限（未知 ⇒ null：只报用时，不臆断越界倍数）
 * @returns {{elapsedMs:number, budgetMs:number|null, overshootMs:number|null, ratio:number|null, likelyStall:boolean}}
 */
export function describeBreach(elapsedMs, budgetMs = null) {
  const ms = Number(elapsedMs);
  const b = budgetMs == null ? null : Number(budgetMs);
  if (!(b > 0)) return { elapsedMs: ms, budgetMs: null, overshootMs: null, ratio: null, likelyStall: false };
  return {
    elapsedMs: ms,
    budgetMs: b,
    overshootMs: ms - b,
    ratio: Number((ms / b).toFixed(3)),
    likelyStall: ms >= b * STALL_OVERSHOOT_RATIO,
  };
}

/**
 * 跑一次 `attempt`；结果是**击穿**就带新期限再跑一次（默认恰好一次）。
 *
 * @param {(attemptNo:number) => T} attempt 每次调用即**一次完整的重试单位**（整段有界等待）
 * @param {{classify:(value:T, meta:{attempt:number, elapsedMs:number}) => any, retries?:number,
 *          budgetMs?:number|null}} [opts]
 *        `classify` 返回**真值**表示这次是击穿（值本身即原因，进 audit）；返回假值表示这是**结论**，
 *        不论对错都接受、不再重取。`budgetMs` 只用于 audit 的越界读数。
 * @returns {{value:T, breached:boolean, attempts:number, audit:Array<object>}}
 *          `value` 恒为**最后一次**的结果：两次皆击穿时它就是那个击穿结果（调用方照旧判红）。
 * @template T
 */
export function withStallRetrySync(attempt, { classify, retries = 1, budgetMs = null } = {}) {
  const audit = [];
  const total = Math.max(1, Number(retries) + 1);
  let value;
  let reason = null;
  for (let i = 0; i < total; i++) {
    const t0 = Date.now();
    value = attempt(i + 1);
    const elapsedMs = Date.now() - t0;
    reason = classify ? classify(value, { attempt: i + 1, elapsedMs }) : null;
    if (!reason) return { value, breached: false, attempts: i + 1, audit };
    audit.push({ attempt: i + 1, reason: reason === true ? 'breached' : reason, ...describeBreach(elapsedMs, budgetMs) });
  }
  return { value, breached: true, attempts: audit.length, audit, last: reason };
}

/**
 * `withStallRetrySync` 的异步版（轮询式等待用它）。
 * 逐点同义：`attempt` 可以返回 Promise，其余契约一字不改。
 * @template T
 * @param {(attemptNo:number) => Promise<T>|T} attempt
 * @returns {Promise<{value:T, breached:boolean, attempts:number, audit:Array<object>}>}
 */
export async function withStallRetry(attempt, { classify, retries = 1, budgetMs = null } = {}) {
  const audit = [];
  const total = Math.max(1, Number(retries) + 1);
  let value;
  let reason = null;
  for (let i = 0; i < total; i++) {
    const t0 = Date.now();
    value = await attempt(i + 1);
    const elapsedMs = Date.now() - t0;
    reason = classify ? classify(value, { attempt: i + 1, elapsedMs }) : null;
    if (!reason) return { value, breached: false, attempts: i + 1, audit };
    audit.push({ attempt: i + 1, reason: reason === true ? 'breached' : reason, ...describeBreach(elapsedMs, budgetMs) });
  }
  return { value, breached: true, attempts: audit.length, audit, last: reason };
}

/**
 * 子进程结果的**超时**判据：只看「有界等待被击穿」，不看别的失败。
 *
 * - `spawnSync` 超时 ⇒ `error.code === 'ETIMEDOUT'`（并带 `signal='SIGTERM'`）；
 * - `spawnSync` 找不到可执行文件 ⇒ `status === null` 但 `error.code === 'ENOENT'` ⇒ **不是**击穿
 *   （CLI 缺失是真结论，重取只会再失败一次）；
 * - 被外部 SIGKILL ⇒ `status === null` 且 `signal='SIGKILL'` ⇒ **不是**击穿（那是别人做的决定，
 *   不是我们的等待被击穿）；故第二条只认**超时机制自己发的** `SIGTERM`。
 * - 非零退出 ⇒ `status` 是数字 ⇒ **不是**击穿。
 * @param {object} res `spawnSync` 的返回
 * @returns {{reason:string}|null} 真值 ＝ 击穿（含原因），null ＝ 这是结论
 */
export function timeoutBreachOf(res) {
  if (!res || typeof res !== 'object') return null;
  if (res.error && res.error.code === 'ETIMEDOUT') return { reason: 'timeout(ETIMEDOUT)' };
  if (res.status === null && res.signal === 'SIGTERM') return { reason: 'timeout(SIGTERM)' };
  return null;
}

/**
 * `execFileSync` 抛出的超时判据（`runRaw` 一类的 catch 分支用它）。
 * 注意实际形态有两种，**都要认**：子进程已被杀 ⇒ `status = null`；子进程其实已正常退出 ⇒
 * `status = 0`（实测 macOS/Node 22）。共同点是 `code === 'ETIMEDOUT'`。
 * @param {any} err
 * @returns {{reason:string}|null}
 */
export function execTimeoutBreachOf(err) {
  if (!err || typeof err !== 'object') return null;
  if (String(err.code || '') === 'ETIMEDOUT') return { reason: 'timeout(execFileSync ETIMEDOUT)' };
  return null;
}
