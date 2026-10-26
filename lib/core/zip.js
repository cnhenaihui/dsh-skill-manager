/**
 * dsh-skill-manager —— 零依赖 ZIP 读写模块
 * ============================================================================
 * 设计目标：
 *   1. 零 npm 依赖，仅使用 Node 内置模块（node:fs / node:zlib / node:buffer）。
 *   2. 写入结果**确定性**：相同输入 + 相同选项必然产出逐字节相同的 Buffer。
 *   3. 读取**永不因恶意/损坏数据抛异常崩溃**，一切异常都落到 problems 数组。
 *   4. 安全优先：路径穿越、ZIP64、zip 炸弹、加密条目、未知压缩方法全部被拒绝。
 *
 * 有意为之的取舍（与验收点的对应关系）：
 *   - DOS 时间统一按 **UTC** 解释与编码（getUTC* / Date.UTC）。ZIP 规范里 DOS 时间
 *     名义上是“本地时间”，但那样会让同一份输入的产物随机器时区变化，破坏确定性。
 *     统一 UTC 后：默认 mtime 恒为 2020-01-01T00:00:00Z，且跨时区可复现。
 *     注意 DOS 时间秒字段精度为 2 秒（seconds >> 1），奇数秒会被向下取整。
 *   - 写入时若 deflate 结果不比原文更小，则自动回退为 store，避免“越压越大”。
 *     该判断只依赖输入内容，因此仍然是确定性的。
 *   - names 一律校验，**不重写**：安全的名字原样写入，不安全的直接抛错，避免
 *     “悄悄改名字”导致调用方与归档内容不一致。
 *   - 读取时 CRC 或长度校验失败的条目会被**丢弃**（不进 entries），同时记 problem。
 *     宁可少给数据，也不把已损坏的数据交给上层。
 *   - 中央目录里 bit 3（数据描述符）是**受支持**的：我们始终以中央目录记录的长度
 *     定位并解压数据，因此带数据描述符的归档可以正常读取。除此之外的异常
 *     （加密 bit 0、未知 method、签名错、越界、截断等）都产出 problem。
 */

import fs from 'node:fs';
import zlib from 'node:zlib';
import { Buffer } from 'node:buffer';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 压缩方法：不压缩 */
export const ZIP_METHOD_STORE = 0;
/** 压缩方法：deflate（raw，无 zlib 头） */
export const ZIP_METHOD_DEFLATE = 8;

const UINT16_MAX = 0xffff;
const UINT32_MAX = 0xffffffff;

/** 单条目解压后的大小上限：64MB，用于防御 zip 炸弹 */
const MAX_ENTRY_SIZE = 64 * 1024 * 1024;

/** 默认条目时间戳（固定值，保证确定性） */
const DEFAULT_MTIME = new Date('2020-01-01T00:00:00Z');

/** 通用标志位 bit 11：文件名/注释为 UTF-8 */
const FLAG_UTF8 = 0x0800;
/** 通用标志位 bit 0：条目已加密 */
const FLAG_ENCRYPTED = 0x0001;

/** 各段签名 */
const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;

/** ZIP64 扩展字段 ID */
const ZIP64_EXTRA_ID = 0x0001;

/** 外部属性：MS-DOS 目录标志位（低字节） */
const DOS_ATTR_DIRECTORY = 0x10;

/** "version made by"：高字节 3 = UNIX，低字节 20 = 2.0 */
const VERSION_MADE_BY = (3 << 8) | 20;
/** "version needed to extract"：2.0 */
const VERSION_NEEDED = 20;

// ---------------------------------------------------------------------------
// CRC32
// ---------------------------------------------------------------------------

/** CRC32 查表（多项式 0xEDB88320，反射实现） */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c >>> 0;
  }
  return table;
})();

/**
 * 计算 CRC32。
 * @param {Buffer|Uint8Array|string} buf 待计算数据，字符串按 UTF-8 处理
 * @returns {number} 无符号 32 位整数
 */
export function crc32(buf) {
  let bytes;
  if (typeof buf === 'string') bytes = Buffer.from(buf, 'utf8');
  else if (Buffer.isBuffer(buf)) bytes = buf;
  else if (buf instanceof Uint8Array) bytes = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  else throw new TypeError('crc32: 入参必须是 Buffer / Uint8Array / string');

  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------------------
// 条目名安全校验
// ---------------------------------------------------------------------------

/** Windows 保留设备名（忽略大小写与扩展名） */
const WINDOWS_RESERVED_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

/**
 * 校验一个 ZIP 条目名是否安全（可安全落盘）。
 *
 * 拒绝：
 *   - 以 '/' 或 '\' 开头的绝对路径
 *   - 含盘符/冒号（C: 之类，含 NTFS 数据流语义）
 *   - 含 '..' 路径段（路径穿越）
 *   - 含 NUL 字节
 *   - Windows 保留设备名（忽略扩展名与大小写）
 *   - 以点或空格结尾的路径段（Windows 会静默修剪，易造成名字歧义/覆盖）
 * 允许：中间目录、中文、空格、'.gitignore' 这类点开头的段。
 *
 * 注意：本函数**不重写**名字，校验通过时原样返回。
 *
 * @param {string} name 条目名
 * @returns {{ok: true, name: string} | {ok: false, reason: string, message: string}}
 *          reason 为稳定的机器可读代码，message 为中文说明。
 */
export function safeZipEntryName(name) {
  const fail = (reason, message) => ({ ok: false, reason, message });

  if (typeof name !== 'string') return fail('NOT_A_STRING', '条目名必须是字符串');
  if (name.length === 0) return fail('EMPTY_NAME', '条目名不能为空');
  if (name.includes('\0')) return fail('NUL_BYTE', '条目名不能包含 NUL 字节');
  if (name.startsWith('/') || name.startsWith('\\')) {
    return fail('ABSOLUTE_PATH', '条目名不能以 "/" 或 "\\" 开头（绝对路径）');
  }
  if (/^[A-Za-z]:/.test(name)) return fail('DRIVE_LETTER', '条目名不能包含盘符（如 C:）');

  // 反斜杠在 Windows 上同样是分隔符，因此两种分隔符都参与分段检查
  const segments = name.split(/[\\/]+/).filter((s) => s.length > 0);
  if (segments.length === 0) return fail('EMPTY_NAME', '条目名不能只由分隔符组成');

  for (const segment of segments) {
    if (segment.includes(':')) {
      return fail('DRIVE_LETTER', `路径段 "${segment}" 含冒号（盘符或 NTFS 数据流），已拒绝`);
    }
    if (segment === '.' || segment === '..') {
      return fail('PATH_TRAVERSAL', `路径段 "${segment}" 属于路径穿越，已拒绝`);
    }
    if (segment.endsWith('.')) {
      return fail('TRAILING_DOT', `路径段 "${segment}" 以点结尾，Windows 会静默修剪，已拒绝`);
    }
    if (segment.endsWith(' ')) {
      return fail('TRAILING_SPACE', `路径段 "${segment}" 以空格结尾，Windows 会静默修剪，已拒绝`);
    }
    const base = segment.split('.')[0];
    if (WINDOWS_RESERVED_NAMES.has(base.toUpperCase())) {
      return fail('WINDOWS_RESERVED_NAME', `路径段 "${segment}" 命中 Windows 保留设备名，已拒绝`);
    }
  }

  return { ok: true, name };
}

// ---------------------------------------------------------------------------
// DOS 时间编解码
// ---------------------------------------------------------------------------

/**
 * 把 Date / number / string 编码为 DOS 时间位域（按 UTC 解释）。
 * 超出 1980..2107 范围的会被钳制，保证不会写出非法位域。
 */
function toDosDateTime(input) {
  let date;
  if (input instanceof Date) date = input;
  else if (typeof input === 'number') date = new Date(input);
  else if (typeof input === 'string') date = new Date(input);
  else throw new TypeError('createZip: mtime 必须是 Date / number(毫秒) / 可解析的日期字符串');

  if (Number.isNaN(date.getTime())) throw new TypeError('createZip: mtime 不是合法时间');

  let year = date.getUTCFullYear();
  let month = date.getUTCMonth() + 1;
  let day = date.getUTCDate();
  let hours = date.getUTCHours();
  let minutes = date.getUTCMinutes();
  let seconds = date.getUTCSeconds();

  if (year < 1980) {
    year = 1980; month = 1; day = 1; hours = 0; minutes = 0; seconds = 0;
  } else if (year > 2107) {
    year = 2107; month = 12; day = 31; hours = 23; minutes = 59; seconds = 58;
  }

  const time = ((hours & 0x1f) << 11) | ((minutes & 0x3f) << 5) | ((seconds >> 1) & 0x1f);
  const dosDate = (((year - 1980) & 0x7f) << 9) | ((month & 0x0f) << 5) | (day & 0x1f);
  return { time: time & 0xffff, date: dosDate & 0xffff };
}

/** 把 DOS 时间位域解码为 Date（UTC 解释）；日期字段为 0 或非法时返回 null。 */
function fromDosDateTime(time, dosDate) {
  if (!dosDate) return null;
  const day = dosDate & 0x1f;
  const month = (dosDate >> 5) & 0x0f;
  const year = ((dosDate >> 9) & 0x7f) + 1980;
  if (day === 0 || month === 0 || month > 12) return null;

  const seconds = (time & 0x1f) * 2;
  const minutes = (time >> 5) & 0x3f;
  const hours = (time >> 11) & 0x1f;
  if (hours > 23 || minutes > 59 || seconds > 59) return null;

  const ms = Date.UTC(year, month - 1, day, hours, minutes, seconds);
  return Number.isNaN(ms) ? null : new Date(ms);
}

// ---------------------------------------------------------------------------
// 写入
// ---------------------------------------------------------------------------

/** 构造 ZIP64 相关的错误（写入路径） */
function zip64Error(message) {
  const err = new Error(`createZip: 不支持 ZIP64 —— ${message}`);
  err.code = 'ZIP64_UNSUPPORTED';
  return err;
}

/** 把条目 data 统一转成 Buffer */
function toBuffer(value, name) {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError(
    `createZip: 条目 ${JSON.stringify(name)} 的 data 必须是 Buffer / Uint8Array / string`,
  );
}

/** 取出条目内容：data 优先，其次读 path，目录条目允许缺省为空 */
function readEntryData(entry, name, isDirectory) {
  if (entry.data !== undefined && entry.data !== null) return toBuffer(entry.data, name);
  if (entry.path !== undefined && entry.path !== null) {
    if (typeof entry.path !== 'string') {
      throw new TypeError(`createZip: 条目 ${JSON.stringify(name)} 的 path 必须是字符串`);
    }
    return fs.readFileSync(entry.path);
  }
  if (isDirectory) return Buffer.alloc(0);
  throw new Error(`createZip: 条目 ${JSON.stringify(name)} 既没有 data 也没有 path`);
}

/**
 * 生成一个 ZIP Buffer。
 *
 * @param {Array<{name: string, data?: Buffer|Uint8Array|string, path?: string,
 *                mtime?: Date|number|string, compress?: boolean}>} entries
 *        条目列表。data 优先；没有 data 时从 path 读取。名字用 '/' 分隔，
 *        以 '/' 结尾表示目录项（必须为 0 字节）。compress 覆盖全局设置。
 * @param {{compress?: boolean, mtime?: Date|number|string}} [options]
 *        compress 默认 true；mtime 默认 2020-01-01T00:00:00Z（固定值，保证确定性）。
 * @returns {Buffer}
 */
export function createZip(entries, options = {}) {
  if (!Array.isArray(entries)) throw new TypeError('createZip: entries 必须是数组');
  if (options === null || typeof options !== 'object') {
    throw new TypeError('createZip: options 必须是对象');
  }

  const defaultCompress = options.compress === undefined ? true : !!options.compress;
  const defaultMtime = options.mtime === undefined ? DEFAULT_MTIME : options.mtime;

  // ZIP64 上限：条目数
  if (entries.length > UINT16_MAX) {
    throw zip64Error(`条目数 ${entries.length} 超过 0xFFFF（${UINT16_MAX}）`);
  }

  /** @type {Buffer[]} 本地头 + 名字 + 数据 */
  const fileChunks = [];
  /** @type {Buffer[]} 中央目录头 + 名字 */
  const centralChunks = [];
  /** 已写出的条目名：重名 zip 会被解压器"静默后者覆盖前者"，必须拒绝 */
  const seenNames = new Set();
  let offset = 0;

  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (entry === null || typeof entry !== 'object') {
      throw new TypeError(`createZip: 第 ${i} 个条目必须是对象`);
    }

    const safe = safeZipEntryName(entry.name);
    if (!safe.ok) {
      throw new Error(
        `createZip: 第 ${i} 个条目名不安全（${safe.reason}）：${JSON.stringify(entry.name)}；${safe.message}`,
      );
    }
    const name = safe.name;
    if (seenNames.has(name)) {
      throw new Error(`createZip: 条目名重复 ${JSON.stringify(name)}（重名条目会被解压器静默覆盖，拒绝产出歧义包）`);
    }
    seenNames.add(name);
    const isDirectory = name.endsWith('/');
    const nameBuf = Buffer.from(name, 'utf8');
    if (nameBuf.length > UINT16_MAX) {
      throw new Error(`createZip: 条目名过长（${nameBuf.length} 字节 > ${UINT16_MAX}）`);
    }

    const data = readEntryData(entry, name, isDirectory);
    if (isDirectory && data.length !== 0) {
      throw new Error(`createZip: 目录条目 ${JSON.stringify(name)} 必须为空（当前 ${data.length} 字节）`);
    }

    // ZIP64 上限：大小
    if (data.length >= UINT32_MAX) {
      throw zip64Error(`条目 ${JSON.stringify(name)} 的未压缩大小 ${data.length} ≥ 0xFFFFFFFF`);
    }
    // ZIP64 上限：本地头偏移
    if (offset >= UINT32_MAX) {
      throw zip64Error(`条目 ${JSON.stringify(name)} 的本地头偏移 ${offset} ≥ 0xFFFFFFFF`);
    }

    const { time, date } = toDosDateTime(
      entry.mtime === undefined ? defaultMtime : entry.mtime,
    );

    const wantCompress = entry.compress === undefined ? defaultCompress : !!entry.compress;
    let method = ZIP_METHOD_STORE;
    let payload = data;
    if (!isDirectory && wantCompress && data.length > 0) {
      const deflated = zlib.deflateRawSync(data);
      // 压不动就用 store，避免产出比原文更大的字节
      if (deflated.length < data.length) {
        method = ZIP_METHOD_DEFLATE;
        payload = deflated;
      }
    }
    if (payload.length >= UINT32_MAX) {
      throw zip64Error(`条目 ${JSON.stringify(name)} 的压缩后大小 ${payload.length} ≥ 0xFFFFFFFF`);
    }

    const checksum = crc32(data);

    // ---- 本地文件头（30 字节定长 + 名字） ----
    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(VERSION_NEEDED, 4);
    local.writeUInt16LE(FLAG_UTF8, 6); // bit 11：UTF-8 文件名
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // 扩展字段长度（不写扩展字段，保证确定性）
    fileChunks.push(local, nameBuf, payload);

    // ---- 中央目录记录（46 字节定长 + 名字） ----
    // 低字节写 MS-DOS 属性（目录位 0x10），高字写 Unix 权限位
    const externalAttr = isDirectory
      ? ((DOS_ATTR_DIRECTORY | (0o40755 << 16)) >>> 0)
      : ((0o100644 << 16) >>> 0);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(SIG_CENTRAL, 0);
    central.writeUInt16LE(VERSION_MADE_BY, 4);
    central.writeUInt16LE(VERSION_NEEDED, 6);
    central.writeUInt16LE(FLAG_UTF8, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // 扩展字段长度
    central.writeUInt16LE(0, 32); // 注释长度
    central.writeUInt16LE(0, 34); // 起始磁盘号
    central.writeUInt16LE(isDirectory ? 0x10 : 0, 36); // 内部属性
    central.writeUInt32LE(externalAttr, 38);
    central.writeUInt32LE(offset, 42);
    centralChunks.push(central, nameBuf);

    offset += 30 + nameBuf.length + payload.length;
  }

  // ---- 中央目录 + EOCD ----
  const centralBuf = Buffer.concat(centralChunks);
  if (centralBuf.length >= UINT32_MAX) {
    throw zip64Error(`中央目录大小 ${centralBuf.length} ≥ 0xFFFFFFFF`);
  }
  if (offset >= UINT32_MAX) {
    throw zip64Error(`中央目录偏移 ${offset} ≥ 0xFFFFFFFF`);
  }

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(0, 4); // 当前磁盘号
  eocd.writeUInt16LE(0, 6); // 中央目录起始磁盘号
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20); // 注释长度
  fileChunks.push(centralBuf, eocd);

  return Buffer.concat(fileChunks);
}

// ---------------------------------------------------------------------------
// 读取
// ---------------------------------------------------------------------------

/** 从尾部向前查找 EOCD；优先返回注释长度自洽的那一条。 */
function findEocd(buf) {
  const min = Math.max(0, buf.length - (UINT16_MAX + 22));
  let fallback = -1;
  for (let i = buf.length - 22; i >= min; i -= 1) {
    if (buf.readUInt32LE(i) !== SIG_EOCD) continue;
    const commentLen = buf.readUInt16LE(i + 20);
    if (i + 22 + commentLen === buf.length) return i;
    if (fallback < 0) fallback = i;
  }
  return fallback;
}

/** 在扩展字段区里找指定 ID 的字段，返回其数据片段或 null */
function findExtraField(buf, start, len, id) {
  const end = start + len;
  let p = start;
  while (p + 4 <= end) {
    const headerId = buf.readUInt16LE(p);
    const size = buf.readUInt16LE(p + 2);
    if (headerId === id) return buf.subarray(p + 4, p + 4 + size);
    p += 4 + size;
  }
  return null;
}

/** 判断一段字节是否是合法 UTF-8（严格，拒绝过长编码/代理区/截断） */
function isValidUtf8(buf) {
  const len = buf.length;
  let i = 0;
  while (i < len) {
    const b0 = buf[i];
    i += 1;
    if (b0 <= 0x7f) continue;
    if (b0 >= 0xc2 && b0 <= 0xdf) {
      if (i >= len || (buf[i] & 0xc0) !== 0x80) return false;
      i += 1;
    } else if (b0 === 0xe0) {
      if (i + 1 >= len || buf[i] < 0xa0 || buf[i] > 0xbf || (buf[i + 1] & 0xc0) !== 0x80) return false;
      i += 2;
    } else if (b0 >= 0xe1 && b0 <= 0xec) {
      if (i + 1 >= len || (buf[i] & 0xc0) !== 0x80 || (buf[i + 1] & 0xc0) !== 0x80) return false;
      i += 2;
    } else if (b0 === 0xed) {
      // 排除 UTF-16 代理区 U+D800..U+DFFF
      if (i + 1 >= len || buf[i] < 0x80 || buf[i] > 0x9f || (buf[i + 1] & 0xc0) !== 0x80) return false;
      i += 2;
    } else if (b0 >= 0xee && b0 <= 0xef) {
      if (i + 1 >= len || (buf[i] & 0xc0) !== 0x80 || (buf[i + 1] & 0xc0) !== 0x80) return false;
      i += 2;
    } else if (b0 === 0xf0) {
      if (i + 2 >= len || buf[i] < 0x90 || buf[i] > 0xbf
        || (buf[i + 1] & 0xc0) !== 0x80 || (buf[i + 2] & 0xc0) !== 0x80) return false;
      i += 3;
    } else if (b0 >= 0xf1 && b0 <= 0xf3) {
      if (i + 2 >= len || (buf[i] & 0xc0) !== 0x80
        || (buf[i + 1] & 0xc0) !== 0x80 || (buf[i + 2] & 0xc0) !== 0x80) return false;
      i += 3;
    } else if (b0 === 0xf4) {
      if (i + 2 >= len || buf[i] < 0x80 || buf[i] > 0x8f
        || (buf[i + 1] & 0xc0) !== 0x80 || (buf[i + 2] & 0xc0) !== 0x80) return false;
      i += 3;
    } else {
      // 0x80..0xC1（孤立续字节/过长编码）与 0xF5..0xFF
      return false;
    }
  }
  return true;
}

/**
 * 解码条目名：
 *   - 置了 bit 11 -> 直接按 UTF-8 解码（写入方已作出承诺）；
 *   - 未置 bit 11 -> 先尝试严格 UTF-8，不合法（含非法字节）再退回 latin1。
 */
function decodeEntryName(nameBuf, flags) {
  if ((flags & FLAG_UTF8) !== 0) return nameBuf.toString('utf8');
  if (isValidUtf8(nameBuf)) return nameBuf.toString('utf8');
  return nameBuf.toString('latin1');
}

/**
 * 读取 ZIP。
 *
 * @param {Buffer|Uint8Array|string} input Buffer / Uint8Array，或 ZIP 文件路径
 * @returns {{entries: Array<{name: string, data: Buffer, method: number, size: number,
 *            compressedSize: number, crc32: number, isDirectory: boolean,
 *            mtime: Date|null, flags: number, externalAttributes: number}>,
 *           problems: Array<{name?: string, code: string, message: string}>}}
 */
export function readZip(input) {
  /** @type {Array<{name?: string, code: string, message: string}>} */
  const problems = [];
  /** @type {Array<object>} */
  const entries = [];

  let buf;
  if (typeof input === 'string') {
    try {
      buf = fs.readFileSync(input);
    } catch (err) {
      problems.push({
        code: 'READ_FAILED',
        message: `读取 ZIP 文件失败：${err && err.message ? err.message : String(err)}`,
      });
      return { entries, problems };
    }
  } else if (Buffer.isBuffer(input)) {
    buf = input;
  } else if (input instanceof Uint8Array) {
    buf = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  } else {
    throw new TypeError('readZip: 入参必须是 Buffer、Uint8Array 或文件路径字符串');
  }

  if (buf.length < 22) {
    problems.push({ code: 'EOCD_NOT_FOUND', message: '数据长度不足 22 字节，不是有效的 ZIP 文件' });
    return { entries, problems };
  }

  const eocdOffset = findEocd(buf);
  if (eocdOffset < 0) {
    problems.push({ code: 'EOCD_NOT_FOUND', message: '未找到 EOCD 记录，不是有效的 ZIP 文件（或已严重损坏）' });
    return { entries, problems };
  }

  const entriesOnDisk = buf.readUInt16LE(eocdOffset + 8);
  const entryCount = buf.readUInt16LE(eocdOffset + 10);
  const cdSize = buf.readUInt32LE(eocdOffset + 12);
  const cdOffset = buf.readUInt32LE(eocdOffset + 16);

  // ---- ZIP64 哨兵检测（EOCD） ----
  if (entriesOnDisk === UINT16_MAX || entryCount === UINT16_MAX) {
    problems.push({
      code: 'ZIP64_UNSUPPORTED',
      message: 'EOCD 中条目数为 0xFFFF 哨兵值，疑似 ZIP64 归档，本模块不支持 ZIP64',
    });
    return { entries, problems };
  }
  if (cdSize === UINT32_MAX || cdOffset === UINT32_MAX) {
    problems.push({
      code: 'ZIP64_UNSUPPORTED',
      message: 'EOCD 中中央目录大小或偏移为 0xFFFFFFFF 哨兵值，疑似 ZIP64 归档，本模块不支持 ZIP64',
    });
    return { entries, problems };
  }
  if (entriesOnDisk !== entryCount) {
    problems.push({
      code: 'MULTI_DISK_ARCHIVE',
      message: `分卷归档（本盘 ${entriesOnDisk} 条 / 总计 ${entryCount} 条）不受支持`,
    });
    return { entries, problems };
  }
  if (cdOffset + cdSize > buf.length || cdOffset > buf.length) {
    problems.push({
      code: 'CENTRAL_DIRECTORY_OUT_OF_RANGE',
      message: '中央目录超出文件末尾，归档可能被截断',
    });
    return { entries, problems };
  }

  // ---- 逐条解析中央目录 ----
  let p = cdOffset;
  for (let i = 0; i < entryCount; i += 1) {
    if (p + 46 > buf.length) {
      problems.push({
        code: 'CENTRAL_DIRECTORY_TRUNCATED',
        message: `中央目录第 ${i + 1} 条记录越界，归档被截断`,
      });
      break;
    }
    if (buf.readUInt32LE(p) !== SIG_CENTRAL) {
      problems.push({
        code: 'BAD_CENTRAL_DIRECTORY_SIGNATURE',
        message: `中央目录第 ${i + 1} 条记录签名非法`,
      });
      break;
    }

    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const dosTime = buf.readUInt16LE(p + 12);
    const dosDate = buf.readUInt16LE(p + 14);
    const storedCrc = buf.readUInt32LE(p + 16);
    const compressedSize = buf.readUInt32LE(p + 20);
    const uncompressedSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const diskStart = buf.readUInt16LE(p + 34);
    const externalAttr = buf.readUInt32LE(p + 38);
    const localOffset = buf.readUInt32LE(p + 42);

    const nameStart = p + 46;
    const extraStart = nameStart + nameLen;
    const next = extraStart + extraLen + commentLen;
    if (next > buf.length) {
      problems.push({
        code: 'CENTRAL_DIRECTORY_TRUNCATED',
        message: `中央目录第 ${i + 1} 条记录（含名字/扩展字段）越界，归档被截断`,
      });
      break;
    }

    const nameBuf = buf.subarray(nameStart, extraStart);
    const name = decodeEntryName(nameBuf, flags);
    p = next; // 无论本条是否可用，都先推进到下一条

    // ---- ZIP64 扩展字段 0x0001 ----
    if (findExtraField(buf, extraStart, extraLen, ZIP64_EXTRA_ID) !== null) {
      problems.push({
        name,
        code: 'ZIP64_UNSUPPORTED',
        message: `条目 ${JSON.stringify(name)} 含 ZIP64 扩展字段(0x0001)，本模块不支持 ZIP64`,
      });
      continue;
    }
    if (compressedSize === UINT32_MAX || uncompressedSize === UINT32_MAX
      || localOffset === UINT32_MAX || diskStart === UINT16_MAX) {
      problems.push({
        name,
        code: 'ZIP64_UNSUPPORTED',
        message: `条目 ${JSON.stringify(name)} 含 0xFFFFFFFF/0xFFFF 哨兵值，疑似 ZIP64，本模块不支持 ZIP64`,
      });
      continue;
    }

    // ---- 路径安全 ----
    const safe = safeZipEntryName(name);
    if (!safe.ok) {
      problems.push({
        name,
        code: 'UNSAFE_NAME',
        message: `条目名不安全（${safe.reason}），已跳过：${JSON.stringify(name)}；${safe.message}`,
      });
      continue;
    }

    // ---- 加密 ----
    if ((flags & FLAG_ENCRYPTED) !== 0) {
      problems.push({
        name,
        code: 'ENCRYPTED',
        message: `条目 ${JSON.stringify(name)} 已加密（通用标志位 bit 0），不支持解密，已跳过`,
      });
      continue;
    }

    // ---- 压缩方法 ----
    if (method !== ZIP_METHOD_STORE && method !== ZIP_METHOD_DEFLATE) {
      problems.push({
        name,
        code: 'UNSUPPORTED_METHOD',
        message: `条目 ${JSON.stringify(name)} 使用了不支持的压缩方法 ${method}（仅支持 store=0 / deflate=8），已跳过`,
      });
      continue;
    }

    // ---- zip 炸弹防护：声明大小 ----
    if (uncompressedSize > MAX_ENTRY_SIZE) {
      problems.push({
        name,
        code: 'ENTRY_TOO_LARGE',
        message: `条目 ${JSON.stringify(name)} 声明解压后大小 ${uncompressedSize} 字节，超过上限 ${MAX_ENTRY_SIZE} 字节（64MB），已拒绝`,
      });
      continue;
    }

    // ---- 定位本地头与数据 ----
    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== SIG_LOCAL) {
      problems.push({
        name,
        code: 'BAD_LOCAL_HEADER',
        message: `条目 ${JSON.stringify(name)} 的本地文件头非法或越界，已跳过`,
      });
      continue;
    }
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    if (dataStart + compressedSize > buf.length) {
      problems.push({
        name,
        code: 'ENTRY_DATA_OUT_OF_RANGE',
        message: `条目 ${JSON.stringify(name)} 的数据区间超出文件末尾，归档可能被截断，已跳过`,
      });
      continue;
    }

    // ---- 解压 ----
    let data;
    try {
      const raw = buf.subarray(dataStart, dataStart + compressedSize);
      if (method === ZIP_METHOD_STORE) {
        data = Buffer.from(raw); // 复制，避免与入参共享底层内存
      } else {
        // maxOutputLength 是第二道防线：即使声明大小撒谎也无法膨胀超过 64MB
        data = zlib.inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_SIZE });
      }
    } catch (err) {
      const tooLarge = !!err && (err.code === 'ERR_BUFFER_TOO_LARGE'
        || /too large|larger than|output length/i.test(String(err.message)));
      problems.push({
        name,
        code: tooLarge ? 'ENTRY_TOO_LARGE' : (method === ZIP_METHOD_DEFLATE ? 'INFLATE_FAILED' : 'ENTRY_READ_FAILED'),
        message: tooLarge
          ? `条目 ${JSON.stringify(name)} 解压后超过上限 ${MAX_ENTRY_SIZE} 字节（64MB），已拒绝`
          : `条目 ${JSON.stringify(name)} 解压失败：${err && err.message ? err.message : String(err)}`,
      });
      continue;
    }

    // ---- CRC 与长度校验 ----
    let verified = true;
    if (data.length !== uncompressedSize) {
      problems.push({
        name,
        code: 'SIZE_MISMATCH',
        message: `条目 ${JSON.stringify(name)} 解压后长度 ${data.length} 与头部声明 ${uncompressedSize} 不一致，已丢弃`,
      });
      verified = false;
    }
    const actualCrc = crc32(data);
    if (actualCrc !== storedCrc) {
      problems.push({
        name,
        code: 'CRC_MISMATCH',
        message: `条目 ${JSON.stringify(name)} CRC32 校验失败（实际 0x${actualCrc.toString(16).padStart(8, '0')}，头部声明 0x${storedCrc.toString(16).padStart(8, '0')}），数据已损坏，已丢弃`,
      });
      verified = false;
    }
    if (!verified) continue;

    entries.push({
      name,
      data,
      method,
      size: uncompressedSize,
      compressedSize,
      crc32: storedCrc,
      isDirectory: name.endsWith('/') || (externalAttr & DOS_ATTR_DIRECTORY) !== 0,
      mtime: fromDosDateTime(dosTime, dosDate),
      // 以下为额外信息，便于上层诊断，不属于最小契约
      flags,
      externalAttributes: externalAttr,
    });
  }

  return { entries, problems };
}
