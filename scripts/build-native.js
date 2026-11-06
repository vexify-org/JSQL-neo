#!/usr/bin/env node
'use strict';

// 从源码编译原生模块（Rust crate: nativesrc/jsql-neo-native），产物写入 native/jsql-neo-native.node。
// 用法：npm run build:native
// 需要本机安装 Rust 工具链（cargo）。
// 供应链安全（issue #25）：postinstall 默认不再自动下载预编译二进制，需要原生模块时
// 可显式运行本脚本从源码构建，或设置 JSQL_AUTO_DOWNLOAD_NATIVE=1 拉取 release 资产。
const { buildNativeFromSource } = require('../postinstall');

buildNativeFromSource();
