// Spotify 播放页只留歌词：清空 /scrollsita/v1/scroll 的所有 section
// 播放页歌词下方的「制作人 / 关于艺人 / 相似艺人 / 活动」等板块由 scrollsita 下发（protobuf），
// 删除 body 内全部 field-1 section，仅保留外层结构 → 下方板块全部消失，歌词面板（独立 color-lyrics）不受影响。
// 字节级操作，无需完整 schema；解析失败则原样放行。DeckryZ fork 自制。
(() => {
	"use strict";
	const rv = (b, i) => {
		let n = 0, s = 0, x;
		do { x = b[i++]; n += (x & 0x7f) * 2 ** s; s += 7; } while (x & 0x80);
		return [n, i];
	};
	const wv = n => {
		const o = [];
		while (n > 0x7f) { o.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); }
		o.push(n & 0x7f);
		return o;
	};
	const walk = (b, from, to) => {
		let i = from; const out = [];
		while (i < to) {
			const st = i; let tag; [tag, i] = rv(b, i);
			const fn = tag >>> 3, wt = tag & 7;
			if (wt === 0) [, i] = rv(b, i);
			else if (wt === 2) { let ln; [ln, i] = rv(b, i); i += ln; }
			else if (wt === 5) i += 4;
			else if (wt === 1) i += 8;
			else return null;
			out.push({ fn, wt, st, en: i });
		}
		return out;
	};
	try {
		const body = $response.body;
		if (!body || !body.length) return $done($response);
		const outer = walk(body, 0, body.length);
		if (!outer) return $done($response);
		let removed = 0;
		const parts = [];
		for (const f of outer) {
			if (f.fn === 1 && f.wt === 2) {
				let p = f.st; let tag; [tag, p] = rv(body, p); let ln; [ln, p] = rv(body, p);
				const inner = walk(body, p, f.en);
				if (!inner) { parts.push(body.subarray(f.st, f.en)); continue; }
				const kept = [];
				for (const s of inner) {
					if (s.fn === 1 && s.wt === 2) { removed++; continue; } // 删所有 section
					kept.push(body.subarray(s.st, s.en));
				}
				if (removed === 0) { parts.push(body.subarray(f.st, f.en)); continue; }
				let len = 0; for (const k of kept) len += k.length;
				parts.push(new Uint8Array([(1 << 3) | 2, ...wv(len)]));
				for (const k of kept) parts.push(k);
			} else {
				parts.push(body.subarray(f.st, f.en));
			}
		}
		if (removed === 0) return $done($response);
		let total = 0; for (const p of parts) total += p.length;
		const res = new Uint8Array(total);
		let off = 0; for (const p of parts) { res.set(p, off); off += p.length; }
		$response.body = res;
	} catch (e) {}
	$done($response);
})();
