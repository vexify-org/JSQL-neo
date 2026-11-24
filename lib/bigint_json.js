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
// #169：用户数据里恰好有 { __jsql_bigint__: "123" } 时，用 NUL 前缀转义，
// reviver 只还原没有被转义的标记，避免把用户对象误改成 BigInt。
const ESCAPE = '\u0000';

function replacer(_key, value) {
    if (typeof value === 'bigint') return { [MARKER]: value.toString() };
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        const keys = Object.keys(value);
        if (keys.length === 1 && keys[0] === MARKER && typeof value[MARKER] === 'string') {
            return { [MARKER]: ESCAPE + value[MARKER] };
        }
    }
    return value;
}

function reviver(_key, value) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        const keys = Object.keys(value);
        if (keys.length === 1 && keys[0] === MARKER && typeof value[MARKER] === 'string') {
            if (value[MARKER].startsWith(ESCAPE)) {
                return { [MARKER]: value[MARKER].slice(ESCAPE.length) };
            }
            try { return BigInt(value[MARKER]); } catch (_) { return value; }
        }
    }
    return value;
}

function stringify(value, space) {
    // 快路径：绝大多数行不含 BigInt / 标记对象。replacer 会对每个属性回调一次，
    // 百万行批量写入时是主要 CPU 开销；这里先走原生无 replacer 序列化，
    // 仅在结果里出现标记（需要 #169 转义）或抛 BigInt TypeError 时回退慢路径。
    try {
        const text = JSON.stringify(value, undefined, space);
        if (typeof text === 'string' && text.indexOf(MARKER) !== -1) {
            return JSON.stringify(value, replacer, space);
        }
        return text;
    } catch (e) {
        if (e instanceof TypeError) return JSON.stringify(value, replacer, space);
        throw e;
    }
}

function parse(text) {
    return JSON.parse(text, reviver);
}

module.exports = { stringify, parse, MARKER };
