// Spotify 歌单去「受推广影响」标签
// 拦截 /playlist/v2/playlist/{id}（含 /diff），protobuf。
// 个性化合辑（每日推荐 daily-mix / 流行合辑、年代合辑 topic-mix 等）的歌单属性里带
//   should_show_promo_disclosure = true
// 客户端据此给该歌单播放的每首歌显示「受推广影响」标签（gabo: mobile-now-playing-promotional-label）。
// 这是整张歌单的统一披露，服务器不标具体哪首是推广（抓包 1219：6 张合辑 300 首，逐首属性完全一致，
// contextualflair Badge 全为空）→ 只能去标签，去不掉歌。
// 做法：属性键原地改名（等长，不重编码），客户端找不到该键 → 按默认不显示。
// 匹配 `0a 1c` + 键名（属性 entry 的 field1 字符串、长度 28），确保命中的是键而非简介文本。
// 未命中原样放行。DeckryZ fork 自制。
(() => {
	"use strict";
	const enc = s => Array.from(s, c => c.charCodeAt(0));
	const KEY = enc("should_show_promo_disclosure");
	const NEW = enc("deckry_hide_promo_disclosure"); // 必须与 KEY 等长
	const MARK = [0x0a, KEY.length, ...KEY];
	try {
		const body = $response.body;
		if (!body || !body.length || NEW.length !== KEY.length) return $done($response);
		let hit = 0;
		for (let i = 0; i <= body.length - MARK.length; i++) {
			if (body[i] !== 0x0a) continue;
			let k = 1;
			while (k < MARK.length && body[i + k] === MARK[k]) k++;
			if (k !== MARK.length) continue;
			body.set(NEW, i + 2);
			hit++;
			i += MARK.length - 1;
		}
		if (hit === 0) return $done($response); // 非合辑歌单，原样放行
		$response.body = body;
	} catch (e) {
		// 出错则不改动，避免弄坏歌单
	}
	$done($response);
})();
