# Changelog

## 0.1.3

**下载**

- Windows x64：`LemonServer-0.1.3-windows-x64.zip`，解压后双击 `start-server.bat`。
- Ubuntu 22.04 / 24.04 / 26.04 x64：`sudo apt install ./lemonserver_0.1.3_ubuntu_amd64.deb`，然后运行 `lemonserver --port 8080`。

**新功能**

- 评测队列：所有比赛的评测请求进入同一个队列，依次评测（每次评测内部仍按“评测线程”并行）。评测进行中提交的请求会排队，不再报错；相同的请求不会重复排队。
- 评测期间可以打开和编辑其他比赛。正在评测或排队的比赛可以查看、可以继续提交评测，但不能修改；点“全部出队”可移出它的全部任务（正在评测的会停止）。评测设置、编译器和默认比赛位置仍需评测结束后修改。
- 评测面板显示正在评测的比赛和排队列表，可移出单个任务；比赛列表显示“评测中 / 排队中”。
- API：`POST /api/contests/{name}/judge` 改为加入队列并返回任务；新增 `DELETE /api/contests/{name}/judge`、`GET /api/judge-queue`、`DELETE /api/judge-queue/{id}`、`GET /api/judge/status`。

**修复**

- Linux：从 zip 导入或上传的比赛中，编译好的校验器会丢失可执行权限，导致整场评测出错。现在打包和解压 zip 时保留可执行权限，评测前也会自动补上。

## 0.1.2

**下载**

- Windows x64：`LemonServer-0.1.2-windows-x64.zip`，解压后双击 `start-server.bat`。
- Ubuntu 22.04 / 24.04 / 26.04 x64：`sudo apt install ./lemonserver_0.1.2_ubuntu_amd64.deb`，然后运行 `lemonserver --port 8080`。

**修复（Ubuntu）**

- 安装包缺少 Qt 的 TLS 插件，每个 HTTP 请求都会输出几行 `qt.network.ssl: No functional TLS backend was found`。现在安装包自带 TLS 插件，并依赖系统的 `libssl3t64` / `libssl3`。
- 作为系统服务运行时，评测期间无法阻止系统休眠，每次评测都会输出 “Failed to prevent system sleep” 警告。安装包现在带有 polkit 规则，允许 `lemonserver` 用户和 `lemonserver` 组成员这样做。
- 安装测试增加 Ubuntu 26.04。

## 0.1.1

**下载**

- Windows x64：`LemonServer-0.1.1-windows-x64.zip`，解压后双击 `start-server.bat`。
- Ubuntu 22.04 / 24.04 x64：`sudo apt install ./lemonserver_0.1.1_ubuntu_amd64.deb`，然后运行 `lemonserver --port 8080`。

**新功能**

- 比赛时间（可不设置）：比赛中不能查看成绩、详细结果、源程序、导出和统计，只显示提交情况（代码长度）和是否已评测；评测日志不显示测试点结果。比赛结束后不能再修改时间。在“比赛设置”中设置，或用 `PUT /api/contests/{name}` 的 `startTime` / `endTime`。
- down.zip（可不设置，备用）：上传或指定比赛文件夹中的文件，`GET / PUT / DELETE /api/contests/{name}/down-zip`。
- 以上属性保存在比赛文件夹的 `lemonserver.json` 中，`.cdf` 格式不变。
- 通过网页或 API 修改 `source/` 下的提交（上传、编辑、解压、删除、移动、重命名）后，对应结果自动变为未评测。
- `POST /api/contests/{name}/judge` 新增 `"refresh": true`，评测前先刷新选手。

## 0.1.0

LemonServer 的第一个版本：基于 LemonLime 0.3.7 的评测核心，提供网页界面和 REST API。

**下载**

- Windows x64：`LemonServer-0.1.0-windows-x64.zip`，解压后双击 `start-server.bat`（已包含 Qt 与 MSVC 运行库）。
- Ubuntu 22.04 / 24.04 x64：`lemonserver_0.1.0_ubuntu_amd64.deb`，`sudo apt install ./lemonserver_0.1.0_ubuntu_amd64.deb`，然后运行 `lemonserver --port 8080`，或 `sudo systemctl enable --now lemonserver`。

启动后用浏览器打开 `http://<服务器IP>:8080/`，默认访问令牌为 `123456`，请在首次登录后修改。服务器上需要安装选手程序使用的编译器（如 g++）；Ubuntu 上评测依赖 bubblewrap（安装 .deb 时会自动安装）。

**功能**

- 比赛：在默认比赛位置中按名称新建、打开、改名、删除；导入已配置好的比赛（含 .cdf 的文件夹或 zip）。
- 试题与测试点：自动添加试题、按模式批量添加测试点、测试点管理器（表格编辑、多选、拖动排序、合并 / 拆分、撤销 / 重做，依赖关系自动调整）。
- 评测：全部 / 选中 / 未评测 / 按状态（NS、CE、TLE、WA…）重测，侧边栏实时显示评测日志与进度，选手详细结果与源程序。
- 导出 result.html / result.htm / CSV，统计页与 statistics.html。
- 文件系统：目录树、上传文件 / 文件夹 / zip、拖动移动与复制、剪切粘贴、右键菜单、快捷键，在线编辑 100 KiB 以下的文本文件（冲突检测）。
- 使用内置 Testlib for Lemons 在服务器上编译校验器，并一键设为试题的校验器。
- 访问令牌与 API Key，完整的 REST API（网页中的 API 页面有说明）。
- 浅色 / 深色模式。
