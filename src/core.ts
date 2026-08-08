/**
 * jp-postal-mcp-server — コアロジック(データロード・検索)
 * 完全オフライン・読み取り専用。判断はLLMに委ね、ツールは事実のみを返す。
 */

import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

// compiled.json.gz のレコード形式:
// [zip, prefId, cityId, town, kana, flags, note?, noteType?]
type RawRecord = [string, number, number, string, string, number, string?, string?];

export interface CompiledData {
  format: number;
  source: string;
  dataVersion: string;
  generatedAt: string;
  recordCount: number;
  prefs: [string, string][];          // [漢字, カナ]
  cities: [string, string, string][]; // [JISコード, 漢字, カナ]
  records: RawRecord[];
}

export interface PostalRecord {
  zipcode: string;
  jisCode: string;
  prefecture: string;
  prefectureKana: string;
  city: string;
  cityKana: string;
  town: string;
  townKana: string;
  note: string | null;
  noteType: string | null;
  catchAll: boolean;        // 「以下に掲載がない場合」
  directNumbering: boolean; // 「○○の次に番地がくる場合」
  wholeArea: boolean;       // 「○○一円」
  oneZipManyTowns: boolean; // 公式フラグ列13: 1つの郵便番号で2以上の町域を表す
  oneTownManyZips: boolean; // 公式フラグ列10: 1つの町域が2以上の郵便番号で表される
}

const FLAG = {
  oneTownManyZips: 1,       // bit0 (公式列10)
  koaza: 2,                 // bit1 (公式列11)
  hasChome: 4,              // bit2 (公式列12)
  oneZipManyTowns: 8,       // bit3 (公式列13)
  catchAll: 1 << 9,
  directNumbering: 1 << 10,
  wholeArea: 1 << 11,
} as const;

export class PostalDb {
  private data: CompiledData;
  private zipIndex: Map<string, number[]>;

  constructor(compiledGzPath: string) {
    const gz = readFileSync(compiledGzPath);
    this.data = JSON.parse(gunzipSync(gz).toString('utf8')) as CompiledData;
    this.zipIndex = new Map();
    for (let i = 0; i < this.data.records.length; i++) {
      const zip = this.data.records[i][0];
      const arr = this.zipIndex.get(zip);
      if (arr) arr.push(i);
      else this.zipIndex.set(zip, [i]);
    }
  }

  get dataVersion(): string {
    return this.data.dataVersion;
  }

  get recordCount(): number {
    return this.data.recordCount;
  }

  private toRecord(i: number): PostalRecord {
    const [zip, pi, ci, town, kana, flags, note, noteType] = this.data.records[i];
    const [pref, prefKana] = this.data.prefs[pi];
    const [jis, city, cityKana] = this.data.cities[ci];
    return {
      zipcode: zip,
      jisCode: jis,
      prefecture: pref,
      prefectureKana: prefKana,
      city,
      cityKana,
      town,
      townKana: kana,
      note: note ?? null,
      noteType: noteType ?? null,
      catchAll: (flags & FLAG.catchAll) !== 0,
      directNumbering: (flags & FLAG.directNumbering) !== 0,
      wholeArea: (flags & FLAG.wholeArea) !== 0,
      oneZipManyTowns: (flags & FLAG.oneZipManyTowns) !== 0,
      oneTownManyZips: (flags & FLAG.oneTownManyZips) !== 0,
    };
  }

  /**
   * 郵便番号の正規化: ハイフン・空白の除去、全角数字→半角。
   * 3〜7桁の数字列にならなければ null。
   */
  static normalizeZip(input: string): string | null {
    const s = input
      .replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0))
      .replace(/[-‐‑–—−ー〒\s]/g, '');
    if (!/^\d{3,7}$/.test(s)) return null;
    return s;
  }

  /** 郵便番号検索。7桁は完全一致、3〜6桁は前方一致。 */
  lookupZipcode(input: string, limit = 50): { normalized: string | null; total: number; records: PostalRecord[] } {
    const zip = PostalDb.normalizeZip(input);
    if (zip === null) return { normalized: null, total: 0, records: [] };

    if (zip.length === 7) {
      const idxs = this.zipIndex.get(zip) ?? [];
      return { normalized: zip, total: idxs.length, records: idxs.slice(0, limit).map((i) => this.toRecord(i)) };
    }

    // 前方一致(3〜6桁): 全件走査(検証Bにより十分速い)
    const out: number[] = [];
    let total = 0;
    for (let i = 0; i < this.data.records.length; i++) {
      if (this.data.records[i][0].startsWith(zip)) {
        total++;
        if (out.length < limit) out.push(i);
      }
    }
    return { normalized: zip, total, records: out.map((i) => this.toRecord(i)) };
  }

  /** 住所の部分一致検索。漢字・カナのどちらにもマッチ。全件走査。 */
  searchAddress(query: string, limit = 50): { total: number; records: PostalRecord[] } {
    const q = query.trim();
    if (q.length === 0) return { total: 0, records: [] };
    const out: number[] = [];
    let total = 0;
    const { records, prefs, cities } = this.data;
    for (let i = 0; i < records.length; i++) {
      const [, pi, ci, town, kana] = records[i];
      const [pref, prefKana] = prefs[pi];
      const [, city, cityKana] = cities[ci];
      if (
        town.includes(q) || city.includes(q) || pref.includes(q) ||
        kana.includes(q) || cityKana.includes(q) || prefKana.includes(q) ||
        (pref + city + town).includes(q)
      ) {
        total++;
        if (out.length < limit) out.push(i);
      }
    }
    return { total, records: out.map((i) => this.toRecord(i)) };
  }
}
