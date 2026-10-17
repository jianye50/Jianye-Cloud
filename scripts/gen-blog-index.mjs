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
const coverDirs = [];   /* slug → 文章图片所在目录（生成缩略图用） */
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
  coverDirs.push({ slug, dir: join(blogDir, imgBase === "blog/" ? "" : name) });
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

/* ---------- 生成缩略图（可选，装了 sharp 就自动做）----------
 * 列表缩略图 480px WebP / 文章页头图 1600px WebP，输出到 blog/thumbs/。
 * 没装 sharp 时自动跳过，网站会回退用原图，不影响构建。 */
import { mkdirSync } from "node:fs";
import { pathToFileURL } from "node:url";
let sharp = null;
try { sharp = (await import("sharp")).default; } catch (e) {}
if (!sharp && process.env.SHARP_PATH) {
  try { sharp = (await import(pathToFileURL(process.env.SHARP_PATH).href)).default; } catch (e) {}
}
if (!sharp) {
  /* CI 环境自动装 sharp（本地没有也自动装，装不上则跳过缩略图） */
  try {
    const { execSync } = await import("node:child_process");
    execSync("npm install sharp --no-save --no-fund --no-audit", { cwd: root, stdio: "ignore", timeout: 240000 });
    sharp = (await import("sharp")).default;
  } catch (e) {}
}
const thumbDir = join(blogDir, "thumbs");
const slugSafe = s => String(s).replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 80);   /* 只替换文件系统禁用符，保留中文 */
const IMG_RE = /\.(jpe?g|png|gif|webp|bmp|avif|heic|heif)$/i;
if (sharp) {
  try {
    mkdirSync(thumbDir, { recursive: true });
    let n = 0;
    for (const { slug, dir } of coverDirs) {
      const post = posts.find(x => x.slug === slug);
      if (!post) continue;
      /* 正文图片映射：文章文件夹里每一张图 → 1600px WebP（页面宽度足够 retina 显示） */
      const imgs = {};
      try {
        readdirSync(dir).forEach((f, i) => {
          if (!IMG_RE.test(f)) return;
          const outName = `${slugSafe(slug)}-i${i}.webp`;
          imgs[f] = `blog/thumbs/${outName}`;
        });
      } catch (e) {}
      for (const [srcFile, outRel] of Object.entries(imgs)) {
        const src = join(dir, srcFile);
        if (!existsSync(src)) continue;
        await sharp(src, { failOn: "none" }).rotate()
          .resize({ width: 1600, withoutEnlargement: true })
          .webp({ quality: 72 })
          .toFile(join(thumbDir, outRel.split("/").pop()));
        n++;
      }
      if (Object.keys(imgs).length) post.imgs = imgs;
      /* 封面 480px / 头图 1600px 专用版本 */
      for (const [field, width, q, key] of [["cover", 480, 74, "coverThumb"], ["bg", 1600, 70, "bgThumb"]]) {
        const file = post[field];
        if (!file) continue;
        const src = join(dir, file);
        if (!existsSync(src)) continue;
        const outName = `${slugSafe(slug)}-${key === "coverThumb" ? "cover" : "bg"}.webp`;
        await sharp(src, { failOn: "none" }).rotate()
          .resize({ width, withoutEnlargement: true })
          .webp({ quality: q })
          .toFile(join(thumbDir, outName));
        post[key] = `blog/thumbs/${outName}`;
        n++;
      }
    }
    console.log(`✓ 已生成 ${n} 张缩略图到 blog/thumbs/`);
    /* 把缩略图加入 git 暂存区（配合 GitHub Action 的提交步骤；本地手动运行时静默跳过） */
    try {
      const { execSync } = await import("node:child_process");
      execSync("git add blog/thumbs", { cwd: root, stdio: "ignore" });
    } catch (e) {}
  } catch (e) {
    console.warn("! 缩略图生成失败（网站会回退用原图）：" + e.message);
  }
} else {
  console.log("! 未安装 sharp，跳过缩略图（可运行 npm install sharp 后重试）");
}

const out = JSON.stringify({ generated: new Date().toISOString(), posts }, null, 2);
if (process.argv.includes("--stdout")) {
  process.stdout.write(out);
} else {
  writeFileSync(join(blogDir, "index.json"), out, "utf8");
  console.log(`✓ blog/index.json 已生成（${posts.length} 篇文章）`);
}
