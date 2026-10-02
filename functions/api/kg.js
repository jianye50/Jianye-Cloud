/* ============================================================
   鉴业音乐 · 云端读取酷狗歌单
   ------------------------------------------------------------
   线上路径：/api/kg
   为什么需要它：酷狗接口没有开放跨域（响应里没有
   Access-Control-Allow-Origin），浏览器直接请求会被拦掉，
   所以由 Cloudflare 的边缘节点替网页去读，再把结果原样吐回来。

   部署：把本文件放到仓库根目录 functions/api/kg.js
        （即 functions/api/kg.js），Cloudflare Pages 会自动
        挂到 /api/kg，不需要任何额外配置。

   可选参数：
     ?gid=collection_xxx   换一个歌单
     ?refresh=1            跳过缓存，强制重新抓
   ============================================================ */

const SALT = 'OIlwieks28dk2k092lksi2UIkp';
const APPID = 1005;
const CLIENTVER = 20489;
const UA = 'Android15-1070-11083-46-0-DiscoveryDRADProtocol-wifi';
const KG = 'https://gateway.kugou.com';
const KG_PATH = '/pubsongs/v2/get_other_list_file_nofilt';
const DEFAULT_GID = 'collection_3_1977029865_2_0';   // 鉴业喜欢的音乐
const PS = 300;        // 接口单页上限（给更大也只返回 300）
const CONC = 4;        // 并发抓几页
const TTL = 1800;      // 缓存 30 分钟，避免每次开网页都抓 11 遍

/* ---------------- MD5（Workers 的 crypto.subtle 不支持 MD5，自己实现） ---------------- */
const _K = new Uint32Array(64);
for (let i = 0; i < 64; i++) _K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0;
const _S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21
];

function md5hex(str) {
  const bytes = new TextEncoder().encode(str);
  const len = bytes.length;
  const total = (((len + 8) >> 6) + 1) << 6;
  const buf = new Uint8Array(total);
  buf.set(bytes);
  buf[len] = 0x80;
  const dv = new DataView(buf.buffer);
  const bits = len * 8;
  dv.setUint32(total - 8, bits >>> 0, true);
  dv.setUint32(total - 4, Math.floor(bits / 4294967296), true);

  let a = 0x67452301, b = 0xefcdab89, c = 0x98badcfe, d = 0x10325476;
  const M = new Uint32Array(16);
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) M[i] = dv.getUint32(off + (i << 2), true);
    let A = a, B = b, C = c, D = d;
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) & 15; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) & 15; }
      else { F = C ^ (B | ~D); g = (7 * i) & 15; }
      const t = (A + F + _K[i] + M[g]) | 0;
      A = D; D = C; C = B;
      const s = _S[i];
      B = (B + ((t << s) | (t >>> (32 - s)))) | 0;
    }
    a = (a + A) | 0; b = (b + B) | 0; c = (c + C) | 0; d = (d + D) | 0;
  }
  const out = new Uint8Array(16);
  const ov = new DataView(out.buffer);
  ov.setUint32(0, a >>> 0, true); ov.setUint32(4, b >>> 0, true);
  ov.setUint32(8, c >>> 0, true); ov.setUint32(12, d >>> 0, true);
  let hex = '';
  for (let i = 0; i < 16; i++) hex += out[i].toString(16).padStart(2, '0');
  return hex;
}

function randHex(n) {
  const a = new Uint8Array(n / 2);
  crypto.getRandomValues(a);
  let s = '';
  for (let i = 0; i < a.length; i++) s += a[i].toString(16).padStart(2, '0');
  return s;
}

/* ---------------- 调一次酷狗接口（带签名） ---------------- */
async function kgCall(params) {
  const mid = randHex(32);
  const dfid = '-';
  const ct = Math.floor(Date.now() / 1000);
  const p = { dfid, mid, uuid: '-', appid: APPID, clientver: CLIENTVER, clienttime: ct };
  for (const k in params) p[k] = params[k];

  const sorted = Object.keys(p).sort().map(k => k + '=' + p[k]).join('');
  p.signature = md5hex(SALT + sorted + SALT);

  const qs = Object.keys(p).map(k => k + '=' + encodeURIComponent(p[k])).join('&');
  const r = await fetch(KG + KG_PATH + '?' + qs, {
    headers: {
      'User-Agent': UA,
      'dfid': dfid,
      'clienttime': String(ct),
      'mid': mid,
      'Accept': 'application/json'
    }
  });
  if (!r.ok) throw new Error('kugou HTTP ' + r.status);
  const j = await r.json();
  if (j && j.error_code) throw new Error('kugou error ' + j.error_code + ' ' + (j.errmsg || ''));
  return j;
}

/* ---------------- 酷狗返回的是 "歌手 - 歌名"，拆开存成 "歌名|歌手" ---------------- */
function parseSong(s) {
  const full = (s && s.name ? String(s.name) : '').trim();
  if (!full) return null;
  let title = full;
  let artists = [];
  if (Array.isArray(s.singerinfo)) {
    artists = s.singerinfo.map(x => x && x.name).filter(Boolean);
  }
  const k = full.indexOf(' - ');
  if (k >= 0) {
    if (!artists.length) artists = [full.slice(0, k).trim()];
    title = full.slice(k + 3).trim();
  }
  if (!title) return null;
  const a = artists.join('、');
  return {
    key: title + '|' + (artists[0] || ''),
    line: a ? title + '|' + a : title
  };
}

/* ---------------- 抓整张歌单（第一页探总数，其余并发拉） ---------------- */
async function fetchAll(gid) {
  const base = {
    area_code: 1, plat: 1, type: 1, mode: 1, personal_switch: 1,
    extend_fields: 'abtags', pagesize: PS, global_collection_id: gid
  };

  const first = await kgCall(Object.assign({}, base, { begin_idx: 0 }));
  const d0 = first.data || {};
  const total = d0.count || 0;
  const listName = (d0.list_info && d0.list_info.name) || '我的酷狗歌单';

  const lines = [];
  const seen = new Set();
  const add = arr => {
    if (!Array.isArray(arr)) return;
    for (const s of arr) {
      const o = parseSong(s);
      if (!o || seen.has(o.key)) continue;
      seen.add(o.key);
      lines.push(o.line);
    }
  };
  add(d0.songs);

  const offsets = [];
  for (let i = PS; i < total; i += PS) offsets.push(i);

  for (let i = 0; i < offsets.length; i += CONC) {
    const batch = offsets.slice(i, i + CONC);
    const rs = await Promise.all(batch.map(b =>
      kgCall(Object.assign({}, base, { begin_idx: b }))
        .catch(() => kgCall(Object.assign({}, base, { begin_idx: b })).catch(() => null))
    ));
    for (const r of rs) if (r) add((r.data || {}).songs);
  }

  return { lines, listName, total };
}

/* ---------------- 入口 ---------------- */
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': '*'
};

export async function onRequestGet(ctx) {
  const url = new URL(ctx.request.url);
  const gid = url.searchParams.get('gid') || DEFAULT_GID;
  const refresh = url.searchParams.get('refresh') === '1';
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  const cacheKey = new Request('https://kg-cache.internal/v1/' + encodeURIComponent(gid));

  if (cache && !refresh) {
    try {
      const hit = await cache.match(cacheKey);
      if (hit) {
        const at = parseInt(hit.headers.get('x-kg-at') || '0', 10);
        if (at && Date.now() - at < TTL * 1000) return hit;
      }
    } catch (e) { /* 缓存不可用就直接去抓 */ }
  }

  try {
    const { lines, listName, total } = await fetchAll(gid);
    if (!lines.length) throw new Error('歌单是空的（可能被设为私密，或歌单号变了）');

    const body = {
      ok: true,
      cloud: true,
      gid,
      name: listName,
      uid: 1977029865,
      src: '酷狗音乐',
      updated: new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10),
      total,                        // 酷狗那边原始条数（含被去重的）
      count: lines.length,          // 去重后实际可用条数
      at: Date.now(),
      songs: lines
    };

    const res = new Response(JSON.stringify(body), {
      status: 200,
      headers: Object.assign({
        'content-type': 'application/json;charset=utf-8',
        'cache-control': 'public, max-age=' + TTL,
        'x-kg-at': String(Date.now())
      }, CORS)
    });
    if (cache && ctx.waitUntil) {
      ctx.waitUntil(cache.put(cacheKey, res.clone()).catch(() => {}));
    }
    return res;
  } catch (e) {
    return new Response(JSON.stringify({
      ok: false,
      error: String((e && e.message) || e)
    }), {
      status: 502,
      headers: Object.assign({
        'content-type': 'application/json;charset=utf-8',
        'cache-control': 'no-store'
      }, CORS)
    });
  }
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}
