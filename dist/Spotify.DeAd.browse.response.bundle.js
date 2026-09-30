// Spotify 主页 + 搜索/浏览页去广告/推广 section
// 拦截 /casita/v1/home（主页）与 /browsita/v1/browse（搜索页），两者均为 protobuf，结构相同：
// 顶层 field1 = 内容体，其内 repeated field1 = 各 section。删除命中任一特征的 section，其余保留。
//   watch-feed             = 搜索页「发现新内容」短视频排
//   0JQ5DApMPy0jM78k6Ozvy5 = mobile-promotion-section（搜索页「你可能会喜欢」/Sponsored recommendation 赞助推广排）
//   0JQ5DApMPy0jM78k6Ozvy9 = 主页 brand-ad（hpto 首页大图/视频广告卡，快捷方式网格下方，抓包 1182 确认）
//   0JQ5DApMPy0jM78k6Ozvyb = 搜索页 brand-ads-browse（搜索页顶部品牌广告卡，抓包 1182 确认）
//   aet.spotify.com/v2/t   = 广告事件追踪 beacon，只出现在广告 payload 里；兜底将来换了 section id 的新广告位
// 安全阀：若某内容体的 section 会被全部删光，则该内容体原样保留，避免页面整片空白。
// 字节级操作，无需完整 schema；未命中则原样放行。DeckryZ fork 自制。
(() => {
	"use strict";
	const enc = s => Array.from(s, c => c.charCodeAt(0));
	const MARKS = [
		"watch-feed",
		"0JQ5DApMPy0jM78k6Ozvy5",
		"0JQ5DApMPy0jM78k6Ozvy9",
		"0JQ5DApMPy0jM78k6Ozvyb",
		"aet.spotify.com/v2/t",
	].map(enc);
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
	// 遍历字段，返回 [{fn,wt,start,end}]；越界或未知 wire type 返回 null
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
			if (i > to) return null;
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
		const outParts = [];
		for (const f of outer) {
			if (f.fn !== 1 || f.wt !== 2) { outParts.push(body.subarray(f.st, f.en)); continue; }
			// 解析内容体 payload 起点
			let p = f.st; [, p] = rv(body, p); [, p] = rv(body, p);
			const inner = walk(body, p, f.en);
			if (!inner) { outParts.push(body.subarray(f.st, f.en)); continue; }
			const keptSecs = [];
			let secs = 0, hit = 0;
			for (const s of inner) {
				if (s.fn === 1 && s.wt === 2) {
					secs++;
					if (has(body, s.st, s.en)) { hit++; continue; }
				}
				keptSecs.push(body.subarray(s.st, s.en));
			}
			// 未命中，或会删光所有 section（安全阀）→ 原样保留
			if (hit === 0 || hit === secs) { outParts.push(body.subarray(f.st, f.en)); continue; }
			removed += hit;
			// 重编码内容体
			let len = 0; for (const k of keptSecs) len += k.length;
			outParts.push(new Uint8Array([(1 << 3) | 2, ...wv(len)]));
			for (const k of keptSecs) outParts.push(k);
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
