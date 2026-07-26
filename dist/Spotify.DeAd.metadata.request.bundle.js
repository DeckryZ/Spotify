// Spotify 艺人页去短视频入口标识（请求侧）
// extended-metadata 是 POST，Loon http-response 脚本对 POST 处理不同 → 改在请求侧动手：
// 请求体用数字 kind id 声明要拉哪些 extension：
//   kind 114 = watchfeedextensions...EntityExplorerEntrypointResponse（artist/playlist 短视频/探索入口）
//   kind 226 = ...WatchFeedSeedItemTrait（watchfeed 种子项，playlist 请求）
//   kind 186 = CreditsTrait（播放页「制作人」卡；每首歌单独请求，不走 scrollsita section，删 section 无效，必须从这里删）
//   kind 99  = spotify.bumblebee.video_associations.v1.VideoAssociations（曲目↔音乐视频关联表）
//              有 MV 的歌返回 200+约139字节（内含 MV 轨 URI），无 MV 的歌返回 404 空体。
//              抓包统计(s883)：156 首被查询曲目中 26 首 200 / 130 首 404，与"哪些歌有 MV"一致。
//              该 kind 常与 kind 10(Track) 打包请求，本脚本按 kind 逐条删，不影响 Track 元数据。
//   kind 136 = spotify.playback_platform.transition.v1.TransitionMaps（音频↔视频配对表）
//              ★ 这才是「切换至视频」按钮的真正来源：客户端用 uri=spotify:audio:<base62(original_audio.uuid)>
//              查询它，响应返回配对的 video gid → 客户端存为 PlayerState.ProvidedTrack 的 associated_video_id
//              → 有 avid 才显示按钮。抓包实证(s886)：Tears 的 136 响应返回 a0c1baaa25454aad994e445f655992f8，
//              该 gid 一字不差出现在随后的 connect-state avid 里；而无按钮的 When Did You Get Hot? 既无 136
//              请求也无 avid。kind 136 仅用于 spotify:audio: 实体且该 query 只含这一个 kind，删除零附带影响。
//   kind 249 = ContentExperienceTrait（曾误判为按钮来源，实为样本标注错误所致；保留删除，无害）
// 从每个 query 的 repeated extension 里删掉这些 kind 的声明项，服务器就不再返回它们。
// 结构：top = f1(context) + repeated f2(query){ f1:uri, repeated f2:ext{ f1:varint(kind)[, f2:etag] } }。
// 删 ext 后需重算所在 query 的长度前缀。未命中则原样放行。DeckryZ fork 自制。
(() => {
	"use strict";
	const KINDS = new Set([99, 114, 136, 186, 226, 249]);
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
					if (s.fn === 2 && s.wt === 2 && KINDS.has(kindOf(body, s.st, s.en))) { localRemoved++; removed++; continue; }
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
