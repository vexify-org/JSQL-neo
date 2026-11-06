// © Vexify 2026 All Rights Reserved.
/**
 * BigInt 安全的 JSON 序列化（Issue #38）。
 *
 * 行数据里可能出现 >2^53 的 BigInt（integer/int/bigint 列）。原生
 * JSON.stringify 遇到 BigInt 直接抛 "Do not know how to serialize a BigInt"，
 * 于是 WAL、事务快照、统计等路径会整条失败。
 *
 * 这里用一个单键标记对象 `{ __jsql_bigint__: "9223372036854775807" }`
 * 在 JSON 中无损往返；反序列化时还原成 BigInt。只有「对象恰好只有这一个键」
 * 时才还原，尽量避免误伤用户自己的同名字段。
 */

const MARKER = '__jsql_bigint__';

function replacer(_key, value) {
    if (typeof value === 'bigint') return { [MARKER]: value.toString() };
    return value;
}

function reviver(_key, value) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        const keys = Object.keys(value);
        if (keys.length === 1 && keys[0] === MARKER && typeof value[MARKER] === 'string') {
            try { return BigInt(value[MARKER]); } catch (_) { return value; }
        }
    }
    return value;
}

function stringify(value, space) {
    return JSON.stringify(value, replacer, space);
}

function parse(text) {
    return JSON.parse(text, reviver);
}

module.exports = { stringify, parse, MARKER };
