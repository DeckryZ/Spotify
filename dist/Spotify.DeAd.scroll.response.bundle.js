// Spotify 播放页精简 /scrollsita/v1/scroll 的 section，双模式：
//   有歌词锚点 section（仅引用 track、无 artist、非 explore 族）→ 只保留它（播放页只剩歌词）
//   无歌词锚点（该曲无歌词，Spotify 不下发歌词 section）→ 只保留「关于艺人」（模板 id 0JQ5DB6s3cssW5Bo6cGq1L 精准匹配；缺失时退回 artist 数最少的非 explore section）
// 删除对象：制作人（Gq1O）、相似艺人（多 artist）、探索（explore 族 0JQ5DABRtFWApcy 前缀）等。字节级操作，解析失败或无可删则原样放行。DeckryZ fork 自制。
(() => {
	"use strict";
	const ARTIST = [0x73, 0x70, 0x6f, 0x74, 0x69, 0x66, 0x79, 0x3a, 0x61, 0x72, 0x74, 0x69, 0x73, 0x74, 0x3a]; // "spotify:artist:"
	const EXPLORE = [0x30, 0x4a, 0x51, 0x35, 0x44, 0x41, 0x42, 0x52, 0x74, 0x46, 0x57, 0x41, 0x70, 0x63, 0x79]; // "0JQ5DABRtFWApcy"
	const ABOUT = [0x30, 0x4a, 0x51, 0x35, 0x44, 0x42, 0x36, 0x73, 0x33, 0x63, 0x73, 0x73, 0x57, 0x35, 0x42, 0x6f, 0x36, 0x63, 0x47, 0x71, 0x31, 0x4c]; // "0JQ5DB6s3cssW5Bo6cGq1L" 关于艺人模板 id
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
	const count = (b, s, e, pat) => {
		let c = 0;
		for (let i = s; i <= e - pat.length; i++) {
			let k = 0;
			while (k < pat.length && b[i + k] === pat[k]) k++;
			if (k === pat.length) { c++; i += pat.length - 1; }
		}
		return c;
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
	// 禁止客户端缓存 scrollsita：默认 cache-control: private, max-age=600 会让客户端 10 分钟内
	// 直接用本地旧缓存渲染播放页——若旧缓存是插件生效前的原始数据，会残留制作人/相似艺人排。
	// 改 no-store 后客户端每次进播放页都重新拉取，必经本脚本处理。
	if ($response.headers) {
		for (const k of Object.keys($response.headers)) if (/^cache-control$/i.test(k)) delete $response.headers[k];
		$response.headers["Cache-Control"] = "no-store";
	}
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
				// 归类每个 section
				const secs = [];
				const nonSecs = [];
				for (const s of inner) {
					if (s.fn === 1 && s.wt === 2) {
						secs.push({ s, artists: count(body, s.st, s.en, ARTIST), explore: count(body, s.st, s.en, EXPLORE) > 0, about: count(body, s.st, s.en, ABOUT) > 0 });
					} else nonSecs.push(s);
				}
				// 选出要保留的 section
				const lyrics = secs.filter(x => !x.explore && x.artists === 0);
				let keepSet;
				if (lyrics.length) {
					keepSet = new Set(lyrics.map(x => x.s));
				} else {
					const about = secs.filter(x => x.about);
					if (about.length) keepSet = new Set(about.map(x => x.s));
					else {
						const artistSecs = secs.filter(x => !x.explore && x.artists > 0).sort((a, b) => a.artists - b.artists);
						keepSet = new Set(artistSecs.length ? [artistSecs[0].s] : (secs[0] ? [secs[0].s] : []));
					}
				}
				const kept = [];
				for (const s of inner) {
					const isSec = s.fn === 1 && s.wt === 2;
					if (isSec && !keepSet.has(s)) { removed++; continue; }
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
