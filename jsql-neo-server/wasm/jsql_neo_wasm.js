/* @ts-self-types="./jsql_neo_wasm.d.ts" */
import * as wasm from "./jsql_neo_wasm_bg.wasm";
import { __wbg_set_wasm } from "./jsql_neo_wasm_bg.js";

__wbg_set_wasm(wasm);
wasm.__wbindgen_start();
export {
    jsql_count, jsql_create_table, jsql_drop_table, jsql_find, jsql_find_by_id, jsql_insert, jsql_insert_buf, jsql_insert_buf_count, jsql_insert_json, jsql_remove_by_id, jsql_update_by_id
} from "./jsql_neo_wasm_bg.js";
