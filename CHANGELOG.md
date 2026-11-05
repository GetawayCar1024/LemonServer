# Changelog

## 0.1.8

**下载**

- Windows x64：`LemonServer-0.1.8-windows-x64.zip`。
- Ubuntu 22.04 / 24.04 / 26.04 x64：`lemonserver_0.1.8_ubuntu_amd64.deb`。

**改进**

- 测试点管理器支持拖动连续选择、双击编辑和更多右键操作：修改／批量修改测试点、修改子任务、绑定、合并、拆分、移动和删除。右侧选择会关联到所属子任务，可直接合并；绑定与排序保留分值和依赖，无法保留的依赖调整会明确拒绝。
- 子任务使用浅深交替底色，选中状态左右一致，浅色／深色模式保持 iOS 风格。排序使用独立把手，避免拖选时选中文字；精简冗余提示。
- 题目列表支持拖动重排，原成绩随题目移动；保存失败时回滚。
- 设置校验器时，可选择已有可执行文件，或勾选“从源文件编译”，从服务器文件列表选择／从本地上传 C/C++ 源码并编译使用。修复旧 GCC 编译内置 Testlib 时缺少整数类型头文件的问题，失败编译不覆盖已有程序。
- 新增 Hydro 配置导入：粘贴 YAML/JSON 或选择本地文件，预览转换结果后导入；无效及不支持的项目逐项提示并跳过。支持时间／内存、文件 I/O、min/sum 子任务、分值、依赖和 Testlib／Lemon 校验器，源码可在导入时编译。详见 `docs/hydro-import.md`。

**评测核对**

- 增加与本项目基于的 LemonLime 0.3.7 原版评测源码的差异测试，覆盖文本、实数、两类特殊校验器、部分分、捆绑／依赖及 C++/Python 运行等场景；逐项比较判定、编译状态、分数和总分。保留既有计时和 Unicode 路径修复，具体范围见 `docs/judging-compatibility.md`。

## 0.1.7

**下载**

- Windows x64：`LemonServer-0.1.7-windows-x64.zip`，解压后双击 `start-server.bat`。
- Ubuntu 22.04 / 24.04 / 26.04 x64：`sudo apt install ./lemonserver_0.1.7_ubuntu_amd64.deb`。

**修复**

- 修复部分系统编码下中文等 Unicode 数据路径导致的“文件错误”：Windows 比较器改用宽字符路径打开文件，并在打开失败时显示具体文件路径。
- 保留中文题目显示名，将其与源程序名、文件输入输出名分开；新建或自动添加中文题目时生成安全英文文件名。源程序名及启用的文件 I/O 名只接受安全 ASCII 文件名，旧配置可打开修改，但不合法的运行文件名会在保存／评测前明确报错，不再等到评测时出现不明原因的文件错误。只修改显示名不会再自动修改源程序名。
- 修复配置还在延迟保存时就开始评测、导致使用旧文件路径的问题：保存按顺序完成，评测、切换页面、打开测试点管理器等操作先等待保存；失败的修改保留并可重试，保存失败时不开始评测。
- 修复 CDF 实际写入失败时接口仍返回“保存成功”的问题；新建／自动添加题目写入失败时不留下未保存的题目。
- 当前选中的题目也可折叠；选中题目不再强制展开测试点，只有手动点击箭头或明确添加测试点才展开。

**验证**

- 增加 Unicode 路径、中文显示名、英文运行文件名、改名后首次评测、配置保存顺序与失败重试、题目折叠的回归测试。

## 0.1.6

**下载**

- Windows x64：`LemonServer-0.1.6-windows-x64.zip`，解压后双击 `start-server.bat`。
- Ubuntu 22.04 / 24.04 / 26.04 x64：`sudo apt install ./lemonserver_0.1.6_ubuntu_amd64.deb`，然后运行 `lemonserver --port 8080`。

**修复**

- 计时：按用户态 CPU 时间（即结果中显示的时间）判定超时。原来 Linux 下 RLIMIT_CPU 把内核态时间也算进去，会出现“时限 1 s、用时 800 ms 却超时”；Windows 下实际时间超过“时限 + 0.2 s”就判超时，启动程序、读写文件或其他评测线程造成的等待也会变成超时。现在用户态时间超过可重测的上限（时限 × (1 + 额外时间比例)）才结束程序；实际时间只用来结束一直在等待的程序（上限 × 2 + 1 s）。
- 超时重测（设置中的“重测次数”）原来不生效：略超时限、不超过上述上限的测试点现在会重测。

**改进**

- 右键菜单与 LemonLime 一致：试题树（新建试题、删除试题、新建测试点、批量添加测试点、删除测试点、测试点管理器；Ctrl+Insert / Insert / Delete），结果表（详情、源程序、评测、删除选手；Delete 删除，Ctrl+A 全选）。
- 结果表中未评测的格子显示“未评测”（已提交）或“未提交”。
- 顶栏标出当前页面；试题树底部的按钮整理为两行；提示语更简洁。

**变化**

- 删除比赛时间：不再在比赛中隐藏成绩、详细结果和源程序，任何时候看到的都一样。旧版本设置的比赛时间会被忽略，API 中的 `startTime` / `endTime` 也会被忽略。比赛时间与赛后评测由 CodeHub（≥ 0.1.1）负责。

## 0.1.5

**下载**

- Windows x64：`LemonServer-0.1.5-windows-x64.zip`，解压后双击 `start-server.bat`。
- Ubuntu 22.04 / 24.04 / 26.04 x64：`sudo apt install ./lemonserver_0.1.5_ubuntu_amd64.deb`，然后运行 `lemonserver --port 8080`。

**改进**

- 结果页的选择：单击选中一格，Ctrl（⌘）单击多选，Shift 单击选择矩形区域，拖动框选；选手名一列代表整行；不会再选中表格中的文字。
- 评测栏底部显示当前评测任务的总进度（已评测测试点的时限 / 全部测试点的时限）。
- 比赛进行中：未提交的格子只显示“未提交”；正在评测时，不显示每份代码是否已评测，评测栏也只显示总进度。

**修复**

- 评测进度：被跳过的测试点（子任务依赖未满足，或同一测试点中前面的子测试点出错）现在也计入进度，评测结束时进度为 100%。这是原版 Lemon 中就有的问题，桌面版的进度条同样受益。

## 0.1.4

**下载**

- Windows x64：`LemonServer-0.1.4-windows-x64.zip`，解压后双击 `start-server.bat`。
- Ubuntu 22.04 / 24.04 / 26.04 x64：`sudo apt install ./lemonserver_0.1.4_ubuntu_amd64.deb`，然后运行 `lemonserver --port 8080`。

**新功能**

- 克隆比赛：比赛列表中点“克隆”，输入新比赛名。默认复制试题、数据和比赛文件夹中的其他文件，不复制选手程序、成绩和导出的结果；可勾选“同时复制选手程序和成绩”。比赛时间不会被复制，down.zip 保留。API：`POST /api/contests/{name}/clone`。

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
