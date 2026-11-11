# Hydro 配置导入

在题目编辑器点击“导入 Hydro 配置”，粘贴 `config.yaml` / `config.yml` 的内容，或选择本地 YAML/JSON 文件。数据目录填写相对于比赛 `data/` 的目录；先上传测试数据，再解析和导入。解析结果显示将导入的子任务／测试点数量，以及跳过项目。

## 转换范围

| Hydro 配置 | LemonServer 行为 |
| --- | --- |
| `type: default` / `submit_answer` | 传统题 / 提交答案题；未指定时默认传统题 |
| `time`、`memory` | 全局 → 子任务 → 测试点继承；支持 `s/ms/us`、`k/m/g` 等单位，转换为整数毫秒与 MiB |
| `filename` | 设置文件输入输出名；缺省、空串或 null 使用标准输入输出 |
| `cases` | 按 sum 计分，转换为独立测试点 |
| `subtasks` 的 `min` / `sum` | min 保留捆绑，sum 展开为独立测试点；整数余分分给最后的测试点，与 Hydro 的分配顺序一致 |
| `score` | 非负数，支持小数；Hydro 的零值表示未指定，使用默认分配并提示 |
| `id`、`if` | 按依赖顺序排列，并把依赖映射到转换后的全部对应子任务；无效编号、循环依赖会提示并跳过 |
| `checker_type: testlib` / `lemon` | 已有可执行文件可直接使用，C/C++ 源码可勾选编译后使用 |
| 未显式列出测试点 | 可从指定目录的 `.in` 与 `.out/.ans` 配对，识别 `1_1.in` 等子任务编号 |

缺少引用文件、无效限制、非法路径、不支持的类型、`max` 计分、语言倍率、交互器、额外文件等，不会静默当成支持的配置使用，而是提示跳过。YAML 语法错误需先修正，不能安全猜测其结构。

LemonLime 的一个捆绑子任务共享时限和内存限制；Hydro 的同一 min 子任务内若有不同测试点限制，会提示忽略不一致的覆盖，使用子任务限制。小数分值会保留，sum 子任务均分小数总分；整数总分仍将余分分给最后的测试点。Hydro 的 `default` / `strict` 比较器与 LemonLime 空白处理并不完全等价，因此不擅自替换当前比较方式。导入后请检查比较方式、分数与警告。

导入只修改所选题目的配置，不移动测试数据，不修改源程序名。校验器编译失败会保留当前校验器，其余合法配置仍可导入。

## 实现依据

核对于 2026-11-05：

- [Hydro 配置类型](https://github.com/hydro-dev/Hydro/blob/master/packages/common/types.ts)
- [测试点读取](https://github.com/hydro-dev/Hydro/blob/master/packages/common/cases.ts)
- [子任务及分值分配](https://github.com/hydro-dev/Hydro/blob/master/packages/common/subtask.ts)
- [校验器协议](https://github.com/hydro-dev/Hydro/blob/master/packages/hydrojudge/src/checkers.ts)

YAML 解析器随程序离线打包，采用 JSON schema，不允许可执行 YAML 类型。版本、来源和许可证见 `web/vendor/README.md`。
