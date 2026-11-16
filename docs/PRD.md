# 赶词工 · PRD v0.1

> 赶词工，别让单词等你。

面向自制力不足的学习者的**主动触发型单词复习工具**。不是你去点开软件，是软件到点来找你。

## 1. 范围

### 做
- 本地词库：手动新增/编辑/删除，CSV 批量导入导出，按词表分组
- 定时调度：多个复习时段、触发间隔、单次词数
- 两种复习形态：温和置顶弹窗、强制全屏（应用级锁定 / Kiosk 级锁定两档）
- 复习记录与统计：认识/不认识标记、学习日志、间隔排程
- 每日延后配额：有限次数「稍后」，用完只剩「开始复习」
- 紧急逃生快捷键，任何锁定状态下都能解锁
- 全本地 SQLite，零云端上传

### 不做（明确排除）
- 账号、云同步、多设备
- 移动端
- 社交、排行榜、打卡分享
- 联网查词、联网取例句（离线词典覆盖不到的词，释义留空并标记「待补充」）

## 2. 核心循环

```
设置时段 → 到点 → 主进程弹出一轮卡片 → 逐词翻转标记 → 更新间隔排程 → 写日志 → 关窗
                                        ↘ 点「稍后」→ 扣当日额度 → 推迟 N 分钟
```

## 3. 复习排程（简化间隔重复）

每个单词有 `interval_days` 与 `due_at`。

| 标记 | interval 变化 | 说明 |
|---|---|---|
| 认识 | 0→1→2→4→8→16→30（封顶 30） | 指数翻倍 |
| 不认识 | 直接打回 1 | `lapses += 1` |

**抽词规则**（一轮 N 个词，默认 10）：
1. 已学过且 `due_at <= now` 的词，按 `due_at` 升序优先
2. 不足时补新词（尚无 `word_states` 的词），按录入顺序
3. 仍不足时补最接近到期的词（`due_at` 升序，允许提前复习）
4. 全部为空 → 不弹窗：到点触发的空轮记一条 `status='empty'` 的 rounds 行留痕；用户手点「开始复习」抽不到词只回 `no_words`，不往历史里塞空轮
5. 一本词都没有时排程进入 `out_of_words`：面板不再预告倒计时，删掉最后一批词也会立刻回到这个状态；录入或导入第一批词后自动接回网格

## 4. 延后配额

- `delay_quota_per_day` 默认 3，`delay_minutes` 默认 10
- 消耗额度的动作：温和弹窗点「稍后」或点右上角关闭、强制模式下点「本轮稍后」（额度未耗尽时可用）
- 跨天重置：按 `YYYY-MM-DD` 本地日期存一行 `delay_slots`
- 额度耗尽：弹窗只保留「开始复习」和全局逃生键；文案写明「今日 3 次延后已用完」
- 推迟时间若落 out 复习时段之外，自动钳回该时段内最近的一个可触发点

## 5. 两种复习形态

### 温和弹窗（`mode = gentle`）
- 无边框、`alwaysOnTop`、不抢焦点、可拖动、默认屏幕右上角
- 可关（= 消耗 1 次延后额度）
- 单显示器，尺寸 420×300

### 强制全屏（`mode = fullscreen`，锁定强度 `lock_level`）

**`app`（应用级，默认）**
- 全屏无边框 + `alwaysOnTop` 最高层 + 禁止关闭/最小化 + 失焦立即夺回
- 窗口内 Escape 不退出
- 不碰系统快捷键、不禁用任务栏 —— 用户仍可 Alt+Tab 走开，但本轮记 `aborted` 并写日志
- 实现稳定，无杀软风险

**`kiosk`（Kiosk 级，需在设置里显式开启并二次确认）**
- 在应用级之上，由一个 PowerShell 子进程安装 `WH_KEYBOARD_LL` 低级键盘钩子，屏蔽 Alt+Tab、Win、Alt+F4、Ctrl+Esc
- 逃生组合 `Ctrl+Alt+Esc` **由钩子自身识别**：钩子主动放行并自行退出 → 主进程检测到子进程退出即解除全屏
- 心跳：主进程每 2 秒向子进程 stdin 写一次心跳，超过 15 秒无心跳子进程自动卸载钩子并退出（主进程崩溃也不会锁死桌面）
- 子进程被 kill 即钩子消失，无残留
- 已知边界：Ctrl+Alt+Del 是 winlogon 安全序列，任何用户态钩子都无法屏蔽 —— UI 上必须如实写明
- 设置页文案要提示：键盘钩子可能被个别杀软提示，属正常

多显示器：强制模式默认覆盖所有显示器（`lock_all_displays`，可关）。

## 6. 数据模型（SQLite，`userData/gancigong.db`）

```sql
lists(id, name UNIQUE, remark, created_at)
words(id, list_id→lists, term, phonetic, meaning, example, tags,
      need_meaning INTEGER, created_at,
      UNIQUE(list_id, term))
word_states(word_id PK →words, interval_days, due_at, reps, lapses,
            last_rating, last_reviewed_at)
rounds(id, planned_at, started_at, finished_at, mode, planned_count,
       rated_count, status)              -- status: done|aborted|skipped|empty
round_items(id, round_id→rounds, word_id→words, position, rating, shown_at)
delay_slots(day TEXT PK, used, quota)
events(id, kind, detail_json, at)        -- escape_used|kiosk_locked|import|quota_exhausted…
settings(key PK, value_json)
```

`settings` 键：`schedule_windows`（时段数组）、`interval_minutes`、`words_per_round`、`mode`、`lock_level`、`lock_all_displays`、`delay_quota_per_day`、`delay_minutes`、`tts_enabled`、`autostart`、`active_list_id`、`escape_shortcut`。

存储引擎用 Electron 45 自带的 `node:sqlite`（`DatabaseSync`），不引 `better-sqlite3`：零原生模块、不随 Electron 版本重编译，安装失败面和包体都更小。代价是只有同步 API —— 千级词条的量够不到瓶颈。绑定参数不接受布尔，一律先转 0/1。

## 7. 离线词典

- 数据源：ECDICT 派生的 `cdict_query@1.0.0`（MIT，含 `word/phonetic/translation/tag/frq/exchange`）
- 构建期脚本 `scripts/build-dictionary.mjs` 过滤考试标签（`zk gk cet4 cet6 ky`）→ 生成 `resources/dictionary/words.json`，实测 **18162 词条 / 3.01 MB**（17334 条带音标、15203 条带词形变化），另建一份「变形 → 原形」倒排索引，`abandoned` 这类词也能命中
- 打包时该目录走 `extraResources`（在 asar 外），运行时按 `process.resourcesPath/resources/dictionary` 读取
- 运行时只做本地查表，不联网
- 导入/新增时若释义为空则自动补全，补不到则 `need_meaning = 1`
- 音标做字符修正（ECDICT 老字形 `ә` → `ə`），词形变化 `exchange` 解析为 `派生形式` 展示

## 8. CSV 约定

- 编码：导入兼容 UTF-8（含/不含 BOM）与 GBK；导出统一 UTF-8 BOM（Excel 直接双击不乱码）
- 表头自动映射：`word|term|单词|apparent` → term；`meaning|释义|翻译|translation|chinese` → meaning；`phonetic|音标`；`example|例句`；`tag|标签|词表`
- 只有单词列时，释义走离线词典
- 导出：`term,phonetic,meaning,example,tags,interval_days,due_at,reps,lapses`

## 9. 复习卡片交互（逐词翻转）

```
[单词 大字]  [音标]           ← 正面
   显示释义（空格）
──────────────────────────────
[释义] [词形变化] [例句]        ← 背面
   不认识(1)  认识(2)          ← 快捷键
进度点 ●●○○○○  本轮 3/10
```
- 键盘优先：Space 翻面、1/2 标记、Enter 下一词
- TTS：`speechSynthesis` 系统语音朗读单词（背面加读例句），无网络依赖
- 本轮最后一词标记完 → 结算页（用时、认识率）→ 自动关窗恢复桌面

## 10. 逃生与安全

- 全局快捷键 `Ctrl+Alt+Esc`（Electron `globalShortcut`）在任意模式下中断本轮并写 `escape_used` 事件
- Kiosk 钩子的逃生判定在钩子内部完成，不依赖 Electron 是否还活着
- 中断本轮：已标记的词保留排程更新，未标记的词不改动
- 每次启动恢复调度器前，若发现上次异常退出留下的 `status=aborted` 未完成轮次，静默补记事件，不重复弹窗轰炸

## 11. 验收要点

1. 导入 3000 词 CSV 无释义 → 自动补全率 ≥ 90%，剩余标记待补充
2. 设时段为「当前分钟起 10 分钟，间隔 1 分钟」→ 到点自动弹窗，无需任何点击
3. 温和弹窗点关闭 → `delay_slots.used` +1，第 4 次起只剩「开始复习」
4. 强制全屏 Alt+F4 / 任务栏关闭 / 关闭窗口均无效，标记完成后可正常操作桌面
5. Kiosk 下 Alt+Tab、Win 无效；`Ctrl+Alt+Esc` 一定能解锁；强杀主进程后 15 秒内钩子自动释放
6. 杀掉进程重启 → 词库、排程、日志、设置全部还在
7. 全部读写走本地，进程无任何出站网络请求

### 实测结论（2026-11-03，dev 与安装包双验）

| 验收项 | 结果 | 关键数据 |
| --- | --- | --- |
| 1 导入补全 | 通过 | 3000 行无释义 CSV，`missingMeaning` 0（100% 补全），耗时 399 ms；词形反查索引命中是补全率的关键 |
| 2 到点自动弹窗 | 通过 | 调度器在计算出的 `nextFireAt` 准点触发（round 16），全程零点击；空库时 `nextFireReason=out_of_words`，不预告倒计时 |
| 3 延后额度 | 通过 | 额度用尽后仅剩「开始复习」，`delay_slots.used` 逐次 +1 |
| 4 应用级全屏 | 通过 | Alt+F4 / 关窗无入口，本轮标完后窗口自动关闭、桌面恢复 |
| 5 Kiosk 级 | 通过 | Win、Alt+Tab、Alt+F4、Ctrl+Esc 全部被吞（钩子侧 `BLOCKED` 计数上报）；`Ctrl+Alt+Esc` 退出码 7；主进程被强杀后心跳断供，退出码 8 自动解锁（15 s 内） |
| 6 重启持久 | 通过 | kill 主进程再拉起，词库/排程/日志/设置全在 |
| 7 无出站网络 | 通过 | 运行时依赖仅 papaparse；词典与发音均本地 |

安装包：`release/赶词工-0.1.0-setup.exe`（NSIS x64，122,297,630 字节）。打包态独立验证过词典从 `process.resourcesPath` 载入（18162 条 / 3,160,605 字节）、逃生键注册成功、完整跑完一轮并跨重启保留数据。
