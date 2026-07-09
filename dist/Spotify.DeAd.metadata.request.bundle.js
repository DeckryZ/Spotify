// Spotify 艺人页去短视频入口标识（请求侧）
// extended-metadata 是 POST，Loon http-response 脚本对 POST 处理不同 → 改在请求侧动手：
// 请求体用数字 kind id 声明要拉哪些 extension，kind 114 =
// spotify.watchfeedextensions...EntityExplorerEntrypointResponse（艺人页短视频/探索入口）。
// 从每个 query 的 repeated extension 里删掉 kind==114 的声明项，服务器就不再返回该 extension。
// 结构：top = f1(context) + repeated f2(query){ f1:uri, repeated f2:ext{ f1:varint(kind)[, f2:etag] } }。
// 删 ext 后需重算所在 query 的长度前缀。未命中则原样放行。DeckryZ fork 自制。
(() => {
	"use strict";
	const KIND = 114;
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
	// 读一个 ext 子消息的 kind（其 f1 varint）
	const kindOf = (b, st, en) => {
		let p = st; let tag; [tag, p] = rv(b, p); let ln; [ln, p] = rv(b, p); // 跳过 ext 的 tag+len
		const inner = walk(b, p, en);
		if (!inner) return null;
		for (const f of inner) if (f.fn === 1 && f.wt === 0) { const [v] = rv(b, f.st + 1); return v; }
		return null;
	};
	try {
		const body = $request.body;
		if (!body || !body.length) return $done($request);
		const top = walk(body, 0, body.length);
		if (!top) return $done($request);
		let removed = 0;
		const outParts = [];
		for (const f of top) {
			// query = 顶层 f2 消息（含 uri + 多个 ext）
			if (f.fn === 2 && f.wt === 2) {
				let p = f.st; let tag; [tag, p] = rv(body, p); let ln; [ln, p] = rv(body, p);
				const subs = walk(body, p, f.en);
				if (!subs) { outParts.push(body.subarray(f.st, f.en)); continue; }
				let localRemoved = 0;
				const kept = [];
				for (const s of subs) {
					if (s.fn === 2 && s.wt === 2 && kindOf(body, s.st, s.en) === KIND) { localRemoved++; removed++; continue; }
					kept.push(body.subarray(s.st, s.en));
				}
				if (!localRemoved) { outParts.push(body.subarray(f.st, f.en)); continue; }
				let len = 0; for (const k of kept) len += k.length;
				outParts.push(new Uint8Array([(2 << 3) | 2, ...wv(len)]));
				for (const k of kept) outParts.push(k);
			} else {
				outParts.push(body.subarray(f.st, f.en));
			}
		}
		if (removed === 0) return $done($request);
		let total = 0; for (const p of outParts) total += p.length;
		const res = new Uint8Array(total);
		let off = 0; for (const p of outParts) { res.set(p, off); off += p.length; }
		// body 变短，删 Content-Length 让 Loon 按新长度重算，避免服务器按旧长度截断
		if ($request.headers) for (const k of Object.keys($request.headers)) if (/^content-length$/i.test(k)) delete $request.headers[k];
		$request.body = res;
	} catch (e) {}
	$done($request);
})();
