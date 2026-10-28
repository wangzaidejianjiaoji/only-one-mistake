# only-one-mistake

Codex 的本地上下文经验伴随程序（方案 A）：观察可见会话和工具事件，记录问题与验证结果，让有效经验参与后续决策，并在回合结束请求当前模型复盘。

本仓库只包含 A 的运行时、companion 技能、安装工具、测试和文档。内部运行时、技能及状态目录沿用 `evolveflow` 命名，避免已有安装和记忆失效。

[English](README-EN.md) · [使用说明](doc/only-one-mistake.md) · [架构](doc/架构.md) · [需求与验收](doc/需求与验收.md) · [验证报告](doc/验证报告.md)

## 安装与使用

需要 Node.js 24+。安装器和运行时使用 Node 内置模块，不调用独立后台模型。

```powershell
git clone --branch main https://github.com/wangzaidejianjiaoji/only-one-mistake.git D:\only-one-mistake
cd D:\only-one-mistake
node tools/install-user.mjs install --dry-run
node tools/install-user.mjs install
node tools/install-user.mjs check
```

已有个人级安装时改用 `update`。安装后需在同一配置的 CLI `/hooks` 中审阅并信任定义，再重载宿主。安装检查不能确认桌面对话已加载或已自动触发。

A 覆盖使用同一 CODEX_HOME 的本地会话；经验按项目隔离，跨项目不会自动推广。远程执行主机、云端和其他配置目录不在本次本机安装覆盖内。自动复盘可能增加当前对话用量，用户中断优先。

## 开发与发行

```powershell
npm ci
npm run check
npm run package
```

发行产物为 `dist/only-one-mistake.zip`，包含可安装的 A 插件和用户安装器，不包含工作流技能体系。仓库根目录也是完整 A 插件；使用插件方式仍需宿主加载与信任验证。不要在同一对话重复启用插件、项目 hooks 和用户 hooks。

可选项目安装：`node tools/install.mjs install --mode both --target 'D:\Projects\My Project'`。此处 `both` 指 A 的帮助技能和项目运行时，`skills` 仅帮助技能，`companion` 仅运行时；推荐所有本地对话使用个人级安装。

已取得的 SSH 连接、经验检索、增量来源复盘和回放证据见 [SSH 试点](doc/SSH排查复盘与验证.md)。原生桌面自动监控与新故障自动修复仍待验证；项目名称不代表保证所有错误只发生一次。
