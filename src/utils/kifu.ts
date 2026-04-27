import { Buffer } from 'buffer';
import type { GameState, Move } from '../types';

function letterForX(x: number): string {
  // Map 0..18 -> A..S
  return String.fromCharCode('A'.charCodeAt(0) + x);
}

function sanitizeFilename(s: string): string {
  return s.replace(/[\\/:*?"<>|]/g, '-');
}

export interface KifuMeta {
  blackTeam: string; // 先手队名
  whiteTeam: string; // 后手队名
  timePlace: string; // 比赛时间及地点
  event: string; // 赛事名称
}

export function generateKifuString(
  state: GameState,
  meta: KifuMeta,
  moves: Move[],
): string {
  const headerParts: string[] = [];
  headerParts.push('C6');
  headerParts.push(meta.blackTeam || '先手参赛队');
  headerParts.push(meta.whiteTeam || '后手参赛队');

  let resultLabel = '未完';
  if (state.winner === 'BLACK') resultLabel = '先手胜';
  else if (state.winner === 'WHITE') resultLabel = '后手胜';
  else if (state.winner === 'DRAW') resultLabel = '和局';
  headerParts.push(resultLabel);

  headerParts.push(meta.timePlace || '');
  headerParts.push(meta.event || '');

  const header = '[' + headerParts.join('][') + ']';

  // moves 序列，使用分号分隔；第一分号前为 header，随后为每手
  const moveEntries: string[] = [];
  for (const m of moves) {
    const color = m.player === 'BLACK' ? 'B' : 'W';
    // 每个手内可能有 1 或 2 个位置
    for (const pos of m.positions) {
      const xLetter = letterForX(pos.x);
      const yNum = pos.y + 1; // 1-based
      moveEntries.push(`${color}(${xLetter},${yNum})`);
    }
  }

  const body = moveEntries.join(';');
  // 全部用英文定界符，按要求包在 { }
  return `{${header};${body}}`;
}

export function buildFilename(state: GameState, meta: KifuMeta): string {
  const black = meta.blackTeam || 'B';
  const white = meta.whiteTeam || 'W';
  let resultLabel = '未完';
  if (state.winner === 'BLACK') resultLabel = '先手胜';
  else if (state.winner === 'WHITE') resultLabel = '后手胜';
  else if (state.winner === 'DRAW') resultLabel = '和局';

  const parts = [
    'C6',
    `${black} B vs ${white} W`,
    resultLabel,
    meta.timePlace || '',
    meta.event || '',
  ];

  const raw = parts.filter(p => p && p.length > 0).join('-');
  // Append a timestamp to allow multiple saves without name collision
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(
    now.getDate(),
  )}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return sanitizeFilename(`${raw}-${ts}`) + '.txt';
}

export async function saveKifuTextToFile(filename: string, text: string) {
  // First try to POST to a local helper server (node script) that can write to Desktop.
  try {
    const serverUrl =
      (window as any).__KIFU_SERVER_URL__ ?? 'http://localhost:3001/save-kifu';
    const resp = await fetch(serverUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename, text }),
    });
    if (resp.ok) {
      try {
        const j = await resp.json();
        if (j && j.ok) {
          // saved by server
          alert('棋谱已保存到桌面/game records：' + j.path);
          return;
        }
      } catch {
        // ignore parse error and fall back
      }
    }
  } catch (e) {
    // server not available -> fallback
    console.warn('Kifu server not available, falling back to download', e);
  }

  // Try iconv-lite to generate GB2312/GBK bytes in-browser.
  try {
    if (!(globalThis as any).Buffer) {
      (globalThis as any).Buffer = Buffer;
    }
    const iconvModule = await import('iconv-lite');
    const iconv = (iconvModule as any).default ?? iconvModule;
    const enc =
      iconv.encodingExists && iconv.encodingExists('gb2312') ? 'gb2312' : 'gbk';
    const buf: Uint8Array = iconv.encode(text, enc);
    const blob = new Blob([buf as any], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    return;
  } catch (e) {
    console.warn(
      'iconv-lite encode failed; falling back to charset-hint blob',
      e,
    );
  }

  // Final fallback: create a text blob with charset hint. Not guaranteed to produce GB2312 bytes.
  const blob = new Blob([text], { type: 'text/plain;charset=gb2312' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
