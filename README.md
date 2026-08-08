# jp-postal-mcp-server

日本郵便の公式データを正規化して同梱した、**完全オフライン・APIキー不要・読み取り専用**の郵便番号⇔住所MCPサーバー。

Japanese postal code ⇄ address lookup with bundled official data — fully offline, no API key.

[![CI](https://github.com/h-kazuki-pixel/jp-postal-mcp-server/actions/workflows/ci.yml/badge.svg)](https://github.com/h-kazuki-pixel/jp-postal-mcp-server/actions/workflows/ci.yml)

## 特徴

- **完全オフライン**: 日本郵便の公式データ(約12万件)を圧縮同梱。外部APIを呼ばない。住所データを外部に送らない
- **APIキー不要・課金なし**: 導入して即動く
- **読み取り専用**: 検索するだけ。ファイルもネットワークも書き換えない
- **正規化の透明性**: 「以下に掲載がない場合」「○○一円」などの特殊レコードをフラグとして構造化。括弧注記(「１〜１９丁目」等)は展開せず `note` / `noteType` として保持し、解釈はLLMに委ねる

### 性能(実測)

| 指標 | 目標 | 実測(Node 22) |
|---|---|---|
| 起動(ロード+索引構築) | 500ms以下 | **246ms** |
| メモリ(heapUsed) | 60MB以下 | **37.1MB** |
| 郵便番号lookup | — | 0.03µs/回 |
| 住所部分一致(全件走査) | — | 26ms |

素朴実装(全レコードを文字列で保持)では112MBだったものを、文字列テーブル化により1/3に圧縮しています。

## ツール

### `lookup_zipcode`

郵便番号から住所を検索。7桁は完全一致、3〜6桁は前方一致。

- 入力の揺れを吸収: `060-0000` / `〒１００−０００１` / 全角数字 / 長音記号
- 「1つの郵便番号に複数町域」「1つの町域に複数郵便番号」の曖昧性を公式フラグとして透過

### `search_address`

住所の文字列(漢字またはカナの部分一致)から郵便番号を検索。都道府県・市区町村・町域のいずれにもマッチ。

## セットアップをAIに任せる

Claude Desktop に以下を貼り付けてください。

---

jp-postal-mcp-server をセットアップしてください。

1. https://github.com/h-kazuki-pixel/jp-postal-mcp-server の README を読む
2. 私の claude_desktop_config.json に必要な設定を追記する
3. 設定後、動作確認としてツールを1回実行して結果を見せる

私は非エンジニアです。実行するコマンドは1つずつ提示してください。

---

## 手動セットアップ

```bash
git clone https://github.com/h-kazuki-pixel/jp-postal-mcp-server.git
cd jp-postal-mcp-server
npm install
npm run build
```

`claude_desktop_config.json` に追記:

```json
{
  "mcpServers": {
    "jp-postal": {
      "command": "node",
      "args": ["/absolute/path/to/jp-postal-mcp-server/dist/index.js"]
    }
  }
}
```

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`(argsのパスは `C:\\path\\to\\...` 形式)

## 1分お試し

サーバーを立てずに動作を確認できます。リポジトリ直下で:

```bash
printf '%s\n%s\n%s\n' \
'{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}' \
'{"jsonrpc":"2.0","method":"notifications/initialized"}' \
'{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"lookup_zipcode","arguments":{"zipcode":"522-0317"}}}' \
| node dist/index.js 2>/dev/null | tail -1
```

期待される出力(抜粋):

```json
{"zipcode":"5220317","prefecture":"滋賀県","city":"犬上郡多賀町","town":"一円","townKana":"イチエン", ...}
```

滋賀県犬上郡多賀町「一円」は実在の地名です。「○○一円(=全域)」という注記表現と紛らわしいため、本サーバーの境界値テストとして固定しています。

## 使わない方がいい場合

- **単発の住所確認だけ**なら本MCPは不要です(Web検索で足ります)
- **番地・号レベルの住所正規化や実在検証**が必要な場合は対象外です(公式データの粒度が町域までのため)
- **常に最新データが必須**の場合は注意してください(同梱データは月次更新の公式データに基づく。鮮度は `dataVersion` で確認できます)

## 返却レコードの読み方

```jsonc
{
  "zipcode": "0600000",
  "prefecture": "北海道",
  "city": "札幌市中央区",
  "town": "",                 // catchAllの場合は空
  "note": null,               // 括弧注記(例: "１〜１９丁目")
  "noteType": null,           // chome-range / banchi / enumeration / enumeration-with-exclusion / building-floor / other / word
  "catchAll": true,           // 「以下に掲載がない場合」
  "directNumbering": false,   // 「○○の次に番地がくる場合」
  "wholeArea": false,         // 「○○一円」(町域全域)
  "oneZipManyTowns": false,   // 1つの郵便番号が2以上の町域を表す(公式フラグ)
  "oneTownManyZips": false    // 1つの町域が2以上の郵便番号で表される(公式フラグ)
}
```

## データについて

- 出典: 日本郵便「住所の郵便番号(1レコード1行、UTF-8形式)」
  https://www.post.japanpost.jp/service/search/zipcode/download/utf-zip.html
- データ版数: **2607**(2026年7月31日更新分) / 取得日: 2026-08-08 / 124,513件
- 日本郵便は郵便番号データについて「著作権を主張しません。自由に配布していただいて結構です」と公表しており、本リポジトリはこれに基づいてデータを同梱しています
- 正規化ロジックは公式の「[郵便番号データの説明](https://www.post.japanpost.jp/zipcode/dl/utf-readme.html)」の仕様記述のみを根拠にした**独自実装**です。既存の郵便番号ライブラリのコードは参照していません

### データの再現(ビルドパイプライン)

同梱データ `data/compiled.json.gz` は、公式CSVから誰でも再生成できます:

```bash
# 公式サイトから utf_ken_all.zip をダウンロードし、解凍したCSVを raw/ に置く
JP_POSTAL_DATA_VERSION=2607 npm run build:data
```

パイプラインは4段構成です:

1. **検証**: 列数15・郵便番号7桁・JIS5桁・括弧均衡を全件検査
2. **正規化**: 特殊レコード3種のフラグ化・括弧注記の構造化(展開はしない)
3. **圧縮**: 文字列テーブル化(17.5MB → 1.6MB)
4. **照合**: 元CSVと圧縮データの全件突合(可逆性の保証)

### 実装上の発見(公式データの実測より)

- 丁目範囲の記号は**波ダッシュ「〜」(U+301C)**。全角チルダ「～」(U+FF5E)は全124,513件中0件
- 兵庫県明石市「和坂」は同一郵便番号(673-0012)で読みが2つ(カニガサカ/ワサカ)ある正当な重複レコード
- 滋賀県犬上郡多賀町「一円」(522-0317)は実在地名。「○○一円」の機械除去はこの1件を壊してはならない

## テスト

```bash
npm test
```

41件(パイプライン20件 + 検索・性能・一次データ照合21件)。fixtureは公式CSVからの**無改変の機械抽出**で、公式CSVを `raw/` に置いた環境では圧縮データとの全件突合も実行されます。CI は ubuntu-latest / windows-latest × Node 20 / 22 の4本立てです。

## ライセンス

MIT
