/**
 * JSQL CLI — 模块化入口
 *
 * 将各子命令拆分为独立模块，bin/jsql 通过此文件加载。
 * 当前包含: plugin 命令
 */

const plugin = require('./plugin');

module.exports = {
  plugin,
};
