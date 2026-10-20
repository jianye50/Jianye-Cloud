/**
 * Web 版 ISO 写入工具 - 本地服务端
 * 纯 Node.js 实现，无第三方依赖。
 *
 * 用法：以管理员身份运行 `node server.js`（写入物理磁盘需要管理员权限）
 * 然后浏览器打开 http://localhost:5678
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const PORT = 5678;
const CHUNK = 1024 * 1024; // 1 MiB，需为 512 的倍数
const ISO_EXTS = ['.iso', '.img'];

// ---------------- 全局任务状态 ----------------
let job = {
  running: false,
  phase: 'idle', // idle | write | verify | done | failed
  written: 0,
  total: 0,
  speed: 0,
  error: null,
  cancelled: false,
  disk: null,
  startedAt: 0,
  endedAt: 0,
};

function resetJob(diskName, total) {
  job = {
    running: true,
    phase: 'write',
    written: 0,
    total: total || 0,
    speed: 0,
    error: null,
    cancelled: false,
    disk: diskName,
    startedAt: Date.now(),
    endedAt: 0,
  };
}

function fmtErr(e) {
  const msg = (e && e.message) || String(e);
  const code = (e && e.code) || '';
  if (code === 'EPERM' || code === 'EACCES') {
    return '没有写入权限（' + code + '）：请用【管理员身份】重新运行本服务，且不要从普通终端启动。';
  }
  if (code === 'EBUSY' || /sharing violation|being used/i.test(msg)) {
    return '目标磁盘被占用：请关闭资源管理器中打开该盘的窗口、弹出相关分区后重试。';
  }
  return msg;
}

// ---------------- 磁盘枚举 ----------------
function listDisks() {
  return new Promise((resolve, reject) => {
    const ps =
      'Get-CimInstance Win32_DiskDrive | ' +
      'Select-Object DeviceID,Index,Model,Size,InterfaceType,MediaType | ' +
      'ConvertTo-Json -Compress';
    const child = spawn('powershell.exe', ['-NoProfile', '-Command', ps], {
      windowsHide: true,
    });
    let out = '';
    let errOut = '';
    child.stdout.on('data', (d) => (out += d.toString('utf8')));
    child.stderr.on('data', (d) => (errOut += d.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error('枚举磁盘失败: ' + errOut.trim()));
      try {
        let data = JSON.parse(out);
        if (!Array.isArray(data)) data = [data];
        const disks = data
          .map((x) => ({
            number: typeof x.Index === 'number' ? x.Index : parseInt((String(x.DeviceID).match(/(\d+)$/) || [])[1], 10),
            device: x.DeviceID,
            model: x.Model || '未知磁盘',
            size: Number(x.Size) || 0,
            interface: x.InterfaceType || '',
            media: x.MediaType || '',
            removable: /removable/i.test(String(x.MediaType)),
          }))
          .filter((d) => !isNaN(d.number));
        resolve(disks);
      } catch (e) {
        reject(new Error('解析磁盘信息失败: ' + e.message));
      }
    });
  });
}

// 尝试卸载目标磁盘上的卷（提高裸写成功率）
function dismountVolumes(diskNumber) {
  return new Promise((resolve) => {
    const ps =
      'Get-Partition -DiskNumber ' + diskNumber + ' -ErrorAction SilentlyContinue | ' +
      'ForEach-Object { $_.DriveLetter } | Where-Object { $_ } | ' +
      'ForEach-Object { mountvol ("$($_):") /D }';
    const child = spawn('powershell.exe', ['-NoProfile', '-Command', ps], { windowsHide: true });
    child.on('error', () => resolve());
    child.on('close', () => resolve());
  });
}

// ---------------- 文件浏览 ----------------
function browse(dirPath) {
  if (!dirPath) {
    // 根：列出所有盘符
    const drives = [];
    for (let c = 65; c <= 90; c++) {
      const d = String.fromCharCode(c) + ':\\';
      try {
        fs.accessSync(d);
        drives.push({ name: d, type: 'dir' });
      } catch (_) {}
    }
    return { path: '', parent: null, dirs: drives, files: [] };
  }
  const abs = path.resolve(dirPath);
  const entries = fs.readdirSync(abs, { withFileTypes: true });
  const dirs = [];
  const files = [];
  for (const ent of entries) {
    if (ent.name.startsWith('$')) continue;
    if (ent.isDirectory()) {
      dirs.push({ name: ent.name, type: 'dir' });
    } else if (ent.isFile() && ISO_EXTS.includes(path.extname(ent.name).toLowerCase())) {
      let size = 0;
      try { size = fs.statSync(path.join(abs, ent.name)).size; } catch (_) {}
      files.push({ name: ent.name, type: 'file', size });
    }
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  files.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  return { path: abs, parent: path.dirname(abs), dirs, files };
}

// ---------------- 写入核心 ----------------
async function* fileChunks(p) {
  const stream = fs.createReadStream(p, { highWaterMark: CHUNK });
  for await (const c of stream) yield c;
}

async function* bodyChunks(req) {
  // 把请求体聚合成约 1 MiB 的块
  let buf = Buffer.alloc(0);
  for await (const chunk of req) {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    while (buf.length >= CHUNK) {
      yield buf.slice(0, CHUNK);
      buf = buf.slice(CHUNK);
    }
  }
  if (buf.length) yield buf;
}

function padTo512(buf) {
  if (buf.length % 512 === 0) return buf;
  const padded = Buffer.alloc(Math.ceil(buf.length / 512) * 512);
  buf.copy(padded, 0);
  return padded;
}

async function runWrite(opts) {
  // opts: { devicePath, diskLabel, total, chunks, verifySourcePath }
  resetJob(opts.diskLabel, opts.total);
  let handle;
  try {
    handle = await fs.promises.open(opts.devicePath, 'r+');

    // ---- 写入阶段 ----
    job.phase = 'write';
    let pos = 0;
    const t0 = Date.now();
    for await (let buf of opts.chunks) {
      if (job.cancelled) throw new Error('用户已取消写入');
      buf = padTo512(buf);
      await handle.write(buf, 0, buf.length, pos);
      pos += buf.length;
      job.written = pos;
      const dt = (Date.now() - t0) / 1000;
      if (dt > 0.5) job.speed = pos / dt;
    }
    try { await handle.sync(); } catch (_) {}

    // ---- 校验阶段（仅本地文件写入支持）----
    if (opts.verifySourcePath) {
      job.phase = 'verify';
      job.written = 0;
      let vpos = 0;
      for await (let src of fileChunks(opts.verifySourcePath)) {
        if (job.cancelled) throw new Error('用户已取消');
        const len = padTo512(src).length;
        const back = Buffer.alloc(len);
        const r = await handle.read(back, 0, len, vpos);
        if (!src.equals(back.slice(0, r.bytesRead))) {
          throw new Error('校验失败：回读数据与源文件不一致');
        }
        vpos += len;
        job.written = vpos;
      }
    }

    job.phase = 'done';
    job.endedAt = Date.now();
  } catch (e) {
    job.phase = 'failed';
    job.error = fmtErr(e);
    job.endedAt = Date.now();
  } finally {
    job.running = false;
    if (handle) await handle.close().catch(() => {});
  }
}

// ---------------- HTTP 服务 ----------------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

function send(res, code, data, type) {
  res.writeHead(code, { 'Content-Type': type || 'application/json; charset=utf-8' });
  res.end(typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data));
}

async function readJsonBody(req) {
  let body = '';
  for await (const c of req) body += c;
  return body ? JSON.parse(body) : {};
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  try {
    if (p === '/' || p === '/index.html') {
      const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));
      return send(res, 200, html, 'text/html; charset=utf-8');
    }

    if (p === '/api/disks' && req.method === 'GET') {
      const disks = await listDisks();
      return send(res, 200, { disks, isAdmin: await checkAdmin() });
    }

    if (p === '/api/browse' && req.method === 'GET') {
      const dir = url.searchParams.get('path') || '';
      return send(res, 200, browse(dir));
    }

    // 本地文件写入
    if (p === '/api/write' && req.method === 'POST') {
      if (job.running) return send(res, 409, { error: '已有写入任务进行中' });
      const body = await readJsonBody(req);
      const diskNumber = parseInt(body.disk, 10);
      const isoPath = path.resolve(body.isoPath || '');
      if (isNaN(diskNumber) || !isoPath) return send(res, 400, { error: '参数不完整' });

      const stat = fs.statSync(isoPath);
      if (!stat.isFile()) return send(res, 400, { error: 'ISO 路径无效' });

      const disks = await listDisks();
      const disk = disks.find((d) => d.number === diskNumber);
      if (!disk) return send(res, 400, { error: '目标磁盘不存在' });
      if (stat.size > disk.size) return send(res, 400, { error: `镜像 (${fmtSize(stat.size)}) 大于目标磁盘容量 (${fmtSize(disk.size)})` });

      await dismountVolumes(diskNumber);

      // 异步启动，不阻塞响应
      runWrite({
        devicePath: '\\\\.\\PhysicalDrive' + diskNumber,
        diskLabel: disk.model,
        total: stat.size,
        chunks: fileChunks(isoPath),
        verifySourcePath: body.verify ? isoPath : null,
      });
      return send(res, 200, { ok: true });
    }

    // 拖拽上传写入：请求体即镜像内容，边接收边写盘
    if (p === '/api/write-upload' && req.method === 'POST') {
      if (job.running) return send(res, 409, { error: '已有写入任务进行中' });
      const diskNumber = parseInt(url.searchParams.get('disk'), 10);
      const total = parseInt(url.searchParams.get('size'), 10) || Number(req.headers['content-length']) || 0;
      if (isNaN(diskNumber)) return send(res, 400, { error: '参数不完整' });

      const disks = await listDisks();
      const disk = disks.find((d) => d.number === diskNumber);
      if (!disk) return send(res, 400, { error: '目标磁盘不存在' });
      if (total > disk.size) return send(res, 400, { error: `镜像 (${fmtSize(total)}) 大于目标磁盘容量 (${fmtSize(disk.size)})` });

      await dismountVolumes(diskNumber);

      runWrite({
        devicePath: '\\\\.\\PhysicalDrive' + diskNumber,
        diskLabel: disk.model,
        total,
        chunks: bodyChunks(req),
        verifySourcePath: null, // 上传模式写完即释放，无法回读源文件校验
      });
      // 等待写入结束再返回，前端用轮询看进度
      await waitJobEnd();
      if (job.phase === 'failed') return send(res, 500, { error: job.error });
      return send(res, 200, { ok: true, phase: job.phase });
    }

    if (p === '/api/progress' && req.method === 'GET') {
      return send(res, 200, {
        running: job.running,
        phase: job.phase,
        written: job.written,
        total: job.total,
        speed: job.speed,
        error: job.error,
        disk: job.disk,
        elapsed: job.startedAt ? ((job.endedAt || Date.now()) - job.startedAt) / 1000 : 0,
      });
    }

    if (p === '/api/cancel' && req.method === 'POST') {
      job.cancelled = true;
      return send(res, 200, { ok: true });
    }

    send(res, 404, { error: 'Not Found' });
  } catch (e) {
    send(res, 500, { error: fmtErr(e) });
  }
});

function waitJobEnd() {
  return new Promise((resolve) => {
    const t = setInterval(() => {
      if (!job.running) { clearInterval(t); resolve(); }
    }, 300);
  });
}

async function checkAdmin() {
  return new Promise((resolve) => {
    const child = spawn('net.exe', ['session'], { windowsHide: true });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

function fmtSize(n) {
  if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(2) + ' GB';
  if (n >= 1024 ** 2) return (n / 1024 ** 2).toFixed(1) + ' MB';
  return (n / 1024).toFixed(1) + ' KB';
}

server.listen(PORT, '127.0.0.1', () => {
  console.log('==========================================================');
  console.log('  Web 版 ISO 写入工具已启动');
  console.log('  请在浏览器打开:  http://localhost:' + PORT);
  console.log('  注意: 写入物理磁盘需要【管理员权限】运行本程序');
  console.log('==========================================================');
});
