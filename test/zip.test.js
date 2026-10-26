/**
 * dsh-skill-manager —— zip.js 自测
 * ============================================================================
 * 约定：上层测试台注入 t(name, fn)，fn 可以是 async。
 *   export default function register(t) { t('用例名', async () => { ... }); }
 * 临时文件一律建在 os.tmpdir() 下，测完清理。
 *
 * 这里的 rawZip() 是一个**独立于 zip.js 的手工 ZIP 构造器**，用于伪造
 * malicious / 损坏归档（路径穿越名、加密位、未知方法、ZIP64 扩展字段、
 * 撒谎的尺寸、数据描述符等），以便在读取侧做对抗性验证。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Buffer } from 'node:buffer';

import {
  createZip,
  readZip,
  crc32,
  safeZipEntryName,
  ZIP_METHOD_STORE,
  ZIP_METHOD_DEFLATE,
} from '../lib/core/zip.js';

// ---------------------------------------------------------------------------
// 测试辅助
// ---------------------------------------------------------------------------

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;

const CHINESE_NAME = 'srs-generator/references/线框DSL渲染器V0.1.py';

/** 手工构造一个 ZIP（只实现到刚好够 readZip 解析的程度） */
function rawZip(list) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const e of list) {
    const nameBuf = e.nameBytes ? Buffer.from(e.nameBytes) : Buffer.from(e.name, 'utf8');
    const data = e.data === undefined
      ? Buffer.alloc(0)
      : (Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data));
    const method = e.method === undefined ? 0 : e.method;
    const flags = e.flags === undefined ? 0 : e.flags;
    const checksum = e.crc === undefined ? crc32(data) : e.crc;
    const csize = e.compressedSize === undefined ? data.length : e.compressedSize;
    const usize = e.uncompressedSize === undefined ? data.length : e.uncompressedSize;
    const dosTime = e.dosTime === undefined ? 0 : e.dosTime;
    const dosDate = e.dosDate === undefined ? 0x5021 : e.dosDate;
    // 本地头写 0（模拟数据描述符归档，真实值只在中央目录里）
    const localCrc = e.localZeroSizes ? 0 : checksum;
    const localCsize = e.localZeroSizes ? 0 : csize;
    const localUsize = e.localZeroSizes ? 0 : usize;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(localCrc, 14);
    local.writeUInt32LE(localCsize, 18);
    local.writeUInt32LE(localUsize, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    const cdExtra = e.cdExtra ? Buffer.from(e.cdExtra) : Buffer.alloc(0);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(SIG_CENTRAL, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(csize, 20);
    central.writeUInt32LE(usize, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(cdExtra.length, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(e.externalAttributes === undefined ? 0 : e.externalAttributes, 38);
    central.writeUInt32LE(offset, 42);

    localParts.push(local, nameBuf, data);
    centralParts.push(central, nameBuf, cdExtra);
    offset += local.length + nameBuf.length + data.length;
  }

  const cd = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(list.length, 8);
  eocd.writeUInt16LE(list.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, cd, eocd]);
}

/** 找到 EOCD 的偏移（用于篡改测试） */
function locateEocd(buf) {
  for (let i = buf.length - 22; i >= 0; i -= 1) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  }
  throw new Error('测试辅助：未找到 EOCD');
}

/** 找到第一条中央目录记录的偏移 */
function locateCentral(buf) {
  const eocd = locateEocd(buf);
  return buf.readUInt32LE(eocd + 16);
}

/** 取某个条目在返回结果里的下标 */
function entryByName(result, name) {
  return result.entries.find((e) => e.name === name);
}

/** 在 os.tmpdir() 下创建临时目录 */
function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-zip-test-'));
}

// ---------------------------------------------------------------------------
// 用例注册
// ---------------------------------------------------------------------------

export default function register(t) {
  // ===== CRC32 / 常量 =====

  t('crc32 标准校验值正确', async () => {
    assert.equal(crc32(Buffer.from('123456789', 'utf8')), 0xcbf43926);
    assert.equal(crc32(Buffer.alloc(0)), 0);
    assert.equal(crc32('中文内容') >= 0, true);
    assert.equal(Number.isInteger(crc32('abc')), true);
    assert.ok(crc32('abc') <= 0xffffffff);
  });

  t('压缩方法常量取值正确', async () => {
    assert.equal(ZIP_METHOD_STORE, 0);
    assert.equal(ZIP_METHOD_DEFLATE, 8);
  });

  // ===== 基本往返 =====

  t('store 方法往返一致', async () => {
    const data = Buffer.from('hello store 内容', 'utf8');
    const buf = createZip([{ name: 'a.txt', data, compress: false }]);
    const r = readZip(buf);
    assert.deepEqual(r.problems, []);
    assert.equal(r.entries.length, 1);
    assert.equal(r.entries[0].name, 'a.txt');
    assert.equal(r.entries[0].method, ZIP_METHOD_STORE);
    assert.equal(r.entries[0].data.equals(data), true);
    assert.equal(r.entries[0].size, data.length);
    assert.equal(r.entries[0].compressedSize, data.length);
    assert.equal(r.entries[0].crc32, crc32(data));
    assert.equal(r.entries[0].isDirectory, false);
  });

  t('deflate 方法往返一致（可压缩数据真的走了 deflate）', async () => {
    const data = Buffer.from('压缩测试-ABCDEFGH-'.repeat(2000), 'utf8');
    const buf = createZip([{ name: 'big.txt', data, compress: true }]);
    const r = readZip(buf);
    assert.deepEqual(r.problems, []);
    assert.equal(r.entries[0].method, ZIP_METHOD_DEFLATE);
    assert.ok(r.entries[0].compressedSize < r.entries[0].size, 'deflate 后应更小');
    assert.equal(r.entries[0].data.equals(data), true);
  });

  t('压缩后反而变大时自动回退为 store', async () => {
    const r = readZip(createZip([{ name: 'tiny.txt', data: 'hi', compress: true }]));
    assert.equal(r.entries[0].method, ZIP_METHOD_STORE);
    assert.equal(r.entries[0].data.toString('utf8'), 'hi');
  });

  t('中文文件名往返一致（含题目给的样例路径）', async () => {
    const data = Buffer.from('print("线框")', 'utf8');
    const buf = createZip([{ name: CHINESE_NAME, data, compress: true }]);
    const r = readZip(buf);
    assert.deepEqual(r.problems, []);
    assert.equal(r.entries[0].name, CHINESE_NAME);
    assert.equal(r.entries[0].data.equals(data), true);
  });

  t('写入时通用标志位 bit 11（0x0800）被置位', async () => {
    const buf = createZip([{ name: 'a.txt', data: 'x', compress: false }]);
    assert.equal(buf.readUInt32LE(0), SIG_LOCAL);
    assert.equal(buf.readUInt16LE(6) & 0x0800, 0x0800, '本地头 bit 11 未置位');
    assert.equal(buf.readUInt16LE(6) & 0x0001, 0, '不应置加密位');
    const cd = locateCentral(buf);
    assert.equal(buf.readUInt16LE(cd + 8) & 0x0800, 0x0800, '中央目录 bit 11 未置位');
  });

  t('空文件往返一致', async () => {
    const r = readZip(createZip([{ name: 'empty.txt', data: Buffer.alloc(0) }]));
    assert.deepEqual(r.problems, []);
    assert.equal(r.entries[0].size, 0);
    assert.equal(r.entries[0].data.length, 0);
    assert.equal(r.entries[0].crc32, 0);
    assert.equal(r.entries[0].isDirectory, false);
  });

  t('嵌套路径往返一致', async () => {
    const buf = createZip([
      { name: 'skill-a/SKILL.md', data: '# 说明' },
      { name: 'skill-a/lib/core/x.js', data: 'export const a = 1;' },
      { name: 'skill-a/assets/图片 1.png', data: Buffer.from([1, 2, 3]) },
    ]);
    const r = readZip(buf);
    assert.deepEqual(r.problems, []);
    assert.equal(r.entries.length, 3);
    assert.equal(entryByName(r, 'skill-a/lib/core/x.js').data.toString('utf8'), 'export const a = 1;');
    assert.equal(entryByName(r, 'skill-a/assets/图片 1.png').data.equals(Buffer.from([1, 2, 3])), true);
  });

  t('从 path 读取内容（data 优先于 path）', async () => {
    const dir = makeTempDir();
    try {
      const file = path.join(dir, 'src.txt');
      fs.writeFileSync(file, '来自文件的内容', 'utf8');
      const r = readZip(createZip([
        { name: 'from-path.txt', path: file },
        { name: 'data-wins.txt', path: file, data: 'data 优先' },
      ]));
      assert.deepEqual(r.problems, []);
      assert.equal(entryByName(r, 'from-path.txt').data.toString('utf8'), '来自文件的内容');
      assert.equal(entryByName(r, 'data-wins.txt').data.toString('utf8'), 'data 优先');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // ===== 目录项 =====

  t('目录项写入后可读回 isDirectory: true', async () => {
    const buf = createZip([
      { name: 'dir/' },
      { name: 'dir/sub/' },
      { name: 'dir/sub/a.txt', data: 'x' },
    ]);
    const r = readZip(buf);
    assert.deepEqual(r.problems, []);
    const dir = entryByName(r, 'dir/');
    assert.equal(dir.isDirectory, true);
    assert.equal(dir.size, 0);
    assert.equal(dir.data.length, 0);
    assert.equal(entryByName(r, 'dir/sub/').isDirectory, true);
    assert.equal(entryByName(r, 'dir/sub/a.txt').isDirectory, false);

    // 中央目录里 external attributes 的低字节应有 MS-DOS 目录位 0x10
    const cd = locateCentral(buf);
    assert.equal(buf.readUInt32LE(cd + 38) & 0x10, 0x10);
    assert.equal(dir.externalAttributes & 0x10, 0x10);
  });

  t('目录项写入非空数据会被拒绝', async () => {
    assert.throws(() => createZip([{ name: 'dir/', data: 'non-empty' }]), /目录条目/);
  });

  // ===== 确定性 & DOS 时间 =====

  t('确定性：同样输入两次调用逐字节相同', async () => {
    const entries = () => ([
      { name: 'a.txt', data: 'AAAA'.repeat(100) },
      { name: CHINESE_NAME, data: Buffer.from('中文内容', 'utf8') },
      { name: 'dir/' },
      { name: 'empty.txt', data: Buffer.alloc(0) },
      { name: 'stored.bin', data: Buffer.from([0, 1, 2, 3]), compress: false },
    ]);
    const one = createZip(entries());
    const two = createZip(entries());
    assert.equal(Buffer.compare(one, two), 0, '两次 createZip 结果不一致');

    const three = createZip(entries(), { compress: false });
    const four = createZip(entries(), { compress: false });
    assert.equal(Buffer.compare(three, four), 0);

    // 默认 mtime 固定，因此不传 mtime 也稳定
    assert.equal(Buffer.compare(one, createZip(entries(), { mtime: new Date('2020-01-01T00:00:00Z') })), 0);
  });

  t('DOS 日期与时间位域编码正确且可回读', async () => {
    const when = new Date('2023-07-15T13:45:30Z'); // 偶数秒，避免 2 秒精度截断
    const buf = createZip([{ name: 't.txt', data: 'x', mtime: when }]);

    const dosTime = buf.readUInt16LE(10);
    const dosDate = buf.readUInt16LE(12);
    // time: 时<<11 | 分<<5 | 秒/2
    assert.equal(dosTime, (13 << 11) | (45 << 5) | (30 >> 1));
    // date: (年-1980)<<9 | 月<<5 | 日
    assert.equal(dosDate, ((2023 - 1980) << 9) | (7 << 5) | 15);

    const r = readZip(buf);
    assert.equal(r.entries[0].mtime.getTime(), when.getTime());
  });

  t('不传 mtime 时条目时间为固定的 2020-01-01T00:00:00Z', async () => {
    const r = readZip(createZip([{ name: 'a.txt', data: 'x' }]));
    assert.equal(r.entries[0].mtime.getTime(), Date.parse('2020-01-01T00:00:00Z'));
  });

  t('DOS 时间秒精度为 2 秒（奇数秒向下取整）', async () => {
    const r = readZip(createZip([{ name: 'a.txt', data: 'x', mtime: new Date('2021-03-04T05:06:07Z') }]));
    assert.equal(r.entries[0].mtime.getTime(), Date.parse('2021-03-04T05:06:06Z'));
  });

  // ===== safeZipEntryName =====

  t('safeZipEntryName 拒绝 6 类不安全名字', async () => {
    // 1) 绝对路径
    for (const n of ['/etc/passwd', '\\windows\\system32']) {
      const r = safeZipEntryName(n);
      assert.equal(r.ok, false, `${n} 应被拒绝`);
      assert.equal(r.reason, 'ABSOLUTE_PATH');
      assert.ok(r.message.length > 0);
    }
    // 2) 盘符
    for (const n of ['C:/x.txt', 'c:evil.txt', 'a/b:C.txt']) {
      assert.equal(safeZipEntryName(n).ok, false, `${n} 应被拒绝`);
      assert.equal(safeZipEntryName(n).reason, 'DRIVE_LETTER');
    }
    // 3) 路径穿越
    for (const n of ['../up.txt', 'a/../../b.txt', 'a\\..\\b.txt', '..']) {
      assert.equal(safeZipEntryName(n).ok, false, `${n} 应被拒绝`);
      assert.equal(safeZipEntryName(n).reason, 'PATH_TRAVERSAL');
    }
    // 4) NUL
    const nul = safeZipEntryName('nul\0byte.txt');
    assert.equal(nul.ok, false);
    assert.equal(nul.reason, 'NUL_BYTE');
    // 5) Windows 保留名（忽略扩展名与大小写）
    for (const n of ['CON', 'con.txt', 'a/PRN.md', 'aux', 'COM1/', 'lpt9.log', 'dir/NUL.json']) {
      const r = safeZipEntryName(n);
      assert.equal(r.ok, false, `${n} 应被拒绝`);
      assert.equal(r.reason, 'WINDOWS_RESERVED_NAME');
    }
    // 6) 以点或空格结尾的段
    for (const n of ['a./b.txt', 'trail.txt ', 'dir /x.txt', 'a/b./c.txt']) {
      const r = safeZipEntryName(n);
      assert.equal(r.ok, false, `${n} 应被拒绝`);
      assert.ok(r.reason === 'TRAILING_DOT' || r.reason === 'TRAILING_SPACE');
    }
  });

  t('safeZipEntryName 允许中文/空格/中间目录与合法边界名', async () => {
    for (const n of [
      CHINESE_NAME,
      'a b/c d.txt',
      'dir/',
      'dir/sub/',
      '.gitignore',
      'a-b_c.1.txt',
      'skill-a/SKILL.md',
      '带 空格 的/目录/文件.txt',
    ]) {
      const r = safeZipEntryName(n);
      assert.equal(r.ok, true, `${n} 应被允许，实际被拒：${r.reason}`);
      assert.equal(r.name, n, '校验通过时不应重写名字');
    }
    // 其它非法输入
    assert.equal(safeZipEntryName('').ok, false);
    assert.equal(safeZipEntryName('   /   ').ok, false);
    assert.equal(safeZipEntryName(null).ok, false);
  });

  t('createZip 拒绝不安全条目名', async () => {
    assert.throws(() => createZip([{ name: '../evil.txt', data: 'x' }]), /不安全/);
    assert.throws(() => createZip([{ name: 'C:/evil.txt', data: 'x' }]), /不安全/);
    assert.throws(() => createZip([{ name: 'CON', data: 'x' }]), /不安全/);
  });

  // ===== 读取侧安全 / 健壮性 =====

  t('CRC 篡改会被检测出来（不抛错，产出 problem）', async () => {
    const name = 'data.txt';
    const buf = createZip([{ name, data: 'hello world', compress: false }]);
    assert.equal(buf.readUInt32LE(0), SIG_LOCAL);
    const dataOffset = 30 + Buffer.byteLength(name, 'utf8');
    buf[dataOffset] ^= 0xff; // 篡改一个字节

    const r = readZip(buf);
    assert.equal(r.entries.length, 0, '损坏条目不应进入 entries');
    const p = r.problems.find((x) => x.code === 'CRC_MISMATCH');
    assert.ok(p, `应产出 CRC_MISMATCH，实际：${JSON.stringify(r.problems)}`);
    assert.equal(p.name, name);
    assert.ok(p.message.includes('CRC32'));
  });

  t('解压后长度与声明不符会被检测出来', async () => {
    const buf = rawZip([{ name: 'ok.txt', data: 'abcde', uncompressedSize: 100 }]);
    const r = readZip(buf);
    assert.equal(r.entries.length, 0);
    assert.ok(r.problems.some((p) => p.code === 'SIZE_MISMATCH'));
  });

  t('deflate 数据被破坏时产出 problem 而不崩溃', async () => {
    const data = Buffer.from('X'.repeat(5000), 'utf8');
    const buf = createZip([{ name: 'z.txt', data, compress: true }]);
    const dataOffset = 30 + Buffer.byteLength('z.txt', 'utf8');
    for (let i = 0; i < 20; i += 1) buf[dataOffset + i] ^= 0xa5;
    const r = readZip(buf);
    assert.equal(r.entries.length, 0);
    assert.ok(r.problems.some((p) => p.code === 'INFLATE_FAILED' || p.code === 'CRC_MISMATCH'),
      `应有解压失败或 CRC 问题，实际：${JSON.stringify(r.problems)}`);
  });

  t('ZIP64 哨兵：EOCD 条目数 0xFFFF 被识别', async () => {
    const buf = createZip([{ name: 'a.txt', data: 'x' }]);
    const eocd = locateEocd(buf);
    const patched = Buffer.from(buf);
    patched.writeUInt16LE(0xffff, eocd + 10);
    const r = readZip(patched);
    assert.equal(r.entries.length, 0);
    const p = r.problems.find((x) => x.code === 'ZIP64_UNSUPPORTED');
    assert.ok(p, `应产出 ZIP64_UNSUPPORTED，实际：${JSON.stringify(r.problems)}`);
    assert.ok(p.message.includes('ZIP64'));
  });

  t('ZIP64 哨兵：EOCD 中央目录偏移 0xFFFFFFFF 被识别', async () => {
    const buf = createZip([{ name: 'a.txt', data: 'x' }]);
    const eocd = locateEocd(buf);
    const patched = Buffer.from(buf);
    patched.writeUInt32LE(0xffffffff, eocd + 16);
    const r = readZip(patched);
    assert.equal(r.entries.length, 0);
    assert.ok(r.problems.some((p) => p.code === 'ZIP64_UNSUPPORTED'));
  });

  t('ZIP64 哨兵：条目大小 0xFFFFFFFF 被识别', async () => {
    const buf = rawZip([{ name: 'a.txt', data: 'x', uncompressedSize: 0xffffffff }]);
    const r = readZip(buf);
    assert.equal(r.entries.length, 0);
    assert.ok(r.problems.some((p) => p.code === 'ZIP64_UNSUPPORTED'));
  });

  t('ZIP64 扩展字段 0x0001 被识别并标注 ZIP64', async () => {
    // 头部 0x0001 + 长度 8 + 8 字节占位数据
    const zip64Extra = Buffer.from([0x01, 0x00, 0x08, 0x00, 1, 0, 0, 0, 2, 0, 0, 0]);
    const buf = rawZip([{ name: 'a.txt', data: 'x', cdExtra: zip64Extra }]);
    const r = readZip(buf);
    assert.equal(r.entries.length, 0);
    const p = r.problems.find((x) => x.code === 'ZIP64_UNSUPPORTED');
    assert.ok(p, `应产出 ZIP64_UNSUPPORTED，实际：${JSON.stringify(r.problems)}`);
    assert.ok(p.message.includes('ZIP64'));
    assert.equal(p.name, 'a.txt');
  });

  t('ZIP64 超出写入能力时 createZip 明确报错', async () => {
    // 条目数 > 0xFFFF
    const many = new Array(0x10000).fill(null).map((_, i) => ({ name: `d${i}/` }));
    assert.throws(() => createZip(many), (err) => {
      assert.equal(err.code, 'ZIP64_UNSUPPORTED');
      assert.ok(err.message.includes('ZIP64'));
      assert.ok(err.message.includes('不支持 ZIP64'));
      return true;
    });

    // 声明大小 >= 0xFFFFFFFF（用 defineProperty 伪造长度，不真分配 4GB）
    const fake = Buffer.alloc(8);
    Object.defineProperty(fake, 'length', { value: 0xffffffff });
    assert.equal(fake.length, 0xffffffff);
    assert.throws(
      () => createZip([{ name: 'huge.bin', data: fake, compress: false }]),
      /不支持 ZIP64/,
    );
  });

  t('超大条目（声明 > 64MB）被拒绝，且不需要真的造 64MB 数据', async () => {
    const buf = rawZip([{
      name: 'bomb.bin',
      data: 'tiny',
      uncompressedSize: 70 * 1024 * 1024, // 只撒谎声明，不真造数据
    }]);
    const r = readZip(buf);
    assert.equal(r.entries.length, 0);
    const p = r.problems.find((x) => x.code === 'ENTRY_TOO_LARGE');
    assert.ok(p, `应产出 ENTRY_TOO_LARGE，实际：${JSON.stringify(r.problems)}`);
    assert.equal(p.name, 'bomb.bin');
    assert.ok(p.message.includes('64MB'));
  });

  t('加密条目（bit 0）产出 problem 而不是崩溃', async () => {
    const buf = rawZip([{ name: 'secret.txt', data: 'x', flags: 0x0001 }]);
    const r = readZip(buf);
    assert.equal(r.entries.length, 0);
    const p = r.problems.find((x) => x.code === 'ENCRYPTED');
    assert.ok(p, `应产出 ENCRYPTED，实际：${JSON.stringify(r.problems)}`);
    assert.equal(p.name, 'secret.txt');
  });

  t('未知压缩方法产出 problem 而不是崩溃', async () => {
    const buf = rawZip([{ name: 'weird.bin', data: 'x', method: 99 }]);
    const r = readZip(buf);
    assert.equal(r.entries.length, 0);
    const p = r.problems.find((x) => x.code === 'UNSUPPORTED_METHOD');
    assert.ok(p, `应产出 UNSUPPORTED_METHOD，实际：${JSON.stringify(r.problems)}`);
    assert.ok(p.message.includes('99'));
  });

  t('数据描述符（bit 3）条目可以正常读取', async () => {
    const buf = rawZip([{
      name: 'dd.txt',
      data: 'descriptor',
      flags: 0x0808, // bit 3 + bit 11
      localZeroSizes: true,
    }]);
    const r = readZip(buf);
    assert.deepEqual(r.problems, []);
    assert.equal(r.entries.length, 1);
    assert.equal(r.entries[0].data.toString('utf8'), 'descriptor');
  });

  t('读取时不安全条目被跳过并记 problem，安全条目正常保留', async () => {
    const buf = rawZip([
      { name: 'good/a.txt', data: 'ok' },
      { name: '../escape.txt', data: 'bad' },
      { name: 'C:/abs.txt', data: 'bad' },
    ]);
    const r = readZip(buf);
    assert.equal(r.entries.length, 1);
    assert.equal(r.entries[0].name, 'good/a.txt');
    const unsafe = r.problems.filter((p) => p.code === 'UNSAFE_NAME');
    assert.equal(unsafe.length, 2, `应跳过 2 条不安全条目，实际：${JSON.stringify(r.problems)}`);
    assert.deepEqual(unsafe.map((p) => p.name).sort(), ['../escape.txt', 'C:/abs.txt']);
  });

  // ===== 文件名编码 =====

  t('未置 bit 11 的合法 UTF-8 名字仍按 UTF-8 解码', async () => {
    const buf = rawZip([{ name: CHINESE_NAME, data: 'x', flags: 0x0000 }]);
    const r = readZip(buf);
    assert.deepEqual(r.problems, []);
    assert.equal(r.entries[0].name, CHINESE_NAME);
  });

  t('未置 bit 11 且非法 UTF-8 时退回 latin1', async () => {
    // 0xC4 0xE3 是 GBK 字节，不是合法 UTF-8 序列
    const nameBytes = Buffer.from([0xc4, 0xe3, 0x2e, 0x74, 0x78, 0x74]);
    const buf = rawZip([{ nameBytes, data: 'x', flags: 0x0000 }]);
    const r = readZip(buf);
    assert.deepEqual(r.problems, []);
    assert.equal(r.entries[0].name, nameBytes.toString('latin1'));
    assert.equal(r.entries[0].name, 'Äã.txt');
  });

  // ===== 输入形态 / 文件系统 =====

  t('可以按文件路径读取，并且能处理多条目混排', async () => {
    const dir = makeTempDir();
    try {
      const zipPath = path.join(dir, '样本.zip');
      const payload = Buffer.from('中文内容 payload', 'utf8');
      fs.writeFileSync(zipPath, createZip([
        { name: 'skills/示例/SKILL.md', data: '# 技能' },
        { name: 'skills/示例/bin.dat', data: payload, compress: false },
        { name: 'skills/示例/assets/' },
      ]));
      const r = readZip(zipPath);
      assert.deepEqual(r.problems, []);
      assert.equal(r.entries.length, 3);
      assert.equal(entryByName(r, 'skills/示例/bin.dat').data.equals(payload), true);
      assert.equal(entryByName(r, 'skills/示例/assets/').isDirectory, true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  t('readZip 对非 ZIP 数据产出 problem 而不抛错', async () => {
    const r1 = readZip(Buffer.from('这根本不是 zip 文件', 'utf8'));
    assert.equal(r1.entries.length, 0);
    assert.ok(r1.problems.some((p) => p.code === 'EOCD_NOT_FOUND'));

    const r2 = readZip(Buffer.alloc(4));
    assert.equal(r2.entries.length, 0);
    assert.ok(r2.problems.some((p) => p.code === 'EOCD_NOT_FOUND'));

    // 截断的真实 zip：切掉尾部
    const full = createZip([{ name: 'a.txt', data: 'x' }]);
    const r3 = readZip(full.subarray(0, full.length - 5));
    assert.equal(r3.entries.length, 0);
    assert.ok(r3.problems.length > 0);

    // 文件不存在 -> READ_FAILED（不抛错）
    const r4 = readZip(path.join(os.tmpdir(), 'dsh-zip-not-exist-9f3a', 'nope.zip'));
    assert.equal(r4.entries.length, 0);
    assert.ok(r4.problems.some((p) => p.code === 'READ_FAILED'));
  });

  t('入参类型非法时抛 TypeError（编程错误而非数据问题）', async () => {
    assert.throws(() => readZip(12345), TypeError);
    assert.throws(() => readZip(null), TypeError);
    assert.throws(() => createZip('not-an-array'), TypeError);
    assert.throws(() => crc32({}), TypeError);
  });

  // ===== 综合 =====

  t('综合：一个技能包多条目全量往返（含中文/目录/空文件/binary）', async () => {
    const binary = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    const buf = createZip([
      { name: 'srs-generator/' },
      { name: 'srs-generator/SKILL.md', data: '# SRS 生成器' },
      { name: 'srs-generator/references/' },
      { name: 'srs-generator/references/线框DSL渲染器V0.1.py', data: 'def render(): pass' },
      { name: 'srs-generator/assets/logo.bin', data: binary, compress: false },
      { name: 'srs-generator/assets/empty.txt', data: Buffer.alloc(0) },
    ]);
    const again = createZip([
      { name: 'srs-generator/' },
      { name: 'srs-generator/SKILL.md', data: '# SRS 生成器' },
      { name: 'srs-generator/references/' },
      { name: 'srs-generator/references/线框DSL渲染器V0.1.py', data: 'def render(): pass' },
      { name: 'srs-generator/assets/logo.bin', data: binary, compress: false },
      { name: 'srs-generator/assets/empty.txt', data: Buffer.alloc(0) },
    ]);
    assert.equal(Buffer.compare(buf, again), 0, '同输入两次输出应逐字节相同');

    const r = readZip(buf);
    assert.deepEqual(r.problems, []);
    assert.equal(r.entries.length, 6);
    assert.equal(entryByName(r, 'srs-generator/references/线框DSL渲染器V0.1.py').data.toString('utf8'), 'def render(): pass');
    assert.equal(entryByName(r, 'srs-generator/assets/logo.bin').data.equals(binary), true);
    assert.equal(entryByName(r, 'srs-generator/').isDirectory, true);
    assert.equal(entryByName(r, 'srs-generator/assets/empty.txt').size, 0);
    // 每一条的 CRC 都能对得上
    for (const e of r.entries) assert.equal(e.crc32, crc32(e.data), `${e.name} CRC 不一致`);
  });
}
