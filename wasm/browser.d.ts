/* tslint:disable */
/* eslint-disable */

export function jsql_begin_tx(): string;

export function jsql_commit_tx(tx_id: string): string;

export function jsql_count(table: string): string;

export function jsql_create_table(name: string, schema_json: string): string;

export function jsql_drop_table(name: string): string;

export function jsql_find(table: string, filter_json: string, limit: number, offset: number): string;

export function jsql_find_by_id(table: string, id: bigint): string;

export function jsql_find_by_ids(table: string, ids_json: string): string;

export function jsql_insert(table: string, data_json: string): string;

export function jsql_insert_buf(table: string, data: Uint8Array): string;

export function jsql_insert_buf_count(table: string, data: Uint8Array): string;

export function jsql_insert_json(table: string, json: string): string;

export function jsql_remove_by_id(table: string, id: bigint): string;

export function jsql_remove_by_ids(table: string, ids_json: string): string;

export function jsql_reset(): void;

export function jsql_rollback_tx(tx_id: string): string;

export function jsql_update_by_id(table: string, id: bigint, data_json: string): string;

export function jsql_update_by_ids(table: string, batch_json: string): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly jsql_begin_tx: () => [number, number];
    readonly jsql_commit_tx: (a: number, b: number) => [number, number];
    readonly jsql_count: (a: number, b: number) => [number, number];
    readonly jsql_create_table: (a: number, b: number, c: number, d: number) => [number, number];
    readonly jsql_drop_table: (a: number, b: number) => [number, number];
    readonly jsql_find: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number];
    readonly jsql_find_by_id: (a: number, b: number, c: bigint) => [number, number];
    readonly jsql_find_by_ids: (a: number, b: number, c: number, d: number) => [number, number];
    readonly jsql_insert: (a: number, b: number, c: number, d: number) => [number, number];
    readonly jsql_insert_buf: (a: number, b: number, c: number, d: number) => [number, number];
    readonly jsql_insert_buf_count: (a: number, b: number, c: number, d: number) => [number, number];
    readonly jsql_insert_json: (a: number, b: number, c: number, d: number) => [number, number];
    readonly jsql_remove_by_id: (a: number, b: number, c: bigint) => [number, number];
    readonly jsql_remove_by_ids: (a: number, b: number, c: number, d: number) => [number, number];
    readonly jsql_rollback_tx: (a: number, b: number) => [number, number];
    readonly jsql_update_by_id: (a: number, b: number, c: bigint, d: number, e: number) => [number, number];
    readonly jsql_update_by_ids: (a: number, b: number, c: number, d: number) => [number, number];
    readonly jsql_reset: () => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
