# 自建元搜索引擎 · 部署说明

一个部署在 **GitHub + Cloudflare Pages** 上的自建搜索引擎。
静态页面放 GitHub 仓库,搜索后端用 Cloudflare Pages Functions(免费额度足够个人使用,无需 API Key)。

## 目录结构

```
search-engine/
├── functions/
│   └── api/
│       └── search.js      ← 搜索后端(元搜索聚合,自动多引擎降级)
└── public/                ← 这个目录就是要部署的静态资源根目录
    ├── index.html         ← 你的主页(已改造:回车走本站搜索,可切换引擎)
    ├── search.html        ← 结果页
    └── _redirects         ← 让 /search 指向 search.html
```

## 工作原理

浏览器 → 你的域名 `/api/search?q=xxx`
　　　　→ Cloudflare Function 并发请求多个搜索后端
　　　　→ 去重 + 合并来源 → 返回 JSON
　　　　→ search.html 渲染结果

后端按顺序尝试并互为降级,任一成功即可出结果:

| 后端 | 说明 |
|---|---|
| DuckDuckGo HTML 版 | 主力,结果质量好,无需 Key |
| SearXNG 公共实例 | 备选,依次尝试 5 个实例 |
| 中文维基百科 API | 兜底,永远可用(百科类结果) |

全部失败时前端会给出提示,并可一键跳到 Bing(可选自动回退)。

## 部署步骤

### 方式 A:Cloudflare Pages 直连 GitHub(推荐)

1. 新建 GitHub 仓库,把本目录内容推上去:
   ```bash
   cd search-engine
   git init
   git add .
   git commit -m "feat: 自建元搜索引擎"
   git branch -M main
   git remote add origin https://github.com/<你的用户名>/<仓库名>.git
   git push -u origin main
   ```

2. 打开 Cloudflare Dashboard → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**

3. 选择刚才的仓库,构建配置填:
   - **Framework preset**: `None`
   - **Build command**: 留空
   - **Build output directory**: `public`

4. 点 **Save and Deploy**。约 30 秒后拿到 `https://<项目名>.pages.dev`

5. 打开 `https://<项目名>.pages.dev`,在搜索框输入内容回车 —— 应该跳到 `/search?q=...` 并显示自建结果。

> `functions/` 目录会被 Cloudflare 自动识别,无需任何额外配置。

### 方式 B:Wrangler CLI

```bash
npm install -g wrangler
wrangler login
wrangler pages deploy public --project-name=my-search
```

## 本地调试

```bash
npm install -g wrangler
wrangler pages dev public --compatibility-date=2024-01-01
```

然后访问 http://localhost:8788 。`functions/api/search.js` 会被本地模拟运行,可以直接调试后端逻辑。

## 自定义

**换/加搜索后端**:编辑 `functions/api/search.js` 中的 `viaDuckDuckGo` / `viaSearx` / `viaWikipedia`,在 `onRequestGet` 的 `Promise.allSettled([...])` 里增删即可。

**接正式搜索 API**(更稳定,但要 Key):比如 Brave Search API,在 dashboard 里加环境变量 `BRAVE_KEY`,然后:

```js
async function viaBrave(q, page) {
  const txt = await fetchText(
    `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&offset=${(page-1)*10}`,
    { Accept: 'application/json', 'X-Subscription-Token': context.env.BRAVE_KEY }
  );
  const d = JSON.parse(txt);
  return (d.web?.results || []).map(r => ({
    title: decode(r.title), url: normalizeUrl(r.url),
    snippet: decode(r.description), engine: 'brave',
  }));
}
```
(需要把 `context` 传进函数,或在入口闭包里引用)

**主页改默认引擎**:`public/index.html` 里的 `ENGINES` 数组,顺序即按钮顺序;把想默认的 id 写进 `localStorage.setItem('engine', 'mine')` 逻辑或直接改 `let engineId = 'mine'`。

## 绑定自定义域名

Cloudflare Pages → 你的项目 → **Custom domains** → 添加域名,按提示改 DNS 即可(域名需托管在 Cloudflare)。

## 注意事项

- **免费额度**:Pages Functions 每天 10 万次请求,个人使用绰绰有余。
- **被上游限流**:DuckDuckGo / SearXNG 公共实例可能对高频请求限流。个人主页场景没问题;若要对外开放,建议接 Brave API 或自建 SearXNG。
- **合规**:搜索结果来自第三方,请遵守各来源服务条款。

## 故障排查

搜索页提示「后端不可用」时,先做两件事:

1. **确认你在哪打开页面**。本地双击 HTML(file://)、WorkBuddy 预览面板等环境**没有后端**,报错是正常的,必须部署后访问。
2. **部署后**,直接在浏览器打开 `https://你的域名/api/search?q=test`,或打开 `https://你的域名/debug.html` 自动诊断:

| 现象 | 原因 | 解决 |
|---|---|---|
| `/api/search` 返回 JSON | 后端正常 | 回结果页点「重试」 |
| `/api/search` 返回 404 | Functions 未部署(最常见) | 见下方三条 |
| 用面板拖拽上传部署的 | 直接上传不支持 Functions | 改用 Git 集成连接 GitHub,或 `wrangler pages deploy public` |
| 仓库里没有 `functions/` 目录 | 路径不对 | `functions/` 必须在**仓库根目录**,与 `public` 平级;不要放进 public 里面 |
| Pages 构建输出目录不是 `public` | 配置错 | Pages 项目设置 → Build output directory 填 `public` |
| `/api/search` 返回 HTML 而非 JSON | 路由被覆盖 | 检查 `_redirects` 是否有通配规则盖住了 `/api/*` |
| 返回 5xx | 上游引擎全挂 | 看结果页「诊断详情」;稍等或给 `viaSearx` 换实例 |

> 修正配置后需要在 Pages 里触发重新部署(推一个 commit 或点 Retry deployment)才会生效。
