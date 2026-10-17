#!/usr/bin/env node
/* =====================================================================
 * 生成博客清单 blog/index.json（部署加速用）
 *
 * 作用：扫描 blog/ 里的文章文件夹（含 index.md）和散篇 .md，
 *       解析 front matter，输出整份列表清单。
 *       网站部署后优先读这份清单——一次几 KB 的请求就能渲染列表，
 *       图片/正文全部走本站域名（Cloudflare CDN），不再走 GitHub API。
 *
 * 运行方式（二选一，都能实现「发文后自动更新」）：
 *   A. Cloudflare Pages 构建命令填：node scripts/gen-blog-index.mjs
 *   B. GitHub Actions：仓库里的 .github/workflows/gen-blog-index.yml 会在
 *      blog/** 变动时自动运行并提交更新
 * 也可以本地手动运行：node scripts/gen-blog-index.mjs
 * ===================================================================== */
import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const blogDir = join(root, "blog");
if (!existsSync(blogDir) || !statSync(blogDir).isDirectory()) {
  console.error("✗ 找不到 blog/ 目录（请在站点根目录结构下运行）");
  process.exit(1);
}

/* 与网站 index.html 里的 parsePost 保持一致 */
function parseFM(raw) {
  const meta = {}; let body = raw;
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (m) {
    m[1].split(/\r?\n/).forEach(line => {
      const kv = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
      if (!kv) return;
      let v = kv[2].trim();
      if (/^\[.*\]$/.test(v)) {
        try { v = JSON.parse(v); }
        catch (e) { v = v.slice(1, -1).split(",").map(s => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean); }
      } else v = v.replace(/^["']|["']$/g, "");
      meta[kv[1].toLowerCase()] = v;
    });
    body = m[2];
  }
  return { meta, body };
}

const posts = [];
for (const name of readdirSync(blogDir)) {
  const p = join(blogDir, name);
  let mdPath = null, slug = null, imgBase = "blog/";
  let st = null;
  try { st = statSync(p); } catch (e) { continue; }
  if (st.isDirectory()) {
    const idx = join(p, "index.md");
    if (existsSync(idx)) { mdPath = idx; slug = name; imgBase = `blog/${name}/`; }
  } else if (/\.md$/i.test(name)) {
    mdPath = p; slug = name.replace(/\.md$/i, "");   /* 散篇 .md：图片放在 blog 根目录 */
  }
  if (!mdPath) continue;
  const { meta, body } = parseFM(readFileSync(mdPath, "utf8"));
  const tags = Array.isArray(meta.tags) ? meta.tags
    : (meta.tags ? String(meta.tags).split(/[,，]/).map(x => x.trim()).filter(Boolean) : []);
  posts.push({
    slug,
    md: imgBase === "blog/" ? `blog/${name}` : `blog/${name}/index.md`,
    imgBase,
    title: meta.title || slug,
    desc: meta.desc || "",
    tags,
    date: meta.date || "",
    minutes: +meta.minutes || Math.max(1, Math.round(body.replace(/\s/g, "").length / 450)),
    cover: meta.cover || "",
    bg: meta.background || ""
  });
}
posts.sort((a, b) => (b.date || "").localeCompare(a.date || ""));

const out = JSON.stringify({ generated: new Date().toISOString(), posts }, null, 2);
if (process.argv.includes("--stdout")) {
  process.stdout.write(out);
} else {
  writeFileSync(join(blogDir, "index.json"), out, "utf8");
  console.log(`✓ blog/index.json 已生成（${posts.length} 篇文章）`);
}
