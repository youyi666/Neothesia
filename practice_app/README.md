# 练琴 App

本地网页应用，两部分功能：

1. **曲谱库**（原有功能）：手机/电脑可看的简谱 + 五线谱，配合 Neothesia 跟弹练习。
2. **课程系统**（新增，按《[基于 Neothesia 的钢琴课程训练系统开发需求说明](./基于%20Neothesia%20的钢琴课程训练系统开发需求说明.md)》第一、二轮范围实现）：把一首完整 MIDI 自动拆成一系列小关卡，可以在浏览器里连接电子钢琴实时打分，也可以导出独立 MIDI 在 Neothesia 里跟弹，并记录每个关卡的完成状态。

应用默认打开「课程」，已准备 16 首曲子（含五首儿歌单手、四首双手入门曲、卡农、青花瓷全曲等），**不需要自己导入 MIDI 才能用**。首次会优先推荐《小星星（双手）》；以后会继续推荐上一次未完成的评分关卡。导入功能只在你想加新曲子时使用。

## 启动

双击 [启动练琴App.bat](./启动练琴App.bat)。启动器会自动打开浏览器、复用当前版本的服务，并只会替换已确认属于本 App 的旧服务；未知的 `3721` 服务不会被停止。

也可以直接运行：

```bash
node practice_app/server.cjs
```

默认监听 `http://localhost:3721`（局域网内手机可用 `http://<本机IP>:3721` 访问）。需要彻底关闭后台服务时，双击 [停止练琴App.bat](./停止练琴App.bat)。
每次启动会自动检查曲库里是否有还没生成课程的曲子，自动补上（已存在的课程不会被覆盖，进度不会丢）。

## 课程系统怎么用

1. 打开网页就会看到「继续练习」和已经生成好的课程列表，点「开始评分练习」即可。
2. 点进一个课程，关卡按顺序解锁：练完上一关才能开始下一关。
3. 每个关卡两种练法：
   - **🎯 评分练习**（新增，实时打分）：网页直接通过 Web MIDI 连接你的电子钢琴（USB 连接，用 Chrome 或 Edge 打开）；还没有 MIDI 键盘时，也可以改用电脑键盘练第一批小关。弹对当前该弹的音才会走到下一个，实时看连击/正确数/错音数。简单、普通、困难关分别默认需要累计达标 2、3、4 次；每轮结束倒计时 3 秒自动重练，最后一次达标后自动进入下一关。评分页始终显示整曲五线谱，本关事件高亮、其余灰显。
     评分页顶部有一个固定不动的工具条：**🔊 播放示范**（随时点、随时能听这一段该弹的旋律和节奏；Web Audio
     纯合成的钢琴音色——按谐波衰减 + 击弦噪声瞬态模拟，不是真实采样，但比单振荡器电子音更接近钢琴）和
     **🔁 开启循环练习**——不管当前是哪一关，点一下就能把这一关切成「只管反复弹、
     不计入课程进度和星级」的模式，每轮结束 3 秒后自动重来；再点一下关闭就恢复正常的达标计分。不用像以前
     那样先退出去选小节。
   - **在 Neothesia 中练习**：导出这一小段为独立 MIDI（自动加一小节数拍），启动 Neothesia 打开，看下落音符跟弹（不计入网页评分进度）。
4. 想单独磨某一个还没建过关卡的小节：课程详情页最下面「🔁 单小节循环练习」，直接指定小节号 + 左右手，
   不用先建关卡，点「开始循环练习」就进入同一套评分页（同样有顶部的播放/循环工具条），页面上还能直接切
   「上一小节／下一小节」。
5. 也可以在课程详情页最下面「＋ 手动添加关卡」，自己指定小节/事件范围、左右手、速度。
6. 想加新曲子：点「导入新曲目」→ 从曲库选或上传本地 `.mid` 文件 → 确认左右手轨道（会自动猜，猜错了自己改）→ 生成课程。

## 目录结构

```
practice_app/
├─ server.cjs              HTTP 服务 + API 路由
├─ score-data.cjs          曲谱库用的 MIDI 解析（原有）
├─ lib/
│  ├─ midi-file.js         通用 MIDI 读写（保留全部事件，可无损重建文件）
│  ├─ analyze.js           曲目分析：BPM/拍号/小节边界/音符事件合并（和弦不拆散）
│  ├─ lesson-export.js     关卡切片导出：处理跨边界音符、延音踏板、加数拍
│  ├─ course-store.js      课程/关卡生成与 JSON 持久化，含曲库自动预生成
│  ├─ fingering-engine.js  左右手感知的整曲指法生成与人体工学规则校验
│  ├─ neothesia-launcher.js 启动 Neothesia 并传入关卡 MIDI 路径
│  └─ scoring.js           实时评分状态机（等待模式），Node 和浏览器共用同一份代码
├─ tools/audit-fingering.cjs 全曲库指法一致性与可弹性审计
├─ courses/<course_id>/    每个课程的 course.json + 源 MIDI 副本 + 导出的关卡 MIDI
├─ data/settings.json      最近打开的文件等应用设置
└─ test/                   node:test 单元测试
```

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET  | `/api/midi/list` | 列出 `practice_midis/` 下所有 MIDI 文件（相对路径） |
| GET  | `/api/health` | 启动器使用的服务身份、构建版本与就绪状态 |
| POST | `/api/midi/analyze` | body `{path}`，分析一个曲库内的 MIDI |
| POST | `/api/midi/upload?name=x.mid` | 请求体为原始 MIDI 字节，上传并分析 |
| GET  | `/api/courses` | 课程列表 |
| POST | `/api/courses` | 创建课程，body `{title, sourceMidiPath, leftTrackIndex, rightTrackIndex}` |
| GET  | `/api/courses/:id` | 课程详情（含全部关卡） |
| POST | `/api/courses/:id/lessons` | 手动添加关卡 |
| POST | `/api/courses/:id/lessons/:lessonId/practice` | 导出该关卡 MIDI 并启动 Neothesia |
| POST | `/api/courses/:id/lessons/:lessonId/complete` | 维护接口；课程界面不提供单次标记完成 |
| GET  | `/api/courses/:id/lessons/:lessonId/events` | 该关卡的目标音符事件（带左右手标记），评分练习用 |
| GET  | `/api/courses/:id/lessons/:lessonId/practice-data` | 目标事件、整曲谱面与本关高亮索引 |
| POST | `/api/courses/:id/lessons/:lessonId/sessions` | 保存一次评分结果，累计成功轮次达到要求后解锁下一关 |
| GET  | `/api/courses/:id/measures/:measureIndex/practice-data?hand_mode=` | 单小节循环练习用；与上面的 lesson practice-data 同结构，但不需要先建关卡（`measureIndex` 从 0 开始） |
| GET/POST | `/api/settings` | 读取/更新应用设置 |

## 测试

```bash
cd practice_app
node --test test/*.test.js
node tools/audit-fingering.cjs
```

自动化用例覆盖：MIDI 读写往返、和弦不被拆散、跨边界音符（提前按下/延后释放）、延音踏板与
program change 的状态延续、小节/拍号变化、课程默认生成去重（含长曲目阶段 C 的自适应扩展）、
关卡解锁链、Neothesia 可执行文件定位、曲库自动预生成的幂等性、以及评分引擎的和弦判定/连击/
左右手准确率/累计达标轮次、完整谱面高亮数据、星级结果的计算与持久化、左右手音阶与穿指、
专项训练显式指法、课节间指法稳定性、谱面与当前音提示一致性、启动器的服务身份检查。

`audit-fingering.cjs` 会遍历所有课程和课节；缺指法、和弦交叉、不可弹跨度、同一音符在不同课节
使用不同手指、谱面与当前音提示不一致都会让命令以非零状态退出。拇指落黑键、超出初学者舒适
范围但曲目本身无法避免的高级和弦，只作为人工复核警告列出。

**未纳入自动化测试、已手动验证的部分**：
- 启动 Neothesia 弹出真实窗口并加载导出的关卡 MIDI（用真实曲目跑通过）。
- 评分练习页面的完整交互流程，用模拟的 MIDI 消息在浏览器里驱动 `handlePracticeMidiMessage` 走完
  整关，确认了连击/正确率/结果页/自动解锁下一关都符合预期。
- `navigator.requestMIDIAccess()` 本身连接真实电子钢琴——**这部分没有物理硬件可测**，代码按
  Web MIDI 标准 API 编写，未支持/拒绝授权/无设备三种情况都有对应提示和「改用 Neothesia（不计分）」
  的退路，但真实钢琴连上后的手感需要你自己验证一下。Web MIDI 目前只有 Chrome / Edge 桌面版支持
  （Safari、手机浏览器不支持），电子钢琴需要用 USB 连接电脑（不是连 Neothesia，是连浏览器）。

## 已验证但未假设的事情

- Neothesia 主程序**支持**命令行直接打开 MIDI：`neothesia.exe <path>`
  （`neothesia/src/song.rs` 的 `Song::from_env` 读取 `args()[1]`）。
- Windows 下 `default.sf2` / `settings.ron` 是相对**当前工作目录**解析的
  （`neothesia-core/src/utils/resources.rs`），所以启动子进程时 `cwd` 必须设为仓库根目录，
  否则会静音或报错找不到音色库。

## 本轮范围 / 尚未做的事

已实现：MIDI 导入、事件合并、曲库自动预生成课程、默认课程入口与续练推荐、手动建关卡、导出练习 MIDI、启动
Neothesia、实时 MIDI/电脑键盘评分（等待模式）、按难度累计达标轮次、3 秒自动重练/进关、整曲谱面高亮、星级与
练习记录、按 `pass_condition` 自动解锁下一关。

**尚未做**（文档里属于第三、四、五阶段，这轮没做）：
- 宽松节奏模式 / 严格演奏模式（模式二、三，带 150–300ms 和弦时间窗口的节奏判分）
- 自动难度升降级（连续失败自动降速/缩小范围，连续成功自动升级）
- 错误热图、专项练习自动生成
- 游戏化成就系统、每日训练计划

`practice_mode` 字段目前每个关卡都固定是 `wait`，为后续节奏模式预留；评分结果已按
`lesson.sessions[]` 存了最近 20 次记录，为后续错误热图统计打好了数据基础。
