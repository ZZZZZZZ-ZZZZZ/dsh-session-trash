# dsh-plugin-session-trash · 会话回收站

[English](README.md) | 中文

DeepSeek Harness（DSH）插件：在侧栏会话菜单里加入“移到回收站”。会话不会被直接删除，而是进入回收站；之后可以在“设置 → 会话回收站”中**恢复**，或**再次确认后永久删除**。回收站从不自动清理。

- 兼容 DSH 0.2.x（`engines.dsh: >=0.2.0-rc.2 <0.3.0`，含 0.2.1-alpha 预览版）
- 支持 macOS 与 Linux；Windows 上插件会自动停用（无法检查会话写锁）
- 只支持官方 JSONL 会话存储（DSH 默认配置）

## 安装

**桌面版**：打开侧栏的 **插件** → **添加插件**，在“包名或地址”中填入以下任一项，点 **安装**，完成后点 **立即启用**（新装的插件默认关闭）：

- GitHub 地址：`https://github.com/ZZZZZZZ-ZZZZZ/dsh-session-trash`，指定版本可写 `github:ZZZZZZZ-ZZZZZ/dsh-session-trash#v0.2.1`
- npm 包名：`dsh-plugin-session-trash`
- 本地安装包的绝对路径，例如 `/path/to/dsh-plugin-session-trash-0.2.1.tgz`（由 `pnpm pack` 生成）

仓库已包含构建好的 `lib/`，从 GitHub 安装不会运行任何构建脚本。如果提示无法访问 GitHub，需要能访问 GitHub 的网络环境；DSH 提供的国内镜像只加速 npm 包，不能代替 GitHub 仓库。

不要填写源码目录：源码目录的 `node_modules` 里有开发用的 DSH 包副本，会和 DSH 自身的包冲突。

**命令行**（可选）：在 DSH 应用菜单 **Manage dsh Command…** 中安装桌面版自带的 `dsh` 命令，完全退出 DSH 后运行：

```sh
dsh plugin --profile desktop add dsh-plugin-session-trash
```

**卸载**：在 **插件** 页面找到“会话回收站”点 **卸载**，或退出 DSH 后运行 `dsh plugin --profile desktop remove dsh-plugin-session-trash`。回收站中的会话保存在 `~/.dsh/session-trash/`，卸载不会删除它们。

## 使用

1. 在侧栏会话的“…”菜单中点 **移到回收站**，确认后会话从侧栏消失。如果它在本次启动中打开过，会先被隐藏，下次启动 DSH 时自动移入回收站。
2. 打开 **设置 → 会话回收站**：
   - **恢复**：会话回到原来的位置，原有的归档 / 置顶状态一并恢复；
   - **永久删除**：再次确认后删除本地会话记录，无法撤销；
   - **清空回收站**：确认后逐个永久删除，遇到第一个失败就停止。

## 安全设计

| 规则 | 说明 |
|---|---|
| 不碰正在使用的会话 | 有运行中的回合、子智能体、后台任务或定时提醒时拒绝；被其他 DSH 进程写入的会话（持有 `session.lock` 写锁）也拒绝 |
| 打开过的会话延迟移入 | 本次启动中打开过的空闲会话会立即从侧栏隐藏（官方归档），在下次 DSH 启动、任何会话打开之前再移入回收站；那时仍做全部检查，不满足就继续等待下一次启动。等待期间可在回收站页面撤销 |
| 只移动、不复制 | 移入回收站和恢复都用同一磁盘内的 `rename`；回收站在另一个磁盘时直接拒绝 |
| 不用 `rm -rf` | 永久删除只逐个删除 DSH 自己写入的会话文件（日志代际、发布临时文件、`session.lock`），目录用非递归 `rmdir` 删除；发现任何其他文件就整体拒绝，不删任何东西 |
| 路径边界 | 回收站条目 id 必须是 UUID；会话目录及其上级必须是普通目录（不能是符号链接），且解析后仍在 DSH 会话根目录内；回收站目录不能在会话根目录内 |
| 崩溃安全 | 移入回收站先在 `.staging-<id>` 中准备，最后一次 `rename` 发布；中途崩溃时下次启动自动回滚 |
| 经过认证的接口 | 浏览器通过 DSH 的 `/api` 网关（Typert Remote，带连接认证）调用；不注册无认证的 HTTP 路由 |
| 官方接口 | 隐藏 / 恢复会话用官方 `archiveSession` / `unarchiveSession` / `pinSession`，不直接改写 DSH 的存储数据 |

子智能体会话随父会话一起移入回收站和恢复；fork 出的会话是独立对话，不受影响。项目文件夹和工作区文件从不被触碰。

## 配置

| 字段 | 默认值 | 说明 |
|---|---|---|
| `trashDirectory` | `<DSH home>/session-trash` | 回收站目录；必须在会话根目录之外，并与其在同一磁盘 |

## 永久删除只删除本机数据

**永久删除**只删除本机上的副本，无法删除 DSH 已经发送给 DeepSeek 的内容：

- 使用 DeepSeek 官方 API 时，DSH 默认随每次请求上传会话记录（官方插件 `@deepseek-ai/dsh-session-log-deepseek`）。在设置中关闭“在使用官方模型 API 时上传 Session Log”只会停止之后的上传；重新打开时，关闭期间记录的内容也会被上传。
- 发送给官方 API 的图片会作为文件上传，DSH 请求 DeepSeek 在 7 天后使其过期，但不保证远端一定删除。

本插件不发出任何网络请求，不向任何地方发送数据。

## 已知限制

- 本次启动中打开过的会话要到下次启动 DSH 时才真正移入回收站（插件无法安全地释放 DSH 持有的写锁）；在那之前它只是被隐藏。
- 只处理会话日志目录；其他插件或功能为会话保存的附件、缓存、spill 文件不在回收站范围内（附件占用可用下方的附件库查看）。
- 依赖 DSH 0.2.x 的 JSONL 存储目录结构；DSH 大版本升级后需要重新验证。

## 相关插件

**[附件库 · dsh-plugin-attachment-library](https://github.com/ZZZZZZZ-ZZZZZ/dsh-attachment-library)**：会话回收站只处理会话记录，对话里的图片和文件附件会一直留在本机。附件库是一个只读页面（设置 → 附件库），列出所有附件占用的空间，以及哪些对话（包括回收站里的）还在使用它们，并可在访达中显示或用预览打开。两个插件同时安装时，附件库会把回收站里的对话也计入统计。

安装：在 **插件 → 添加插件** 中填 `github:ZZZZZZZ-ZZZZZ/dsh-attachment-library#v0.4.1`。

## 开发

```sh
pnpm install
pnpm run typecheck
pnpm test        # 构建 lib/ 后运行全部测试
```

`lib/` 随仓库提交，供从 GitHub 安装时直接使用；修改源码后请运行 `pnpm run build` 并一起提交 `lib/`。

客户端测试从 `tests/vendor/ui-primitives` 加载真实的 0.2.0-rc.2 界面组件（tag `dsh-v0.2.0-rc.2` 的 DSH 源码原样副本，MIT 许可证，见 `tests/primitives-shim.ts`），因为 npm 上发布的组件构建只能在 DSH 页面内运行；不需要 DSH 源码目录。测试使用 npm 上发布的 DSH 0.2.0-rc.2 包：真实 JSONL 会话存储、真实工作区注册表与 Typert 网关，会话数据全部在临时目录中生成。
