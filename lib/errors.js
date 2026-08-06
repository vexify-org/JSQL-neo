// © Vexify 2026 All Rights Reserved.
/**
 * JSQL Error Codes — MySQL 风格错误码体系
 */

class JSQL_Error extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'JSQL_Error';
        this.code = code;
        this.details = details;
        this.timestamp = new Date().toISOString();
    }

    toJSON() {
        return {
            error: true,
            code: this.code,
            message: this.message,
            details: this.details,
            timestamp: this.timestamp
        };
    }
}

// MySQL 兼容错误码
const ErrorCodes = {
    // 表/库操作
    ER_TABLE_EXISTS:          { code: 1050,  msg: "Table '%s' already exists" },
    ER_NO_SUCH_TABLE:         { code: 1146,  msg: "Table '%s' doesn't exist" },
    ER_DB_CREATE_EXISTS:      { code: 1007,  msg: "Can't create database '%s'; database exists" },

    // 列操作
    ER_DUP_FIELDNAME:         { code: 1060,  msg: "Duplicate column name '%s'" },
    ER_BAD_FIELD_ERROR:       { code: 1054,  msg: "Unknown column '%s' in '%s'" },
    ER_CANT_DROP_FIELD:       { code: 1091,  msg: "Can't DROP '%s'; check that column exists" },

    // 约束
    ER_DUP_ENTRY:             { code: 1062,  msg: "Duplicate entry '%s' for key '%s'" },
    ER_NO_DEFAULT_FOR_FIELD:  { code: 1364,  msg: "Field '%s' doesn't have a default value" },
    ER_BAD_NULL_ERROR:        { code: 1048,  msg: "Column '%s' cannot be null" },
    ER_CHECK_CONSTRAINT:      { code: 3819,  msg: "Check constraint '%s' is violated" },
    ER_NO_REFERENCED_ROW:     { code: 1216,  msg: "Cannot add or update: foreign key constraint fails" },
    ER_ROW_IS_REFERENCED:     { code: 1217,  msg: "Cannot delete or update: a foreign key constraint fails" },

    // 数据类型
    ER_TRUNCATED_WRONG_VALUE: { code: 1292,  msg: "Truncated incorrect %s value: '%s'" },
    ER_INVALID_DATE:          { code: 1292,  msg: "Incorrect date value: '%s'" },
    ER_DATA_TOO_LONG:         { code: 1406,  msg: "Data too long for column '%s'" },
    ER_OUT_OF_RANGE:          { code: 1264,  msg: "Out of range value for column '%s'" },

    // 事务
    ER_TRANSACTION_ACTIVE:    { code: 1568,  msg: "Transaction already in progress" },
    ER_NO_TRANSACTION:        { code: 1569,  msg: "No transaction in progress" },

    // 其他
    ER_NOT_SUPPORTED:         { code: 1235,  msg: "This version doesn't yet support '%s'" },
    ER_PARSE_ERROR:           { code: 1064,  msg: "You have an error in your syntax: %s" },
    ER_LOCK_WAIT_TIMEOUT:     { code: 1205,  msg: "Lock wait timeout exceeded; try restarting transaction" },
    ER_FILE_NOT_FOUND:        { code: 1017,  msg: "Can't find file: '%s'" },
    ER_VIEW_EXISTS:           { code: 1050,  msg: "View '%s' already exists" },
    ER_TRIGGER_EXISTS:        { code: 1359,  msg: "Trigger '%s' already exists" },
    ER_TRIGGER_NOT_FOUND:     { code: 1360,  msg: "Trigger '%s' does not exist" },
    ER_PLUGIN_ERR:            { code: 1125,  msg: "Plugin error: %s" },
    ER_PLUGIN_ABORT:          { code: 1125,  msg: "Operation aborted by plugin: %s" },
    ER_TABLE_EXISTS_ERROR:    { code: 1050,  msg: "Table '%s' already exists" },
    ER_BAD_TABLE_NAME:        { code: 1058,  msg: "Invalid table name '%s'" },
    ER_BAD_REGEX:             { code: 1258,  msg: "Unsafe regular expression rejected: %s" },
    ER_DBATTACH_EXISTS:       { code: 1007,  msg: "Database '%s' already attached" },
    ER_DBATTACH_NOT_FOUND:    { code: 1049,  msg: "Attached database '%s' not found" },
};

/**
 * 创建错误
 */
function createError(codeKey, ...args) {
    const template = ErrorCodes[codeKey];
    if (!template) {
        return new JSQL_Error('UNKNOWN', `Unknown error: ${codeKey}`, { codeKey, args });
    }

    let msg = template.msg;
    for (let i = 0; i < args.length; i++) {
        msg = msg.replace('%s', String(args[i]));
    }

    return new JSQL_Error(template.code, msg, { args });
}

module.exports = { JSQL_Error, ErrorCodes, createError };