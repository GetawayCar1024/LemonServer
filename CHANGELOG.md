# Changelog

## Unreleased

- 修复：Ubuntu 安装包缺少 Qt 的 TLS 插件，每个 HTTP 请求都会输出 `qt.network.ssl: No functional TLS backend was found`。现在安装包自带 TLS 插件，并依赖系统的 `libssl3t64` / `libssl3`。
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
