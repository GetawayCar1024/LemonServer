# LemonServer

[![LemonServer](https://github.com/GetawayCar1024/LemonServer/actions/workflows/lemonserver.yml/badge.svg)](https://github.com/GetawayCar1024/LemonServer/actions/workflows/lemonserver.yml)
[![Release](https://img.shields.io/github/v/release/GetawayCar1024/LemonServer)](https://github.com/GetawayCar1024/LemonServer/releases/latest)

LemonServer 是 [Project LemonLime](https://github.com/Project-LemonLime/Project_LemonLime) 的一个 fork：沿用其评测核心（`src/base`、`src/core`、导出 `result.html`、统计）和 `.cdf` 比赛格式，并修复服务器场景下的计时、路径等问题，将 Qt Widgets 桌面界面换成内置 HTTP 服务器、网页前端和 REST API。

- 基于 LemonLime 0.3.7（上游提交 `69aa223`），上游说明见 [README.LemonLime.md](README.LemonLime.md)。
- 与 LemonLime 一样以 GPL-3.0-or-later 授权，见 [LICENSE](LICENSE)。
- 原有的桌面版 `lemon` 仍可照常编译（`-DBUILD_GUI=ON`）。

## 功能

| 网页中 | 对应 LemonLime 桌面版 |
| --- | --- |
| 比赛列表：新建（只需输入比赛名，自动存放在默认比赛位置）、打开、删除、改名、克隆（可选是否复制选手程序和成绩）；导入已配置好的比赛（含 .cdf 的文件夹或 zip，可拖拽） | 新建比赛 / 打开比赛 / 修改比赛名 |
| 试题页：比赛概况树（试题 → 测试点，右键菜单与 Ctrl+Insert / Insert / Delete 快捷键同 LemonLime）、试题设置、测试点设置、自动添加试题、批量添加测试点（模式 + 参数）、上移/下移 | SummaryTree、TaskEditWidget、TestCaseEditWidget、AddTestCasesWizard |
| 测试点管理器：表格内直接编辑分值/时限/内存/依赖/数据路径，多选（Ctrl/Shift），上移下移、拖动排序、合并、拆分、把数据移到其他测试点、批量修改、标出不存在的数据文件、撤销/重做，依赖关系自动跟随调整 | ExtTestCaseModifier |
| 结果页：成绩表（同样的配色；单击 / Ctrl / Shift / 拖动选择；右键菜单“详情 / 评测 / 删除选手”同 LemonLime，另有“源程序”；Delete 删除选手）、评测选中 / 全部 / 未评测 / 按状态重测（NS、CE、TLE、WA…，显示每种状态的数量）、停止评测、侧边栏中的实时评测日志与进度、全局评测队列（所有比赛依次评测，评测期间可编辑其他比赛，正在评测或排队的比赛不能修改，可“全部出队”）、选手详细结果、查看源程序、删除选手、整理选手文件 | ResultViewer、JudgingDialog、DetailDialog、清理文件 |
| 导出 result.html / result.htm / CSV（下载，或保存到比赛文件夹） | 导出结果 |
| 统计页，可导出 statistics.html | StatisticsBrowser |
| 文件：当前比赛文件夹的文件系统（左侧目录树），上传文件 / 文件夹 / zip 到任意文件夹（可直接拖到目录树中的文件夹上）；单击/Ctrl/Shift 多选、拖动移动（Ctrl 复制）、复制剪切粘贴、移动到…、右键菜单、筛选、排序，以及常用快捷键（按 ? 查看）；在线编辑 100 KiB 以下的文本文件（保留原编码和换行符，显示最后修改时间，被他人修改过时提示冲突）；新建、重命名、删除、下载（文件夹打包 zip） | 打开比赛文件夹 |
| Testlib for Lemons：在文件系统中右键或 Ctrl+B 在服务器上编译 C/C++ 源文件（内置 testlib.h，Windows 下静态链接），查看编译输出，一键设为某题的校验器；从内置模板（checkers / interactors / validators / generators）新建文件 | 手动编译校验器 |
| 比赛设置：down.zip（可不设置，供 CodeHub 导入）：上传或指定比赛文件夹中的文件。LemonServer 没有比赛时间，成绩与评测详情任何时候都可查看 | —（LemonServer 专有） |
| 浅色 / 深色 / 跟随系统 | 深色模式 |
| 设置：常规设置、编译器（含自动检测）、评测语言与配色 | 选项对话框、添加编译器向导 |
| 访问令牌（默认 `123456`，可在网页修改）、API Key 管理、默认比赛位置 | —（LemonServer 专有） |

## 安装

从 [Releases](https://github.com/GetawayCar1024/LemonServer/releases/latest) 下载：

- **Windows x64**：`LemonServer-<版本>-windows-x64.zip`，解压后双击 `start-server.bat`。已包含 Qt 与 MSVC 运行库，无需另外安装。
- **Ubuntu 22.04 / 24.04 x64**：`lemonserver_<版本>_ubuntu_amd64.deb`

  ```bash
  sudo apt install ./lemonserver_<版本>_ubuntu_amd64.deb   # 会自动安装评测所需的 bubblewrap
  lemonserver --port 8080                                   # 直接运行
  sudo systemctl enable --now lemonserver                   # 或作为系统服务运行（数据在 /var/lib/lemonserver）
  ```

  程序安装在 `/opt/lemonserver`（自带 Qt 等依赖库），命令为 `lemonserver`。评测期间会阻止系统休眠：系统服务可以直接做到；通过 SSH 手动运行时，需要先把用户加入 `lemonserver` 组（`sudo usermod -aG lemonserver $USER`，重新登录后生效），否则日志中会有一条 “Failed to prevent system sleep” 警告，不影响评测。Ubuntu 24.04 默认限制非特权用户命名空间，如果评测时出现“无法启动程序”且日志中提到 bwrap，可执行 `sudo sysctl kernel.apparmor_restrict_unprivileged_userns=0`。

服务器上还需要安装选手程序所用的编译器（如 g++、python3），首次启动会自动检测。

## 编译

需要 Qt ≥ 6.8（Core、Gui、Concurrent、Network、**HttpServer**，以及 LinguistTools）与 CMake ≥ 3.20。克隆后先取子模块（spdlog、SingleApplication、Testlib-for-Lemons）：

```bash
git clone --recursive <仓库地址>      # 或者已克隆后：git submodule update --init
# 只编译服务器（不需要 Qt Widgets / Svg）
cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release -DBUILD_GUI=OFF
cmake --build build --target LemonServer
```

CMake 选项：`BUILD_SERVER`（`LemonServer`，默认 ON）、`BUILD_GUI`（LemonLime 桌面版 `lemon`，默认 ON）、`BUILD_LEMON_TESTS`（默认 ON）。

Windows 下可以用 `build-env.ps1` 载入 MSVC 2022 + Qt 环境（默认 Qt 路径 `D:\Qt\6.8.3\msvc2022_64`）：

```powershell
. .\build-env.ps1
cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release
cmake --build build
windeployqt build\LemonServer.exe    # 打包运行所需的 Qt DLL
```

Linux 下与 LemonLime 桌面版一样需要 `bwrap`（bubblewrap），`watcher_unix` 会自动编译并嵌入。

## 运行

打包好的 Windows x64 版本放在仓库根目录的 `LemonServer/` 中（含 Qt 与 MSVC 运行库，不纳入版本库），双击其中的 `start-server.bat` 即可。

```
LemonServer [--host 0.0.0.0] [--port 8080] [--config <server.json>] [--web-root <dir>]
            [--use-desktop-settings] [--reset-token]
```

启动后用浏览器打开 `http://<服务器IP>:8080/`：

1. 输入访问令牌（默认 `123456`）。
2. 首次使用需要设置**默认比赛位置**（服务器上的绝对路径），可同时修改令牌。
3. 新建比赛时只填比赛名，会自动创建 `<默认比赛位置>/<比赛名>/<比赛名>.cdf`、`data/`、`source/`。已有的 LemonLime 比赛文件夹可以直接复制到默认比赛位置下，或在网页中导入；LemonServer 生成的比赛同样可以用 LemonLime 桌面版打开。

题目显示名可以用中文。源程序名（不含扩展名）和启用的文件输入输出名使用英文字母、数字、点、下划线或连字符，不可使用路径或系统保留名；改显示名不会重命名程序或数据。中文数据文件夹自动添加为题目时，会单独提供英文源程序名。配置自动保存，开始评测前会等待保存完成；保存失败时请根据提示修正或点击状态重试。

- `--config`：服务器配置文件（令牌哈希、API Key、默认比赛位置），默认在 `%LOCALAPPDATA%\LemonServer\server.json`（Linux：`~/.config/LemonServer/server.json`）。
- 评测设置与编译器默认保存在配置文件旁的 `settings.ini` 中，首次启动会自动检测 PATH 中的 gcc / g++ / fpc / jdk / python。加 `--use-desktop-settings` 则与本机的 LemonLime 桌面版共用设置。
- `--reset-token`：忘记令牌时把它重置为 `123456`。
- `--web-root`：从磁盘目录提供网页（开发前端时使用，默认使用编译进程序的 `web/`）。

> 注意：服务器同一时间评测一场比赛，可以查看或编辑其他比赛，正在评测或排队的比赛不能修改。请务必修改默认令牌，并且只在可信网络中开放端口。

## API

网页本身就完全基于 REST API。认证方式（任选其一）：

- `Authorization: Bearer <API Key>`
- `X-API-Key: <API Key>`
- 查询参数 `?access_token=<API Key>`（方便直接下载）

API Key 在网页“设置 → 令牌与 API Key”中创建（可以自动生成，也可以自己指定），可以使用除“修改令牌 / 管理 API Key”之外的所有接口。完整接口列表见网页中的 **API** 页面，常用流程：

```bash
KEY=lsk_xxx; S=http://server:8080; C=$S/api/contests/NOIP2026
curl -X POST -H "Authorization: Bearer $KEY" -d '{"name":"NOIP2026"}' $S/api/contests
curl -X POST -H "Authorization: Bearer $KEY" --data-binary @data.zip   "$C/files/unzip?root=data&stripTop=1"
curl -X POST -H "Authorization: Bearer $KEY" $C/add-tasks                 # 自动添加 data 下的试题
curl -X POST -H "Authorization: Bearer $KEY" --data-binary @source.zip "$C/files/unzip?root=source&stripTop=1"
curl -X POST -H "Authorization: Bearer $KEY" $C/refresh                   # 刷新选手列表
curl -X POST -H "Authorization: Bearer $KEY" -d '{"mode":"all"}' $C/judge
curl -H "Authorization: Bearer $KEY" "$C/judge/status?since=0"           # 进度 + 每个测试点的结果事件
curl -H "Authorization: Bearer $KEY" -o result.html "$C/export?format=html"

# down.zip，保存在比赛文件夹的 lemonserver.json 中
curl -X PUT -H "Authorization: Bearer $KEY" --data-binary @down.zip $C/down-zip

# 导入一个配置好的比赛（zip 内含 .cdf、data、source）
curl -H "Authorization: Bearer $KEY" --data-binary @contest.zip "$S/api/import-contest?name=NOIP2026&overwrite=1"
# 用 Testlib for Lemons 在服务器上编译 data/aplusb/checker.cpp，并设为第 0 题的 Testlib 校验器
curl -H "Authorization: Bearer $KEY" -d '{"root":"data","path":"aplusb/checker.cpp"}' $C/files/compile
curl -X PUT -H "Authorization: Bearer $KEY" -d '{"comparisonMode":5,"specialJudge":"aplusb/checker.exe"}' $C/tasks/0
```

`tests/server/smoke_test.py` 是一个覆盖主要接口的端到端测试（需要服务器端有 g++）：

```bash
python tests/server/smoke_test.py http://127.0.0.1:8080 /path/to/empty/contest-root
```

路径回归自行启动隔离的临时服务器：`python tests/server/task_paths_test.py /path/to/LemonServer`。前端保存队列使用 `node --test tests/server/autosave_test.mjs`；题目折叠及立即评测的浏览器回归为 `node tests/server/ui_test.mjs /path/to/LemonServer --embedded`（需要 Node.js 24 和 Chromium，可用 `CHROME_BIN` 指定浏览器）。

## 代码结构与对上游的改动

- `src/server/` —— LemonServer 程序：`main.cpp`（启动、日志、翻译）、`contestmanager.*`（相当于 LemonLime 主窗口：打开/保存比赛、调用 `Contest::judge()`、记录评测事件、自动添加试题、整理文件、导入比赛）、`lemonserver.*`（HTTP 路由）、`jsonapi.*`（核心对象 ↔ JSON）、`serverconfig.*`（令牌、API Key、默认比赛位置）、`testlibtools.*`（用 Testlib for Lemons 编译）。
- `web/` —— 网页前端（原生 JS，无需构建），通过 `web/web.qrc` 编译进程序。
- `cmake/lemonserver.cmake` —— `LemonServer` 目标。
- 为了让桌面版和服务器共用代码，对 LemonLime 原有代码只做了少量重构：
  - `ExportUtil` 拆分为无界面的 `generateHtml()/generateSmallerHtml()/generateCsv()/writeResultFile()`（`exportutil.cpp`）与对话框部分（`exportutil_gui.cpp`）；
  - 统计 HTML 的生成从 `StatisticsBrowser` 移到 `src/component/statistics/statisticsutil.*`；
  - `Settings::setSettingsFile()` 允许把设置保存到指定的 INI 文件；
  - `Contest` 新增 `taskJudgingStartedFor` / `compileFinishedFor` 信号（带选手名），原有信号不变；
  - `processrunner_win.cpp` 设置错误模式时保留已有标志，避免弹出“找不到 DLL”等对话框；
  - 计时（`processrunner_*.cpp`、`casejudger.cpp`、`unix/watcher_*`）：按用户态 CPU 时间（即显示的时间）判定超时，用户态时间超过可重测的上限才结束程序，实际时间只用来结束一直等待的程序；“最大重测次数”原来不生效，现已修复。`bash tests/watcher/run.sh` 在 Linux 上测试 watcher；
  - `contest.cpp` 去掉了未使用的 `<QMessageBox>`，评测核心不再依赖 Qt Widgets。
