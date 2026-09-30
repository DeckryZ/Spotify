// 🧪 测试（2026-09-30，Spotify 9.0.98）：专辑页短视频按钮（entity explorer）响应侧改写
// 背景：9.0.98 在拿不到 kind 114（EntityExplorerEntrypoint）时，专辑页照样画一个空的 ♩ 按钮
// （抓包 1183：请求侧已删 114，6/6 专辑页仍有 mobile-entity-explorer-button 曝光）。
// 思路：请求侧对专辑放行 114，本脚本把响应里专辑的 114 结果改写成 404（明确告诉客户端「没有短视频」）。
// 响应结构：repeated f2 entry{ f1 header, f2 varint kind, repeated f3 item{ f1 hdr{f1 status, f2 etag, f4 ttl, f5 offline_ttl}, f2 uri, f3 Any } }
// 探针：每次运行都在响应头写 X-DeAd-Meta-Probe，抓包里看得到就说明 Loon 对这个 POST 端点确实跑了响应脚本
// （七月的结论是「不跑」，但当时没专门验证）。测试结束后去掉探针。DeckryZ fork 自制。
(() => {
	"use strict";
	const TARGET = 114;
	const ALBUM = Array.from("spotify:album:", c => c.charCodeAt(0));
	const CL = /^content-length$/i;
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
			if (i > to) return null;
			out.push({ fn, wt, st, en: i });
		}
		return out;
	};
	// 长度前缀字段的 payload 起点（跳过 tag + len）
	const payload = (b, st) => { let p = st; [, p] = rv(b, p); [, p] = rv(b, p); return p; };
	const varintOf = (b, f) => { let p = f.st; [, p] = rv(b, p); return rv(b, p)[0]; };
	const probe = v => {
		const h = $response.headers || {};
		h["X-DeAd-Meta-Probe"] = v;
		return h;
	};
	try {
		const body = $response.body;
		if (!body || !body.length) return $done({ headers: probe("empty") });
		// 预筛：entry 里 kind 114 编码为 `10 72`（f2 varint 114），没有就直接放行
		let maybe = false;
		for (let i = body.indexOf(0x10); i >= 0; i = body.indexOf(0x10, i + 1)) if (body[i + 1] === 0x72) { maybe = true; break; }
		if (!maybe) return $done({ headers: probe("no-114") });
		const top = walk(body, 0, body.length);
		if (!top) return $done({ headers: probe("bad-pb") });
		let rewrote = 0, had = 0;
		const parts = [];
		for (const e of top) {
			const inner = e.fn === 2 && e.wt === 2 ? walk(body, payload(body, e.st), e.en) : null;
			let kind = null;
			if (inner) for (const f of inner) if (f.fn === 2 && f.wt === 0) kind = varintOf(body, f);
			if (kind !== TARGET) { parts.push(body.subarray(e.st, e.en)); continue; }
			const out = [];
			let touched = false;
			for (const f of inner) {
				if (f.fn === 3 && f.wt === 2) {
					const it = walk(body, payload(body, f.st), f.en);
					let uriF = null, status = 0, ttl = 600, off = 2592000;
					if (it) for (const x of it) {
						if (x.fn === 2 && x.wt === 2) uriF = x;
						if (x.fn === 1 && x.wt === 2) {
							const hd = walk(body, payload(body, x.st), x.en) || [];
							for (const y of hd) {
								if (y.wt !== 0) continue;
								if (y.fn === 1) status = varintOf(body, y);
								if (y.fn === 4) ttl = varintOf(body, y);
								if (y.fn === 5) off = varintOf(body, y);
							}
						}
					}
					const up = uriF ? payload(body, uriF.st) : -1;
					if (uriF && up + ALBUM.length <= uriF.en && ALBUM.every((c, i) => body[up + i] === c)) {
						// 合成 404 item：hdr{f1:404, f4:ttl, f5:offline_ttl} + 原 uri 字段，丢弃 etag 与 payload
						const hdr = [0x08, ...wv(404), 0x20, ...wv(ttl), 0x28, ...wv(off)];
						const uriBytes = body.subarray(uriF.st, uriF.en);
						const itemLen = 1 + wv(hdr.length).length + hdr.length + uriBytes.length;
						out.push(new Uint8Array([(3 << 3) | 2, ...wv(itemLen), 0x0a, ...wv(hdr.length), ...hdr]));
						out.push(uriBytes);
						rewrote++; touched = true;
						if (status !== 404) had++;
						continue;
					}
				}
				out.push(body.subarray(f.st, f.en));
			}
			if (!touched) { parts.push(body.subarray(e.st, e.en)); continue; }
			let len = 0; for (const p of out) len += p.length;
			parts.push(new Uint8Array([(2 << 3) | 2, ...wv(len)]));
			for (const p of out) parts.push(p);
		}
		if (!rewrote) return $done({ headers: probe("no-album-114") });
		let total = 0; for (const p of parts) total += p.length;
		const res = new Uint8Array(total);
		let off = 0; for (const p of parts) { res.set(p, off); off += p.length; }
		const h = probe(`rewrote=${rewrote},had-content=${had}`);
		for (const k of Object.keys(h)) if (CL.test(k)) delete h[k];
		$done({ headers: h, body: res });
	} catch (e) {
		$done({ headers: probe("error") });
	}
})();
