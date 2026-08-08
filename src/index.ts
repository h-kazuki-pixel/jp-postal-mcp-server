#!/usr/bin/env node
/**
 * jp-postal-mcp-server
 * 日本郵便の公式データを正規化して同梱した、完全オフライン・APIキー不要・
 * 読み取り専用の郵便番号⇔住所MCPサーバー。
 *
 * データ出典: 日本郵便「住所の郵便番号(1レコード1行、UTF-8形式)」
 * https://www.post.japanpost.jp/service/search/zipcode/download/utf-zip.html
 * (日本郵便は郵便番号データについて著作権を主張しない旨を公表している)
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PostalDb } from './core.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_PATH = join(__dirname, '..', 'data', 'compiled.json.gz');

const db = new PostalDb(DATA_PATH);

const server = new Server(
  { name: 'jp-postal-mcp-server', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

// tools/list は固定の配列リテラルで定義する(MCP 2026-07-28 仕様の決定的順序)
const TOOLS = [
  {
    name: 'lookup_zipcode',
    description:
      '日本の郵便番号から住所を検索する。7桁は完全一致、3〜6桁は前方一致。ハイフン・全角数字も受け付ける。完全オフライン(同梱の日本郵便公式データを使用)。',
    inputSchema: {
      type: 'object',
      properties: {
        zipcode: {
          type: 'string',
          description: '郵便番号(例: "5220317", "060-0000", "〒１００−０００１", 前方一致なら "522" など3桁以上)',
        },
        limit: {
          type: 'number',
          description: '返却件数の上限(既定50)',
        },
      },
      required: ['zipcode'],
    },
  },
  {
    name: 'search_address',
    description:
      '住所の文字列(漢字またはカナの部分一致)から郵便番号を検索する。都道府県・市区町村・町域のいずれにもマッチする。完全オフライン(同梱の日本郵便公式データを使用)。',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '住所の一部(例: "多賀町", "銀座", "サッポロ")',
        },
        limit: {
          type: 'number',
          description: '返却件数の上限(既定50)',
        },
      },
      required: ['query'],
    },
  },
] as const;

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS as unknown as typeof TOOLS[number][] }));

function clampLimit(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : 50;
  return Math.min(Math.max(n, 1), 200);
}

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  if (name === 'lookup_zipcode') {
    const input = String((args as Record<string, unknown>)?.zipcode ?? '');
    const limit = clampLimit((args as Record<string, unknown>)?.limit);
    const r = db.lookupZipcode(input, limit);
    if (r.normalized === null) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: '郵便番号として解釈できません。3〜7桁の数字(ハイフン・全角可)を指定してください。',
              input,
            }),
          },
        ],
        isError: true,
      };
    }
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            normalizedZipcode: r.normalized,
            matchType: r.normalized.length === 7 ? 'exact' : 'prefix',
            total: r.total,
            returned: r.records.length,
            records: r.records,
            dataVersion: db.dataVersion,
          }),
        },
      ],
    };
  }

  if (name === 'search_address') {
    const query = String((args as Record<string, unknown>)?.query ?? '');
    const limit = clampLimit((args as Record<string, unknown>)?.limit);
    if (query.trim().length === 0) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: 'query が空です。', query }) }],
        isError: true,
      };
    }
    const r = db.searchAddress(query, limit);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            query: query.trim(),
            total: r.total,
            returned: r.records.length,
            records: r.records,
            dataVersion: db.dataVersion,
          }),
        },
      ],
    };
  }

  return {
    content: [{ type: 'text', text: JSON.stringify({ error: `不明なツール: ${name}` }) }],
    isError: true,
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
