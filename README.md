# dsh-skill-manager

DSH 技能管理插件：**技能注册、技能介绍、导出 zip 包、版本跟踪、停用/启用**。零运行时依赖（不含任何 npm 包，也不声明任何 `@deepseek-ai/dsh-*` peerDependency）。

- 宿主半：`lib/index.js`（装配 + 覆盖 provider + HTTP 路由）
- 浏览器半：`client.js`（设置页 → **技能管理**）
- 核心库：`lib/core/*`（纯 Node，可独立单测）
- 测试台：`node test/run.js`（当前 **145 项全绿**）

---

## 1. 为什么自研：生态里缺的两件事

侦察了 18 个同类插件（见 `_research/skill-plugins/REPORT.md`）后的结论：

| 能力 | 生态现状 | 本插件 |
|---|---|---|
| 清单 / 介绍 / 停用启用 | 覆盖充分（lolkda、lijian-ui、weibaohui、yanglaofish…） | 有空 |
| **导出 zip 包** | **零实现**（所有 zip 都是单向导入），且**没有任何 zip 带清单** | **自带 `dsh-skill-package.json` 清单 + 逐文件 sha256** |
| **版本跟踪** | 只有两块互不相连的半成品：`.skm-backups/<名>-<时间戳>` 备份目录（无索引/diff/回滚）、内存态 sha256 manifest（不落盘成历史） | **内容寻址快照 + 时间线 + 逐文件差异 + 行级 diff + 一键回滚** |

另外补了两件生态里没人做的事：
- **frontmatter 诊断**：官方遇到非法 frontmatter 会**静默丢弃**整个技能；本插件把这些条目单独列出来并说明原因。
- **磁盘清单 vs 官方目录对照**：把「磁盘上扫到的技能」与 `ctx.skills.snapshot()` 逐名对照，暴露"看起来存在但用不了"的技能。

以及一件"让能力默认就发生"的事：
- **首开基线 + 未捕获改动巡检**：没有版本记录的技能会在页面顶部提示并支持**一键建立基线**；已有基线的技能若磁盘内容变了，会标记「有未捕获改动」并可一键补齐。版本历史不再依赖用户记得手动点"捕获"。

## 2. 安装（本地开发安装，已验证可热装）

```powershell
# 1) 建 junction（零依赖，不需要 pnpm install）
$link   = "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\@cnhenaihui\dsh-skill-manager"
$target = (Resolve-Path .).Path   # 本仓库根目录，请在该目录下执行
New-Item -ItemType Junction -Path $link -Target $target

# 2) 往 profile 的 patch 层追加一段 insert（追加到 ~/.dsh/profiles/desktop/cordis.patch.yml 末尾）
#    - insert:
#        - id: skill-manager
#          name: "@cnhenaihui/dsh-skill-manager"
```

该 profile 声明了 `dsh.profile.patchReload: live`，因此**新装插件会即时装载，无需重启宿主**。

### 卸载

删掉 `cordis.patch.yml` 里那段 `- insert:`，再删 junction 与 `~/.dsh/skill-manager/` 即可（技能文件本身不受影响）。

## 3. 使用

浏览器刷新后：**设置 → 技能管理**。

界面按「平时看列表、要用才展开」组织，默认一屏就能看完整库：

- **顶栏**：技能数 / 未捕获改动数 / 扫描时间，右侧三个动作——`导入`、`导出全部`、`重新扫描`（图标）
- **工具条**：搜索（名字或描述）+ 筛选 + 批量操作（未选中时只显示「全选」）+ `整理`
- **提示条**：只在真有问题时出现——缺基线、有未捕获改动，右侧一键「建立基线 / 捕获改动」，可关闭
- **列表**：一行一个技能 = 勾选框 + 展开箭头 + 名字（「被遮蔽」「N 项提示」小标）+ 一行描述 + 来源·版本数·最近修订；策略胶囊在右侧，点开即改
- **分组视图**：建过分组后，列表按分组分层显示，每组可折叠、显示技能数；未分组固定为最后一组
- **详情（行内展开，同时只开一个）**：策略说明、路径/来源/体积/**所属分组**/状态、frontmatter 提示、捕获行（备注 / 标签 / 捕获 / 导出当前）、版本历史、选中版本的对比·导出·回滚·备注、逐文件差异、`SKILL.md` 原文（折叠）
- **诊断（折叠在底部）**：官方静默丢弃的技能、目录差异、扫描告警、扫描根——正常使用时完全不占版面

能力一览（都收在上面这套界面里，不额外占版面）：

- **分组与排序**（`整理` 进入，按钮变成「完成整理」）：
  - **技能排序**：拖动技能行，落目标行上半区插入其前、下半区插入其后
  - **分组排序**：拖动分组标题调整组的先后
  - **跨组移动有三条路径**，技能多时不必"边拖边滚"：
    1. **拖拽投放栏**：一开始拖动，顶部常驻一条投放栏，列出全部分组 + 未分组；拖到哪个 chip 上就归入哪组
    2. **批量移到分组**：勾选任意多个技能后，批量区出现「移到分组…」下拉，选一个组批量移动（也可移回「未分组」）
    3. **详情里的「所属分组」下拉**：展开单个技能即可改
  - **新建 / 重命名 / 删除分组**：整理模式里的「新建分组」为内联输入（回车创建 / Esc 取消）；分组标题悬停出现「重命名 / 删除」。删除分组只让技能回到「未分组」，不删技能
  - 「恢复默认顺序」清空自定义排序，回到扫描顺序
  - 搜索或筛选生效时自动退回扁平列表（过滤结果落进空组会造成大段空白）
- **策略**（5 档，不改源文件）：
  | 档位 | 效果 |
  |---|---|
  | 跟随文件 | 由 SKILL.md 自己的 frontmatter 决定（默认） |
  | 启用 | 模型与用户都可用 |
  | 仅用户可调用 | 从模型技能目录消失，仍可用 `/名字` |
  | 仅模型可调用 | 不出现在 `/` 菜单 |
  | 停用 | 两路都不可见 |
- **版本**：`捕获当前为新版本`、打标签/备注、与最新版逐文件对比、单文件行级 diff、**回滚**（回滚前自动备份当前状态，回滚本身可逆）；**首开一键基线**与**未捕获改动提示**（见 §1）
- **导出**：单技能 / 选中 / 全部 / 任意历史修订 → 带清单的 zip；**同名多副本自动分配唯一顶层目录**（`name` / `name--来源`），避免第三方解压静默覆盖
- **导入**：上传 zip → 先出计划（`create`/`overwrite`/`rename`/`skip`/`invalid`，冲突策略可选）→ 确认后才落盘；导入前做**清单 sha256 校验 + frontmatter 前置校验**；同一包内的同名副本会按 `sourceIndex` 精确定位，不会被名字覆盖

### HTTP 接口（全部在 Connection 的鉴权栅栏内，精确路由）

`/api/skill-manager.` + `ping | list | detail | policy | revisions | capture | annotate | restore | compare | export | import | baseline | status | layout`

`layout` 同时接受 `GET`（读）与 `POST`（局部更新 `groups` / `assignments` / `order`，三者都可选）。`list` 也会随清单一起下发 `layout`，界面一次请求即可画完最终顺序，不会出现"先按扫描序渲染、再跳成自定义序"的闪烁。

## 4. 数据布局

```
<DSH_HOME>/skill-manager/
  state.json                       策略覆盖 + 分组/排序（同一份原子写；版本门控：未知版本退空状态）
  revisions/<sourceKey>/<name>/
    index.json                     修订时间线（事件序列，最新在前）
    <contentHash>.json             整包 manifest（逐文件 path/bytes/sha256）
  objects/<ab>/<sha256>            文件内容，全局内容寻址去重
  tmp/                             临时落盘
```

`state.json` 里与布局有关的部分：

```jsonc
{
  "version": 1,
  "overrides": { /* 策略覆盖，原样保留 */ },
  "layout": {
    "version": 1,
    "groups": [{ "id": "g_x1y2", "name": "工具类" }],      // 数组顺序 = 分组显示顺序
    "assignments": { "user-dsh::code-review": "g_x1y2" },  // 技能 key → 分组 id
    "order": ["user-dsh::code-review", "user-dsh::baa"]    // 完整有序 key 数组
  }
}
```

**`order` 存完整有序列表，而不是每个技能一个序号**：拖动一次就得到全序并整体提交，前后端都不必计算"相邻两项的中间值"，因此没有浮点精度耗尽也没有并发写冲突；读取时 rank = index，天然去重、紧凑。未出现在 `order` 里的技能（新装的）排在最后并保持扫描顺序，不会插进中间。

**布局是可选字段，刻意不升 `STATE_VERSION`**：`normalizeState` 在版本号不匹配时会整体退回空状态，为一个附加功能升版本号会让所有老用户的策略覆盖（哪些技能被停用）在升级瞬间被清空。所以布局走"缺失即空布局"的降级路径。

修订 id = 整包 manifest 的 contentHash：**内容相同不产生新修订**；改一个字节即产生新修订；只改 mtime 不变。

## 5. 关键机制与坑（都已实测）

1. **停用不能靠"不报告"**。官方注册表只做"同名取优先级最高者"，因此停用的唯一正路是**以更高优先级复报同名技能并改写 invocation**。本插件用 rank 0 覆盖层（官方文件系统 provider 是 100~600）。
2. **必须同时按 agent 作用域各注册一份**。agent preset 会在更近的作用域里再挂一份 `dsh-skill-filesystem`，近层直接胜出，只注册全局层在某些会话里会失效。
3. **策略变化在下一个模型步生效**（目录按需重建、缓存按 revision 失效），当前回合不变——这是官方行为，不是 bug。
4. **`patchReload: live` 只对新装插件有效**：重新挂载会复用已缓存的模块，所以**改插件代码必须重启宿主**（本次实测：删除 insert 再重新插入能让插件重新装载并重读 `state.json`，但模块代码仍是旧的）。
5. **本插件刻意不声明任何 `@deepseek-ai/dsh-*` peerDependency**：`dsh-app-boot` 会对每个官方 peer 做 `semver.satisfies(runtime, range, { includePrerelease: true })`，在 `0.2.0-rc.2` 这种 prerelease 下极易被判不兼容而整体拒载。能力一律通过 `ctx` 服务名（`skills` / `connection`）在运行时取用。
6. **不改源文件是取舍**：好处是绝对不动用户手写的 frontmatter（含未知键、注释、缩进、CRLF）；代价是策略随本机状态走，换机器/换工具看不到。四档策略"写回源文件"的能力已在 `lib/core/frontmatter.js` 里实现（手术式替换，保留其它字节），作为可选动作保留。
7. **同名副本必须在 zip 里消歧**：技能名同时也是 zip 顶层目录时，同名多副本会产出重复条目名，第三方解压器（资源管理器 / bsdtar / Expand-Archive）会**静默后者覆盖前者**。现在由 `assignEntryRoots()` 统一分配唯一顶层目录（重名追加 `--来源后缀`），并在清单里记录 `entryRoot`；`createZip` 另加重复条目名拒绝，作为最后一道防线。旧包（无 `entryRoot`）仍按「顶层目录 = 技能名」读取，向后兼容。
8. **导入不能按名字找技能**：同一个包里可以有两个同名技能（不同来源），因此 `planImport` 的每个动作带 `sourceIndex`，`applyImport` 按索引取技能；旧计划没有该字段时退回按名字查找。否则两份同名副本会被写成同一份内容。

## 6. 开发

```powershell
node test/run.js                # 全部 145 项
node test/run.js zip revisions  # 只跑名字匹配的用例
node scripts/acceptance-p0a.mjs # 真实技能库 → 导出 zip → 输出 expected.json
```

- 测试只写 `os.tmpdir()`，对真实技能库一律只读（有专门的前后快照校验）。
- 界面可视化验证：`.design/harness/harness.html`（直接用浏览器打开）用迷你渲染器 + 假 API 加载**真实的 `client.js`**，无需宿主即可看浅色/深色、展开态、策略菜单、版本对比、行级差异、导入对话框、分组视图与整理模式；配套 `harness-dark.html` / `harness-menu.html` / `harness-diff.html` / `harness-import.html` / `harness-groups.html` / `harness-organize.html` / `harness-many.html`（20 技能规模，用于验证拖拽投放栏）。改动 `client.js` 后先在这里过一眼，再刷新宿主的设置页。
- 打包 zip 用自研零依赖实现（`lib/core/zip.js`）：store/deflate、UTF-8 文件名标志位 bit 11、CRC32、DOS 时间、确定性输出、拒绝 ZIP64/加密/未知方法。
- `lib/core/frontmatter.js` 是**行式、缩进感知**的 frontmatter 解析 + 手术式编辑：不做完整 YAML 反序列化，因此未知键、注释与原始格式全部保留。官方实际只读 6 个键（`name` / `description` / `whenToUse` / `metadata` / `disable-model-invocation` / `user-invocable`），其中三个 camelCase 旧键（`disableModelInvocation` / `modelInvocable` / `userInvocable`）会让官方**丢弃整个技能**——本插件会显式拦截。

## 7. 尚未完成（后续阶段）

- P5：技能注册脚手架 UI（已有 `scaffoldSkill` 后端能力）、右侧栏 tab（`main` + `sidebar.panellist`）、中英文 i18n、旧 `dsh-skills-manager` 状态迁移的确认界面（**绝不自动应用**：本机旧状态把 7 个 dsh 技能全标为停用，自动迁移会让技能集体消失）
- 覆盖层是**按名字**生效：同名技能里只禁用某一个来源时，另一个同名副本也会被一起挡住（该机制与生态同类实现一致）
- `revisions/` 与 `objects/` 无限增长，`prune()` 已实现但没有界面入口
- 导出包里的 `entryRoot` 是新增字段；旧版本插件读新包时会把它当未知字段忽略（仍按技能名找目录），新版本读旧包则走兼容分支
- **分组只影响本插件的显示顺序，不影响模型看到的技能目录**：它是"我怎么看这些技能"的组织方式，不是注册顺序。要改可见性请用策略（停用/仅模型/仅用户）
- 拖拽排序用**原生 HTML5 拖放**，触屏上没有效果（桌面 DSH 不受影响）。触屏或不便拖拽的场景请用「移到分组…」下拉或详情里的「所属分组」，它们不依赖拖放
- 分组不随导出包带走：zip 里仍是扁平目录 + 清单，换台机器不会带过去（与策略同一取舍，见 §5.6）
