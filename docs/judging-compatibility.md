# 与 LemonLime 的评测一致性

## 对比基准

本项目基于 LemonLime 0.3.7，基准提交为 `69aa22370706a4f14b394a6e27aa92e7eca4a8f5`。

`tests/judging-compat/prepare_reference.py` 从该提交原样提取 `casejudger.cpp`、`taskjudger.cpp`、`processrunner.cpp` 和各平台 runner。两个独立驱动分别链接当前版本与这些原版实现，用同一份临时数据、配置及编译器运行。参考驱动只补充服务器新增的路径设置接口，未更改原版评测算法；公共 Task / Contestant 数据及聚合代码沿用共同代码。Linux 驱动使用打包的 watcher。

比较的字段为：编译状态、逐测试点判定、逐测试点分数和总分。覆盖：

- 逐行／空白比较、空文件、长行、长 token、CRLF、缺失输出、额外输出。
- 实数精度边界。
- Testlib 的 OK、WA、FAIL、部分分、points 和超时；Lemon 校验器的整数分值及异常输出。
- 子任务捆绑、失败后跳过、部分分依赖。
- C++ AC / WA / CE / RE / TLE 和 Python AC / WA。

本机 Windows 对比的 51 个场景，以上字段全部一致；CI 同样运行该回归，具备 diff 的环境另测外部比较器。此测试锁定常用行为，不代表所有程序、硬件和操作系统都能产生逐字相同的结果。

## 保留的差异

不回退已修复的问题来追求错误行为一致：

- 保留 0.1.6 的用户态 CPU 计时、等待超时及重测修复。因此临界超时／大量系统调用程序可能与原版的旧计时行为不同。
- 保留 Unicode 文件读取和每场比赛独立路径，修复原版路径编码及全局工作目录的问题。
- 进度事件会统计被跳过的测试点；这不改变判定和分数。

耗时、内存、路径和诊断措辞不参与逐字比较；这些字段受系统及修复影响。特殊校验器按 LemonLime 协议运行，不替换为其他 OJ 的评分协议。

## 本地复现

先确认 Git 仓库中包含上述基准提交，再执行：

```bash
python tests/judging-compat/prepare_reference.py build/reference
cmake -S . -B build -DBUILD_GUI=OFF -DLEMON_COMPAT_REFERENCE_DIR="$PWD/build/reference"
cmake --build build --target judge-compat-current judge-compat-reference
python tests/judging-compat/compare.py build/tests/judging-compat/judge-compat-current build/tests/judging-compat/judge-compat-reference
```

Windows 使用相应 Qt/MSVC 或 MinGW 环境，最后两个路径加 `.exe`，并保证 Qt DLL 和 g++ 在搜索路径中。测试只使用自行创建的临时目录。

Linux 对照测试默认使用 `/usr/bin/python3`，而不是 CI 工具放在 `/opt` 下的 Python；后者不在原版 runner 的沙箱挂载范围内。可用 `LEMON_COMPAT_PYTHON` 显式指定两个对照引擎共用的解释器，不会为测试关闭沙箱或扩大挂载范围。
