# 交接文档

## 2026-09-04 更新：GitHub Issue #4 第二阶段（踏板辅助）

- 接着第一阶段（和弦手型可视化）往下做。目标是 Issue #4「核心问题 4：增加踏板辅助」，范围收得很
  窄：只做"当前这一刻踏板该踩/该松/保持踩住"的实时提示，不做整曲踏板时间轴、不做踏板准确度评分。
- `lib/analyze.js` 新增 `extractPedalEvents(midi)`：扫描所有轨道的 CC64（延音踏板）controller
  事件，`value>=64` 记为踩下，合并连续同状态的冗余重发。**空数组是合法结果**——公版库里肖邦夜曲
  Op.9 No.2 的 Mutopia MIDI 实测完全没有踏板标记（只有 150 个 CC7 音量事件），跟这份 MIDI 本身的
  制谱方式有关，不是代码 bug；青花瓷（`05_qinghuaci/*.mid`）和巴赫前奏曲则有真实踏板数据（分别
  ~50-206 个 / 12 个 CC64 事件），验证用的就是青花瓷。
- `lib/course-store.js` 新增 `annotateEventsWithPedal(events, pedalEvents)`：给一段已经按 tick 排
  好序的练习事件标注 `pedalDown`（这一刻踏板是否踩着，跨切片边界正确延续之前的状态）和
  `pedalChange`（相对上一个事件，踏板状态是否变化过，对应"这里需要做动作"）。已加入
  `module.exports`（和 `buildHandEvents`/`applyCourseFingering` 一样导出，方便单元测试直接调）。
  `buildPracticeDataFromSelection()` 里接入：`events` 数组的每一项现在多了 `pedalDown`/
  `pedalChange` 两个布尔字段，顶层多了 `hasPedalData`（= 这首曲子的 MIDI 里到底有没有踏板标记，
  前端用它决定要不要显示踏板 UI，没有就完全不渲染，不显示一个永远"抬起"的假提示）。
- `public/index.html` 新增 `renderPracticePedalIndicator(p, event)`，接在 `renderPracticeFingerGuide`
  顶部（在和弦手型面板之上）。三种状态：`change-down`（亮黄，"⬇ 踩下踏板"）、`change-up`（灰，
  "⬆ 松开踏板"）、`holding`（浅黄，"● 保持踩住"）；不踩且没有变化时不渲染，避免变成每个音符下面
  都有的常驻噪音。`openPracticeSession`/`openMeasureLoopPractice` 两条进入练习页的路径都同步透传
  了 `hasPedalData` 到 `state.practice`。
- 测试：`test/analyze.test.js` 新增 3 个用例覆盖 `extractPedalEvents`（读取/合并冗余重发/无标记
  曲子返回空数组）；`test/course-store.test.js` 新增 5 个用例——2 个是 `annotateEventsWithPedal`
  的精确边界测试（切片开始前踏板已踩下、松开后立刻重新踩下、以及"没变化不应误报"），2 个是端到端
  集成测试（用已有的 `__test_twinkle__` 测试课程验证无踏板数据时全部返回 false，用真实的
  `qinghuaci` 课程——只读，没碰它的进度数据——验证前 10 个小节里至少真的出现过一次 `pedalChange`，
  证明数据确实从 MIDI 一路透传到了接口，不是死代码）。`node --test test/*.test.js` 从 83 → **91/91**
  全过。
- 视觉验证：起了临时端口（3799，验证完已停），用青花瓷课程 Playwright 截图确认了三种状态在真实
  数据下都渲染正确（`holding` 是真实练习流程里截的图，`change-down` 用真实数据构造，`change-up`
  当时没能在前 10 小节里正好碰上，用同一个渲染函数手动构造了一个事件对象截图确认，逻辑已经被上面
  的单元测试精确覆盖，不依赖这张截图当证据）。
- 还没做（留给 Issue #4 后续 PR）：模式 B/C、独立的手型训练模式、配色体系推广到整曲谱面——这三项
  和第一阶段结尾列的一样，本次没有往下推进；踏板这条线自身也还有余量：目前只提示"这一刻"，没有像
  Issue 原文 mockup 里"提前预告下一次换踏板"的前瞻提示，如果后续验证发现"看到提示才反应已经晚了"，
  可以在当前数据结构上很容易加一层"预告下一个 change 事件"，不需要改后端。

## 2026-09-04 更新：GitHub Issue #4 第一阶段（和弦手型可视化）

- 新 Issue：[youyi666/Neothesia#4](https://github.com/youyi666/Neothesia/issues/4)「重构钢琴练习视觉交互：
  从 MIDI 跟随播放器升级为 AI 钢琴陪练模式」。这是一个很大的根问题（三种练习模式、踏板系统、和弦对象化
  显示、统一配色体系），按 Issue 里"实施原则"约定不拆成多个新 Issue，本次只做了其中最小可验证的第一片：
  **和弦对象化显示**（Issue 正文「核心问题 1」）。其余（踏板辅助、模式 B/C、专门的 Chord Practice 模式、
  跨谱面的统一配色）都还没做，留给后续同一 Issue 下的 PR。
- 做了什么：`public/index.html` 新增 `detectChordName()`/`describeNoteGroup()`（一个面向初学者的启发式
  和弦/音程命名器，纯前端，不依赖新的后端数据——直接复用 `fingering-engine.js` 早就在算的 `note.finger`）
  和 `renderPracticeChordShapes()`（按手分组，画一条按实际音高比例排布的横条，每个音一个圆点标手指号），
  接到 `renderPracticeFingerGuide()` 顶部，练习页原有的文字卡片列表原样保留在下面。配色按 Issue 建议：
  右手绿色、左手单音（低音）蓝色、左手同时多音（和弦/音程）紫色——**只加在这个新面板里，没有改整曲谱面
  `practiceNoteTone()` 的配色**，那套颜色是"对/错/当前/未练"的练习状态反馈，价值更高，不能被手部配色
  抢掉，这是有意的取舍，不是遗漏。
- 和弦命名是启发式规则模型（同 `fingering-engine.js` 一贯的定位），只覆盖常见三和弦/七和弦，匹配不到就
  退化显示音程名或"N 音和弦"，不会为了好看硬猜一个可能错的名字。用肖邦夜曲 Op.9 No.2 实测：能正确识别出
  `D♯ 大三和弦`（降E大调主和弦的第一转位）等真实和弦。
- 验证方式：`node --test test/*.test.js` 83/83 通过（纯前端改动，不影响现有测试覆盖范围）；额外起了
  `chopin_nocturne_9_2` 课程的真实练习会话，用 Playwright 截图核对了单音/双手同时/三音和弦三种场景在
  桌面宽度和 390×844 移动宽度下的排布，颜色和换行都符合预期。
- 还没做（Issue #4 后续阶段，故意没有一次做完）：踏板辅助（`lib/midi-file.js` 其实已经在解析 CC 事件，
  含延音踏板 CC64，只是 `analyze.js`/`course-store.js` 的 practice-data 接口目前会把它们丢弃，没有导出
  给前端——这是接下来做踏板系统时的现成切入点）；独立的「手型训练/Chord Practice」模式；模式 B（演奏
  模式/五线谱为主）和模式 C（拆解模式）；把配色体系推广到整曲谱面视图。

## 2026-09-01 更新：GitHub Issue #2 第一阶段（课程策略重构）

- `generateDefaultLessons()`（`lib/course-store.js`）对双手曲目改成了"小节闭环课程"：
  按 2 小节一组，每组当场走完 右手 → 左手 → 双手 的闭环，不再是"右手全曲 → 左手全曲 →
  才第一次双手"。每组还会额外生成：
  - 衔接关（`is_connection: true`）：练上一组结尾接这一组开头的那一小段；
  - 连续演奏关（`is_continuous: true`, `practice_mode: 'continuous'`）：从第 1 小节
    不停顿弹到当前已学到的位置，检查点按倍增间隔（1/2/4/8...组）插入，避免长曲子
    （如103小节的《致爱丽丝》）生成几十个重复检查点。
  单手曲目（无左手轨道）行为不变，仍用旧的倍增关卡序列。
- `lib/scoring.js` 新增 `createContinuousModeSession()`：按曲速给每个事件一个到期
  时间，调用方（浏览器 `setInterval` 每 100ms 调一次 `session.tick(Date.now())`）
  到点就强制前进，不管弹没弹对，不会像 `createWaitModeSession` 一样允许用户停下来
  想。`getResult()` 复用和等待模式完全相同的字段形状（`maxCombo`===最长连续演奏
  事件数，`mistakeEventIndexes`===断点），所以 `course-store.js` 的
  `recordPracticeResult`/`meetsPassCondition`/`calculateStarCount` 不需要为连续
  模式另写一套判分逻辑。
- `public/index.html` 按 `lesson.practice_mode` 选择创建哪种 session
  （`createPracticeSession()`），连续模式下额外起一个 100ms 的 `setInterval`
  （`startContinuousClockIfNeeded`/`stopContinuousClock`）驱动 `session.tick()`。
- 新增 `store.computeMasterySummary(course)`：把"完成了多少关"翻译成
  "已稳定双手第几小节 / 当前可连续演奏到第几小节 / 当前速度 / 最长连续演奏 /
  最大卡点"，`GET /api/courses/:id` 现在多返回一个 `mastery` 字段，课程详情页
  顶部会展示。这是首页反馈重构的第一步，还没有做成独立首页卡片。
- **不影响现有用户进度**：`courses/`、`data/user_progress/` 都是 gitignore 掉的
  本地数据，`seedDefaultCourses()` 跳过已存在的课程目录，只有新建课程才会用到
  新算法；已有课程的 `lesson_id` 编号方案没变但具体切分变了，如果要让老用户吃到
  新课程结构，需要用户自己决定是否删除对应 `courses/<id>/` 重新生成（会清空该
  课程的练习进度），这个决定本次没有做迁移脚本，留给使用者手动判断。
- 验收标准里"用《致爱丽丝》做真实回归测试"：本地跑过 `seedDefaultCourses` 生成
  `fur_elise`（105 小节），确认能生成 右手→左手→双手→连续演奏 的完整闭环、
  衔接关、以及覆盖全曲的连续演奏关，日志见本次提交说明，未做真实弹奏验收（需要
  MIDI 键盘，本机不具备）。
- **还没做的**（Issue #2 后续阶段，故意没有一次做完）：宽松节奏模式（模式二）、
  自动难度升降级（连续失败自动降速/缩范围）、首页专门的"真实能力"卡片（目前只在
  课程详情页顶部展示）、错误热图/专项练习自动生成。

写给接手继续开发的 AI / 开发者。这份文档假设你没有看过之前的对话，只看这个仓库。

## 现状一句话总结

这是一个可直接使用的本地钢琴课程 MVP：双击 `启动练琴App.bat` 后会在标准地址 `http://localhost:3721/`
打开课程首页，默认推荐《小星星（双手）》第一关；没有 MIDI 键盘时也可用普通电脑键盘评分。评分关会按阶段要求
累计达标 2/3/4 次，每轮结束 3 秒自动重练或进入下一关，并始终显示整曲灰显谱面与本关高亮。课程进度、星级和
上次练习关卡均会写入本地 JSON。`node --test test/*.test.js` 当前为 **46/46** 通过。

## 用户是谁、想要什么

- 用户在用 Neothesia（一个开源 MIDI 可视化跟弹播放器，仓库根目录 `D:\Neothesia` 就是它的源码）自学钢琴。
- 完整需求文档在
  [`practice_app/基于 Neothesia 的钢琴课程训练系统开发需求说明.md`](./基于%20Neothesia%20的钢琴课程训练系统开发需求说明.md)，
  是一份 20 节、涵盖 5 个阶段的完整产品规划（MVP → 实时评分 → 自适应难度 → 错误热图 → 游戏化）。**不要试图一次性看完就去实现全部**，用户自己在文档里也写了要分轮次做。
- 用户的真实水平：能双手弹《小星星》《欢乐颂》，在学《卡农》，实际正在练的是周杰伦《青花瓷》
  （仓库里 `practice_midis/05_qinghuaci/` 那些文件就是证据——按周分好的段落、四档速度）。
- 用户明确说过"不要让我去弄什么 mid，我不会，要打开就能用的课程"——**这是硬性要求**，任何改动都不能
  退化成"必须先导入/配置才能用"。

## 技术栈决策（已经和用户确认过，不要推翻）

现有仓库里已经有一个手写的 Node.js 网页版曲谱查看器（`practice_app/server.cjs` + `public/index.html`，
零依赖，纯 `http` 模块 + 原生 JS，没有构建步骤、没有框架）。需求文档建议用 Python+PySide6 另起一个桌面
程序，但我和用户确认过：**在现有 Node.js 系统基础上扩展**，不要另起技术栈。所有新代码都是 CommonJS
（`.cjs`/`.js` 用 `require`），前端是一个 1900+ 行的单文件 `public/index.html`（内联 `<script>`，没有打包
工具，直接改，改完刷新浏览器就生效，不需要编译）。

## 目录结构

```
practice_app/
├─ server.cjs              HTTP 服务 + 所有 API 路由（原生 http 模块，见下面路由表）
├─ score-data.cjs          曲谱库用的 MIDI 解析（原有功能，五线谱/简谱查看器用）
├─ lib/
│  ├─ midi-file.js         通用 MIDI 读写：readMidi()/writeMidi()，保留全部事件，可重建文件
│  ├─ analyze.js           曲目分析：BPM/拍号/小节边界/同时落键合并成"事件"（和弦不拆散）
│  ├─ lesson-export.js     关卡切片导出成独立 MIDI：处理跨边界音符、延音踏板、加一小节数拍
│  ├─ course-store.js      课程/关卡生成、JSON 持久化、曲库自动预生成（最重要的一个文件）
│  ├─ neothesia-launcher.js 启动 neothesia.exe 并传入关卡 MIDI 路径
│  └─ scoring.js           实时评分状态机（等待模式）。用 UMD 写法：Node 用 require()，
│                          浏览器用 <script src="/lib/scoring.js">，两边跑同一份代码
├─ public/index.html       全部前端 UI（曲谱库 tab 是原有的，课程 tab + 评分练习页是新加的）
├─ courses/<course_id>/    每个课程的 course.json + source/ 源 MIDI 副本 + lessons/ 导出的关卡 MIDI
│                          （.gitignore 掉了，是用户本地进度数据，不要删）
├─ data/settings.json      最近打开的文件等设置（同样 gitignore 掉了）
├─ test/*.test.js          node:test 单元测试，44 个，全过
├─ 启动练琴App.bat          标准启动入口：打开浏览器并安全替换过期服务
├─ 停止练琴App.bat          标准停止入口：只停止已识别的本 App 服务
├─ start-practice-app.ps1  端口/构建指纹检查与后台服务启动
├─ stop-practice-app.ps1   后台服务安全停止
├─ README.md               面向用户的使用说明
└─ 基于 Neothesia 的钢琴课程训练系统开发需求说明.md   完整需求文档
```

## 数据流 / 核心概念

1. 一个"课程"(course) 对应一首曲子的一个 MIDI 文件，存在 `courses/<course_id>/course.json`。
2. 曲目被 `analyze.js` 解析成"音符事件"(note event)：**同一时刻需要同时按下的一组音符算一个事件**，
   这是整个系统最核心的不变量——任何切片/导出/评分逻辑都不能把一个和弦拆成两个事件。
3. 一个课程包含很多"关卡"(lesson)，每个关卡是这首曲子的一个子范围，用两种方式之一定义：
   - `range_type: 'event'` + `start_event`/`end_event`（按事件序号切）
   - `range_type: 'measure'` + `start_measure`/`end_measure`（按小节切）
4. 关卡默认由 `course-store.js` 的 `generateDefaultLessons()` 自动生成，分三阶段（对应需求文档 MVP功能三）：
   - 阶段 A：单手熟悉（右手/左手分别的小范围）
   - 阶段 B：双手合练（小范围）
   - 阶段 C：扩大范围，**这里做了一个需求文档没有的改进**——原文档给的 7 个固定范围
     （1-2小节、2-3小节……前半段、后半段、全曲）只适合十几小节的儿歌，对 103 小节的《青花瓷》完全不够用
     （会从"第3-6小节"直接跳到"前51小节"）。改成了按曲长自适应的倍增窗口生成
     （`stageCRanges()` 函数），短曲子行为和文档一致，长曲子会插入 8/16/32 小节等中间检查点。
5. 关卡有两种"练习"方式：
   - `POST /lessons/:id/practice`：导出这段为独立 MIDI 文件，`child_process.spawn` 启动
     `target/debug/neothesia.exe <导出的mid路径>`，用户在 Neothesia 里跟弹，**不计入网页评分进度**。
   - 浏览器里的「🎯 评分练习」：调用 `GET /lessons/:id/practice-data` 拿到这个关卡要弹的事件、整曲谱面和
     高亮索引，
     用 `navigator.requestMIDIAccess()` 连接电子钢琴（USB 接电脑），`lib/scoring.js` 的
     `createWaitModeSession()` 实时判断按对/按错/连击，弹完 `POST /lessons/:id/sessions` 保存成绩；简单、
     中等、困难关默认分别累计达标 2/3/4 次，每轮间隔 3 秒自动重练，最后一次达标后自动解锁并进入下一关。

## 已验证的关键事实（不要重新假设，直接用）

- **Neothesia 支持命令行直接打开 MIDI**：`neothesia.exe <绝对路径>`。依据：
  `neothesia/src/song.rs` 里 `Song::from_env()` 读 `std::env::args()[1]`。不需要模拟按键之类的变通方案。
- **Windows 下 Neothesia 启动子进程时，`cwd` 必须设成仓库根目录**（`D:\Neothesia`），否则
  `default.sf2`/`settings.ron` 加载失败（静音或报错）。依据：
  `neothesia-core/src/utils/resources.rs` 里这两个文件是相对**当前工作目录**解析的（`./default.sf2`），
  不是相对 exe 所在目录。`lib/neothesia-launcher.js` 里已经处理了，改动这块代码时不要把这行删掉。
- Neothesia 可执行文件目前只有 debug 构建：`target/debug/neothesia.exe`。`neothesia-launcher.js` 会依次找
  `target/release/` 和 `target/debug/`，找不到会抛出清晰的报错（不是静默失败）。
- 曲库里 `practice_midis/` 下已生成的 MIDI 文件，左右手轨道要么有明确的轨道名（"Right hand"/"Left hand"），
  要么可以靠平均音高猜（`analyze.js` 的 `guessRole()`），16 首种子曲目全部猜对了，没有需要人工纠正的。

## 当前验收与唯一外部边界

- 静态资源和 API 均返回 `no-store`，旧浏览器缓存不会继续使用过期页面。
- 首页默认进入课程，课程排序以《小星星（双手）》为起点；上次未完成关卡会作为“继续练习”恢复。
- 浏览器评分、电脑键盘映射、星级记录、累计达标轮次、3 秒自动重练/进关、整曲谱面灰显与高亮已通过真实浏览器
  与单元测试验收。普通键盘首音的映射为 `A=C4`，实际按键会推进关卡并更新连击/正确数。
- `启动练琴App.bat` 会通过 `/api/health` 返回的 App 身份和完整后端源码指纹判断现有服务是否过期；
  只有确认是本 App 的旧 Node 服务才会替换，未知服务保持不动。`停止练琴App.bat` 也有同样的身份保护。
- 已完成真实验证：旧服务替换、当前服务复用、停止、重新启动、`3721` 标准地址课程首页、电脑键盘评分，以及
  390×844 竖屏与 844×390 横屏无横向溢出。
- 唯一未在本机完成的外部验证是**真实 MIDI 键盘的 Web MIDI 连接**。拿到设备后用 Chrome/Edge、USB 连接到
  运行浏览器的电脑，并允许 MIDI 权限即可验收；没有设备时电脑键盘模式是可用退路。

## 怎么跑起来

双击 `启动练琴App.bat` 是标准入口。它会确认 `3721` 上是否已是当前版本；只有确认是本 App 的旧 Node 服务时才会替换，然后自动打开浏览器。需要停止后台服务时双击 `停止练琴App.bat`。

```bash
cd practice_app
node server.cjs
```

默认端口 3721，`http://localhost:3721`。`GET /api/health` 现在返回 App 身份与启动时源码 SHA-256，供启动器识别过期进程。改端口用环境变量 `PRACTICE_APP_PORT`（调试时建议开一个副本用
不同端口，因为 `courses/` 目录是固定路径，同一台机器上跑两个端口的 server.cjs **会共享同一份课程进度
数据**，调试时手滑很容易把用户真实进度搞坏——我自己就中过这个招，改完记得核对/恢复）。

```bash
cd practice_app
node --test test/*.test.js   # 46 个用例
```

## 已实现范围 vs 需求文档里没做的

已实现（对应需求文档第一、二轮）：MIDI 导入分析、事件合并、课程自动生成（含长曲目自适应）、手动建关卡、
导出练习 MIDI、启动 Neothesia、实时 MIDI/电脑键盘评分（等待模式）、阶段化累计达标轮次、3 秒自动循环、
整曲谱面高亮、星级记录、按 `pass_condition` 自动解锁、续练推荐、曲库自动预生成（16 首现成课程，不需要用户
手动导入）。

没做（需求文档第三、四、五阶段，当前 MVP 范围之外）：
- 宽松节奏模式/严格演奏模式（模式二、三，150–300ms 和弦时间窗口的节奏判分，`lib/scoring.js` 目前只有
  等待模式）
- 自动难度升降级（连续失败自动降速/缩范围，连续成功自动升级）
- 错误热图、专项练习自动生成（`lesson.sessions[]` 已经在存最近 20 次练习记录，数据基础是有的）
- 游戏化成就系统、每日训练计划

## 一些约定/坑，接手时留意

- `course-store.js` 里 `hand_tracks` 用的 key 是 `{left, right}`，不是 `{leftTrackIndex, rightTrackIndex}`
  ——之前有一版这两个地方 key 名不一致导致 `exportLessonFile` 崩溃，已经修好并加了测试
  （`resolveLessonRange` 现在对 key 不一致/左手轨道缺失会抛出清楚的报错，不会是 `events is not
  iterable` 这种莫名其妙的错误了）。
- `analyze.js` 的 `groupIntoEvents()` 判断"同时"用的容差是 `ticksPerQuarter / 32`（约 128 分音符的
  时值），不是固定毫秒数——这个值是我拍脑袋定的，如果发现某首曲子的和弦被错误拆开/合并，先看这个容差
  是否需要调。
- `lib/scoring.js` 用了 IIFE + UMD 写法，是因为它要同时被 Node `require()` 和浏览器 `<script>`
  标签直接加载（`server.cjs` 里有个专门的静态路由 `GET /lib/scoring.js`）。改这个文件时如果加了新的
  顶层 `function`/`const`，记得它们在浏览器里不会泄漏到 `window`（因为在 IIFE 里），这是有意为之，
  不是疏漏。
- 前端 `index.html` 里草稿阶段的原生「简谱查看器」用的是 `state.view` 一个字符串来切页面
  （`'songs'|'tasks'|'courses'|'import'|'course-detail'|'practice-session'`），整个 `render()`
  函数是一次性重新生成整个 `#root` 的 `innerHTML`——没有虚拟 DOM，改动某个页面时注意别把其他 view
  的渲染逻辑写串了。
