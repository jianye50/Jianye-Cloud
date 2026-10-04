# 部署到 jianye50/Jianye-Cloud 的操作清单(方案 C:保留长路径)

## 一、要改的地方只有 3 个文件

你的仓库是**多项目站点**,站点根 = 仓库根。已有的 `functions/api/kg.js` 证明 Functions 正常工作,
所以只要把搜索后端放到**仓库根**的 `functions/api/` 下即可,与 `kg.js` 并列。

### 1. 新增:`functions/api/search.js`(仓库根,与 kg.js 同目录)

```
Jianye-Cloud/                  ← 仓库根
├── functions/
│   └── api/
│       ├── kg.js              ← 你已有的,不动
│       └── search.js          ← ★ 新增(本目录 ../Jianye-Cloud-root-functions/api/search.js)
├── search-engine/
│   └── public/
│       ├── index.html         ← 覆盖更新(改了「本站」跳转路径)
│       ├── search.html        ← 覆盖更新(API 路径 + 诊断)
│       ├── debug.html         ← 覆盖更新(API 路径)
│       ├── _redirects         ← 保留(带前缀,不冲突)
│       └── (README.md 可选)
└── ...(你其他的 index.html / music.html / 音乐/ 等,全都不动)
```

### 2. 覆盖:`search-engine/public/index.html`
「本站」引擎的跳转地址从 `/search?q=` 改为 `/search-engine/public/search?q=`。
(Cloudflare Pages 会自动去掉 `.html` 后缀,所以写 `/search` 而不是 `/search.html`)

### 3. 覆盖:`search-engine/public/search.html` 和 `search-engine/public/debug.html`
后端地址保持 `/api/search`(站点根绝对路径),页面在子目录下也能正确访问。

## 二、为什么之前是 200 + HTML

| 请求 | 结果 |
|---|---|
| `/api/search` | 没有这个函数 → Pages SPA 回退 → 返回根 `index.html`,状态码 200 → 前端以为通了,实际是 HTML |

现在 `functions/api/search.js` 放到根之后,`/api/search` 就会命中真正的函数。

## 三、部署后验证(按顺序)

1. **后端**:浏览器打开
   `https://jianye.pages.dev/api/search?q=test`
   应看到 JSON:`{"query":"test","page":1,"count":N,"engines":[...],"results":[...]}`

2. **诊断页**:打开
   `https://jianye.pages.dev/search-engine/public/debug`
   状态码 200 + 返回类型「JSON(Functions 已生效)」= 成功

3. **搜索页**:打开
   `https://jianye.pages.dev/search-engine/public/search?q=华为`
   应显示结果列表

4. **主页**:打开 `https://jianye.pages.dev/search-engine/public/`
   输入关键词回车 → 跳到本站结果页

## 四、注意事项

- **不要**把 `search-engine/functions/` 删掉也无所谓(它本来就不生效),但留着作备份无害。
- 如果 `/api/search` 仍返回 HTML,检查根 `functions/api/search.js` 是否真的提交上去了
  (GitHub 网页上点进 `functions/api/` 应能看到 `kg.js` 和 `search.js` 两个文件)。
- 改完记得等 Cloudflare 重新部署完成(Deployments 页面显示 Success)再测。
