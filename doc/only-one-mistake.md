# only-one-mistake：个人级上下文经验 Agent 使用说明

源码仓库：[wangzaidejianjiaoji/only-one-mistake](https://github.com/wangzaidejianjiaoji/only-one-mistake)，主分支为 `main`。当前源码路径为 `D:\only-one-mistake`，本仓库仅发行 A。本文介绍方案 A 的个人级安装、自动复盘、增量学习与验证方法。代码、命令和状态目录目前沿用 `EvolveFlow` / `evolveflow` 命名；文档重命名不会迁移已有安装或记忆。

用户级 A 通过当前 Codex 配置目录的 `hooks.json` 接入。默认目录为用户主目录 `.codex`，设置了 CODEX_HOME 时使用其实际值。它适用于使用该配置的本地 Codex 对话，包括未安装 EvolveFlow 的项目；远程主机、云端编排及不同配置目录需要分别适配。

## 从 Git 安装

需要 Node.js 24 或更新版本，以及 Git。在准备长期保留源码的位置执行：

```powershell
git clone --branch main https://github.com/wangzaidejianjiaoji/only-one-mistake.git
cd only-one-mistake
node --version
node tools/install-user.mjs install --dry-run
```

检查预览后安装：

```powershell
node tools/install-user.mjs install
node tools/install-user.mjs check
```

安装内容：用户 `hooks.json` 的九类事件、`evolveflow/runtime/` 运行时副本、`skills/evolveflow-companion/` 帮助技能和 `evolveflow/install-user.json` 收据。保留已有 hooks，不改 config.toml，不自动设置 hook trust。支持 `--home <绝对配置目录>` 和 install 的 `--dry-run`。

安装器使用 Node 内置模块，不需要先安装项目依赖。开发和运行测试时才执行 `npm ci`、`npm run check`。也可从 `dist/only-one-mistake.zip` 解压目录运行同一用户安装器；本仓库根目录已包含完整 A 插件，技能位于 `skills/evolveflow-companion/`。

首次在同一配置下启动或重载 Codex 后，通过 CLI `/hooks` 审阅并信任 EvolveFlow 定义。官方要求非托管 hooks 先信任才运行：[Hooks 文档](https://learn.chatgpt.com/docs/hooks)。既有打开的对话可能需要重载；安装文件和模拟输入成功不证明正在使用的桌面对话已经加载。

如果目标项目此前装了项目级 A，可先迁移原记忆，再移除项目运行时的重复 hooks；skills 模式只保留 A 帮助技能：

```powershell
node src/user.ts migrate --project 'D:\only-one-mistake'
node tools/install.mjs update --mode skills --target 'D:\only-one-mistake'
```

migrate 通过 SQLite 备份读取项目状态；保留旧文件，目标已有用户状态时不覆盖。迁移应在首次使用对应用户级状态前执行。不是合并两个都已运行的数据库。

## 自动总结怎样工作

宿主加载并信任 hooks 后，正常聊天即可。A 在会话、输入、工具、压缩和停止等节点收集可见上下文，回合结束时最多请求当前 Codex 模型自动复盘一次：

- 回看重复失败、长难问题、已验证解法、明确纠正和非显然方法。
- 证据足够时提交记忆模板；核心改动保持待确认。
- 没有新经验时只记录“已复盘，无新增经验”及理由，不堆积模板。
- 已核对或暂缓的纠正记录 review 理由；未解决的失败不会被 summary 关闭。
- 总结只确认开始复盘时捕获的上下文快照，不能提前关闭后来消息。
- 用户中断优先，复盘自身的行政命令排除在学习队列之外。

使用当前对话模型配额，可能增加一次续接的耗时和用量。没有另外配置 API key 或独立后台模型；没有要求用户每次手动提出总结。

如果宿主不提供 turn_id，则使用本地用户输入序号并报告去重精度降低；不声称未知事件具有完整覆盖。转录格式不支持或不可读时也会报告。

## 增量学习与当前验证范围

这里的“学习”指经验检索、问题状态更新和记忆模板版本维护，不是训练模型参数。已有证据和有效方法保留，新内容按问题、来源和适用条件补充；结论撤回、授权变化与方案失效需要同步更新当前状态，不能只堆积旧总结。

目前有两类增量机制，需要分别判断：

- 运行时转录采集使用偏移游标并对已观察工具结果去重；压缩、截断、轮转和未知格式会记录覆盖缺口。
- 本次 SSH 来源复盘比较回合与条目指纹，只更新新增内容，保存来源检查点。同一快照再次复盘不会重复提交报告。这是已执行的助手复盘流程；尚未证明任意改写的重复经验都能自动进行语义去重，通用 `report` 接口本身仍会生成新版本。

2026-10-28 的 SSH 增量试点中，完整回合记录从 8 个增加到 10 个，原 8 个回合未变。原经验 ID 保留，版本从 v1 更新到 v2，记忆数仍为 1；同一快照重放后，版本、记忆数和事件数均不再增加。新增状态包含用户重新授权恢复隧道、模型回复与工具执行分别验收，以及本机 Clash 和隧道的依赖条件。部分工具长输出被读取接口截断，不将其说成逐字读取了全部原始记录。

查看 [SSH 复盘与增量证据](SSH排查复盘与验证.md) 和 [验证报告](验证报告.md)。当前已验证本地接口、真实只读 SSH 连接和显式适配器复盘；真实桌面对话自动触发、全局跨项目经验复用及新故障自动修复不能据此判定通过。

## 位置和管理

原始经验按会话工作目录或最近的 Git 根目录隔离，存放于 `<CODEX_HOME>/evolveflow/projects/<工作区哈希>/state`。不自动将项目私有经验推广到其他项目，跨会话只复用符合原范围的经验。

下面以本机项目为例。配置目录按实际 CODEX_HOME 选择；替换工作目录后再执行：

```powershell
$profilePath = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
$routerPath = Join-Path $profilePath 'evolveflow\runtime\src\user.ts'
$projectPath = 'D:\only-one-mistake'
node $routerPath status --project $projectPath
node $routerPath coverage --project $projectPath
node $routerPath summary history --project $projectPath
node $routerPath memory list --project $projectPath
node $routerPath pause --project $projectPath
node $routerPath resume --project $projectPath
```

status 中 summaryRequests 的 `requested` 表示已请求复盘，`completed` 表示已完成，`interrupted` 表示被中断；summary history 是实际写回的复盘记录。手动调用适配器也能产生这些记录，因此还需结合来源和宿主日志判断是否自动触发。`install-user check` 只核对安装文件，不能确认 hooks 已信任或桌面对话已加载。需要当前会话精确状态时加 `--session <实际会话ID>`。用户级技能旁的 `user-install.json` 提供正确 router/home，不假定插件路径。

## 更新、卸载与恢复

在原源码目录更新；Git 工作区有未提交修改时，先保留并处理这些修改：

```powershell
git pull --ff-only origin main
node tools/install-user.mjs update
node tools/install-user.mjs check
```

更新 hooks 定义后按宿主提示重新审阅信任并重载。收据验证被修改的受管文件，遇到变化时拒绝覆盖，应先检查差异，不直接删除收据强制安装。

卸载用 `node tools/install-user.mjs uninstall`。卸载恢复安装前的用户 hooks，保留项目状态，不改宿主信任记录。需要恢复使用时，从同一配置目录重新安装，已有状态继续保留。

首次真实使用验收建议：在同一项目中完成一次问题解决，检查采集事件与验证证据；下一次相关请求应出现对应经验；检查 Stop 后是否有真实复盘记录；再用无变化输入确认没有重复模板。区分“没有可总结的新经验”和“没有捕获到事件”，后者需要检查信任、重载、配置目录与 coverage。
