// Spotify 搜索/浏览页去「发现新内容」短视频排 +「你可能会喜欢」赞助推广排
// 拦截 /browsita/v1/browse（protobuf），删除命中任一特征的 body 级 section，保留浏览格子/分类卡等其余 section。
//   watch-feed = 发现新内容短视频排
//   0JQ5DApMPy0jM78k6Ozvy5 = mobile-promotion-section（你可能会喜欢/Sponsored recommendation 赞助推广排）的 section 模板 id
// 字节级操作，无需完整 schema；未命中则原样放行。DeckryZ fork 自制。
(() => {
	"use strict";
	const MARKS = [
		[0x77, 0x61, 0x74, 0x63, 0x68, 0x2d, 0x66, 0x65, 0x65, 0x64], // "watch-feed"
		[0x30, 0x4a, 0x51, 0x35, 0x44, 0x41, 0x70, 0x4d, 0x50, 0x79, 0x30, 0x6a, 0x4d, 0x37, 0x38, 0x6b, 0x36, 0x4f, 0x7a, 0x76, 0x79, 0x35], // "0JQ5DApMPy0jM78k6Ozvy5"
	];
	// 读 varint
	const rv = (b, i) => {
		let n = 0, s = 0, x;
		do { x = b[i++]; n += (x & 0x7f) * 2 ** s; s += 7; } while (x & 0x80);
		return [n, i];
	};
	// 写 varint
	const wv = n => {
		const o = [];
		while (n > 0x7f) { o.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); }
		o.push(n & 0x7f);
		return o;
	};
	// 子串包含（在 b 的 [s,e) 内找任一 MARK）
	const has = (b, s, e) => {
		for (const MARK of MARKS) {
			for (let i = s; i <= e - MARK.length; i++) {
				let k = 0;
				while (k < MARK.length && b[i + k] === MARK[k]) k++;
				if (k === MARK.length) return true;
			}
		}
		return false;
	};
	// 遍历字段，返回 [{fn,wt,start,end}]
	const walk = (b, from, to) => {
		let i = from; const out = [];
		while (i < to) {
			const st = i; let tag; [tag, i] = rv(b, i);
			const fn = tag >>> 3, wt = tag & 7;
			if (wt === 0) [, i] = rv(b, i);
			else if (wt === 2) { let ln; [ln, i] = rv(b, i); i += ln; }
			else if (wt === 5) i += 4;
			else if (wt === 1) i += 8;
			else return null; // 未知 wire type → 放弃
			out.push({ fn, wt, st, en: i });
		}
		return out;
	};
	try {
		const body = $response.body;
		if (!body || !body.length) return $done($response);
		// 顶层：field1 = 内容体，其内 field1 = 各 section
		const outer = walk(body, 0, body.length);
		if (!outer) return $done($response);
		let removed = 0;
		const outParts = [];
		for (const f of outer) {
			if (f.fn === 1 && f.wt === 2) {
				// 解析 body payload 起点
				let p = f.st; let tag; [tag, p] = rv(body, p); let ln; [ln, p] = rv(body, p);
				const inner = walk(body, p, f.en);
				if (!inner) { outParts.push(body.subarray(f.st, f.en)); continue; }
				const keptSecs = [];
				for (const s of inner) {
					if (s.fn === 1 && s.wt === 2 && has(body, s.st, s.en)) { removed++; continue; }
					keptSecs.push(body.subarray(s.st, s.en));
				}
				if (removed === 0) { outParts.push(body.subarray(f.st, f.en)); continue; }
				// 重编码 body
				let len = 0; for (const k of keptSecs) len += k.length;
				outParts.push(new Uint8Array([(1 << 3) | 2, ...wv(len)]));
				for (const k of keptSecs) outParts.push(k);
			} else {
				outParts.push(body.subarray(f.st, f.en));
			}
		}
		if (removed === 0) return $done($response); // 未命中，原样放行
		let total = 0; for (const p of outParts) total += p.length;
		const res = new Uint8Array(total);
		let off = 0; for (const p of outParts) { res.set(p, off); off += p.length; }
		$response.body = res;
	} catch (e) {
		// 出错则不改动，避免弄坏页面
	}
	$done($response);
})();
