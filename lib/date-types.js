// © Vexify 2026 All Rights Reserved.
/**
 * JSQL Date Types — DATE / DATETIME / TIMESTAMP 类型处理
 *
 * 时区策略（自 6.6.0 起）：引擎内部一律用 **UTC 作为稳定基准**。
 *
 *  - 不带时区标记的日期字面量（'2024-01-15' / '2024-01-15 10:30:00'）
 *    按 **UTC 墙上时间** 解释，而不是运行环境的本地时区。此前用 new Date(s)
 *    会按主机时区解析，同一份 SQL 在 UTC runner 与 UTC+8 开发机上落库值不同，
 *    跨主机完全不可移植（#75）。
 *  - 带时区标记的字面量（'...Z' / '...+08:00'）语义不变：先换算成绝对时刻，
 *    再以 UTC 墙上时间存储。
 *  - 因此「带 Z」与「不带时区」对 UTC 字面量等价：'2024-01-15T10:30:00Z'
 *    与 '2024-01-15 10:30:00' 落库结果一致，DATETIME 的 round-trip 彻底闭合。
 *
 * 这与 MySQL 的「DATETIME 按会话时区字面值存」在**形式上**相同，只是把会话
 * 时区固定为 UTC —— 不再随部署主机漂移。
 */

const { createError } = require('./errors');

/**
 * 验证并规范化日期类型值
 * @param {*} value - 输入值
 * @param {string} type - 'date' | 'datetime' | 'timestamp'
 * @param {string} fieldName - 字段名（用于错误提示）
 * @returns {*} 规范化后的值
 */
function validateDateType(value, type, fieldName) {
    if (value === null || value === undefined) return value;

    switch (type) {
        case 'date':
            return validateDate(value, fieldName);
        case 'datetime':
            return validateDateTime(value, fieldName);
        case 'timestamp':
            return validateTimestamp(value, fieldName);
        case 'time':
            return validateTime(value, fieldName);
        default:
            return value;
    }
}

// ============================================================
// DATE: YYYY-MM-DD
// ============================================================

function pad2(n) { return String(n).padStart(2, '0'); }

/**
 * 解析 ISO-8601 字符串尾部残余部分里的时区标记，返回「相对 UTC 的分钟偏移」。
 * 输入形如 'Z'、'z'、'+08:00'、'-0500'、'.500Z'、' +02:00'。
 * 没有时区标记（或无法识别）返回 null —— 调用方按 UTC 墙上时间处理。
 */
function parseIsoTimezone(rest) {
    let s = String(rest == null ? '' : rest).trim();
    // 去掉小数秒
    if (s.startsWith('.')) s = s.replace(/^\.\d+/, '');
    if (s === 'Z' || s === 'z') return 0;
    const m = s.match(/^([+-])(\d{2}):?(\d{2})$/);
    if (!m) return null;
    const hh = parseInt(m[2], 10);
    const mm = parseInt(m[3], 10);
    if (hh > 23 || mm > 59) return null;   // 非法偏移：交给后续校验报错
    const sign = m[1] === '-' ? -1 : 1;
    return sign * (hh * 60 + mm);
}

/**
 * UTC 墙上时间的 'YYYY-MM-DD'。
 * 用 getUTC* 而非 toISOString()：后者带 'T' 和毫秒，且遇到 Invalid Date 会抛
 * RangeError（此前用 toISOString().slice 会在越界时间戳上炸掉整个 INSERT）。
 */
function toUtcDateString(d) {
    return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
}

/** UTC 墙上时间的 'YYYY-MM-DD HH:MM:SS'（整秒） */
function toUtcDateTimeString(d) {
    return toUtcDateString(d) + ' ' +
        pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()) + ':' + pad2(d.getUTCSeconds());
}

/** 保留亚秒精度（#82）：仅当存在非零毫秒时追加 '.sss'，整秒输入不变。
 *  用于“字符串里显式携带小数秒”的解析路径；Date 对象/NOW() 走整秒 toUtcDateTimeString。 */
function toUtcDateTimeStringMs(d) {
    const base = toUtcDateTimeString(d);
    const ms = d.getUTCMilliseconds();
    return ms ? base + '.' + String(ms).padStart(3, '0') : base;
}

/**
 * 把「日期/时间部件 ± 可选时区标记」解析成绝对时刻（毫秒）。
 * 无时区标记 → 按 UTC 墙上时间；带 Z / ±HH:MM → 按标记换算。
 * 解析失败或日期非法返回 null。
 */
function parseToUtcMs(str) {
    const s = String(str == null ? '' : str).trim();
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d+))?)?(.*)$/);
    if (!m) return null;
    const y = +m[1], mo = +m[2], day = +m[3];
    const h = m[4] === undefined ? 0 : +m[4];
    const mi = m[5] === undefined ? 0 : +m[5];
    const sec = m[6] === undefined ? 0 : +m[6];
    const frac = m[7] === undefined ? 0 : Math.floor(+('0.' + m[7]) * 1000);
    // 月份/日号越界视为非法；日号超出当月天数（如 2 月 29 日）沿用 JS 的
    // 「溢出归一」行为（→ 3 月 1 日），与改动前 new Date(...) 的宽松解析一致。
    if (mo < 1 || mo > 12 || day < 1 || day > 31) return null;
    if (h > 23 || mi > 59 || sec > 59) return null;
    let ms = Date.UTC(y, mo - 1, day, h, mi, sec, frac);
    const rest = m[8] === undefined ? '' : m[8];
    if (rest !== '') {
        const tz = parseIsoTimezone(rest);
        if (tz === null) return null;   // 有残余但不是合法时区标记
        ms -= tz * 60000;
    }
    return ms;
}

function validateDate(value, fieldName) {
    if (value instanceof Date) {
        return toUtcDateString(value);
    }
    if (typeof value === 'number') {
        // Unix timestamp → date。NaN / ±Infinity / 超出 Date 范围的数会生成
        // Invalid Date，此前被格式化成字面量 "NaN-NaN-NaN" 静默落库（#64）；
        // 与字符串分支保持一致，直接判为非法日期值。
        const d = new Date(value * 1000);
        if (!Number.isFinite(value) || Number.isNaN(d.getTime())) {
            throw createError('ER_INVALID_DATE', fieldName, String(value));
        }
        return toUtcDateString(d);
    }
    if (typeof value === 'string') {
        const s = value.trim();
        // 已是 YYYY-MM-DD：验证日期有效性后返回（字面值即 UTC 日期，无需换算）
        if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
            const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
            const y = parseInt(m[1]), mo = parseInt(m[2]), d = parseInt(m[3]);
            const dt = new Date(Date.UTC(y, mo - 1, d));
            if (dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d) return s;
        }
        const d = parseDateString(s);
        if (d) return toUtcDateString(d);
    }
    throw createError('ER_INVALID_DATE', fieldName, String(value));
}

function parseDateString(str) {
    // 无时区的日历日期一律按 UTC 墙上时间构造（Date.UTC），不依赖主机时区
    // YYYY-MM-DD
    let m = str.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) {
        const y = parseInt(m[1]), mo = parseInt(m[2]), d = parseInt(m[3]);
        const dt = new Date(Date.UTC(y, mo - 1, d));
        if (dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d) return dt;
    }
    // YYYY/MM/DD
    m = str.match(/^(\d{4})\/(\d{2})\/(\d{2})$/);
    if (m) {
        const y = parseInt(m[1]), mo = parseInt(m[2]), d = parseInt(m[3]);
        const dt = new Date(Date.UTC(y, mo - 1, d));
        if (dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d) return dt;
    }
    // MM/DD/YYYY
    m = str.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (m) {
        const y = parseInt(m[3]), mo = parseInt(m[1]), d = parseInt(m[2]);
        const dt = new Date(Date.UTC(y, mo - 1, d));
        if (dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d) return dt;
    }
    // 通用路径：自己解析部件 + 时区标记；不回落 new Date(str)（那会用本地时区）
    // 仅当串里带明确时区标记时才允许原生解析作为兜底。
    const ms = parseToUtcMs(str);
    if (ms !== null) return new Date(ms);
    if (/[Zz]$|[+-]\d{2}:?\d{2}$/.test(str)) {
        const d = new Date(str);
        if (!isNaN(d.getTime())) return d;
    }
    return null;
}

// ============================================================
// DATETIME: YYYY-MM-DD HH:MM:SS
// ============================================================

function validateDateTime(value, fieldName) {
    if (value instanceof Date) {
        return toUtcDateTimeString(value);
    }
    if (typeof value === 'number') {
        // 同 validateDate：拒绝 NaN / Infinity / 越界时间戳（#64）
        const d = new Date(value * 1000);
        if (!Number.isFinite(value) || Number.isNaN(d.getTime())) {
            throw createError('ER_INVALID_DATE', fieldName, String(value));
        }
        return toUtcDateTimeString(d);
    }
    if (typeof value === 'string') {
        // ISO format: 2024-01-15T10:30:00.000Z / +08:00（可能带时区标记）
        // #82：捕获可选的亚秒 .sss，避免 .500 被静默截断。
        const isoMatch = value.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?/);
        if (isoMatch) {
            // P2-35: 验证日期和时间有效性
            const datePart = isoMatch[1];
            const timePart = isoMatch[2];
            const fracPart = isoMatch[3];
            const msPart = fracPart ? parseInt(fracPart.padEnd(3, '0')) : 0;
            const dm = datePart.match(/^(\d{4})-(\d{2})-(\d{2})$/);
            const tm = timePart.match(/^(\d{2}):(\d{2}):(\d{2})$/);
            if (dm && tm) {
                const y = parseInt(dm[1]), mo = parseInt(dm[2]), d = parseInt(dm[3]);
                const h = parseInt(tm[1]), mi = parseInt(tm[2]), s = parseInt(tm[3]);
                const dt = new Date(Date.UTC(y, mo - 1, d));
                if (dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d &&
                    h >= 0 && h < 24 && mi >= 0 && mi < 60 && s >= 0 && s < 60) {
                    // 带 Z / ±HH:MM 时区标记：先换算成绝对时刻，再以 UTC 墙上时间落库。
                    // 无时区标记：字面值本身就是 UTC 墙上时间，原样保留。
                    // 二者因此在 UTC 字面量上完全等价（#75 round-trip）。
                    const tz = parseIsoTimezone(value.slice(isoMatch[0].length));
                    if (tz !== null) {
                        const ms = Date.UTC(y, mo - 1, d, h, mi, s) + msPart - tz * 60000;
                        return toUtcDateTimeStringMs(new Date(ms));
                    }
                    return datePart + ' ' + timePart + (msPart ? '.' + String(msPart).padStart(3, '0') : '');
                }
            }
        }
        // MySQL format: YYYY-MM-DD HH:MM:SS —— 已是目标格式，原样返回
        const myMatch = value.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/);
        if (myMatch) {
            // P2-35: 验证日期和时间有效性
            const datePart = myMatch[1];
            const timePart = myMatch[2];
            const dm = datePart.match(/^(\d{4})-(\d{2})-(\d{2})$/);
            const tm = timePart.match(/^(\d{2}):(\d{2}):(\d{2})$/);
            if (dm && tm) {
                const y = parseInt(dm[1]), mo = parseInt(dm[2]), d = parseInt(dm[3]);
                const h = parseInt(tm[1]), mi = parseInt(tm[2]), s = parseInt(tm[3]);
                const dt = new Date(Date.UTC(y, mo - 1, d));
                if (dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d &&
                    h >= 0 && h < 24 && mi >= 0 && mi < 60 && s >= 0 && s < 60) {
                    return value;   // 无时区 → 即 UTC 墙上时间，原样落库
                }
            }
        }
        const ms = parseToUtcMs(value);
        if (ms !== null) {
            return toUtcDateTimeStringMs(new Date(ms));
        }
        // 仅带明确时区标记时允许原生解析兜底
        if (/[Zz]$|[+-]\d{2}:?\d{2}$/.test(value)) {
            const d = new Date(value);
            if (!isNaN(d.getTime())) return toUtcDateTimeString(d);
        }
    }
    throw createError('ER_INVALID_DATE', fieldName, String(value));
}

// ============================================================
// TIMESTAMP: Unix 时间戳（秒）
// ============================================================

function validateTimestamp(value, fieldName) {
    if (value instanceof Date) {
        return Math.floor(value.getTime() / 1000);
    }
    if (typeof value === 'number') {
        // 自动检测毫秒时间戳
        if (value > 1e12) return Math.floor(value / 1000);
        return value;
    }
    if (typeof value === 'string') {
        // 无时区字面量按 UTC 解释（此前 new Date(s) 用主机时区，导致同一 INSERT
        // 在不同 TZ 的机器上落库的 Unix 秒不同 —— 跨主机不可移植，#75）。
        const ms = parseToUtcMs(value);
        if (ms !== null) return Math.floor(ms / 1000);
        if (/[Zz]$|[+-]\d{2}:?\d{2}$/.test(value)) {
            const d = new Date(value);
            if (!isNaN(d.getTime())) return Math.floor(d.getTime() / 1000);
        }
        const n = parseInt(value, 10);
        if (!isNaN(n)) {
            if (n > 1e12) return Math.floor(n / 1000);
            return n;
        }
    }
    throw createError('ER_INVALID_DATE', fieldName, String(value));
}

// ============================================================
// TIME: HH:MM:SS
// ============================================================

function validateTime(value, fieldName) {
    if (typeof value === 'string') {
        const m = value.match(/^(\d{2}):(\d{2}):(\d{2})$/);
        if (m) {
            const h = parseInt(m[1]), min = parseInt(m[2]), sec = parseInt(m[3]);
            if (h >= 0 && h < 24 && min >= 0 && min < 60 && sec >= 0 && sec < 60) {
                return value;
            }
        }
        // 负时间: -HH:MM:SS（同样校验范围）
        const neg = value.match(/^-(\d{2}):(\d{2}):(\d{2})$/);
        if (neg) {
            const h = parseInt(neg[1]), min = parseInt(neg[2]), sec = parseInt(neg[3]);
            if (h >= 0 && h < 24 && min >= 0 && min < 60 && sec >= 0 && sec < 60) return value;
        }
    }
    throw createError('ER_INVALID_DATE', fieldName, String(value));
}

// ============================================================
// 类型转换辅助
// ============================================================

function now(type = 'datetime') {
    const d = new Date();
    switch (type) {
        // 必须与 validateDate/validateDateTime 一致使用 UTC 基准：
        // 落库值是 UTC 墙上时间，now() 若用本地时区会和已存数据错开整个 offset。
        case 'date': return toUtcDateString(d);
        case 'timestamp': return Math.floor(d.getTime() / 1000);
        case 'time': return pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()) + ':' + pad2(d.getUTCSeconds());
        default: return toUtcDateTimeString(d);
    }
}

function formatDate(value, format = 'YYYY-MM-DD') {
    if (!value) return value;
    let d;
    if (value instanceof Date) d = value;
    else {
        const ms = parseToUtcMs(value);
        d = ms !== null ? new Date(ms) : new Date(value);
    }
    if (isNaN(d.getTime())) return String(value);

    const pad = n => String(n).padStart(2, '0');
    return format
        .replace('YYYY', d.getUTCFullYear())
        .replace('MM', pad(d.getUTCMonth() + 1))
        .replace('DD', pad(d.getUTCDate()))
        .replace('HH', pad(d.getUTCHours()))
        .replace('mm', pad(d.getUTCMinutes()))
        .replace('ss', pad(d.getUTCSeconds()));
}

module.exports = { validateDateType, now, formatDate };