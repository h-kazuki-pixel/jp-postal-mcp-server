/**
 * 検索ロジック(dist/core.js)のテスト。同梱の本番データ(data/compiled.json.gz)を使う。
 * 実行前に `npm run build` が必要。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { PostalDb } from '../dist/core.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA = join(__dirname, '..', 'data', 'compiled.json.gz');

const t0 = performance.now();
const db = new PostalDb(DATA);
const startupMs = performance.now() - t0;

// ---------------------------------------------------------------- 正規化

test('正規化: ハイフンあり', () => {
  assert.equal(PostalDb.normalizeZip('060-0000'), '0600000');
});

test('正規化: 全角数字・全角ダッシュ・〒マーク', () => {
  assert.equal(PostalDb.normalizeZip('〒１００−０００１'), '1000001');
});

test('正規化: 長音記号ーをハイフンとして扱う', () => {
  assert.equal(PostalDb.normalizeZip('100ー0001'), '1000001');
});

test('正規化: 数字でない入力は null', () => {
  assert.equal(PostalDb.normalizeZip('あいうえお'), null);
  assert.equal(PostalDb.normalizeZip(''), null);
});

test('正規化: 2桁以下・8桁以上は null', () => {
  assert.equal(PostalDb.normalizeZip('06'), null);
  assert.equal(PostalDb.normalizeZip('12345678'), null);
});

// ---------------------------------------------------------------- 完全一致

test('完全一致: 多賀町一円(5220317)が実在地名として返る', () => {
  const r = db.lookupZipcode('5220317');
  assert.equal(r.total, 1);
  assert.equal(r.records[0].town, '一円');
  assert.equal(r.records[0].city, '犬上郡多賀町');
  assert.equal(r.records[0].wholeArea, false);
});

test('完全一致: catchAll(0600000)が空町域+フラグで返る', () => {
  const r = db.lookupZipcode('0600000');
  assert.equal(r.total, 1);
  assert.equal(r.records[0].catchAll, true);
  assert.equal(r.records[0].town, '');
});

test('完全一致: 和坂(6730012)は2読みとも返る', () => {
  const r = db.lookupZipcode('6730012');
  assert.equal(r.total, 2);
  const kanas = r.records.map((x) => x.townKana).sort();
  assert.deepEqual(kanas, ['カニガサカ', 'ワサカ']);
});

test('完全一致: 存在しない番号は0件(エラーではない)', () => {
  const r = db.lookupZipcode('0000001');
  assert.equal(r.total, 0);
  assert.equal(r.records.length, 0);
  assert.equal(r.normalized, '0000001');
});

// ---------------------------------------------------------------- 前方一致

test('前方一致: 3桁指定で複数件返り、totalが返却上限と独立に数えられる', () => {
  const r = db.lookupZipcode('060', 5);
  assert.equal(r.records.length, 5);
  assert.equal(r.total > 5, true);
  for (const rec of r.records) assert.equal(rec.zipcode.startsWith('060'), true);
});

test('前方一致: matchTypeの判定材料(normalized長)が正しい', () => {
  const r = db.lookupZipcode('522');
  assert.equal(r.normalized, '522');
});

// ---------------------------------------------------------------- 住所検索

test('住所検索: 漢字の部分一致(銀座)', () => {
  const r = db.searchAddress('銀座');
  assert.equal(r.total > 0, true);
  assert.equal(r.records.some((x) => x.town.includes('銀座')), true);
});

test('住所検索: カナでもヒットする(サッポロ)', () => {
  const r = db.searchAddress('サッポロ');
  assert.equal(r.total > 0, true);
});

test('住所検索: 都道府県+市区町村をまたぐ連結文字列でもヒットする', () => {
  const r = db.searchAddress('滋賀県犬上郡多賀町');
  assert.equal(r.total > 0, true);
  assert.equal(r.records.every((x) => x.city === '犬上郡多賀町'), true);
});

test('住所検索: 0件クエリと空クエリ', () => {
  assert.equal(db.searchAddress('存在しない地名ゾゾゾ').total, 0);
  assert.equal(db.searchAddress('   ').total, 0);
});

test('住所検索: limitが効き、totalは全件数を返す', () => {
  const r = db.searchAddress('町', 10);
  assert.equal(r.records.length, 10);
  assert.equal(r.total > 10, true);
});

// ---------------------------------------------------------------- 性能(§4の目標値)

test('性能: 起動(ロード+索引構築)が1500ms以下(CI安全マージン。設計目標500ms・手元実測246ms)', () => {
  // 初回コールドスタートやCIランナーの速度差で揺れるため、テストの閾値は緩めに置く。
  // 設計目標(500ms)の達成値はREADMEに実測記録する。
  assert.equal(startupMs < 1500, true, `実測 ${startupMs.toFixed(0)}ms`);
});

test('性能: heapUsedが60MB以下', () => {
  const mb = process.memoryUsage().heapUsed / 1024 / 1024;
  assert.equal(mb < 60, true, `実測 ${mb.toFixed(1)}MB`);
});

test('性能: 住所全件走査が300ms以下', () => {
  const t = performance.now();
  db.searchAddress('中央');
  const ms = performance.now() - t;
  assert.equal(ms < 300, true, `実測 ${ms.toFixed(0)}ms`);
});

// ---------------------------------------------------------------- 一次データ照合(公式CSVがある場合のみ全件突合)

const RAW = join(__dirname, '..', 'raw', 'utf_ken_all.csv');

test('一次データ照合: 同梱データの件数・版数のメタ情報', () => {
  assert.equal(db.recordCount > 120000, true);
  assert.equal(typeof db.dataVersion, 'string');
  assert.equal(db.dataVersion.length > 0, true);
});

test('一次データ照合: 公式CSVとの全件突合(raw/がある環境のみ)', { skip: !existsSync(RAW) }, async () => {
  const { validateRows, compile, verifyRoundTrip } = await import('../scripts/build-data.mjs');
  const lines = readFileSync(RAW, 'utf8').split(/\r?\n/).filter((l) => l.length > 0);
  const { rows, errors } = validateRows(lines);
  assert.equal(errors.length, 0);
  const compiled = compile(rows, 'check');
  assert.deepEqual(verifyRoundTrip(rows, compiled), []);
  assert.equal(compiled.records.length, db.recordCount);
});
