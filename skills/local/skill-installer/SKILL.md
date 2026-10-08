---
name: skill-installer
description: 当用户提供 URL/GitHub 仓库链接要求安装 skill 时触发。自动判断 marketplace/手动模式，支持选择性安装、批量安装和增量更新。自动适配标准 skills/、非标准目录名（如 scientific-skills/）、单 skill 仓库、plugin-only marketplace 四种仓库类型。
---

# Skill Installer

## 核心原则

1. **选择性安装**：只安装用户指定的 skill，不全量安装
2. **增量同步**：更新时只覆盖已安装的 skill，新 skill 必须经用户确认
3. **安装记录**：`sources/.installed-skills.json` 追踪每个源已安装的 skill
4. **整体提交**：所有变更一次性 commit 到 `~/.claude` 备份仓库
5. **批量优化**：支持一次分析所有仓库后统一展示，减少交互轮次
6. **废弃过滤**：自动排除声明为废弃/legacy 的 skill，不安装、不展示在可选列表中

## 安装记录文件

**`~/.claude/sources/.installed-skills.json`** — 中央记录文件，追踪所有通过 skill-installer 安装的源。

> 不能放在各 submodule 目录内，因为父仓库不会追踪 submodule 内部文件。

```json
{
  "sources": {
    "sources/antfu-skills": {
      "source": "https://github.com/antfu/skills",
      "mode": "manual",
      "installed": ["antfu", "vue", "vite"],
      "firstInstalled": "2026-04-26T12:00:00Z",
      "lastUpdated": "2026-04-26T12:00:00Z"
    },
    "plugins/marketplaces/anthropic-skills": {
      "source": "https://github.com/anthropics/skills",
      "mode": "marketplace",
      "installed": ["brand-guidelines", "pdf", "xlsx"],
      "firstInstalled": "2026-04-26T12:00:00Z",
      "lastUpdated": "2026-04-26T12:00:00Z"
    }
  }
}
```

**读取方式**：
```bash
python3 -c "
import json
with open('sources/.installed-skills.json') as f:
    d = json.load(f)
info = d['sources'].get('<source-key>')
print(f\"mode: {info['mode']}, installed: {info['installed']}\")
"
```

---

## 流程

### 第 1 步：解析输入

提取：
- **仓库 URL**（必需，`https://github.com/owner/repo` 或 `git@github.com:owner/repo`）
- **要安装的 skill 名称**（可选；未指定则分析后再确认）

统一为 `https://github.com/owner/repo` 格式（submodule 用）。

### 第 2 步：检测是否已安装

检查该源是否已作为 submodule 存在：

```bash
cd ~/.claude
# 检查 sources/ 和 plugins/marketplaces/ 下是否有匹配的 submodule
git submodule status | grep -E "(sources|plugins/marketplaces)/"
# 或读取 sources/.installed-skills.json 匹配 source URL
python3 -c "import json; d=json.load(open('sources/.installed-skills.json')); [print(k) for k,v in d['sources'].items() if '<repo-url>' in v['source']]"
```

- **已存在且有记录** → 跳到「第 5 步：更新流程」
- **已存在但无记录** → 补充 `.installed-skills.json`
- **不存在** → 继续第 3 步

### 第 3 步：浅克隆分析

**当用户一次请求安装多个仓库时，并行克隆所有仓库**（每个 `/tmp/skill-check-N`），然后统一分析。

```bash
REPO_URL="<url>"
CHECK_DIR="/tmp/skill-check-<N>"
git clone --depth 1 "$REPO_URL" "$CHECK_DIR"
```

> 注意：并行克隆多个仓库时避免 shell 竞态（如重定向到同一个日志文件），每个仓库使用独立的临时目录。

#### 3.1 判断模式

```bash
if [ -f "$CHECK_DIR/.claude-plugin/marketplace.json" ]; then
    MODE="marketplace"
else
    MODE="manual"
fi
```

#### 3.2 仓库类型分类

分析仓库属于以下四种类型之一：

| 类型 | 识别特征 | 安装行为 |
|------|---------|---------|
| `skill-collection` | 有 `skills/` 或 `*-skills/` 目录，内含 SKILL.md | 选择性安装/软链接 |
| `single-skill` | 根目录有 `SKILL.md`，无 skills 目录 | 整体作为单个 skill 安装 |
| `plugin-only` | 有 `marketplace.json` 但**无 skills 目录**（仅有 commands/等） | 只注册 marketplace，不复制 skill |
| `no-skill` | 无 `SKILL.md` 文件 | 终止安装 |

#### 3.3 发现 skill 目录（skill-collection）

按优先级探测（第一个匹配即停止）：

1. `skills/` 下的子目录（标准）
2. 匹配模式 `*-skills/` 的目录（非标准，如 `scientific-skills/`、`trading-skills/`）
3. 根目录下任意包含 `SKILL.md` 的子目录（兜底）

```bash
# 方式 1：检测标准 skills/ 目录
if [ -d "$CHECK_DIR/skills" ]; then
    SKILLS_DIR="$CHECK_DIR/skills"
# 方式 2：检测非标准 *-skills/ 目录（如 scientific-skills/）
elif SKILLS_DIR=$(find "$CHECK_DIR" -maxdepth 1 -type d -name "*-skills" -not -path "*/.git*" | head -1) && [ -n "$SKILLS_DIR" ]; then
    echo "检测到非标准目录: $(basename $SKILLS_DIR)"
# 方式 3：检测根目录下有 SKILL.md 的子目录
else
    SKILL_SUBDIRS=$(find "$CHECK_DIR" -maxdepth 2 -name SKILL.md -not -path "*/.git/*")
    # 提取各自所属的父目录名（仅限直接子目录）
    SKILLS_DIR="$CHECK_DIR"
fi
```

对 skill-collection 类型，列出所有 skill：
```bash
ALL_SKILLS=$(ls -1 "$SKILLS_DIR" | grep -v "^\\." | grep -v "^_" )
```

#### 3.4 检测单 skill 仓库（single-skill）

```bash
if [ -z "$SKILLS_DIR" ] || [ -z "$ALL_SKILLS" ]; then
    if [ -f "$CHECK_DIR/SKILL.md" ]; then
        REPO_TYPE="single-skill"
        ALL_SKILLS=$(basename "$CHECK_DIR")
    fi
fi
```

#### 3.5 检测 plugin-only marketplace

```bash
if [ "$MODE" = "marketplace" ] && [ "$REPO_TYPE" != "skill-collection" ] && [ ! -f "$CHECK_DIR/SKILL.md" ]; then
    REPO_TYPE="plugin-only"
    # 从 marketplace.json 提取插件列表
    PLUGINS=$(python3 -c "
import json
with open('$CHECK_DIR/.claude-plugin/marketplace.json') as f:
    d = json.load(f)
plugins = d.get('plugins', [])
for p in plugins:
    print(p.get('name', 'unknown'))
")
fi
```

#### 3.6 验证和收集元信息

对 `skill-collection` 和 `single-skill` 类型，验证 SKILL.md 并提取描述：

```bash
for skill in $ALL_SKILLS; do
    SKILL_MD=""
    if [ "$REPO_TYPE" = "single-skill" ]; then
        SKILL_MD="$CHECK_DIR/SKILL.md"
    else
        SKILL_MD="$SKILLS_DIR/$skill/SKILL.md"
    fi
    
    if [ -f "$SKILL_MD" ]; then
        DESC=$(head -10 "$SKILL_MD" | grep "description:" | cut -d: -f2- | xargs)
        echo "  ✓ $skill | ${DESC:-(无描述)}"
    else
        echo "  ✗ $skill (无 SKILL.md，跳过)"
    fi
done
```

#### 3.7 废弃 Skill 检测与过滤

**在展示可用 skill 列表前，必须执行废弃检测，将标记为废弃的 skill 从候选列表中移除。**

##### 检测规则

对每个 skill，检查以下来源（任一命中即标记为废弃）：

1. **SKILL.md frontmatter 的 `description` 字段**：包含 `deprecated`、`legacy`、`废弃`、`Legacy`、`Deprecated`、`DEPRECATED`
2. **SKILL.md frontmatter 的 `name` 字段**：包含 `deprecated`、`legacy`、`废弃`
3. **SKILL.md 正文（前 10 行）**：匹配 `Legacy slash-entry shim`、`Legacy Shim`、`Deprecated - use`
4. **skill 所在目录路径**：目录名以 `-deprecated` 或 `-legacy` 结尾

```bash
# 在每个 skill 的 SKILL.md 中执行废弃检测
is_deprecated() {
    SKILL_MD="$1"
    [ ! -f "$SKILL_MD" ] && return 1
    
    # 提取 frontmatter（到第二个 --- 之间）
    FRONTMATTER=$(sed -n '/^---$/,/^---$/p' "$SKILL_MD" | head -20)
    
    # 1. 检查 description 字段
    if echo "$FRONTMATTER" | grep -qiE "description:.*(deprecated|legacy|废弃)"; then
        return 0
    fi
    
    # 2. 检查 name 字段
    if echo "$FRONTMATTER" | grep -qiE "name:.*(deprecated|legacy|废弃)"; then
        return 0
    fi
    
    # 3. 检查正文前 10 行中的废弃声明
    BODY_START=$(grep -n "^---$" "$SKILL_MD" | sed -n '2p' | cut -d: -f1)
    if [ -n "$BODY_START" ]; then
        BODY=$(sed -n "$((BODY_START+1)),$((BODY_START+10))p" "$SKILL_MD")
        if echo "$BODY" | grep -qiE "(Legacy slash-entry shim|Legacy Shim|Deprecated - use|deprecated)"; then
            return 0
        fi
    fi
    
    return 1
}
```

##### 过滤执行

在 3.6 验证收集后，对候选 skill 列表执行过滤：

```bash
FILTERED_SKILLS=""
DEPRECATED_SKILLS=""
for skill in $ALL_SKILLS; do
    if is_deprecated "$SKILL_MD_PATH"; then
        DEPRECATED_SKILLS="$DEPRECATED_SKILLS $skill"
    else
        FILTERED_SKILLS="$FILTERED_SKILLS $skill"
    fi
done
ALL_SKILLS="$FILTERED_SKILLS"
```

##### 展示时标注

在分析报告中列出过滤结果：

```
## Repo N: owner/repo 分析

**类型**：skill-collection
**已自动排除**（标记为废弃）：
  ⊘ skill-x  - (Deprecated - use the skill-y instead)
  ⊘ skill-z  - (Legacy slash-entry shim)

**可用 skill**（共 N 个）：
  1. skill-a  - 简介描述
  ...
```

> 如果全部被排除（`ALL_SKILLS` 为空），告知用户「该仓库所有 skill 均标记为废弃或 legacy，建议跳过安装」，终止该仓库的安装流程。

### 第 4 步：展示分析结果

**批量模式**（多个仓库同时安装）：先对所有仓库完成分析，再统一展示。用户可逐仓库确认或一次性确认全部。

格式（单仓库）：
```
## Repo N: owner/repo 分析

**类型**：skill-collection / single-skill / plugin-only
**模式**：marketplace / 手动
**Skills 目录**：skills/ 或 scientific-skills/（如果是非标准目录名，在此标注）
**可用 skill**：
  1. skill-a  - 简介描述
  2. skill-b  - 简介描述
  ...

请输入要安装的 skill 编号或名称。
```

格式（plugin-only 类型）：
```
## Repo N: owner/repo 分析

**类型**：plugin-only（无 skills/ 目录）
**模式**：marketplace
**可用插件**（从 marketplace.json 提取）：
  1. plugin-a  - 描述
  ...

> 此仓库为纯 marketplace 插件，无标准 SKILL.md。将注册 marketplace 但不复制 skill 文件。
> 插件命令可直接通过 `/plugin-name:command` 调用。
```

**如果用户已在请求中明确指定了要安装的 skill 列表**（如「安装 repo X 的 skill-a skill-b」），直接跳到第 5 步执行安装，不再展示确认环节。

**必须等待用户明确确认后，才能执行安装。** 例外：用户在请求中已明确指定。

### 第 5 步：执行安装

#### 5.1 确定源目录名和路径

从 repo URL 提取：`https://github.com/owner/repo` → `repo`

根据模式和类型确定目标路径：
| 模式 | 类型 | 目标路径 |
|------|------|---------|
| marketplace | skill-collection | `plugins/marketplaces/<marketplace-id>` |
| marketplace | plugin-only | `plugins/marketplaces/<marketplace-id>` |
| manual | skill-collection | `sources/<repo-name>` |
| manual | single-skill | `sources/<repo-name>` |

若目标目录已存在（非 submodule），追加后缀 `-2`、`-3` 等避免冲突。

#### 5.2 添加 Git Submodule（所有类型通用）

```bash
cd ~/.claude
git submodule add <repo-url> <target-path>
```

#### 5.3 Marketplace 模式安装

##### 5.3a 注册到 known_marketplaces.json（所有 marketplace 类型）

```bash
cd ~/.claude
python3 -c "
import json
with open('plugins/known_marketplaces.json') as f:
    d = json.load(f)
d['<marketplace-id>'] = {
    'source': {'source': 'github', 'repo': '<owner/repo>'},
    'installLocation': '/Users/tanyu/.claude/plugins/marketplaces/<marketplace-id>',
    'lastUpdated': '$(date -u +%Y-%m-%dT%H:%M:%SZ)'
}
with open('plugins/known_marketplaces.json', 'w') as f:
    json.dump(d, f, indent=2)
"
```

##### 5.3b 创建 Skill 软链接（仅 skill-collection 类型）

如果 repo 类型为 `skill-collection`（有 skills 目录）：

```bash
cd ~/.claude/skills
for skill in <用户选择列表>; do
    ln -sf ../plugins/marketplaces/$ID/skills/$skill $skill
done
```

> 如果 skills 目录名非标准（如 `scientific-skills/`），将路径中的 `skills/` 替换为实际目录名。

如果 repo 类型为 **plugin-only**（无 skills 目录）：**跳过软链接步骤**。插件命令通过 marketplace 注册自动解析（如 `/trading-ideas:research`）。

#### 5.4 手动模式安装

##### 5.4a Skill 安装

**skill-collection 类型**（有 skills 目录）：
```bash
cd ~/.claude/skills
for skill in <用户选择列表>; do
    cp -r ../sources/$NAME/skills/$skill .
done
```
> 如果源 skills 目录名非标准（如 `scientific-skills/`），将路径中的 `skills/` 替换为实际目录名。

**single-skill 类型**（根目录有 SKILL.md）：
```bash
cd ~/.claude/skills
SKILL_NAME=$(head -10 ../sources/$NAME/SKILL.md | grep "name:" | cut -d: -f2- | xargs)
# 如果 frontmatter 中无 name 字段，使用目录名
[ -z "$SKILL_NAME" ] && SKILL_NAME=$(basename ../sources/$NAME)
rm -rf "$SKILL_NAME" 2>/dev/null
cp -r ../sources/$NAME "$SKILL_NAME"
rm -rf "$SKILL_NAME/.git" 2>/dev/null
```

#### 5.5 更新安装记录（所有类型）

```bash
cd ~/.claude
python3 -c "
import json
with open('sources/.installed-skills.json') as f:
    d = json.load(f)
d['sources']['<target-path>'] = {
    'source': '<repo-url>',
    'mode': '<marketplace|manual>',
    'type': '<skill-collection|single-skill|plugin-only>',
    'installed': [<用户选择列表>],
    'firstInstalled': '$(date -u +%Y-%m-%dT%H:%M:%SZ)',
    'lastUpdated': '$(date -u +%Y-%m-%dT%H:%M:%SZ)'
}
with open('sources/.installed-skills.json', 'w') as f:
    json.dump(d, f, indent=2)
"
```

> 记录中新增 `type` 字段：`skill-collection`、`single-skill`、`plugin-only`，用于后续增量更新时准确定位。

#### 5.6 验证安装

```bash
cd ~/.claude/skills

# skill-collection 和 single-skill：检查 SKILL.md
for skill in <用户选择列表>; do
    if [ -f "$skill/SKILL.md" ]; then
        echo "✓ $skill 安装成功"
    else
        echo "✗ $skill 安装失败"
    fi
done

# plugin-only 类型：检查 marketplace 注册
if [ "$REPO_TYPE" = "plugin-only" ]; then
    python3 -c "
import json
with open('../plugins/known_marketplaces.json') as f:
    d = json.load(f)
if '<marketplace-id>' in d:
    print('✓ marketplace 注册成功')
else:
    print('✗ marketplace 注册失败')
"
fi
```

#### 5.5 整体提交

```bash
cd ~/.claude
git add .gitmodules
git add skills/<installed-skills>
git add <source-dir>                   # sources/<name> 或 plugins/marketplaces/<id>
git add sources/.installed-skills.json
# marketplace 额外：
git add plugins/known_marketplaces.json

git commit -m "$(cat <<'EOF'
feat: install skills from <repo-name>

Mode: <marketplace|manual>
Skills: <comma-separated-list>
EOF
)"
git push
```

---

### 第 6 步：后续更新

用户要求更新已安装源时触发。

#### 6.1 定位源和记录

```bash
cd ~/.claude
# 从 sources/.installed-skills.json 读取记录
RECORD="sources/.installed-skills.json"
SOURCE_KEY=$(python3 -c "
import json
with open('$RECORD') as f:
    d = json.load(f)
for k,v in d['sources'].items():
    if '<repo-url>' in v['source']:
        print(k)
")
SOURCE_DIR="$SOURCE_KEY"
MODE=$(python3 -c "import json; d=json.load(open('$RECORD')); print(d['sources']['$SOURCE_KEY']['mode'])")
INSTALLED=$(python3 -c "import json; d=json.load(open('$RECORD')); print(' '.join(d['sources']['$SOURCE_KEY']['installed']))")
```

#### 6.2 拉取子模块最新

```bash
cd ~/.claude
git submodule update --remote "$SOURCE_DIR"
```

#### 6.3 对比变化

```bash
cd "$SOURCE_DIR"
# 列出源中所有可用 skill
ALL_SKILLS=$(ls -1 skills/ 2>/dev/null | grep -v "^\\.")
# 或检测根目录下的 skill

# 分类
TO_SYNC=""   # 已安装的
UNCHANGED="" # 已安装但无变化
NEW=""       # 源中新增的

for skill in $ALL_SKILLS; do
    if echo "$INSTALLED" | grep -q "$skill"; then
        TO_SYNC="$TO_SYNC $skill"
    else
        NEW="$NEW $skill"
    fi
done
```

#### 6.4 展示变化并确认

```
## 更新报告：<name>

**将同步（已安装）**：
  ✓ skill-a
  ✓ skill-b

**新发现（需确认是否安装）**：
  ○ skill-d  - 描述
  ○ skill-e  - 描述

请输入要新增的 skill（编号或名称），留空跳过。
```

**必须等待用户确认。** 如用户只按回车 → 仅同步已安装的，不新增。

#### 6.5 执行同步

手动模式：
```bash
cd ~/.claude/skills
for skill in $INSTALLED; do
    rm -rf "$skill"
    cp -r "../$SOURCE_DIR/skills/$skill" .
done
# 用户确认的新 skill
for skill in <用户新增>; do
    cp -r "../$SOURCE_DIR/skills/$skill" .
done
# 更新记录到 sources/.installed-skills.json
python3 -c "
import json
with open('sources/.installed-skills.json') as f:
    d = json.load(f)
d['sources']['$SOURCE_KEY']['installed'] = d['sources']['$SOURCE_KEY']['installed'] + [<用户新增列表>]
d['sources']['$SOURCE_KEY']['lastUpdated'] = '$(date -u +%Y-%m-%dT%H:%M:%SZ)'
with open('sources/.installed-skills.json', 'w') as f:
    json.dump(d, f, indent=2)
"
```

Marketplace 模式：
```bash
cd ~/.claude/skills
# 已安装的无需操作（软链接自动指向更新内容）
# 用户确认的新 skill
for skill in <用户新增>; do
    ln -sf ../$SOURCE_DIR/skills/$skill $skill
done
# 更新记录
```

#### 6.6 整体提交

```bash
cd ~/.claude
git add skills/ "$SOURCE_DIR" sources/.installed-skills.json
git commit -m "chore: update <name> skills ($(echo $TO_SYNC | wc -w) synced, $(echo $NEW | wc -w) added)"
git push
```

---

## 错误处理

| 场景 | 处理 |
|------|------|
| Clone 失败（网络/权限） | 提示用户检查 URL 和网络，终止该仓库的安装（批量模式下继续其他仓库） |
| 所有 skill 均标记为废弃（`ALL_SKILLS` 为空） | 告知用户"该仓库所有 skill 均为废弃/legacy，不建议安装"，终止该仓库的安装 |
| 仓库中无任何 `SKILL.md` 且非 plugin marketplace | 告知用户"未找到有效 skill"，列出仓库结构 |
| Plugin-only 仓库（无 skills 目录） | 注册 marketplace，跳过 skill 复制，告知用户插件通过 marketplace 解析 |
| 非标准目录名（如 `scientific-skills/`） | 自动检测，标注实际目录名，正常安装 |
| 发现标记为废弃/legacy 的 skill | 自动过滤，在分析报告中标注排除原因，更新时同样过滤 |
| Submodule 已存在 | 切换到更新流程，提示用户此源已安装 |
| `skills/` 软链接冲突 | 先删除旧软链接再创建新链接 |
| `git push` 失败 | 检查网络，提示用户手动推送 |
| known_marketplaces.json 格式错误 | 先备份再修改 |
| 并行克隆竞态 | 每个仓库使用独立临时目录，避免共享日志文件 |

---

## 仓库类型速查

| 类型 | 识别特征 | 模式判断 | skills 位置 | 安装行为 |
|------|---------|---------|-----------|---------|
| `skill-collection` | `skills/` 或 `*-skills/` 目录 + SKILL.md | marketplace/manual | `skills/` 或 `scientific-skills/` 等 | 选择性安装 |
| `single-skill` | 根目录 SKILL.md，无 skills 目录 | manual | 根目录 | 整体作为单个 skill |
| `plugin-only` | marketplace.json 但无 skills 目录 | marketplace | 无（只有 commands/） | 注册 marketplace，不复制 |
| `no-skill` | 无 SKILL.md 文件 | — | — | 中止安装 |

## 模式对比

| | Marketplace | 手动 |
|---|---|---|
| 条件 | `.claude-plugin/marketplace.json` | 无 |
| 子模块位置 | `plugins/marketplaces/<id>/` | `sources/<name>/` |
| skills/ 入口 | 软链接（仅 skill-collection） | 文件副本 |
| plugin-only 处理 | 注册 + 跳过 skill 链接 | 不适用 |
| non-standard dir | 自动检测实际目录名 | 自动检测实际目录名 |
| 记录文件位置 | `sources/.installed-skills.json` | `sources/.installed-skills.json` |
| 更新 skill | 自动（软链接） | 手动 `cp -r` |
| 配置文件 | `known_marketplaces.json` | 无额外配置 |
| 记录中的 type 字段 | `skill-collection` / `plugin-only` | `skill-collection` / `single-skill` |

---

## 注意事项

- `~/.claude` 是 git 仓库，所有操作在根目录执行
- Submodule 的 `git pull` 会改变指针，需一并提交
- `.installed-skills.json` 是唯一真相来源，勿手动修改
- 安装前先 `git status` 确认干净
- 如果安装到一半失败，先 `git reset --hard` 回退再重试
- 临时目录 `/tmp/skill-check-*` 分析完即清理
