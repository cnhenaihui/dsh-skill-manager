# P0 验收报告（dsh-skill-manager）

- 环境：DSH Desktop 0.2.0-rc.2 / Node v25.2.1 / profile `desktop` / GUI `http://127.0.0.1:43120`
- 日期：2026-10-17
- 结论：**P0 全部通过**（核心库 97 项、真实技能库端到端、宿主热装、停用/启用端到端、浏览器设置页验收）

---

## A. 核心库（P0a）

### A1 单测：`node test/run.js`

```
97 passed, 0 failed, 97 total
```

| 套件 | 项数 | 覆盖 |
|---|---|---|
| `frontmatter` | 16 | 合法/非法技能名、宽松布尔（含 `TRUE`/`yes`/`off`/1/0）、三档策略推断、缺/未闭合 frontmatter、必填键、camelCase 旧键拒绝、CRLF、块标量（`>`/`|`）、引号标量、未知键保留、metadata 浅解析、手术式编辑字节级保留、四档策略写回、脚手架生成闭环、**真实技能库 13 个全部可解析**、真实特例（折叠描述 / `agent_created` 未知键 / `grill-me` 仅用户可调用） |
| `scan` | 8 | 根表 rank 与官方一致（100/200/400/500 + `skipSystem`）、项目根回退、扫描形状只有一层、`.system` 跳过、非法条目单列（3 类错误码）、同名遮蔽（rank 小者胜）、**真实库 13 个技能 0 非法**、`srs-generator` 多文件 bundle、其它 Agent 技能库只读导入 |
| `revisions` | 8 | 捕获幂等、内容变更产生新修订、对象去重、逐文件差异、行级 diff、平铺 `.md` 支持、**回滚字节一致 + 快照外文件清理 + 未捕获改动自动备份 + 回滚可逆**、prune dry-run/实删、修订内逃逸路径拒回滚 |
| `policy` | 7 | 默认跟随文件、覆盖表持久化、版本门控退空态、prune 自愈、导入来源开关、旧插件状态解析与迁移预览（**只规划不自动应用 + 风险提示**）、真实旧状态可解析 |
| `pack` | 10 | 导出→读回完整性、篡改检测、裸包（目录/根 SKILL.md）、危险路径拒绝、导入计划五态、落盘导入（暂存+原子替换+不残留旧文件）、历史修订导出、脚手架、真实技能库整包往返 |
| `zip` | 38 | store/deflate 往返、中文文件名（含 `references/线框DSL渲染器V0.1.py`）、目录项、空文件、确定性、DOS 时间位域、6 类不安全名拒绝、CRC 篡改、ZIP64、>64MB、加密、未知 method、latin1 回退、数据描述符、`.NET` 互操作 |
| `host` | 10 | ping/路由表 11 条、list（策略/版本/对照字段）、**策略设置后覆盖 provider 立刻复报改写后的 invocation**、非法参数 400、版本闭环（capture→compare→diff→annotate→restore→detail）、导出 zip 可校验 + 导入 dry-run/apply、历史修订导出旧内容、多技能合并包、404 语义、源文件消失时安全跳过并告警 |

### A2 真实技能库端到端：导出 zip → Windows 自带 `Expand-Archive` → 逐文件比对

命令：`node scripts/acceptance-p0a.mjs`（导出 `srs-generator` + `grilling`）

```
有效技能 13   非法条目 0
技能  baa-generator 39411B/2文件 · change-routing 38778B/3文件 · find-skills 5472B/1文件
      frontend-design 19564B/2文件 · grill-me 294B/2文件(userOnly) · grilling 2162B/2文件
      hyperframes-cli 127718B/11文件 · prototype-clickthrough-auditor 12640B/2文件
      prototype-smoke-test 18248B/1文件 · self-improving-agent 19662B/6文件
      srs-demo-generator 38741B/2文件 · srs-generator 894117B/37文件
      srs-prototype-functional-tester 55313B/9文件
zip 大小 299967B   条目 39   含清单 true
```

第三方交叉验证（不使用本插件的解压代码）：

```
Expand-Archive: ok=39 mismatch=0 missing=0
解压后目录：grilling/  srs-generator/  dsh-skill-package.json
```

### A3 只读性证明

对 `~/.dsh/skills` 递归 80 个文件做 `路径|字节数|LastWriteTimeUtc.Ticks` 快照，跑完整测试台 + 验收脚本后再次快照：

```
测试结论: 97 passed, 0 failed, 97 total
前后文件数: 80 -> 80
真实技能库只读验证：通过，0 处改动
```

插件自己的数据目录此时只有 109 字节的 `state.json`（空覆盖表，0 条策略）：

```
~/.dsh/skill-manager\state.json    109
```

即：插件不写技能库、只写自己的数据目录；导出/导入/回滚/停用全过程对 `~/.dsh/skills` 零改动。

## B. 宿主集成（P0b）

### B1 装载（无需重启）

profile 有 `dsh.profile.patchReload: live`，追加 patch insert 后宿主日志：

```
2026-10-17 18:11:03.282 [I] [dsh-skill-manager] [skill-manager] 已装载 v0.1.0：11 条路由、1 条策略覆盖、
  数据目录 ~/.dsh/skill-manager
```

- 11 条精确路由（`/api/skill-manager.*`）全部注册成功，无重复路由异常
- `client-modules` 客户端模块图**无组合错误、无 FAILED fiber**（该注册表是增量的：新装载的插件会被标记 dirty 并重新组合，索引注入行随之更新）

### B2 停用/启用端到端（核心差异化能力）

不通过 HTTP（整个 web 服务在鉴权栅栏后，非浏览器请求一律 403，包括官方 `/api/present.host` 与 `/`），改用**真实新 agent 的模型侧技能目录**验证：

| 步骤 | 操作 | 观察 |
|---|---|---|
| 1 | 基线 | 本会话目录 13 个技能，含 `frontend-design` |
| 2 | 通过 `createPolicyStore` 写入 `user-dsh/frontend-design = disabled` | `state.json` 落盘：`overrides.user-dsh.frontend-design`（含 path/dir/officialRank） |
| 3 | 强制插件重挂载（删 insert → 重新插入） | 日志：`已装载 … 1 条策略覆盖` |
| 4 | 派一个**全新 subagent** 只读报告其 `<available_skills>` | **12 个技能，不含 `frontend-design`** ✅ |
| 5 | 恢复 `follow` + 重挂载 | 日志：`已装载 … 0 条策略覆盖` |
| 6 | 再派一个全新 subagent 同样报告 | **13 个技能，`frontend-design` 回来了** ✅ |

结论：rank-0 覆盖层在**真实 agent 作用域**内确实压过官方 `dsh-skill-filesystem`，且 `invocation` 改写生效、`get()` 回传改写值正确。第 4 步同时也验证了「按 agent 作用域各注册一份」这条必需路径（全新 agent 走的就是 `agent/created` 分支）。

### B3 浏览器验收（已通过）

宿主装载插件后**没有重启**，用户刷新 `http://127.0.0.1:43120` 即确认：**设置 → 技能管理** 页面出现（技能清单表格可见）。

这与源码行为一致：`dsh-client-modules` 的 `ClientModuleRegistry` 订阅 `internal/plugin` 事件，新装载的插件会被标记 dirty 并**增量重新组合**客户端模块图（`webserver/index-inject` 注入行 + `PLUGIN_ROUTE` 打包路由），因此客户端半随一次页面刷新生效；日志中无 `client-modules` 组合错误、无 FAILED fiber。

### B4 未验证项（诚实标注）

1. **HTTP 层未做真实请求验证**：`/api/*` 与 `/` 对非浏览器请求全部 403（Host/Origin 栅栏 + cookie 鉴权），命令行拿不到浏览器 cookie。因此路由的**请求/响应语义**通过 `test/host.test.js` 的 10 项**进程内直调处理器**验证（同一套代码路径，只少了 HTTP 序列化层），浏览器侧则通过用户实际点击页面验收。
2. **代码热更新未验证成功**：实测「删除 insert → 重新插入」能让插件重新装载并重读状态，但**模块代码仍是旧版本** —— 说明 live reload 复用模块缓存。因此 `lib/index.js` 里最新的自检代码（启动时会打印磁盘技能数/官方目录对照/停用清单）要在**下次宿主重启**后才会出现；本次日志里是上一版自检。

## C. 已知偏差与取舍

1. **DOS 时间按 UTC 编解码**（zip 模块）：为本模块的跨环境确定性主动选择；本模块往返精确，但 Windows 资源管理器/.NET 按本地时间显示会带时区偏移。
2. **停止用不改源文件路线**：策略随本机状态走，不写进 SKILL.md；「写回源文件」的能力已实现但默认不启用。
3. **覆盖按名字生效**：同名技能只禁用某一来源时，其它同名副本也会被一起挡住（与生态同类实现一致）。
4. **`prune()` 无界面入口**：对象库可能无限增长。
5. 严格的 `safeRelPath` 比规范更严（拒绝任意段内冒号、Windows 保留名、结尾点/空格）：宁可拒绝也不产出歧义包。
6. 旧 `dsh-skills-manager` 状态**绝不自动迁移**：本机旧状态把 7 个 dsh 技能全标为停用，自动应用会让技能集体消失；迁移只输出预览 + 风险提示，等用户逐条确认。
