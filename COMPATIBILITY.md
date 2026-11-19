# Forge Anywhere 网页媒体兼容性

记录桌面 Chrome 的网页素材发送结果，测试版本为 v1.0.36–v1.0.38。结论以测试样本为准。✅ 支持：已成功发送；❌ 不支持：实站样本发送未通过；🟡 待测：页面受阻、只验证了选取或仅通过模拟测试；— 无需测试：本轮未安排。

| 平台 | 图片 | 视频 | 备注 |
| --- | --- | --- | --- |
| Pexels | ✅ | ✅ | 常用素材库。主图右键发送通过，视频右键和面板均可发送全片，右键样本刷新画布后可播放。[图片样本](https://www.pexels.com/photo/path-in-green-forest-13264824/) · [视频样本](https://www.pexels.com/video/serene-ocean-waves-crashing-on-shoreline-33684742/) |
| Pinterest | ✅ | 🟡 | 视觉灵感。换网后图片页右键发送成功；视频样本待复测。[图片样本](https://www.pinterest.com/pin/969188782717555355/) · [视频样本](https://www.pinterest.com/pin/1067205871302510217/) |
| 小红书 | ✅ | ✅ | 中文图文和视频参考。发现页图片通过；RED 页可播放视频右键发送 36 秒片段，画布可解码。[发现页](https://www.xiaohongshu.com/explore) · [RED 视频](https://www.xiaohongshu.com/red_video) |
| 微博 | ✅ | ✅ | 热点配图和视频。本轮文章配图和 102 秒视频全片均通过。[图片样本](https://weibo.com/ttarticle/p/show?id=2309404725458397954695) · [视频样本](https://weibo.com/tv/show/1034:5207772470902792) |
| 微信 | ✅ | ✅ | 公众号文章。静态图和内嵌全片已验证，GIF 不支持，部分视频偶发 403；本轮文章复测被浏览器安全策略阻止。[图片样本](https://mp.weixin.qq.com/s/Xy3sYlWVkQ-dd0xR2z478w) · [视频样本](https://mp.weixin.qq.com/s/k9wZSu8v-wt4XxP_g-7OpQ) |
| X | 🟡 | 🟡 | 海外图文和视频参考。v1.0.36 实站无右键图标；v1.0.37 对照测试通过，实站页加载失败且浏览器访问受限。[图片样本](https://x.com/NASA/status/2029580499312627881) · [视频样本](https://x.com/astro_reid/status/2046009031613907029) |
| Unsplash | ✅ | — | 摄影图库。详情页主图右键发送通过。[图片样本](https://unsplash.com/photos/a-lake-in-front-of-a-mountain-AxSaRriVy0E) |
| Pixabay | ✅ | ✅ | 图库和视频库。主图及 31 秒视频均由右键发送，画布可解码。[图片样本](https://pixabay.com/photos/mountains-lake-nature-landscape-7138605/) · [视频样本](https://pixabay.com/videos/waves-water-sea-ocean-landscape-22183/) |
| Google 图片 | ✅ | — | 常用找图入口。搜索结果图可发送，有时遇到验证。[搜索样本](https://www.google.com/search?tbm=isch&q=NASA%20Pillars%20of%20Creation) |
| 百度图片 | ✅ | — | 常用找图入口。缩略图和原图可发送；详情页 Chrome 右键菜单及面板选取成功，悬浮图标点击无响应。[搜索样本](https://image.baidu.com/search/index?tn=baiduimage&word=NASA%20Pillars%20of%20Creation) |
| Behance | 🟡 | 🟡 | 设计作品集。换网后视频页仍报网络错误，图片页此前也未打开。[图片样本](https://www.behance.net/gallery/65590023/Adobe-MAX-2018-identity-1-event-graphics) · [视频样本](https://www.behance.net/gallery/243613957/Motion-Graphics-Showreel-2024) |
| 抖音 | ✅ | ✅ | 国内图文和短视频。正文图可发送。连续播放可发送片段，本轮回归送出 28 秒。[图片样本](https://www.douyin.com/note/7616399587141737704) · [连续播放样本](https://www.douyin.com/video/7705256140821221561) · [跳播样本](https://www.douyin.com/video/7447854137779277115) |
| 哔哩哔哩 | ✅ | ✅ | 中文教程和创作参考。v1.0.37 实站封面发送通过，静态 AVIF 可转 PNG，视频可发送已缓冲片段。[封面样本](https://www.bilibili.com/v/popular/all) · [视频样本](https://www.bilibili.com/video/BV1fY4y1M7Tj/) · [全景样本](https://www.bilibili.com/video/BV1Xq4y177bV/) |
| YouTube | 🟡 | ❌ | 长视频和 Shorts。换网后视频可播放、可选取，但发送提示“不支持的媒体格式”；列表和 Shorts 待复测。[列表样本](https://www.youtube.com/@BlenderOfficial/videos) · [视频样本](https://www.youtube.com/watch?v=YE7VzlLtp-4) · [Shorts 样本](https://www.youtube.com/shorts/-zWwcOVZd4M) |
| Instagram | 🟡 | 🟡 | 海外图集和 Reels。v1.0.36 两条 Reel 报片段不足；v1.0.37 对照通过，实站复测受浏览器访问限制。[图片样本](https://www.instagram.com/p/DelZ5g8l8Pr/) · [原视频样本](https://www.instagram.com/reel/DehZj9wggt0/) · [海冰 Reel](https://www.instagram.com/reel/DUa5b_BDmmD/) · [Earthset Reel](https://www.instagram.com/reel/DeTUk4sDSp-/) |
| TikTok | 🟡 | 🟡 | 海外竖屏短视频。图集、视频页能打开，但推广弹层持续加载并遮住素材，未能测试发送。[图片样本](https://www.tiktok.com/@nomadcentraka/photo/7571216638826122514) · [视频样本](https://www.tiktok.com/@nasa/video/7695060950394703118) |
| Mixkit | — | ✅ | 免费视频素材。本轮右键发送 30 秒全片并播放通过，先前也验证过刷新画布后播放。[视频样本](https://mixkit.co/free-stock-video/waves-reaching-the-shore-1925/) |
| Wikimedia Commons | ✅ | — | 公开素材对照。换网后图片右键发送成功。[图片样本](https://commons.wikimedia.org/wiki/File:JPEG_example_flower.jpg) |

## 音频

| 平台 | 音频 | 备注 |
| --- | --- | --- |
| QQ 音乐 | ❌ | 网页可播放试听和全曲，但本轮未出现可供插件选取的音频，右键与面板均未选中。现有网页音频捕获条件未满足；具体请求环节尚未确认。[播放器](https://y.qq.com/n/ryqq_v2/player) |
| 酷狗音乐 | 🟡 | 歌单页可打开，点击播放要求扫码登录；未测试发送。[歌单样本](https://www.kugou.com/yy/special/single/collection_3_1567926699_3_0.html) |
| 酷我音乐 | ✅ | v1.0.37 右键和面板均从实站送出 4:15 MP3，临时接收端可播放。[单曲样本](https://www.kuwo.cn/play_detail/657553816) |
| Apple Music | ✅ | 网页公开试听可右键发送，接收端成功解码 90 秒 M4A。[播放器](https://music.apple.com/us/new) |
| Bandcamp | ❌ | 换网后单曲可播放；播放器右键和面板选取均未识别音频。[单曲样本](https://chriszabriskie.bandcamp.com/track/cylinder-five) |
| SoundCloud | 🟡 | 换网后有页面标题，但内容空白，无法测试播放和发送。[音频样本](https://soundcloud.com/nasa/apollo-11-thats-one-small-step-for-a-man) |
| Spotify | 🟡 | 换网后不再报连接错误，播放和发送尚未验证。[单曲样本](https://open.spotify.com/track/11dFghVXANMlKmJXsNCbNl) |
| YouTube Music | 🟡 | 换网后播放器可播放，插件发送尚未验证。[单曲样本](https://music.youtube.com/watch?v=QrqjLoPbnyY) |
| Wikimedia Commons | 🟡 | 图片页已恢复；音频样本尚未复测。[音频样本](https://commons.wikimedia.org/wiki/File:Example.ogg) |
