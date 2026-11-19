# My WindTerm

My WindTerm 是一个面向个人的 SSH 桌面客户端，支持 macOS Apple Silicon 和 Windows x64。用 Rust 实现配置存储、SSH 进程、PTY 和文件同步；用 Tauri、WebView 与 xterm.js 实现界面。布局参考 WindTerm 的深色主题：左侧 Filer、中间标签和终端、右侧 Session / Outline、下方 Sender / Transfer。没有复用 WindTerm 源码或图标，也不兼容其配置格式。

## 下载和更新

从 [GitHub Releases](https://github.com/zzxCNCZ/my-windterm/releases) 下载对应平台的安装包：macOS Apple Silicon 选 `macos-arm64.dmg`，Windows x64 选 `windows-x64-setup.exe`。同一 Release 提供 `SHA256SUMS.txt`。**偏好设置 → 通用 → 检查更新** 会检查最新正式 GitHub Release，并提供下载页面，不会自动下载或安装。

Windows 需要安装系统可选功能 **OpenSSH Client**。Windows 版支持 SSH 终端、配置和本地 Filer；远端 Filer / SFTP、rsync、已保存密码自动填入和命令大纲采集暂仅支持 macOS。Windows 可手动输入 SSH 密码，或用 SSH 密钥认证。

macOS 构建没有 Developer ID 签名与公证，Windows 构建没有 Authenticode 签名；从互联网下载时系统可能提示未识别的发布者。

## 快速开始

1. 点击 **New SSH** 新建连接。主机可以填 IP、域名或 `~/.ssh/config` 中的别名。端口和用户名留空时交给 OpenSSH；私钥路径也可留空以使用系统配置或 SSH Agent。
2. 可填写 **SSH 密码** 以便下次自动登录，也可留空，在终端手动输入。编辑时清空该字段并保存即可移除。第一次连接仍需和可信渠道核对主机指纹，再在终端接受。保存的密码仅用于 SSH 密码认证，不会填写密钥口令或交互验证码；需要使用仅支持 keyboard-interactive 的服务器时，请留空后手动登录。
3. 点击 **Group** 新建分组；可在连接编辑器里移动连接，也可在会话或分组右侧的 `⋯` 菜单里编辑、复制或移除项目。删除分组不会删除组内连接。
4. 需要跨设备同步时，打开 **偏好设置（⌘ ,）→ 通用 → 迁移当前配置**，选择专用于 My WindTerm 的 OneDrive 本地文件夹。其他设备用 **打开已有配置** 选择同步后的同一个文件夹。

## 会话保持

- 默认每 30 秒发送 SSH 保活探测；每个连接可单独调整。保活不等于断线后继续执行远端任务。
- 如需重连后回到同一个远端终端，在服务端安装 `tmux`，然后启用连接的 **tmux 持久会话**。应用按连接 ID 生成会话名；断开后点 **Reconnect** 重新附着。结束远端 tmux 会话、远端重启或使用另一个连接 ID 时，不保证能恢复原会话。
- 应用重启只恢复本机的标签及其顺序，不自动重连，也不持久保存终端输出。关标签会断开该 SSH 进程，不会删除已启用的远端 tmux 会话。

## Filer：本地与远端文件

- 连接 SSH 后，左侧 Filer 默认切到当前标签的远端主目录。可以随时切回 **本地**，每个 SSH 标签分别记住本地／远端选择和上次远端路径；断开后回到本地视图。SFTP 复用已认证的 SSH，不会再次询问密码。需要远端开启 SFTP 子系统，并允许在同一个 SSH 连接上打开额外会话通道。
- 双击目录进入，使用 **↑** 返回上级、**⟳** 刷新，或直接输入路径。**⋮** 菜单可回到主目录、显示点文件或选择本地目录。
- 在远端目录点 **⇧** 选择本地文件上传；也可在本地模式选中文件，上传到当前标签的上次远端目录（未浏览时是远端主目录）。在远端选中文件后点 **⇩** 或双击文件，再选择本地下载目录。进度与取消按钮在 **Transfer**。
- SFTP 当前只传输普通文件，不覆盖同名文件。断线时下载不会留下目标文件；未完成的上传会尝试清理，如果连接已断开，远端可能需要手动移除残留文件。上传整目录请用 **Sync**。

## 跟随终端目录和调整面板

- 在 Filer 的 **远端** 模式，点右下角定位图标或按 **F9** 开启跟随。在终端执行 `cd` 并回到提示符后，当前标签的 SFTP 列表会切到上报的目录。切换到本地模式或关闭开关后，不会自动跳转。
- 已发送 OSC 7 或 OSC 1337 `CurrentDir` 的 Shell 无需设置。否则从 Filer 的 **⋮ → 配置 Shell 目录上报** 复制对应 Bash、Zsh 或 Fish 的代码到远端启动文件，重新连接。Bash 登录 Shell 需加载 `~/.bashrc`；若在 tmux 内使用，在远端启用 `set -g allow-passthrough on`。应用不会向终端注入命令，也不会自动改写远端配置。嵌套 SSH 或容器内的路径不一定能由当前连接的 SFTP 访问。
- 拖动终端两侧的分隔线调节 Filer 和 Session 宽度，拖动 Session / Outline 之间或 Sender / Transfer 上方的分隔线调节高度。双击分隔线恢复默认；也可用 Tab 选中分隔线后按方向键微调、Enter 恢复默认。尺寸和跟随开关保存在本机。

## Outline：终端命令大纲

右侧 Outline 显示当前 SSH 标签中识别到的已提交命令，例如 `cat README.md`，不列出文件内容或其他命令输出。单击命令跳转并高亮对应的终端行；双击复制命令到剪贴板，不会执行命令。也可用筛选框查找命令，或用齿轮菜单清空当前标签的大纲。大纲只保留在内存，重连时重置。支持 OSC 133 / 633 命令标记；未配置标记时，根据提交的输入和终端回显识别，不依赖 SFTP。关闭回显的输入、全屏程序的输入、或特殊提示符下从历史召回的部分命令可能不会列出。

## 终端着色与搜索

- 默认给终端里的命令、参数、IP 地址、链接、数字、字符串、代码关键字和常见日志级别着色。远端程序自带的 ANSI 颜色优先；自动着色不会修改输出和复制内容，可在 **偏好设置 → 终端外观** 关闭。
- 在 SSH 标签中按 **⌘ F**，搜索当前终端的命令、代码和输出，包括可回滚的历史。用 **↑ / ↓**、**Enter / Shift+Enter** 或 **⌘ G / ⌘ Shift+G** 循环切换匹配，终端会滚动到对应位置。**Aa** 切换大小写匹配，**Esc** 关闭搜索并回到终端。会话树筛选仍可通过右侧 Filter 或 **Search → 筛选会话** 使用。

## 偏好设置

顶部菜单只保留 **会话、搜索、视图、偏好设置**。按 **⌘ ,** 也能打开偏好设置。

- **通用**：界面语言可选简体中文、English 或跟随系统。打开已有配置只切换目录；迁移会在目标目录复制当前的 `my-windterm.json`，保留原文件并拒绝覆盖目标已有配置。迁移不需要断开 SSH，也不会移动文件夹内的其他文件。
- **终端外观**：可选经典深色、海洋、暖白预设，或自行调整背景、文字、光标、选区及 16 色 ANSI 调色板。支持字体、字号、光标形状与闪烁、自动着色和实时预览。保存后立即应用到已打开和新开的终端；语言与外观保存在本机，不随连接文件迁移。

## 两种文件夹同步

**配置跨设备同步**：软件在指定目录读写 `my-windterm.json`；实际传输由 OneDrive 等软件完成。建议将该目录设为始终保留在设备上。修改后回到窗口会重新检查配置，也可点 **Reload**。文件写入是原子的，保存前会检查本地文件是否已变动；不会合并云端冲突副本，建议不要在多台机器上同时编辑。

同步文件记录连接和分组，包括主机名、用户名、端口、保活选项、可选的私钥路径，以及保存的 **明文 SSH 密码**。应用不使用钥匙串或加密；把配置放进 OneDrive 会连同密码一起同步。请勿共享或提交这个文件，任何能读取它的人都能看到密码。配置不包含私钥文件、主机指纹、终端历史或本机打开的标签。

**本地与远程目录同步**：点击 **Sync**，选择 SSH 连接、两端目录与方向，先预览再执行。两端需要 rsync；应用使用本机 `/usr/bin/rsync` 和 `/usr/bin/ssh`，需要已验证主机指纹，且私钥或 SSH Agent 能非交互登录。目录同步为手动单向增量同步，不删除目标独有的普通文件、不传输符号链接，可能覆盖同名文件。远端源目录须存在；选择易于确认的独立远端目录，避免上传整个主目录。远端路径需为非根目录的绝对路径，支持 ASCII 字母、数字、点、下划线、连字符与斜杠。

## 开发和构建

需要 Rust、Node.js（20.19+ 或 22.12+）及 macOS Xcode Command Line Tools。在项目目录运行：

```sh
npm ci
npm run tauri -- dev
```

如果 Rust 已下载到本项目的 `.toolchain`（未安装到全局），先在项目目录执行：

```sh
export RUSTUP_HOME="$PWD/.toolchain/rustup"
export CARGO_HOME="$PWD/.toolchain/cargo"
export PATH="$CARGO_HOME/bin:$PATH"
```

`npm run tauri -- build --bundles app` 构建本机 `.app`；产物在 `src-tauri/target/release/bundle/macos/`。开发版使用 `--debug`，产物在 `src-tauri/target/debug/bundle/macos/`。本项目未配置对外分发的签名与公证。

发布时同步修改 `package.json`、`package-lock.json`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock` 和 `src-tauri/tauri.conf.json` 的版本，提交后推送与之相同的标签（例如 `1.0.0`）。GitHub Actions 会在两个平台运行测试、构建安装包，全部成功后才创建正式 Release。

## 验证

```sh
npm test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml loopback_ssh_pty_sftp_and_rsync -- --ignored
```

最后一项会在 macOS 上用临时密钥与临时配置监听 `127.0.0.1` 的随机高端口，不启用系统的「远程登录」，也不修改 `~/.ssh`。它覆盖真实 SSH 登录、PTY 输入输出与尺寸、同连接 SFTP 浏览、上传与下载、不覆盖同名文件、取消清理，以及 rsync 预览与目录传输。
