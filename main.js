const obsidian = require("obsidian");

const DEFAULT_SETTINGS = {
  rulesPath: "inbox-rules.json",
  rootFolder: "",
  entityFolder: "实体库",
  mapPath: "知识库地图.md",
  scanWholeVault: true,
  scanOnStart: true,
  intervalMinutes: 10,
  autoOpen: false,
  ignored: []
};

/* ============================================================
 * 纯逻辑部分（不依赖 Obsidian API，便于单独测试）
 * ============================================================ */

function uniq(a) {
  return Array.from(new Set(a.filter(Boolean)));
}

function countHits(text, keywords) {
  if (!text) return 0;
  let n = 0;
  for (const k of keywords) if (k && text.includes(k)) n++;
  return n;
}

function firstHit(text, keywords) {
  for (const k of keywords) if (k && text.includes(k)) return k;
  return "";
}

function areaTagOf(folder, rules) {
  for (const f of rules.folders) if (f.folder === folder) return f.tag;
  if (folder === rules.defaultFolder) return "领域/待整理";
  return "";
}

function pickByRules(text, list) {
  for (const item of list || []) {
    if (firstHit(text, item.keywords)) return item.tag;
  }
  return "";
}

function tagsForFolder(folder, title, noteType, rules) {
  const out = [];
  const area = areaTagOf(folder, rules);
  if (area) out.push(area);
  const type = pickByRules(title, rules.types) || (rules.typeByNoteType || {})[noteType] || "类型/笔记";
  out.push(type);
  const proj = pickByRules(title, rules.projects);
  if (proj) out.push(proj);
  const theme = pickByRules(title, rules.themes);
  if (theme) out.push(theme);
  return uniq(out).slice(0, 4);
}

function classifyText(input, rules) {
  const title = (input.title || "").trim();
  // 只把「来源标签」当作信号；我们自己生成的四维标签（领域/类型/项目/主题）不参与判断，
  // 否则会自我强化，把笔记越推越偏。
  const tags = (input.tags || []).filter((t) => !/^(领域|类型|项目|主题|导航|实体)\//.test(String(t)));
  const noteType = input.noteType || "";
  const body = input.body || "";
  const hay = title + " " + tags.join(",");

  for (const p of (rules.pinned || []).slice().sort((a, b) => String(b.title).length - String(a.title).length)) {
    if (p.title && (title === p.title || title.startsWith(p.title))) {
      return {
        folder: p.folder,
        tags: tagsForFolder(p.folder, title, noteType, rules),
        uncertain: false,
        reason: "固定规则：" + p.title
      };
    }
  }

  const studyRe = new RegExp(rules.studyPattern);
  let folder = "";
  let reason = "";

  if (studyRe.test(title)) {
    for (const s of rules.studySubjects || []) {
      if (countHits(title, s.keywords)) { folder = s.folder; reason = "题库 · 题干命中「" + firstHit(title, s.keywords) + "」"; break; }
    }
    if (!folder) {
      for (const s of rules.studySubjects || []) {
        if (countHits(tags.join(","), s.keywords)) { folder = s.folder; reason = "题库 · 标签命中「" + firstHit(tags.join(","), s.keywords) + "」"; break; }
      }
    }
    if (!folder) { folder = rules.studyDefault; reason = "题库 · 无学科线索，默认归社工"; }
  } else {
    for (const f of rules.folders || []) {
      if (countHits(hay, f.keywords)) { folder = f.folder; reason = "标题/标签命中「" + firstHit(hay, f.keywords) + "」"; break; }
    }
    if (!folder) {
      const head = body.slice(0, 4000);
      for (const f of rules.folders || []) {
        const kws = (f.keywords || []).filter((k) => k.length >= 3);
        if (countHits(head, kws) >= 2) { folder = f.folder; reason = "正文多次命中「" + firstHit(head, kws) + "」"; break; }
      }
    }
  }

  const uncertain = !folder;
  if (!folder) { folder = rules.defaultFolder; reason = "规则未命中，需人工判断"; }
  return { folder, tags: tagsForFolder(folder, title, noteType, rules), uncertain, reason };
}

/** 从一批新笔记的标题里找「反复出现、但词库还没有」的候选新标签 */
function candidateTags(titles, rules, knownTags) {
  const stop = new Set(["", "的", "了", "和", "与", "及", "关于", "一个", "我们", "笔记", "整理", "记录", "分享", "讨论", "复盘", "总结", "课程", "活动", "工作坊", "会议", "纪要", "相关", "如何", "什么", "为什么", "怎么", "可以", "需要", "以及", "进行", "问题", "内容", "主题", "第一", "第二", "第三", "第四", "第五", "上", "下", "中"]);
  const freq = new Map();
  for (const t of titles) {
    const clean = String(t || "").replace(/[《》“”"'（）()【】\[\]：:，,。.、\-—_\s]/g, "|");
    const pieces = clean.split("|").filter(Boolean);
    const seen = new Set();
    for (const p of pieces) {
      for (let len = 2; len <= 8; len++) {
        for (let i = 0; i + len <= p.length; i++) {
          const w = p.slice(i, i + len);
          if (stop.has(w)) continue;
          if (seen.has(w)) continue;
          seen.add(w);
          freq.set(w, (freq.get(w) || 0) + 1);
        }
      }
    }
  }
  const cands = [];
  for (const [w, c] of freq) {
    if (c < 2) continue;
    if (knownTags.has(w)) continue;
    if (w.length < 3) continue;
    // 去掉被更长候选完全包含的短词
    cands.push({ term: w, count: c });
  }
  cands.sort((a, b) => (b.term.length - a.term.length) || (b.count - a.count));
  const out = [];
  for (const c of cands) {
    if (out.some((o) => o.term.includes(c.term))) continue;
    out.push(c);
    if (out.length >= 6) break;
  }
  return out;
}

const REL_HEAD = "\n## 🔗 关联\n";

function stripRelations(text) {
  const i = text.lastIndexOf(REL_HEAD);
  if (i < 0) return text;
  const tail = text.slice(i + REL_HEAD.length);
  for (const line of tail.split("\n")) {
    const s = line.trim();
    if (s && !s.startsWith("- **")) return text;
  }
  return text.slice(0, i);
}

function setTagsInFrontmatter(text, tags) {
  const arr = "[" + tags.map((t) => '"' + t + '"').join(", ") + "]";
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
  if (!m) {
    if (!text.trim()) return text;
    return "---\ntags: " + arr + "\n---\n\n" + text;
  }
  let fm = m[1];
  if (/^tags:/m.test(fm)) fm = fm.replace(/^tags:.*$/m, "tags: " + arr);
  else fm = "tags: " + arr + "\n" + fm;
  return "---\n" + fm + "\n---\n" + text.slice(m[0].length);
}

function areaIndexOf(folderPath, root) {
  let p = String(folderPath || "");
  const r = String(root || "").replace(/\/+$/, "");
  if (r && p.startsWith(r + "/")) p = p.slice(r.length + 1);
  const seg = p.split("/").filter(Boolean);
  for (const s of seg) if (/^\d\d-/.test(s)) return s;
  return "";
}

function buildRelations(text, folderPath, entities, root) {
  const body = stripRelations(text).replace(/\s+$/, "");
  const lines = [REL_HEAD];
  const area = areaIndexOf(folderPath, root);
  if (area) lines.push("- **索引**：[[" + area + "]]");
  const groups = { 人物: [], 项目: [], 机构: [], 概念: [] };
  for (const e of entities) {
    const names = [e.name].concat(e.aliases || []);
    if (names.some((n) => n && body.includes(n))) groups[e.cat] && groups[e.cat].push(e.name);
  }
  for (const cat of ["人物", "项目", "机构", "概念"]) {
    if (groups[cat].length) lines.push("- **" + cat + "**：" + groups[cat].map((n) => "[[" + n + "]]").join("、"));
  }
  if (lines.length === 1) return text;
  return body + "\n" + lines.join("\n") + "\n";
}

/* ============================================================
 * 目录树生成（纯函数，输入是库内文件的相对路径列表）
 * ============================================================ */

function buildTreeFrom(paths, rules, vaultName) {
  const labels = (rules && rules.treeLabels) || {};
  const label = (n) => labels[n] || "";
  const isMd = (p) => p.toLowerCase().endsWith(".md");
  const inAsset = (p) => p.includes("/asset/");
  const countMd = (prefix) => paths.filter((p) => p.startsWith(prefix + "/") && isMd(p) && !inAsset(p)).length;
  const countDoc = (prefix) => paths.filter((p) => p.startsWith(prefix + "/") && !isMd(p) && !inAsset(p)).length;
  // 目录里如果有一篇与目录同名的索引笔记，篇数里扣掉它
  const countNotes = (prefix) => {
    const n = countMd(prefix);
    const self = prefix + "/" + prefix.split("/").pop() + ".md";
    return paths.includes(self) ? n - 1 : n;
  };
  const children = (prefix) => {
    const s = new Set();
    for (const p of paths) {
      if (!p.startsWith(prefix + "/")) continue;
      const rest = p.slice(prefix.length + 1).split("/");
      if (rest.length > 1) s.add(rest[0]);
    }
    return Array.from(s).sort();
  };

  const predef = (rules && Array.isArray(rules.treeRoots) && rules.treeRoots.length) ? rules.treeRoots : [];
  const tops = Array.from(new Set(paths.map((p) => p.split("/")[0])));
  const ordered = predef.filter((t) => tops.includes(t)).concat(tops.filter((t) => !predef.includes(t)).sort());

  const out = [(vaultName || "Vault") + "\\"];
  ordered.forEach((top, i) => {
    const lastTop = i === ordered.length - 1;
    const pad = lastTop ? "    " : "│   ";
    const isFile = !paths.some((p) => p.startsWith(top + "/"));
    if (isFile) {
      out.push((lastTop ? "└── " : "├── ") + top + "   （散落文件）");
      return;
    }
    let note = "";
    if (rules && rules.syncRoot === top) note = "← 同步主库（外部工具写入）";
    else if (top === "50-文献资料") note = "← " + countDoc(top) + " 份原始文献";
    else if (label(top)) note = "← " + label(top);
    out.push((lastTop ? "└── " : "├── ") + top + "\\" + (note ? "   " + note : ""));

    const subs = children(top);
    subs.forEach((sub, j) => {
      const lastSub = j === subs.length - 1;
      const full = top + "/" + sub;
      const isInbox = ["图片笔记", "录音笔记", "纯文本", "链接笔记"].includes(sub);
      let tail;
      if (isInbox) {
        const n = countNotes(full);
        tail = n ? "收件箱 · " + n + " 篇待整理" : "收件箱 · 空";
      } else if (/^05-/.test(sub)) {
        tail = countNotes(full) + " 张卡片";
      } else if (top === "50-文献资料") {
        tail = countDoc(full) + " 份";
      } else {
        tail = countNotes(full) + " 篇";
      }
      const lb = !isInbox && label(sub) ? " ｜ " + label(sub) : "";
      out.push(pad + (lastSub ? "└── " : "├── ") + sub + "\\" + "   " + tail + lb);

      if (rules && rules.syncRoot === top && /^\d\d-/.test(sub)) {
        const grands = children(full);
        grands.forEach((g, k) => {
          const gfull = full + "/" + g;
          out.push(pad + (lastSub ? "    " : "│   ") + (k === grands.length - 1 ? "└── " : "├── ") + g + "\\" + "   " + countNotes(gfull) + (/^5\d/.test(g) ? " 张" : " 篇") + (label(g) ? " ｜ " + label(g) : ""));
        });
      }
    });
  });
  return out.join("\n");
}

/* ============================================================
 * 确认弹窗
 * ============================================================ */

class ReviewModal extends obsidian.Modal {
  constructor(app, plugin, items, candidates) {
    super(app);
    this.plugin = plugin;
    this.items = items.map((it) => ({ ...it, enabled: !it.decision.uncertain }));
    this.candidates = candidates.map((c) => ({ ...c, enabled: false, kind: "项目" }));
    this.custom = [];
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("ic-modal");
    contentEl.createEl("h2", { text: "收件箱整理 · " + this.items.length + " 篇待归类" });
    contentEl.createEl("p", {
      cls: "ic-hint",
      text: "勾选要处理的笔记，可改目录。未列出实体的会被标为「需人工判断」，默认不勾选。"
    });

    const list = contentEl.createDiv({ cls: "ic-list" });
    for (const it of this.items) {
      const s = new obsidian.Setting(list)
        .setName(it.file.basename.length > 40 ? it.file.basename.slice(0, 40) + "…" : it.file.basename)
        .setDesc((it.decision.uncertain ? "⚠️ " : "") + it.decision.reason + " ｜ 标签：" + it.decision.tags.join(" "))
        .addToggle((t) => t.setValue(it.enabled).onChange((v) => { it.enabled = v; }))
        .addDropdown((d) => {
          for (const f of this.plugin.allFolders()) d.addOption(f, f);
          d.setValue(it.decision.folder).onChange((v) => { it.decision.folder = v; it.changed = true; });
        });
      s.settingEl.addClass("ic-row");
    }

    if (this.candidates.length) {
      contentEl.createEl("h3", { text: "词库里没有的候选标签" });
      contentEl.createEl("p", { cls: "ic-hint", text: "在这些新笔记里反复出现、但标签库还没有。勾选后会写入标签库，下次同类笔记自动沿用。" });
      const box = contentEl.createDiv({ cls: "ic-tags" });
      for (const c of this.candidates) {
        new obsidian.Setting(box)
          .setName("#" + c.kind + "/" + c.term)
          .setDesc("出现在 " + c.count + " 篇新笔记的标题里")
          .addDropdown((d) => {
            d.addOption("项目", "项目");
            d.addOption("主题", "主题");
            d.addOption("领域", "领域");
            d.setValue(c.kind).onChange((v) => { c.kind = v; });
          })
          .addToggle((t) => t.setValue(c.enabled).onChange((v) => { c.enabled = v; }));
      }
    }

    const customBox = contentEl.createDiv({ cls: "ic-custom" });
    const input = new obsidian.Setting(customBox)
      .setName("手动新增标签")
      .setDesc("写给单篇笔记用的新标签（例：夏令营），回车或点「加入」")
      .addText((t) => {
        t.setPlaceholder("标签名");
        t.inputEl.addEventListener("keydown", (ev) => {
          if (ev.key === "Enter") { ev.preventDefault(); addCustom(); }
        });
        this._text = t;
      })
      .addDropdown((d) => {
        d.addOption("项目", "项目");
        d.addOption("主题", "主题");
        d.addOption("领域", "领域");
        d.setValue("项目").onChange((v) => { this._kind = v; });
      })
      .addButton((b) => b.setButtonText("加入").onClick(() => addCustom()));

    const addCustom = () => {
      const v = (this._text ? this._text.getValue() : "").trim();
      if (!v) return;
      this.candidates.push({ term: v, count: 0, kind: this._kind || "项目", enabled: true, manual: true });
      this._text.setValue("");
      this.onClose();
      this.onOpen();
    };

    const btns = contentEl.createDiv({ cls: "ic-actions" });
    const apply = btns.createEl("button", { text: "应用", cls: "mod-cta" });
    apply.onclick = async () => {
      apply.disabled = true;
      await this.plugin.applyDecisions(this.items.filter((i) => i.enabled), this.candidates.filter((c) => c.enabled));
      this.close();
    };
    const skip = btns.createEl("button", { text: "跳过全部" });
    skip.onclick = async () => {
      await this.plugin.ignoreAll(this.items.map((i) => i.file.path));
      this.close();
    };
  }

  onClose() {
    this.contentEl.empty();
  }
}

/* ============================================================
 * 插件主体
 * ============================================================ */

class InboxClassifier extends obsidian.Plugin {
  async onload() {
    try {
      this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
      this.rules = await this.loadRules();
      this.entities = [];
      this.statusEl = this.addStatusBarItem();
      this.statusEl.setText("整理：待扫描");

      this.addRibbonIcon("inbox", "整理收件箱", () => this.openReview());

      this.addCommand({ id: "scan-inbox", name: "扫描收件箱，生成整理方案", callback: () => this.openReview() });
      this.addCommand({ id: "rebuild-map", name: "重建知识库地图的目录树", callback: () => this.rebuildMap() });
      this.addCommand({ id: "reload-rules", name: "重新加载标签库", callback: async () => { this.rules = await this.loadRules(); new obsidian.Notice("标签库已重新加载"); this.refreshStatus(); } });
      this.addSettingTab(new SettingsTab(this.app, this));

      this.app.workspace.onLayoutReady(async () => {
        await this.refreshEntities();
        if (this.settings.scanOnStart) await this.scan(true);
        if (this.settings.intervalMinutes > 0) {
          this.registerInterval(setInterval(() => this.scan(true), this.settings.intervalMinutes * 60000));
        }
      });

      this.registerEvent(this.app.vault.on("create", (f) => { if (f instanceof obsidian.TFile && f.extension === "md") this.refreshStatus(); }));
    } catch (e) {
      console.error("[收件箱整理] onload 失败", e);
      new obsidian.Notice("收件箱自动整理启动失败：" + (e && e.message ? e.message : e));
      throw e;
    }
  }

  onunload() {
    if (this.statusEl) this.statusEl.remove();
  }

  async loadRules() {
    const path = this.settings.rulesPath;
    const f = this.app.vault.getAbstractFileByPath(path);
    this.rulesOk = false;
    if (f instanceof obsidian.TFile) {
      try {
        const parsed = JSON.parse(await this.app.vault.read(f));
        if (Array.isArray(parsed.folders) && parsed.folders.length) {
          this.rulesOk = true;
          return parsed;
        }
        console.error("[收件箱整理] 标签库缺少 folders 配置", path);
      } catch (e) {
        console.error("[收件箱整理] 标签库解析失败", e);
        new obsidian.Notice("标签库 JSON 解析失败，已停止自动整理（见控制台）");
      }
    } else {
      console.error("[收件箱整理] 找不到标签库文件", path);
    }
    return { folders: [], types: [], projects: [], themes: [], pinned: [], studySubjects: [], studyPattern: "题", defaultFolder: "90-待整理", typeByNoteType: {} };
  }

  async saveRules() {
    const path = this.settings.rulesPath;
    const f = this.app.vault.getAbstractFileByPath(path);
    if (f instanceof obsidian.TFile) await this.app.vault.modify(f, JSON.stringify(this.rules, null, 2));
  }

  async refreshEntities() {
    const root = this.settings.entityFolder;
    const out = [];
    for (const f of this.app.vault.getMarkdownFiles()) {
      if (!f.path.startsWith(root + "/")) continue;
      const fm = (this.app.metadataCache.getFileCache(f) || {}).frontmatter || {};
      const tags = Array.isArray(fm.tags) ? fm.tags : String(fm.tags || "").split(/[,\s]+/).filter(Boolean);
      const t = tags.find((x) => String(x).startsWith("实体/"));
      if (!t) continue;
      const cat = String(t).split("/")[1];
      let aliases = fm.aliases || fm.alias || [];
      if (typeof aliases === "string") aliases = [aliases];
      out.push({ name: f.basename, cat, aliases: aliases.map(String) });
    }
    this.entities = out;
  }

  getTags(file) {
    const fm = (this.app.metadataCache.getFileCache(file) || {}).frontmatter || {};
    const t = fm.tags;
    if (Array.isArray(t)) return t.map(String);
    if (typeof t === "string") return t.split(/[,\s]+/).filter(Boolean);
    return [];
  }

  isExcluded(path) {
    const ex = (this.rules && this.rules.excludeFolders) || [];
    for (const e of ex) if (path === e || path.startsWith(e + "/")) return true;
    if (!this.settings.scanWholeVault) {
      const inbox = (this.rules && this.rules.inbox) || [];
      return !inbox.some((e) => path.startsWith(e + "/"));
    }
    return false;
  }

  ignoredPaths() {
    return new Set((this.settings.ignored || []).map((x) => x.path));
  }

  getCandidates() {
    const ignored = this.ignoredPaths();
    const out = [];
    for (const f of this.app.vault.getMarkdownFiles()) {
      if (this.isExcluded(f.path)) continue;
      if (ignored.has(f.path)) continue;
      // 元数据还没索引好的先跳过，等下一轮，避免把已归位的笔记误判成新笔记
      if (!this.app.metadataCache.getFileCache(f)) continue;
      const tags = this.getTags(f);
      if (tags.some((t) => t.startsWith("领域/"))) continue;
      if (tags.some((t) => t.startsWith("导航/"))) continue;
      out.push(f);
    }
    return out;
  }

  async scan(quiet) {
    await this.refreshEntities();
    this.rules = await this.loadRules();
    if (!this.rulesOk) {
      if (this.statusEl) this.statusEl.setText("⚠️ 标签库不可用");
      if (!quiet) new obsidian.Notice("规则文件不可用，已停止自动整理：检查 " + this.settings.rulesPath);
      return 0;
    }
    const files = this.getCandidates();
    this.pendingFiles = files;
    this.refreshStatus();
    if (!quiet && files.length === 0) new obsidian.Notice("收件箱是空的，没有需要归类的笔记");
    if (files.length > 0 && quiet && !this._notified) {
      this._notified = true;
      new obsidian.Notice("📥 有 " + files.length + " 篇新笔记待归类：点状态栏或命令「扫描收件箱，生成整理方案」");
    }
    if (!quiet && files.length > 0) this.openReview();
    if (quiet && files.length > 0 && this.settings.autoOpen) this.openReview();
    return files.length;
  }

  refreshStatus() {
    if (!this.statusEl) return;
    const n = (this.pendingFiles || []).length;
    this.statusEl.setText(n ? "📥 待整理 " + n : "✅ 收件箱已清空");
    this.statusEl.style.cursor = "pointer";
    this.statusEl.onclick = () => this.openReview();
  }

  allFolders() {
    const set = new Set();
    for (const f of this.rules.folders || []) set.add(f.folder);
    set.add("90-待整理");
    return Array.from(set);
  }

  async openReview() {
    await this.refreshEntities();
    this.rules = await this.loadRules();
    if (!this.rulesOk) {
      new obsidian.Notice("规则文件不可用，已停止整理：检查 " + this.settings.rulesPath);
      return;
    }
    const files = this.getCandidates();
    this.pendingFiles = files;
    this.refreshStatus();
    if (!files.length) { new obsidian.Notice("没有待归类的笔记 🎉"); return; }

    const items = [];
    const titles = [];

    // uid 索引：子笔记（题库分册）要跟随母题所在的目录
    const uidMap = new Map();
    for (const f of this.app.vault.getMarkdownFiles()) {
      const fm = (this.app.metadataCache.getFileCache(f) || {}).frontmatter || {};
      if (fm.uid) uidMap.set(String(fm.uid), f);
    }

    for (const f of files) {
      const text = await this.app.vault.cachedRead(f);
      const fm = (this.app.metadataCache.getFileCache(f) || {}).frontmatter || {};
      const title = String(fm.title || f.basename);
      const body = stripRelations(text);
      if (body.replace(/^---[\s\S]*?---/, "").trim().length < 5) continue; // 空笔记不处理
      titles.push(title);

      let decision = classifyText({ title, tags: this.getTags(f), noteType: String(fm.note_type || ""), body }, this.rules);

      // 子笔记 → 跟随母题
      const pid = fm.parent_id ? String(fm.parent_id) : "";
      const pf = pid ? uidMap.get(pid) : null;
      if (pf && pf.path !== f.path) {
        const ptags = this.getTags(pf);
        if (ptags.some((t) => t.startsWith("领域/"))) {
          const rp = (this.settings.rootFolder || "").replace(/\/+$/, "");
        const relParent = rp && pf.path.startsWith(rp + "/") ? pf.path.slice(rp.length + 1) : pf.path;
        const dir = relParent.split("/").slice(0, -1).join("/");
          if (dir) {
            decision = {
              folder: dir,
              tags: tagsForFolder(dir, title, String(fm.note_type || ""), this.rules),
              uncertain: false,
              reason: "跟随母题《" + pf.basename + "》"
            };
          }
        }
      }

      items.push({ file: f, title, decision });
    }
    if (!items.length) { new obsidian.Notice("没有需要处理的笔记（空文件已跳过）"); return; }
    this.pendingFiles = items.map((i) => i.file);
    this.refreshStatus();

    const known = new Set();
    const collect = (list) => (list || []).forEach((x) => (x.keywords || []).forEach((k) => known.add(k)));
    collect(this.rules.projects); collect(this.rules.themes); collect(this.rules.folders);
    const cands = candidateTags(titles, this.rules, known).map((c) => ({ ...c, kind: "项目" }));

    new ReviewModal(this.app, this, items, cands).open();
  }

  async applyDecisions(items, newTags) {
    let moved = 0;
    const learnedPins = [];
    for (const it of items) {
      try {
        const extra = newTags.filter((c) => it.title.includes(c.term)).map((c) => c.kind + "/" + c.term);
        const tags = uniq(it.decision.tags.concat(extra)).slice(0, 5);
        const folder = it.decision.folder;
        let file = it.file;

        await this.app.vault.process(file, (t) => setTagsInFrontmatter(t, tags));

        const rootPrefix = (this.settings.rootFolder || "").replace(/\/+$/, "");
    const destFolder = (rootPrefix ? rootPrefix + "/" : "") + folder;
        if (!this.app.vault.getAbstractFileByPath(destFolder)) {
          try { await this.app.vault.createFolder(destFolder); } catch (e) { /* 已存在 */ }
        }
        let nf = file;
        const curDir = file.parent ? file.parent.path : "";
        if (curDir !== destFolder) {
          let name = file.name;
          let dest = destFolder + "/" + name;
          let n = 2;
          while (this.app.vault.getAbstractFileByPath(dest)) {
            dest = destFolder + "/" + name.replace(/\.md$/, "") + " (" + n + ").md";
            n++;
          }
          await this.app.fileManager.renameFile(file, dest);
          nf = this.app.vault.getAbstractFileByPath(dest);
        }
        if (nf instanceof obsidian.TFile) {
          await this.app.vault.process(nf, (t) => buildRelations(t, folder, this.entities, this.settings.rootFolder));
          moved++;
        }
        if (it.changed) learnedPins.push({ title: it.title, folder });
      } catch (e) {
        console.error("[收件箱整理] 处理失败", it.file && it.file.path, e);
        new obsidian.Notice("处理失败：" + (it.file ? it.file.basename : "?") + "（详见控制台）");
      }
    }

    if (newTags.length) {
      for (const c of newTags) {
        const arr = c.kind === "项目" ? this.rules.projects : c.kind === "主题" ? this.rules.themes : null;
        if (!arr) continue;
        const tag = c.kind + "/" + c.term;
        if (arr.some((x) => x.tag === tag)) continue;
        arr.push({ tag, keywords: [c.term] });
      }
      await this.saveRules();
    }
    if (learnedPins.length) {
      this.rules.pinned = (this.rules.pinned || []).concat(learnedPins);
      await this.saveRules();
    }

    new obsidian.Notice("已归类 " + moved + " 篇" + (newTags.length ? "，新增标签 " + newTags.length + " 个" : ""));
    await this.scan(true);
  }

  async ignoreAll(paths) {
    const list = this.settings.ignored || [];
    const now = Date.now();
    for (const p of paths) if (!list.some((x) => x.path === p)) list.push({ path: p, at: now });
    this.settings.ignored = list;
    await this.saveData(this.settings);
    await this.scan(true);
  }

  /* ---------- 目录树重建 ---------- */

  async buildTree() {
    const paths = this.app.vault.getAllLoadedFiles().filter((f) => !f.children).map((f) => f.path);
    return buildTreeFrom(paths, this.rules, this.app.vault.getName());
  }

  async rebuildMap() {
    const path = this.settings.mapPath;
    const f = this.app.vault.getAbstractFileByPath(path);
    if (!(f instanceof obsidian.TFile)) { new obsidian.Notice("找不到知识库地图：" + path); return; }
    const tree = this.buildTree();
    await this.app.vault.process(f, (t) => {
      if (t.includes("<!-- TREE:START -->")) {
        return t.replace(/<!-- TREE:START -->[\s\S]*?<!-- TREE:END -->/, "<!-- TREE:START -->\n```\n" + tree + "\n```\n<!-- TREE:END -->");
      }
      return t + "\n\n<!-- TREE:START -->\n```\n" + tree + "\n```\n<!-- TREE:END -->\n";
    });
    new obsidian.Notice("目录树已按当前文件夹重建");
  }
}

/* ============================================================
 * 设置页
 * ============================================================ */

class SettingsTab extends obsidian.PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "收件箱自动整理" });

    new obsidian.Setting(containerEl)
      .setName("启动时扫描")
      .setDesc("打开 Obsidian 后自动检查有没有新同步的笔记（只弹收件箱计数，不自动移动）")
      .addToggle((t) => t.setValue(this.plugin.settings.scanOnStart).onChange(async (v) => {
        this.plugin.settings.scanOnStart = v; await this.plugin.saveData(this.plugin.settings);
      }));

    new obsidian.Setting(containerEl)
      .setName("定时扫描间隔（分钟）")
      .setDesc("设为 0 关闭。Get 笔记同步完成后会落进收件箱，这里按间隔自动检查一次")
      .addText((t) => t.setValue(String(this.plugin.settings.intervalMinutes)).onChange(async (v) => {
        const n = Number(v);
        if (!Number.isNaN(n)) { this.plugin.settings.intervalMinutes = n; await this.plugin.saveData(this.plugin.settings); }
      }));

    new obsidian.Setting(containerEl)
      .setName("发现新笔记时自动弹确认窗")
      .setDesc("关掉的话只在状态栏显示待整理数量，点状态栏才打开")
      .addToggle((t) => t.setValue(this.plugin.settings.autoOpen).onChange(async (v) => {
        this.plugin.settings.autoOpen = v; await this.plugin.saveData(this.plugin.settings);
      }));

    new obsidian.Setting(containerEl)
      .setName("扫描整个库（不只收件箱）")
      .setDesc("开启后，你在任意位置新建、且没有「领域/」标签的笔记也会被收进来")
      .addToggle((t) => t.setValue(this.plugin.settings.scanWholeVault).onChange(async (v) => {
        this.plugin.settings.scanWholeVault = v; await this.plugin.saveData(this.plugin.settings);
      }));

    new obsidian.Setting(containerEl)
      .setName("整理目标根目录")
      .setDesc("所有分类文件夹都建在这个目录下；留空表示库根目录")
      .addText((t) => t.setValue(this.plugin.settings.rootFolder).onChange(async (v) => {
        this.plugin.settings.rootFolder = v.trim();
        await this.plugin.saveSettings();
      }));

    new obsidian.Setting(containerEl)
      .setName("规则文件路径")
      .setDesc("标签与目录规则所在的 JSON，改它等于改分类逻辑")
      .addText((t) => t.setValue(this.plugin.settings.rulesPath).onChange(async (v) => {
        this.plugin.settings.rulesPath = v.trim(); await this.plugin.saveData(this.plugin.settings);
        this.plugin.rules = await this.plugin.loadRules();
      }));

    new obsidian.Setting(containerEl)
      .setName("清空「已跳过」记录")
      .setDesc("跳过过的笔记将重新出现在待整理列表里")
      .addButton((b) => b.setButtonText("清空").onClick(async () => {
        this.plugin.settings.ignored = [];
        await this.plugin.saveData(this.plugin.settings);
        await this.plugin.scan(true);
        new obsidian.Notice("已清空跳过记录");
      }));

    new obsidian.Setting(containerEl)
      .setName("重建目录树")
      .setDesc("刷新「知识库地图」里的目录树与篇数")
      .addButton((b) => b.setButtonText("立即重建").onClick(() => this.plugin.rebuildMap()));
  }
}

module.exports = InboxClassifier;

/* 供 Node 测试使用 */
module.exports.__test = { classifyText, candidateTags, tagsForFolder, buildRelations, stripRelations, setTagsInFrontmatter, areaIndexOf, buildTreeFrom };
