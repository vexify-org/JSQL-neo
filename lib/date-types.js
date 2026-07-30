// © Vexify 2026 All Rights Reserved.
/**
 * JSQL Date Types — DATE / DATETIME / TIMESTAMP 类型处理
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

function validateDate(value, fieldName) {
    if (value instanceof Date) {
        return value.toISOString().slice(0, 10);
    }
    if (typeof value === 'number') {
        // Unix timestamp → date
        return new Date(value * 1000).toISOString().slice(0, 10);
    }
    if (typeof value === 'string') {
        const d = parseDateString(value);
        if (d) return d.toISOString().slice(0, 10);
    }
    throw createError('ER_INVALID_DATE', fieldName, String(value));
}

function parseDateString(str) {
    // YYYY-MM-DD
    let m = str.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) {
        const d = new Date(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3]));
        if (d.getFullYear() === parseInt(m[1])) return d;
    }
    // YYYY/MM/DD
    m = str.match(/^(\d{4})\/(\d{2})\/(\d{2})$/);
    if (m) {
        const d = new Date(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3]));
        if (d.getFullYear() === parseInt(m[1])) return d;
    }
    // MM/DD/YYYY
    m = str.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (m) {
        const d = new Date(parseInt(m[3]), parseInt(m[1]) - 1, parseInt(m[2]));
        if (d.getFullYear() === parseInt(m[3])) return d;
    }
    // Try native parse
    const d = new Date(str);
    if (!isNaN(d.getTime())) return d;
    return null;
}

// ============================================================
// DATETIME: YYYY-MM-DD HH:MM:SS
// ============================================================

function validateDateTime(value, fieldName) {
    if (value instanceof Date) {
        return value.toISOString().replace('T', ' ').slice(0, 19);
    }
    if (typeof value === 'number') {
        return new Date(value * 1000).toISOString().replace('T', ' ').slice(0, 19);
    }
    if (typeof value === 'string') {
        // ISO format: 2024-01-15T10:30:00.000Z
        const isoMatch = value.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})/);
        if (isoMatch) {
            return isoMatch[1] + ' ' + isoMatch[2];
        }
        // MySQL format: YYYY-MM-DD HH:MM:SS
        const myMatch = value.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/);
        if (myMatch) {
            const d = new Date(value.replace(' ', 'T') + 'Z');
            if (!isNaN(d.getTime())) return value;
        }
        const d = new Date(value);
        if (!isNaN(d.getTime())) {
            return d.toISOString().replace('T', ' ').slice(0, 19);
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
        const d = new Date(value);
        if (!isNaN(d.getTime())) {
            return Math.floor(d.getTime() / 1000);
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
        // 负时间: -HH:MM:SS
        const neg = value.match(/^-(\d{2}):(\d{2}):(\d{2})$/);
        if (neg) return value;
    }
    throw createError('ER_INVALID_DATE', fieldName, String(value));
}

// ============================================================
// 类型转换辅助
// ============================================================

function now(type = 'datetime') {
    const d = new Date();
    switch (type) {
        case 'date': return d.toISOString().slice(0, 10);
        case 'timestamp': return Math.floor(d.getTime() / 1000);
        case 'time': return d.toISOString().slice(11, 19);
        default: return d.toISOString().replace('T', ' ').slice(0, 19);
    }
}

function formatDate(value, format = 'YYYY-MM-DD') {
    if (!value) return value;
    const d = value instanceof Date ? value : new Date(value);
    if (isNaN(d.getTime())) return String(value);

    const pad = n => String(n).padStart(2, '0');
    return format
        .replace('YYYY', d.getFullYear())
        .replace('MM', pad(d.getMonth() + 1))
        .replace('DD', pad(d.getDate()))
        .replace('HH', pad(d.getHours()))
        .replace('mm', pad(d.getMinutes()))
        .replace('ss', pad(d.getSeconds()));
}

module.exports = { validateDateType, now, formatDate };