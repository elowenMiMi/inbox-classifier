# Inbox Classifier · 收件箱自动整理

Find new notes, suggest a folder and tags for each one, **ask before adding new tags**, then file the note and rebuild your folder tree.

自动发现新笔记，按规则建议目录与标签，**加新标签前先询问**，确认后归类并重建目录树。

## Features · 功能

| English | 中文 |
| --- | --- |
| Detects new notes on startup and on an interval (default 10 min); the status bar shows how many are waiting. | 启动时与定时（默认 10 分钟）扫描新笔记；状态栏显示待整理数量。 |
| Suggests a destination folder from keyword rules; child notes automatically follow their parent note. | 按关键词规则建议目录；子笔记自动跟随母题。 |
| New tags are only **proposed**, never added silently — and only terms that repeat across the batch. | 新标签只**提议**不擅自添加，且只提议在这批笔记里反复出现的词。 |
| Applying a decision writes tags, moves the file (internal links updated), and appends a backlink block. | 应用后写入标签、移动文件（内部链接自动改写）、文末补关联块。 |
| One command rebuilds the ASCII folder tree with live note counts. | 一条命令按当前文件夹重建目录树与篇数。 |
| If you override the suggested folder, the title→folder pair is remembered for next time. | 手动改过目录的标题会被记住，下次同标题自动照此归档。 |

## Installation · 安装

**Community plugins** (once listed): Settings → Community plugins → Browse → search **Inbox Classifier**.

**BRAT** (available now): `BRAT: Add a beta plugin for testing` → `elowenMiMi/inbox-classifier`.

**Manual**: copy `main.js`, `manifest.json`, `styles.css` into `<vault>/.obsidian/plugins/inbox-classifier/`.

---

**社区插件市场**（上架后）：搜索 **Inbox Classifier**。

**BRAT**：填入 `elowenMiMi/inbox-classifier`。

**手动**：三个文件放进 `<库>/.obsidian/plugins/inbox-classifier/`。

## Usage · 用法

1. Click the status bar item (or run **Scan inbox and build a sorting plan**). · 点状态栏，或执行「扫描收件箱，生成整理方案」。
2. Review each row: tick the ones to process, change the destination folder if needed. · 逐条确认：勾选要处理的、必要时改目录。
3. Tick any new tags you want to add to the vocabulary, then press **Apply**. · 勾选要加入词库的新标签，然后点「应用」。

## Rule file · 规则文件

Default path `inbox-rules.json` (configurable). Example:

默认路径 `inbox-rules.json`（可改）。示例：

```json
{
  "inbox": ["Inbox"],
  "excludeFolders": ["Templates", ".trash"],
  "defaultFolder": "90-unsorted",
  "studyPattern": "multiple choice|true or false|short answer",
  "folders": [
    { "folder": "10-work/11-project-a", "tag": "area/work/project-a", "keywords": ["project a", "retro"] }
  ],
  "types": [{ "tag": "type/retrospective", "keywords": ["retro"] }],
  "projects": [{ "tag": "project/x", "keywords": ["x"] }],
  "pinned": [{ "title": "A fixed note", "folder": "10-work" }],
  "treeRoots": ["10-work", "20-study"],
  "treeLabels": { "10-work": "Work notes" }
}
```

| Key | Meaning · 含义 |
| --- | --- |
| `folders` | Ordered rules: first keyword hit wins. · 按顺序匹配，先命中先用。 |
| `types` / `projects` | Tag rules. · 标签规则。 |
| `pinned` | Manual title→folder overrides, matched by longest title first. · 人工固定项，按标题长度优先。 |
| `treeRoots` / `treeLabels` | Which top-level folders appear in the tree and how they're labelled. · 目录树的根与说明文字。 |

If the rule file is missing or invalid, the plugin **stops** instead of moving anything.

规则文件缺失或解析失败时，插件会**停止整理**，不会乱动笔记。

## Settings · 设置

| English | 中文 |
| --- | --- |
| Rules file path | 规则文件路径 |
| Root folder for sorting (empty = vault root) | 整理目标根目录（留空 = 库根目录） |
| Entity-card folder (optional backlink targets) | 实体卡片文件夹（可选的反链目标） |
| Tree note path | 目录树笔记路径 |
| Scan on start / interval / auto-open the dialog / scan the whole vault | 启动时扫描 / 扫描间隔 / 自动弹窗 / 全库扫描 |

## Limitations · 已知限制

- Keyword matching, not semantics — the rule file needs some upkeep. · 关键词匹配而非语义理解，规则文件需要自己维护。
- Markdown notes only. · 只处理 Markdown 笔记。

## License · 许可

MIT
