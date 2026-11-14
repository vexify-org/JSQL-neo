'use strict';
/**
 * 统一的网络访问策略 —— 「默认不出网，必须出网的地方写明原因」。
 *
 * 约定：仓库里任何会真正访问**外部网络**的位置，都要在紧邻处写一段
 * `NETWORK:` 注释，四行说清楚：
 *
 *   Why:     为什么非联网不可（本地为什么做不到）
 *   Trigger: 什么操作才会触发（必须能由用户主动预期）
 *   Offline: JSQL_OFFLINE=1 时的行为
 *   Scope:   访问的目标主机 / 数据
 *
 * 只连 127.0.0.1 / localhost 的本地回环（各 * _server.js、client.js、
 * web_ui 的同源 fetch）不算外部网络，写 `LOCAL-ONLY:` 一句即可。
 *
 * 环境变量：
 *   JSQL_OFFLINE=1|true|yes|on   一键禁用所有外部网络访问。
 *   已有的专用开关（JSQL_NO_NATIVE_DOWNLOAD / JSQL_NATIVE_DOWNLOAD=0 /
 *   JSQL_NATIVE_FORCE_REFRESH=0 / JSQL_NO_STAR_NAG=1）继续有效。
 */

const TRUTHY = /^(1|true|yes|on)$/i;

/** 当前进程是否处于离线模式。 */
function isOffline() {
  return TRUTHY.test(String(process.env.JSQL_OFFLINE || ''));
}

/**
 * 构造一个可读的离线错误。带 code，方便调用方区分「用户主动离线」和
 * 「网络真的不通」—— 这两者不该给用户同一句报错。
 */
function offlineError(feature, why) {
  const err = new Error(
    `${feature} 需要联网（${why}）。当前 JSQL_OFFLINE=1，已跳过；` +
    '取消该环境变量即可恢复。'
  );
  err.code = 'JSQL_OFFLINE';
  return err;
}

module.exports = { isOffline, offlineError, TRUTHY };
