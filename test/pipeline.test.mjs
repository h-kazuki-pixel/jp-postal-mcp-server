/**
 * パイプライン(scripts/build-data.mjs)の単体テスト
 * fixture: test/fixtures/sample_official.csv
 *   日本郵便公式 utf_ken_all.csv(2026年7月31日更新分・版数2607)から
 *   該当行を無改変で機械抽出したもの。出典:
 *   https://www.post.japanpost.jp/service/search/zipcode/download/utf-zip.html
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseCsvLine, validateRows, classifyNote, normalizeTown, compile, verifyRoundTrip } from '../scripts/build-data.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(__dirname, 'fixtures', 'sample_official.csv');
const lines = readFileSync(FIXTURE, 'utf8').split(/\r?\n/).filter((l) => l.length > 0);

// ---------------------------------------------------------------- CSVパース

test('CSVパース: fixture全行が15列', () => {
  for (const l of lines) {
    assert.equal(parseCsvLine(l).length, 15);
  }
});

test('CSVパース: ダブルクォート内の値が正しく取り出せる', () => {
  const c = parseCsvLine('01101,"060  ","0600000","ホッカイドウ","サッポロシチュウオウク","イカニケイサイガナイバアイ","北海道","札幌市中央区","以下に掲載がない場合",0,0,0,0,0,0');
  assert.equal(c[2], '0600000');
  assert.equal(c[8], '以下に掲載がない場合');
  assert.equal(c[0], '01101');
});

test('CSVパース: エスケープされた二重引用符("")を処理できる', () => {
  const c = parseCsvLine('00000,"000  ","0000000","ア","イ","ウ","あ","い","テスト""引用""あり",0,0,0,0,0,0');
  assert.equal(c[8], 'テスト"引用"あり');
});

// ---------------------------------------------------------------- Stage 1 検証

test('Stage 1: fixture全行が検証を通過', () => {
  const { rows, errors } = validateRows(lines);
  assert.equal(errors.length, 0);
  assert.equal(rows.length, lines.length);
});

test('Stage 1: 列数不正を検出する', () => {
  const { errors } = validateRows(['a,b,c']);
  assert.equal(errors.length >= 1, true);
});

test('Stage 1: 郵便番号の桁数不正(208件型の多重連結)を検出する', () => {
  const bad = '01101,"060  ","0660005066000506600050","ア","イ","ウ","あ","い","う",0,0,0,0,0,0';
  const { errors } = validateRows([bad]);
  assert.equal(errors.some((e) => e.includes('7桁でない')), true);
});

test('Stage 1: 括弧の不均衡を検出する', () => {
  const bad = '01101,"060  ","0600000","ア","イ","ウ","あ","い","町域（閉じない",0,0,0,0,0,0';
  const { errors } = validateRows([bad]);
  assert.equal(errors.some((e) => e.includes('括弧')), true);
});

// ---------------------------------------------------------------- Stage 2 正規化: 特殊レコード

test('特殊: 「以下に掲載がない場合」→ catchAll', () => {
  const n = normalizeTown('以下に掲載がない場合', 'イカニケイサイガナイバアイ');
  assert.equal(n.catchAll, true);
  assert.equal(n.town, '');
  assert.equal(n.directNumbering, false);
  assert.equal(n.wholeArea, false);
});

test('特殊: 「○○の次に番地がくる場合」→ directNumbering', () => {
  const n = normalizeTown('大通の次に番地がくる場合', 'オオドオリノツギニバンチガクルバアイ');
  assert.equal(n.directNumbering, true);
  assert.equal(n.town, '');
});

test('特殊: 「○○一円」→ wholeArea', () => {
  const n = normalizeTown('直島町一円', 'ナオシマチョウイチエン');
  assert.equal(n.wholeArea, true);
  assert.equal(n.town, '');
});

test('境界値: 多賀町「一円」は実在地名として保持する(wholeAreaにしない)', () => {
  const n = normalizeTown('一円', 'イチエン');
  assert.equal(n.wholeArea, false);
  assert.equal(n.town, '一円');
  assert.equal(n.kana, 'イチエン');
});

// ---------------------------------------------------------------- Stage 2 正規化: 括弧7分類

test('括弧分類: 丁目範囲は波ダッシュ U+301C で判定する(公式データの実記号)', () => {
  assert.equal(classifyNote('１〜１９丁目'), 'chome-range'); // U+301C
  // 全角チルダ U+FF5E は公式データに存在しない(実測0件)が、来ても誤分類せず word に落ちることを固定
  assert.notEqual(classifyNote('１～１９丁目'), 'chome-range');
});

test('括弧分類: 7分類の代表例', () => {
  assert.equal(classifyNote('４階'), 'building-floor');
  assert.equal(classifyNote('１〜１３１番地'), 'banchi');
  assert.equal(classifyNote('上勇知、下勇知'), 'enumeration');
  assert.equal(classifyNote('内金矢「１７４を除く」'), 'enumeration-with-exclusion');
  assert.equal(classifyNote('その他'), 'other');
  assert.equal(classifyNote('南'), 'word');
});

test('括弧の構造化: 注記を note/noteType として保持し展開しない', () => {
  const n = normalizeTown('大通西（１〜１９丁目）', 'オオドオリニシ(1-19チョウメ)');
  assert.equal(n.town, '大通西');
  assert.equal(n.note, '１〜１９丁目');
  assert.equal(n.noteType, 'chome-range');
});

// ---------------------------------------------------------------- Stage 3+4 圧縮・可逆性

test('Stage 3: 全数保証 — 正規化後レコード数 = 元レコード数(1:1)', () => {
  const { rows } = validateRows(lines);
  const compiled = compile(rows, 'test');
  assert.equal(compiled.records.length, rows.length);
});

test('Stage 3: 文字列テーブル参照が正しい(都道府県・市区町村を復元できる)', () => {
  const { rows } = validateRows(lines);
  const compiled = compile(rows, 'test');
  for (let i = 0; i < rows.length; i++) {
    const [zip, pi, ci] = compiled.records[i];
    assert.equal(zip, rows[i][2]);
    assert.equal(compiled.prefs[pi][0], rows[i][6]);
    assert.equal(compiled.cities[ci][1], rows[i][7]);
    assert.equal(compiled.cities[ci][0], rows[i][0]);
  }
});

test('Stage 4: 可逆性照合がfixture全件で合格する', () => {
  const { rows } = validateRows(lines);
  const compiled = compile(rows, 'test');
  const errors = verifyRoundTrip(rows, compiled);
  assert.deepEqual(errors, []);
});

test('Stage 4: 件数の欠落を検出する', () => {
  const { rows } = validateRows(lines);
  const compiled = compile(rows, 'test');
  compiled.records.pop();
  const errors = verifyRoundTrip(rows, compiled);
  assert.equal(errors.length >= 1, true);
});

test('Stage 4: 町域の破壊を検出する(変異テスト)', () => {
  const { rows } = validateRows(lines);
  const compiled = compile(rows, 'test');
  // 通常町域のレコードを探して意図的に壊す
  const i = compiled.records.findIndex((r) => r[3].length > 0 && !r[6]);
  assert.notEqual(i, -1);
  compiled.records[i][3] = compiled.records[i][3] + '壊';
  const errors = verifyRoundTrip(rows, compiled);
  assert.equal(errors.some((e) => e.includes('可逆性')), true);
});

// ---------------------------------------------------------------- fixture自体の健全性

test('fixtureに境界値が含まれている(多賀町一円・和坂)', () => {
  const all = lines.join('\n');
  assert.equal(all.includes('"5220317"'), true, '多賀町一円');
  assert.equal(all.includes('"6730012"'), true, '和坂');
  assert.equal(all.includes('カニガサカ'), true, '和坂の読み1');
  assert.equal(all.includes('ワサカ'), true, '和坂の読み2');
});
