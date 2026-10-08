# CI 门禁与发版 SOP（Linus）

> 归属：**Linus 岗位 SOP**（L2.5 方法库）。规范正文引用 `PROTOCOL §⑥.1`；本文件是**执行详法**。
> 适用范围：所有纳入版本控制的项目交付 —— **CI 门禁、构建、发布、部署**均属 Linus 职责。

## 一、职责边界
- **Linus 负责**：CI 门禁的维护与通过、构建（build）、发版（release）、部署（deploy）。
- **Turing 负责**：独立验证 / 回归 / 安全审计（不对 CI 配置负责，但可复核门禁是否真实有效）。
- **Elon 负责**：验收与放行。
即：**门禁红/绿由 Linus 保证，验收由 Turing/Elon 独立判定**。

## 二、验证环境：Docker（强制）
> 项目约定：**本地验证一律在容器内跑，绝不在宿主**（与 task-panel 一致）。

- **唯一健康事实源**：`docker/verify-in-container.sh` —— CI 与本地 `docker/verify.sh` 调**同一脚本**，故「本地绿 = CI 绿」。
- **入口**：`docker/verify.sh`（宿主构建+运行）· `docker compose -f docker/docker-compose.yml up --build` · CI `.github/workflows/verify.yml`。
- **离线优先**：默认无网络；网络路径用 `OPENCLAW_TEAM_NET=1`（或 `docker/verify.sh --net`）。
- **覆盖**：语法（shell/node）· manifest+lock 完整性（0 未解析/0 重复）· 安装器与 fetcher 干跑 · 真实文件部署 · **升级/备份/用户文件保留** · （可选）上游拉取。
- **要求**：任何交付前，容器验证必须**全绿**；宿主直跑只允许用于排障，**不得作为交付证据**。
- **验收依据**：Report 附容器验证输出（退出码 0 + 末行 `all container checks passed`）。

## 三、CI 门禁纪律
1. **门禁即 DoD**：任何提交 / PR 必须通过统一门禁才可合并、才可置 `done`。
2. **门禁最小集**（按项目裁剪，缺项须在卡内说明）：
   - [ ] lint / 静态检查
   - [ ] 类型检查（`tsc --noEmit` / `mypy` / `ruff` 等）
   - [ ] 单元测试 + 集成测试
   - [ ] 覆盖率阈值（见 `PROTOCOL §⑥.1` 与 Linus 测试纪律）
   - [ ] **构建必须成功**（build 是门禁项，不是可选项）
3. **红灯即停**：门禁未全绿 ⇒ 不得合并、不得置 `done`；修复后重跑至全绿。
4. **本地先过**：推送前先跑等价门禁（`pre-commit` / `make check` / `npm run check`），避免烧 CI 空转。
5. **禁绕过**：不得用 `--no-verify`、跳过或禁用 job 等手段绕门禁；确有必要须**卡内书面授权**并留痕。
6. **失败留痕**：CI 失败需在 Report 附「失败 job + 关键日志摘要 + 修复 commit」。
7. **门禁配置归 Linus**：workflow / Makefile / task runner 由 Linus 维护；变更属**口径变更**，需双签并以 `kind=change` 留痕（`PROTOCOL §⑬`）。

## 四、发版 SOP（Build & Release）
1. **版本号**：语义化 `MAJOR.MINOR.PATCH`；每次发版更新 `CHANGELOG`。
2. **冻结**：发版前确认门禁全绿、待发内容 frozen（无半成品）。
3. **可复现构建**：锁定依赖（lockfile）+ 固定 toolchain 版本；产物生成 `sha256` 校验和。
4. **发版步骤**：
   - [ ] 门禁全绿（含 build）
   - [ ] 更新版本号 + `CHANGELOG`
   - [ ] 打 tag（带注释；有签名条件则签名）
   - [ ] 构建产物 + 生成校验和
   - [ ] **对产物做冒烟测试**（不只看源码测试）
   - [ ] 发布 / 归档产物
5. **发布证据入 Report**：`tag` + `commit hash` + CI run 链接 + 产物 `sha256` + 冒烟结果。

## 五、部署 SOP（Deploy）
1. **环境分层**：`staging → production`；禁止跳过 staging（紧急热修须记录理由并经 Elon 批准）。
2. **部署前**：备份当前版本 / 数据；确认**回滚点**。
3. **部署中**：按既定脚本 / 流水线执行，**禁止手改线上**。
4. **部署后**：冒烟验证（健康检查 + 关键路径）；失败**即回滚**。
5. **回滚预案**：保留上一稳定版本；回滚后留痕（时间 / 原因 / 版本）。
6. **记录入 Report**：部署版本、时间、环境、冒烟结果、回滚点。

## 六、交付前门禁清单（并入 Linus「交付前总清单」）
- [ ] CI 门禁全绿（含 build）
- [ ] 发版：tag + CHANGELOG + 产物哈希 + 产物冒烟
- [ ] 部署：备份/回滚点 + 部署冒烟
- [ ] Report 含门禁与发版/部署证据

## 七、引用关系
- 质量 / 测试门槛：`PROTOCOL §⑥.1`
- 文档双向同步：`PROTOCOL §⑫`
- 段收尾（心跳/终态/Report）：`PROTOCOL §⑥`
- 任务变更留痕：`PROTOCOL §⑬.7`（`kind=change`）
