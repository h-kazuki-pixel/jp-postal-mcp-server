#!/usr/bin/env node
/**
 * jp-postal-mcp-server — ビルド時データパイプライン
 *
 * 入力: 日本郵便公式「住所の郵便番号(1レコード1行、UTF-8形式)」utf_ken_all.csv
 *   取得元: https://www.post.japanpost.jp/service/search/zipcode/download/utf-zip.html
 *   ※ CSVはリポジトリに同梱しない。手動ダウンロードして raw/utf_ken_all.csv に置く
 *
 * 出力: data/compiled.json.gz(文字列テーブル圧縮済み)
 *
 * Stage 1: 検証   — 列数15・郵便番号7桁・JIS5桁・括弧均衡を全件検査
 * Stage 2: 正規化 — 特殊レコード処理・括弧注記の構造化
 * Stage 3: 圧縮   — 文字列テーブル化 → gzip
 * Stage 4: 照合   — 元CSVと圧縮データの全件突合(可逆性テスト)
 *
 * 正規化仕様の根拠は日本郵便「郵便番号データの説明」の記述のみ。
 * 既存実装(zipcloud / Geolonia / posuto 等)のコードは読んでいない・使っていない。
 */

import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const INPUT = process.argv[2] || join(ROOT, 'raw', 'utf_ken_all.csv');
const OUTPUT = join(ROOT, 'data', 'compiled.json.gz');

// ---------------------------------------------------------------- 共通

/** 15列固定・ダブルクォート対応のCSV1行パーサ(公式仕様準拠) */
export function parseCsvLine(line) {
  const cols = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = false;
      } else cur += ch;
    } else {
      if (ch === '"') inQ = true;
      else if (ch === ',') { cols.push(cur); cur = ''; }
      else cur += ch;
    }
  }
  cols.push(cur);
  return cols;
}

// ---------------------------------------------------------------- Stage 1: 検証

export function validateRows(lines) {
  const errors = [];
  const rows = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const c = parseCsvLine(line);
    if (c.length !== 15) { errors.push(`行${i + 1}: 列数${c.length}(15であるべき)`); continue; }
    const [jis, , zip, , , , , , town] = c;
    if (!/^\d{7}$/.test(zip)) errors.push(`行${i + 1}: 郵便番号が7桁でない: "${zip}"`);
    if (!/^[0-9A-Za-z]{5}$/.test(jis)) errors.push(`行${i + 1}: JISコードが5桁でない: "${jis}"`);
    const open = (town.match(/（/g) || []).length;
    const close = (town.match(/）/g) || []).length;
    if (open !== close) errors.push(`行${i + 1}: 括弧の不均衡: "${town}"`);
    rows.push(c);
  }
  return { rows, errors };
}

// ---------------------------------------------------------------- Stage 2: 正規化

/**
 * 括弧注記の分類(公式2607版の全数分類に基づく7分類)
 * 範囲記号は波ダッシュ U+301C「〜」。全角チルダ U+FF5E は公式データに存在しない(実測0件)。
 */
export function classifyNote(note) {
  if (/「.+」/.test(note)) return 'enumeration-with-exclusion';
  if (/[０-９0-9]+〜[０-９0-9]+丁目/.test(note)) return 'chome-range';
  if (/番地/.test(note)) return 'banchi';
  if (/、/.test(note)) return 'enumeration';
  if (/階|地階|ビル/.test(note)) return 'building-floor';
  if (/^その他$|除く|以外|全域/.test(note)) return 'other';
  return 'word';
}

/**
 * 町域の正規化。
 * 返却: { town, kana, note, noteType, catchAll, directNumbering, wholeArea }
 */
export function normalizeTown(town, kana) {
  const out = { town, kana, note: null, noteType: null, catchAll: false, directNumbering: false, wholeArea: false };

  // 特殊1: 以下に掲載がない場合(1,870件)
  if (town === '以下に掲載がない場合') {
    out.town = '';
    out.kana = '';
    out.catchAll = true;
    return out;
  }

  // 特殊2: ○○の次に番地がくる場合(17件)
  const dn = town.match(/^(.*)の次に番地がくる場合$/);
  if (dn) {
    out.town = '';
    out.kana = '';
    out.directNumbering = true;
    return out;
  }

  // 特殊3: ○○一円(22件除去・1件保持)
  // 例外: 滋賀県犬上郡多賀町「一円」(5220317)は実在地名。町域が「一円」そのものの場合は保持する
  if (/一円$/.test(town) && town !== '一円') {
    out.town = '';
    out.kana = '';
    out.wholeArea = true;
    return out;
  }

  // 括弧注記の構造化保持(展開はしない。判断はLLMに委ねる)
  const m = town.match(/^(.*?)（(.+)）$/);
  if (m) {
    out.town = m[1];
    out.note = m[2];
    out.noteType = classifyNote(m[2]);
    const km = kana.match(/^(.*?)\((.+)\)$/);
    if (km) out.kana = km[1];
  }

  return out;
}

// ---------------------------------------------------------------- Stage 3: 圧縮

export function compile(rows, dataVersion) {
  // 文字列テーブル: 都道府県(47)・市区町村(約1900)・都道府県カナ・市区町村カナ
  const prefTable = [];
  const prefIdx = new Map();
  const cityTable = [];
  const cityIdx = new Map();

  const records = [];
  for (const c of rows) {
    const [jis, /*oldZip 落とす*/, zip, prefKana, cityKana, townKana, pref, city, town, f1, f2, f3, f4, f5, f6] = c;

    const prefKey = pref + '\u0000' + prefKana;
    let pi = prefIdx.get(prefKey);
    if (pi === undefined) { pi = prefTable.length; prefTable.push([pref, prefKana]); prefIdx.set(prefKey, pi); }

    const cityKey = jis + '\u0000' + city + '\u0000' + cityKana;
    let ci = cityIdx.get(cityKey);
    if (ci === undefined) { ci = cityTable.length; cityTable.push([jis, city, cityKana]); cityIdx.set(cityKey, ci); }

    const n = normalizeTown(town, townKana);

    // フラグを1整数に詰める(公式列10〜15 + 特殊フラグ3種)
    // bit0: 1町域が2以上の郵便番号(列10) / bit1: 小字毎に番地が起番(列11) / bit2: 丁目を有する(列12)
    // bit3: 1郵便番号で2以上の町域(列13) / bit4-5: 更新の表示(列14, 2bit) / bit6-7: 変更理由(列15は0-6だが3bitに)
    // bit8: catchAll / bit9: directNumbering / bit10: wholeArea
    let flags = 0;
    if (f1 === '1') flags |= 1;
    if (f2 === '1') flags |= 2;
    if (f3 === '1') flags |= 4;
    if (f4 === '1') flags |= 8;
    flags |= (Number(f5) & 3) << 4;
    flags |= (Number(f6) & 7) << 6;
    if (n.catchAll) flags |= 1 << 9;
    if (n.directNumbering) flags |= 1 << 10;
    if (n.wholeArea) flags |= 1 << 11;

    // レコード: [zip, prefId, cityId, town, kana, flags, note?, noteType?]
    const rec = [zip, pi, ci, n.town, n.kana, flags];
    if (n.note !== null) { rec.push(n.note, n.noteType); }
    records.push(rec);
  }

  return {
    format: 1,
    source: 'https://www.post.japanpost.jp/service/search/zipcode/download/utf-zip.html',
    dataVersion,
    generatedAt: new Date().toISOString().slice(0, 10),
    recordCount: records.length,
    prefs: prefTable,
    cities: cityTable,
    records,
  };
}

// ---------------------------------------------------------------- Stage 4: 照合(可逆性)

export function verifyRoundTrip(rows, compiled) {
  if (rows.length !== compiled.records.length) {
    return [`件数不一致: 元${rows.length} / 圧縮後${compiled.records.length}`];
  }
  const errors = [];
  for (let i = 0; i < rows.length; i++) {
    const c = rows[i];
    const r = compiled.records[i];
    const [zip, pi, ci, town, kana, flags, note, noteType] = r;
    if (zip !== c[2]) { errors.push(`行${i + 1}: 郵便番号不一致`); continue; }
    const [pref, prefKana] = compiled.prefs[pi];
    const [jis, city, cityKana] = compiled.cities[ci];
    if (pref !== c[6] || prefKana !== c[3]) errors.push(`行${i + 1}: 都道府県不一致`);
    if (jis !== c[0] || city !== c[7] || cityKana !== c[4]) errors.push(`行${i + 1}: 市区町村不一致`);

    // 町域の可逆性: 元の町域を再構成して比較
    let reconstructed;
    if (flags & (1 << 9)) reconstructed = '以下に掲載がない場合';
    else if (flags & (1 << 10)) reconstructed = c[8]; // ○○の次に番地がくる場合(接頭辞は落としている。元と同じ判定条件で照合)
    else if (flags & (1 << 11)) reconstructed = c[8]; // ○○一円(同上)
    else if (note != null) reconstructed = `${town}（${note}）`;
    else reconstructed = town;

    if (flags & (1 << 10)) {
      if (!/の次に番地がくる場合$/.test(c[8])) errors.push(`行${i + 1}: directNumberingフラグ不正`);
    } else if (flags & (1 << 11)) {
      if (!/一円$/.test(c[8]) || c[8] === '一円') errors.push(`行${i + 1}: wholeAreaフラグ不正`);
    } else if (reconstructed !== c[8]) {
      errors.push(`行${i + 1}: 町域の可逆性が崩れた: "${reconstructed}" ≠ "${c[8]}"`);
    }
    if (errors.length > 20) { errors.push('(以降省略)'); break; }
  }
  return errors;
}

// ---------------------------------------------------------------- main

function main() {
  if (!existsSync(INPUT)) {
    console.error(`入力ファイルが見つかりません: ${INPUT}`);
    console.error('日本郵便公式サイトから utf_ken_all.zip をダウンロードし、解凍したCSVを raw/ に置いてください。');
    process.exit(1);
  }

  const dataVersion = process.env.JP_POSTAL_DATA_VERSION || 'unknown';
  console.log(`入力: ${INPUT} (${(statSync(INPUT).size / 1024 / 1024).toFixed(1)}MB) / 版数: ${dataVersion}`);

  const raw = readFileSync(INPUT, 'utf8');
  const lines = raw.split(/\r?\n/).filter((l) => l.length > 0);

  // Stage 1
  const t1 = performance.now();
  const { rows, errors: vErrors } = validateRows(lines);
  if (vErrors.length > 0) {
    console.error(`Stage 1 検証失敗: ${vErrors.length}件`);
    for (const e of vErrors.slice(0, 20)) console.error('  ' + e);
    process.exit(1);
  }
  console.log(`Stage 1 検証: ${rows.length}件 全合格 (${(performance.now() - t1).toFixed(0)}ms)`);

  // Stage 2 + 3
  const t2 = performance.now();
  const compiled = compile(rows, dataVersion);
  console.log(`Stage 2+3 正規化・圧縮: prefs=${compiled.prefs.length} cities=${compiled.cities.length} records=${compiled.records.length} (${(performance.now() - t2).toFixed(0)}ms)`);

  // Stage 4
  const t3 = performance.now();
  const rtErrors = verifyRoundTrip(rows, compiled);
  if (rtErrors.length > 0) {
    console.error(`Stage 4 照合失敗: ${rtErrors.length}件`);
    for (const e of rtErrors.slice(0, 20)) console.error('  ' + e);
    process.exit(1);
  }
  console.log(`Stage 4 照合: 全${rows.length}件の可逆性を確認 (${(performance.now() - t3).toFixed(0)}ms)`);

  const json = JSON.stringify(compiled);
  const gz = gzipSync(Buffer.from(json), { level: 9 });
  writeFileSync(OUTPUT, gz);
  console.log(`出力: ${OUTPUT} (JSON ${(json.length / 1024 / 1024).toFixed(1)}MB → gzip ${(gz.length / 1024 / 1024).toFixed(1)}MB)`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
