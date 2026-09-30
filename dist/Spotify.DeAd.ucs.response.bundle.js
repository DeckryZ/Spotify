// 🧪 测试（2026-09-30，Spotify 9.0.98）：改远程功能开关，尝试去掉专辑页短视频按钮（entity explorer）
// 抓包 1185 已证实 9.0.98 的按钮与 kind 114 无关（服务器明确回 404 照样画）。
// 唯一候选开关：ios-album-albumfeatureproperties-impl / album_redirect_to_cdp_enabled = true
//   （专辑跳到新式 creative-work-page，按钮就是在这个页面上曝光的）→ 改成 false，看专辑页是否回到老样式、按钮消失。
// 开关来自 bootstrap/v1/bootstrap 与 user-customization-service/v1/customize 两个 POST 响应（UCS assignments）。
// 结构：assignment{ f1 key{f1 component, f2 property}, [f2 实验信息], f3 bool{f1 varint} }，字段顺序可能被其他插件重排，
// 所以按结构逐层定位到该 assignment，再把 f3 里的 varint 1 原地改成 0 —— 长度不变，不重编码，其余字节不动。
// 未命中/解析失败原样放行。探针头 X-DeAd-UCS 记录结果，测试结束后去掉。DeckryZ fork 自制。
(() => {
	"use strict";
	const enc = s => Array.from(s, c => c.charCodeAt(0));
	const FLIPS = [
		["ios-album-albumfeatureproperties-impl", "album_redirect_to_cdp_enabled"],
	].map(([c, p]) => ({ comp: enc(c), prop: enc(p), name: p }));
	const rv = (b, i) => {
		let n = 0, s = 0, x;
		do { x = b[i++]; n += (x & 0x7f) * 2 ** s; s += 7; } while (x & 0x80);
		return [n, i];
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
	const payload = (b, st) => { let p = st; [, p] = rv(b, p); [, p] = rv(b, p); return p; };
	const eq = (b, at, arr) => at >= 0 && at + arr.length <= b.length && arr.every((c, i) => b[at + i] === c);
	const find = (b, arr, from) => {
		for (let i = b.indexOf(arr[0], from); i >= 0; i = b.indexOf(arr[0], i + 1)) if (eq(b, i, arr)) return i;
		return -1;
	};
	// 从顶层逐层下钻到「直接子字段起始于 target」的那条消息（即 assignment），返回其字段表
	const locate = (b, target) => {
		let st = 0, en = b.length;
		for (let depth = 0; depth < 16; depth++) {
			const fs = walk(b, st, en);
			if (!fs) return null;
			let next = null;
			for (const f of fs) {
				if (f.st === target) return fs;
				if (f.wt === 2) {
					const p = payload(b, f.st);
					if (p <= target && target < f.en) { next = [p, f.en]; break; }
				}
			}
			if (!next) return null;
			[st, en] = next;
		}
		return null;
	};
	const probe = v => { const h = $response.headers || {}; h["X-DeAd-UCS"] = v; return h; };
	try {
		const body = $response.body;
		if (!body || !body.length) return $done({ headers: probe("empty") });
		const log = [];
		let flipped = 0;
		for (const F of FLIPS) {
			// key 消息字节：0a L 0a Lc <comp> 12 Lp <prop>（名字都 < 128 字节，长度各 1 字节）
			const inner = [0x0a, F.comp.length, ...F.comp, 0x12, F.prop.length, ...F.prop];
			const key = [0x0a, inner.length, ...inner];
			let hit = false;
			for (let at = find(body, key, 0); at >= 0; at = find(body, key, at + 1)) {
				const fs = locate(body, at);
				if (!fs) continue;
				const val = fs.find(f => f.fn === 3 && f.wt === 2);
				if (!val) { log.push(F.name + ":no-value"); hit = true; continue; }
				const vf = walk(body, payload(body, val.st), val.en) || [];
				const bit = vf.find(f => f.fn === 1 && f.wt === 0);
				hit = true;
				if (!bit) { log.push(F.name + ":already-false"); continue; }
				const pos = bit.st + 1; // tag 0x08 占 1 字节
				if (body[pos] === 1) { body[pos] = 0; flipped++; log.push(F.name + ":1->0"); }
				else log.push(F.name + ":value=" + body[pos]);
			}
			if (!hit) log.push(F.name + ":not-found");
		}
		if (!flipped) return $done({ headers: probe(log.join(",")) });
		$done({ headers: probe(log.join(",")), body });
	} catch (e) {
		$done({ headers: probe("error") });
	}
})();
