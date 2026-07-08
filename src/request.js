import { $app, Console, done, fetch, Lodash as _, Storage } from "@nsnanocat/util";
import database from "./function/database.mjs";
import setENV from "./function/setENV.mjs";
import setCache from "./function/setCache.mjs";
// 构造回复数据
// biome-ignore lint/style/useConst: <explanation>
let $response = undefined;
/***************** Processing *****************/
// 解构URL
const url = new URL($request.url);
Console.info(`url: ${url.toJSON()}`);
// 获取连接参数
const PATHs = url.pathname.split("/").filter(Boolean);
Console.info(`PATHs: ${PATHs}`);
// 解析格式
const FORMAT = ($request.headers?.["Content-Type"] ?? $request.headers?.["content-type"])?.split(";")?.[0];
Console.info(`FORMAT: ${FORMAT}`);
!(async () => {
	/**
	 * 设置
	 * @type {{Settings: import('./types').Settings}}
	 */
	const { Settings, Caches, Configs } = setENV("DualSubs", "Spotify", database);
	Console.logLevel = Settings.LogLevel;
	// 获取字幕类型与语言
	const Type = url.searchParams.get("subtype") ?? Settings.Type;
	const Languages = [url.searchParams.get("lang")?.toUpperCase?.() ?? Settings.Languages[0], (url.searchParams.get("tlang") ?? Caches?.tlang)?.toUpperCase?.() ?? Settings.Languages[1]];
	Console.info(`Type: ${Type}`, `Languages: ${Languages}`);
	// 创建空数据
	let body = {};
	// 方法判断
	switch ($request.method) {
		case "POST":
		case "PUT":
		case "PATCH":
		// biome-ignore lint/suspicious/noFallthroughSwitchClause: <explanation>
		case "DELETE":
			// 格式判断
			switch (FORMAT) {
				case undefined: // 视为无body
					break;
				case "application/x-www-form-urlencoded":
				case "text/plain":
				default:
					break;
				case "application/x-mpegURL":
				case "application/x-mpegurl":
				case "application/vnd.apple.mpegurl":
				case "audio/mpegurl":
					break;
				case "text/xml":
				case "text/html":
				case "text/plist":
				case "application/xml":
				case "application/plist":
				case "application/x-plist":
					break;
				case "text/vtt":
				case "application/vtt":
					break;
				case "text/json":
				case "application/json":
					break;
				case "application/protobuf":
				case "application/x-protobuf":
				case "application/vnd.google.protobuf":
				case "application/grpc":
				case "application/grpc+proto":
				case "application/octet-stream": {
					let rawBody = $app === "Quantumult X" ? new Uint8Array($request.bodyBytes ?? []) : ($request.body ?? new Uint8Array());
					switch (FORMAT) {
						case "application/protobuf":
						case "application/x-protobuf":
						case "application/vnd.google.protobuf":
							switch (url.pathname) {
								case "/bootstrap/v1/bootstrap":
								case "/user-customization-service/v1/customize":
									delete $request.headers?.["If-None-Match"];
									delete $request.headers?.["if-none-match"];
									break;
								case "/extended-metadata/v0/extended-metadata":
									break;
							}
							break;
						case "application/grpc":
						case "application/grpc+proto":
							break;
					}
					// 写入二进制数据
					$request.body = rawBody;
					break;
				}
			}
		// break; // 不中断，继续处理URL
		// biome-ignore lint/suspicious/noFallthroughSwitchClause: <explanation>
		case "GET":
			if (url.pathname.startsWith("/color-lyrics/v2/track/")) {
				const trackId = PATHs?.[3];
				Console.debug(`trackId: ${trackId}`);
				const _request = JSON.parse(JSON.stringify($request));
				// api.spotify.com/v1/tracks 已对客户端 token 关闭（404），改用 spclient metadata 端点（JSON 格式），需将 base62 id 转 hex gid
				const hexGid = (id => {
					let n = 0n;
					for (const c of id) n = 62n * n + BigInt("0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ".indexOf(c));
					return n.toString(16).padStart(32, "0");
				})(trackId);
				_request.url = `https://spclient.wg.spotify.com/metadata/4/track/${hexGid}?market=from_token`;
				if (_request?.headers?.Accept) _request.headers.Accept = "application/json";
				if (_request?.headers?.accept) _request.headers.accept = "application/json";
				//Console.debug(`_request: ${JSON.stringify(_request)}`);
				// 只有 Translate 需要探测官方歌词 200/404；若未启用 Translate（如仅 External），跳过这次完整歌词拉取以减少延迟，直接定 subtype
				let detectStutus;
				if (Settings.Types.includes("Translate")) {
					detectStutus = fetch($request);
				} else {
					if (Settings.Types.includes("External")) url.searchParams.set("subtype", "External");
					detectStutus = Promise.resolve(null);
				}
				// 元数据已缓存（含 track 名）则跳过重复拉取，省一次网络请求与磁盘写入
				const detectTrack = Caches.Metadatas.Tracks.get(trackId)?.track ? Promise.resolve(null) : fetch(_request);
				// 探测请求封顶 2.2s，超时用默认 subtype 直接放行，避免拖住歌词请求导致播放页偶发不显示歌词板块
				await Promise.race([Promise.allSettled([detectStutus, detectTrack]), new Promise(r => setTimeout(r, 2200))]).then(results => {
					if (!results) {
						if (!url.searchParams.has("subtype")) {
							if (Settings.Types.includes("Translate")) url.searchParams.set("subtype", "Translate");
							else if (Settings.Types.includes("External")) url.searchParams.set("subtype", "External");
						}
						Console.info("prefetch timeout → default subtype");
						return;
					}
					switch (results[0].status) {
						case "fulfilled": {
							const response = results[0].value;
							switch (response?.statusCode ?? response?.status) {
								case 200:
									if (Settings.Types.includes("Translate")) url.searchParams.set("subtype", "Translate");
									else if (Settings.Types.includes("External")) url.searchParams.set("subtype", "External");
									break;
								case 401:
								default:
									break;
								case 404:
									if (Settings.Types.includes("External")) url.searchParams.set("subtype", "External");
									break;
							}
							break;
						}
						case "rejected":
							if (Settings.Types.includes("External")) url.searchParams.set("subtype", "External");
							break;
					}
					switch (results[1].status) {
						case "fulfilled": {
							const response = results[1].value;
							if (!response) break; // 元数据已缓存，本次跳过拉取
							body = JSON.parse(response.body);
							if (body?.name) {
								const trackInfo = {
									id: trackId,
									track: body?.name,
									album: body?.album?.name,
									artist: body?.artist?.[0]?.name ?? body?.album?.artist?.[0]?.name,
									duration: body?.duration, // ms，供外部歌词搜索按时长匹配正确版本
								};
								// 写入数据
								Caches.Metadatas.Tracks.set(trackId, trackInfo);
								// 格式化缓存
								Caches.Metadatas.Tracks = setCache(Caches.Metadatas.Tracks, Settings.CacheSize);
								// 写入持久化储存
								Storage.setItem(`@DualSubs.${"Spotify"}.Caches.Metadatas.Tracks`, Caches.Metadatas.Tracks);
							} else Console.debug(`metadata miss: ${response?.statusCode ?? response?.status} ${String(response?.body).slice(0, 100)}`);
							break;
						}
						case "rejected":
							Console.debug(`detectTrack.reason: ${JSON.stringify(results[1].reason)}`);
							break;
					}
				});
			}
		case "HEAD":
		case "OPTIONS":
			break;
		case "CONNECT":
		case "TRACE":
			break;
	}
	$request.url = url.toString();
	Console.debug(`$request.url: ${$request.url}`);
})()
	.catch(e => Console.error(e))
	.finally(() => {
		switch (typeof $response) {
			case "object": // 有构造回复数据，返回构造的回复数据
				//Console.debug("finally", `echo $response: ${JSON.stringify($response, null, 2)}`);
				if ($response.headers?.["Content-Encoding"]) $response.headers["Content-Encoding"] = "identity";
				if ($response.headers?.["content-encoding"]) $response.headers["content-encoding"] = "identity";
				switch ($app) {
					default:
						done({ response: $response });
						break;
					case "Quantumult X":
						if (!$response.status) $response.status = "HTTP/1.1 200 OK";
						delete $response.headers?.["Content-Length"];
						delete $response.headers?.["content-length"];
						delete $response.headers?.["Transfer-Encoding"];
						done($response);
						break;
				}
				break;
			case "undefined": // 无构造回复数据，发送修改的请求数据
				//Console.debug("finally", `$request: ${JSON.stringify($request, null, 2)}`);
				done($request);
				break;
			default:
				Console.error(`不合法的 $response 类型: ${typeof $response}`);
				break;
		}
	});
