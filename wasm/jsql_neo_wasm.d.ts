/* tslint:disable */
/* eslint-disable */

export function jsql_count(table: string): string;

export function jsql_create_table(name: string, schema_json: string): string;

export function jsql_drop_table(name: string): string;

export function jsql_find(table: string, filter_json: string, limit: number, offset: number): string;

export function jsql_find_by_id(table: string, id: bigint): string;

export function jsql_insert(table: string, data_json: string): string;

export function jsql_insert_buf(table: string, data: Uint8Array): string;

export function jsql_remove_by_id(table: string, id: bigint): string;

export function jsql_update_by_id(table: string, id: bigint, data_json: string): string;
