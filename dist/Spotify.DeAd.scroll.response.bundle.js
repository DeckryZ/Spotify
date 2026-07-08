// Spotify 播放页只留歌词：从 /scrollsita/v1/scroll 删除「关于艺人/相似艺人/制作人/探索」等 section，保留歌词锚点 section
// 规则：删除引用了 spotify:artist:（关于艺人/相似艺人/制作人）或属 explore 族（section id 前缀 0JQ5DABRtFWApcy，短视频）的 section；
// 仅引用当前 track、无艺人的 section（歌词模块锚点）保留，以维持播放页滚动布局不塌。
// 字节级操作，无需完整 schema；解析失败或无可删项则原样放行。DeckryZ fork 自制。
(() => {
	"use strict";
	const ARTIST = [0x73, 0x70, 0x6f, 0x74, 0x69, 0x66, 0x79, 0x3a, 0x61, 0x72, 0x74, 0x69, 0x73, 0x74, 0x3a]; // "spotify:artist:"
	const EXPLORE = [0x30, 0x4a, 0x51, 0x35, 0x44, 0x41, 0x42, 0x52, 0x74, 0x46, 0x57, 0x41, 0x70, 0x63, 0x79]; // "0JQ5DABRtFWApcy"
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
	const contains = (b, s, e, pat) => {
		for (let i = s; i <= e - pat.length; i++) {
			let k = 0;
			while (k < pat.length && b[i + k] === pat[k]) k++;
			if (k === pat.length) return true;
		}
		return false;
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
					if (s.fn === 1 && s.wt === 2 && (contains(body, s.st, s.en, ARTIST) || contains(body, s.st, s.en, EXPLORE))) { removed++; continue; }
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
