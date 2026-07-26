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
	// 本地短路开关：删完 kind 后若整个请求已无任何 extension 声明，服务器必定只回 200+空体
	//（抓包 s898 实证 190/190）。此时直接本地合成同样的空响应，省掉一次 HTTPS 往返与 TLS 解密，
	// 每 3 分钟会话约省 200 次射频往返。若怀疑它引起异常，改成 false 即可完全回退。
	// ⚠️ 2026-07-26 实测关闭：打开后「切换至视频」按钮死灰复燃。推断 Loon 不认 http-request 脚本里的
	// response 键，且遇到不认识的键时会忽略整个 $done 对象（连同我们塞进去当保险的 headers/body），
	// 于是转发了原始未删减的请求 → kind 99/136 照常返回 → 按钮回来。
	// 结论：Loon 的 http-request 脚本不能用来合成响应。除非有真机验证的反证，不要再打开。
	const SHORT_CIRCUIT = false;
	const CL = /^content-length$/i; // hoist：避免在 header 循环里反复新建 RegExp
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
		// 空跑一律 $done({})：告诉 Loon「没改」，让它转发原始（仍为 gzip 的）请求体。
		// 若返回 $request，Loon 会把解压后的明文发上行 —— 抓包实测上行从 108KB 涨到 265KB。
		if (!body || !body.length) return $done({});
		// ── 预筛：单遍跳跃扫描找 `08 <目标kind varint>`，未命中立即放行。
		// 实测 484 次调用里 46% 走这条，省掉完整 protobuf 解析。零假阴性：多字节 varint 一律保守判命中。
		let maybe = false;
		for (let i = body.indexOf(8); i >= 0; i = body.indexOf(8, i + 1)) {
			const x = body[i + 1];
			if (x === undefined) break;
			let k;
			if (x < 0x80) k = x;
			else {
				const y = body[i + 2];
				if (y === undefined || y >= 0x80) { maybe = true; break; } // 3 字节以上：保守命中
				k = (x & 0x7f) | (y << 7);
			}
			if (KINDS.has(k)) { maybe = true; break; }
		}
		if (!maybe) return $done({});
		const top = walk(body, 0, body.length);
		if (!top) return $done({});
		let removed = 0, nQuery = 0, keptExt = 0;
		const outParts = [];
		for (const f of top) {
			// query = 顶层 f2 消息（含 uri + 多个 ext）
			if (f.fn === 2 && f.wt === 2) {
				nQuery++;
				let p = f.st; let tag; [tag, p] = rv(body, p); let ln; [ln, p] = rv(body, p);
				const subs = walk(body, p, f.en);
				if (!subs) { outParts.push(body.subarray(f.st, f.en)); keptExt++; continue; } // 解析不了就保守计数，禁止短路
				let localRemoved = 0, qExt = 0;
				const kept = [];
				for (const s of subs) {
					if (s.fn === 2 && s.wt === 2) {
						qExt++;
						if (KINDS.has(kindOf(body, s.st, s.en))) { localRemoved++; removed++; continue; }
					}
					kept.push(body.subarray(s.st, s.en));
				}
				keptExt += qExt - localRemoved;
				if (!localRemoved) { outParts.push(body.subarray(f.st, f.en)); continue; }
				let len = 0; for (const k of kept) len += k.length;
				outParts.push(new Uint8Array([(2 << 3) | 2, ...wv(len)]));
				for (const k of kept) outParts.push(k);
			} else {
				outParts.push(body.subarray(f.st, f.en));
			}
		}
		if (removed === 0) return $done({});
		let total = 0; for (const p of outParts) total += p.length;
		const res = new Uint8Array(total);
		let off = 0; for (const p of outParts) { res.set(p, off); off += p.length; }
		// body 变短，删 Content-Length 让 Loon 按新长度重算，避免服务器按旧长度截断
		if ($request.headers) for (const k of Object.keys($request.headers)) if (CL.test(k)) delete $request.headers[k];
		// 删空了：请求已不含任何 extension 声明 → 本地合成服务器必然返回的 200+空体，省一次往返。
		// ⚠️ 同一个对象里同时带上改写后的 headers/body：万一 Loon 不认 response 键，它会退化成
		// 「转发已删干净的请求」，而不是转发原始请求 —— 后者会让 kind 186 制作人卡、
		// kind 114 艺人页短视频入口静默复活且不报错。两条路径的可观察结果都正确。
		if (SHORT_CIRCUIT && nQuery > 0 && keptExt === 0)
			return $done({ response: { status: 200, headers: { "Content-Type": "application/protobuf" }, body: new Uint8Array(0) }, headers: $request.headers, body: res });
		$request.body = res;
	} catch (e) {}
	$done($request);
})();
