/**
 * Cloudflare Pages Function —— 元搜索引擎后端
 * 路由: /api/search?q=关键词&page=1&lang=zh-CN
 *
 * 设计要点:
 *  - 多后端并发,任一成功即返回,互为降级(不需要 api key)
 *  - 结果做 URL 去重 + 简单交叉排序
 *  - 全部失败时返回空结果而非 500,前端可优雅降级到备用引擎
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const TIMEOUT = 8000;

/* ---------------- 工具 ---------------- */

function withTimeout(ms) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return { signal: c.signal, done: () => clearTimeout(t) };
}

async function fetchText(url, extraHeaders = {}) {
  const { signal, done } = withTimeout(TIMEOUT);
  try {
    const res = await fetch(url, {
      signal,
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        ...extraHeaders,
      },
      redirect: 'follow',
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    done();
  }
}

function decode(s) {
  return String(s || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&hellip;/g, '…')
    .replace(/&middot;/g, '·')
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeUrl(u) {
  if (!u) return '';
  try {
    const url = new URL(u, 'https://x.invalid');
    // 去掉跟踪参数
    [...url.searchParams.keys()]
      .filter((k) => /^(utm_|fbclid|gclid|ref|ref_src|spm)/i.test(k))
      .forEach((k) => url.searchParams.delete(k));
    url.hash = '';
    return url.toString();
  } catch {
    return u;
  }
}

function hostOf(u) {
  try {
    return new URL(u).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/* ---------------- 后端 1: DuckDuckGo HTML ---------------- */

function parseDDG(html) {
  const out = [];
  if (!html) return out;
  const blocks = html.split(/class="result results_links/).slice(1);
  for (const b of blocks) {
    const linkM = b.match(/<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!linkM) continue;
    let url = linkM[1];
    // DDG 有时用 //duckduckgo.com/l/?uddg=<encoded>
    const uddg = url.match(/[?&]uddg=([^&]+)/);
    if (uddg) url = decodeURIComponent(uddg[1]);
    const snipM = b.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
    out.push({
      title: decode(linkM[2]),
      url: normalizeUrl(url),
      snippet: decode(snipM ? snipM[1] : ''),
      engine: 'duckduckgo',
    });
  }
  return out;
}

async function viaDuckDuckGo(q, page) {
  const body = new URLSearchParams({ q, kl: 'wt-wt', dc: String(page) });
  const { signal, done } = withTimeout(TIMEOUT);
  try {
    const res = await fetch('https://html.duckduckgo.com/html/', {
      method: 'POST',
      signal,
      headers: {
        'User-Agent': UA,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
      body,
    });
    if (!res.ok) return [];
    return parseDDG(await res.text());
  } catch {
    return [];
  } finally {
    done();
  }
}

/* ---------------- 后端 2: SearXNG 公共实例 ---------------- */

const SEARX_INSTANCES = [
  'https://searx.be',
  'https://search.bus-hit.me',
  'https://priv.au',
  'https://searxng.site',
  'https://opnxng.com',
];

async function viaSearx(q, page) {
  for (const base of SEARX_INSTANCES) {
    const url =
      `${base}/search?q=${encodeURIComponent(q)}` +
      `&format=json&safesearch=0&language=zh-CN&pageno=${page}`;
    const txt = await fetchText(url, { Accept: 'application/json' });
    if (!txt) continue;
    try {
      const data = JSON.parse(txt);
      const items = (data.results || []).map((r) => ({
        title: decode(r.title),
        url: normalizeUrl(r.url),
        snippet: decode(r.content),
        engine: 'searx',
      }));
      if (items.length) return items;
    } catch {
      /* 该实例不支持 json,试下一个 */
    }
  }
  return [];
}

/* ---------------- 后端 3: 维基百科(兜底,永远可用) ---------------- */

async function viaWikipedia(q) {
  const url =
    'https://zh.wikipedia.org/w/api.php?action=query&list=search&format=json' +
    `&srsearch=${encodeURIComponent(q)}&srlimit=6&origin=*`;
  const txt = await fetchText(url, { Accept: 'application/json' });
  if (!txt) return [];
  try {
    const data = JSON.parse(txt);
    return (data?.query?.search || []).map((r) => ({
      title: r.title,
      url: 'https://zh.wikipedia.org/wiki/' + encodeURIComponent(r.title),
      snippet: decode(r.snippet),
      engine: 'wikipedia',
    }));
  } catch {
    return [];
  }
}

/* ---------------- 聚合 + 去重 ---------------- */

function dedupe(list) {
  const seen = new Map();
  for (const r of list) {
    if (!r.url || !r.title) continue;
    const key = r.url.replace(/\/$/, '').toLowerCase();
    if (seen.has(key)) {
      const prev = seen.get(key);
      // 合并引擎来源,保留更长的摘要
      if (r.snippet && r.snippet.length > (prev.snippet || '').length) prev.snippet = r.snippet;
      prev.engines = [...new Set([...(prev.engines || [prev.engine]), r.engine])];
    } else {
      seen.set(key, { ...r, engines: [r.engine] });
    }
  }
  return [...seen.values()];
}

/* ---------------- 入口 ---------------- */

export async function onRequestGet(context) {
  const { request } = context;
  const params = new URL(request.url).searchParams;
  const q = (params.get('q') || '').trim();
  const page = Math.max(1, parseInt(params.get('page') || '1', 10) || 1);

  const json = (data) =>
    new Response(JSON.stringify(data), {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=60',
      },
    });

  if (!q) return json({ query: '', page, results: [], engines: [], elapsed: 0 });

  const t0 = Date.now();
  const settled = await Promise.allSettled([
    viaDuckDuckGo(q, page),
    viaSearx(q, page),
    viaWikipedia(q),
  ]);

  let results = [];
  const engines = [];
  for (const s of settled) {
    if (s.status === 'fulfilled' && s.value.length) {
      results.push(...s.value);
      engines.push(...new Set(s.value.map((r) => r.engine)));
    }
  }

  // 维基百科结果优先靠后:它是百科兜底,不适合压过网页结果
  const primary = results.filter((r) => r.engine !== 'wikipedia');
  const fallback = results.filter((r) => r.engine === 'wikipedia');
  results = dedupe([...primary, ...fallback]).map((r) => ({
    title: r.title,
    url: r.url,
    displayUrl: hostOf(r.url) + (new URL(r.url).pathname !== '/' ? new URL(r.url).pathname : ''),
    snippet: r.snippet || '',
    engines: [...new Set(r.engines || [r.engine])],
  }));

  return json({
    query: q,
    page,
    count: results.length,
    engines: [...new Set(engines)],
    elapsed: Date.now() - t0,
    results,
  });
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
