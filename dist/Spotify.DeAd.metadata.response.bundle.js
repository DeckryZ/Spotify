// Spotify 艺人页去短视频入口标识
// 拦截 /extended-metadata/v0/extended-metadata（protobuf，通用批量端点），仅删除含
// spotify.watchfeedextensions...EntityExplorerEntrypointResponse 的顶层 entry（艺人页短视频/探索入口），
// 其余 entry（热门歌曲/相关艺人/演唱会/精选歌单等）原样保留。
// 顶层为并列 repeated field-2，删整段拼接剩余，无 length 包裹、零重编码风险。
// 未命中（如 track/album 的 extended-metadata 不含该 extension）则原样放行。DeckryZ fork 自制。
(() => {
	"use strict";
	const MARK = [0x45, 0x6e, 0x74, 0x69, 0x74, 0x79, 0x45, 0x78, 0x70, 0x6c, 0x6f, 0x72, 0x65, 0x72, 0x45, 0x6e, 0x74, 0x72, 0x79, 0x70, 0x6f, 0x69, 0x6e, 0x74]; // "EntityExplorerEntrypoint"
	const rv = (b, i) => {
		let n = 0, s = 0, x;
		do { x = b[i++]; n += (x & 0x7f) * 2 ** s; s += 7; } while (x & 0x80);
		return [n, i];
	};
	const has = (b, s, e) => {
		for (let i = s; i <= e - MARK.length; i++) {
			let k = 0;
			while (k < MARK.length && b[i + k] === MARK[k]) k++;
			if (k === MARK.length) return true;
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
		// 高频端点：绝大多数 extended-metadata 是 track/album 元数据、不含短视频入口，先整体扫一遍特征，无则立即放行，省去 walk
		if (!has(body, 0, body.length)) return $done($response);
		const fields = walk(body, 0, body.length);
		if (!fields) return $done($response);
		let removed = 0;
		const parts = [];
		for (const f of fields) {
			if (f.fn === 2 && f.wt === 2 && has(body, f.st, f.en)) { removed++; continue; }
			parts.push(body.subarray(f.st, f.en));
		}
		if (removed === 0) return $done($response);
		let total = 0; for (const p of parts) total += p.length;
		const res = new Uint8Array(total);
		let off = 0; for (const p of parts) { res.set(p, off); off += p.length; }
		$response.body = res;
	} catch (e) {}
	$done($response);
})();
