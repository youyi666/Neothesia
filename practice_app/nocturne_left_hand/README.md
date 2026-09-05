# Neothesia 夜曲左手练习室

独立、无依赖的静态交互原型。用于验证 `Neothesia/practice_app` Issue #4 的教学视觉，不修改现有课程和评分。

## 本地预览

`npm start`，打开 http://localhost:4173。无需安装依赖。

## 已实现

- 四组原创降 E 大调伴奏手型，含三音和弦和属七和弦的双音骨架；不是肖邦原曲片段。
- 每组分成认识和弦、单独低音、松手换位、重复和弦四步；同指跨区明确分时。
- 音卡、可触摸键盘、左手示意及音高谱同步；可切换备选指法。
- Web Audio 合成琴音、单音/逐音/齐奏试听、本组完整示范与循环；示范速度可调。
- 默认无踏板练习；可选踏板试听、手动虚拟踏板、换和声时的切分踏板示范。
- 大尺寸单组谱面为音高示意，不表示完整节奏。窄屏键盘保留尺寸并自动居中目标音域。
- localStorage 保留组别、阶段、手动进度、速度和踏板偏好；没有真实弹奏检测。

## 数据与集成

`public/app.js` 中 GROUPS 是示例数据：`symbol, title, notes (MIDI numbers), bass, fingerings, move`。
后续接入已有 `/api/courses/:id/lessons/:lessonId/practice-data`：按真实 onset 分组，保留每个音的释放时刻、左右手、指法及踏板 CC64。不能把延音重叠的异时音误当成同时和弦；同一 onset 同手的指法不应重复。真实谱的版本、拍号、节拍和经复核的指法应替换示例，保留已有 `scoring.js` 评分与课程进度语义。

本原型的手动完成记录与原项目的评分完成记录无关，不回写 GitHub，也不回写现有课程。

## 设计依据

- https://github.com/youyi666/Neothesia/issues/4
- https://hub.yamaha.com/keyboards/k-how-to/how-to-use-keyboard-pedals/

无外部字体、音频、图片或分析请求；网站访问由 Sites 的 owner-only 私密发布保护。
