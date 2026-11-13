# Pocket Evo Safari

Pocket Evo Safari 是 macOS Safari 扩展，为PT站点提供统一的接入、管理、搜索。用户可以集中管理站点、查看状态与统计信息，进行资源聚合搜索，一键推送下载。配置也可以生成二维码，导入 Pocket Evo App。

## 功能

- **站点接入**：参考 PT-depiler 等站点适配信息，识别并接入了300多个站点，可通过一键探测、书签、浏览历史等增加站点。
- **站点管理**：集中管理站点资料、启用状态、标签和访问配置，查看站点可用状态及统计数据。
- **聚合搜索**：同时搜索多个站点，汇总资源结果，并按条件筛选和排序。
- **一键读取**：批量读取站点用户资料与做种统计，减少逐站查看的操作。
- **下载器推送**：将搜索到的种子发送到已配置的下载器。
- **备份与恢复**：支持导出与恢复配置数据，数据未加密，请做好数据保护。
- **Pocket Evo App 导入**：把站点配置生成二维码，由 Pocket Evo App 扫码一键导入。
- **Safari 原生桥接**：通过 Safari 原生扩展处理部分浏览器受限的网络请求。

站点兼容情况会因站点页面结构和登录方式而异。

## 站点支持

以下为 Pocket Evo 插件已适配的站点列表：

| 站点名称 | 站点类型 |
| --- | --- |
| AlphaRatio | GazelleJSONAPI |
| Anthelion | Gazelle |
| AsianCinema | Unit3D |
| Audiences | NexusPHP |
| BeyondHD | F3NIX |
| Blutopia | Unit3D |
| BroadcastTheNet | Gazelle |
| BrokenStones | GazelleJSONAPI |
| CHDBits | NexusPHP |
| DIC Music | GazelleJSONAPI |
| DiscFan | NexusPHP |
| Emp | Luminance |
| ExoticaZ | AvistazNetwork |
| FileList | FileList |
| GazelleGames | GazelleJSONAPI |
| Great Poster Wall | GazelleJSONAPI |
| HD-F | Gazelle |
| HD-Space | XBTIT |
| HD-Torrents | XBTIT |
| HDArea | NexusPHP |
| HDBits | PrivateSite |
| HDChina | NexusPHP |
| HDFans | NexusPHP |
| HDHome | NexusPHP |
| HDSky| NexusPHP |
| HDTIME | NexusPHP |
| HDU | NexusPHP |
| HHanClub | NexusPHP |
| IPTorrents | AbstractPrivateSite |
| Keepfrds | NexusPHP |
| M-Team | mTorrent |
| NicePT | NexusPHP |
| NYPT | NexusPHP |
| OpenCD | NexusPHP |
| OurBits | NexusPHP |
| PassThePopcorn | Gazelle |
| Piggo | Piggo |
| PT | NexusPHP |
| PTerClub | NexusPHP |
| PTHOME | NexusPHP |
| Redacted | GazelleJSONAPI |
| Soulvoice | NexusPHP |
| 不可说| NexusPHP |
| SUNNYPT | SUNNYPT |
| TCCF | SUNNYPT |
| TJUPT | SUNNYPT |
| TLFBits | SUNNYPT |
| TTG | TBSource |
| U2 | NexusPHP |
| Ying | AbstractPrivateSite |
| ZhuQue | TNode |

## 环境要求

- macOS
- Xcode（项目由 Safari Web Extension Converter 生成）
- Safari

当前 Xcode 工程的 macOS 部署版本设为 **macOS 27.2**。使用更早版本 macOS 的用户可能无法运行此工程。

## 从源码构建

1. 下载或克隆本项目。
2. 用 Xcode 打开 `Pocket Evo 站点导入/Pocket Evo 站点导入.xcodeproj`。
3. 选择 `Pocket Evo 站点导入` Scheme。
4. 在 App 和 Extension 两个 Target 的 **Signing & Capabilities** 中选择自己的 Apple 开发团队，并启用自动签名。
5. 选择本机作为运行目标，点击 **Run**。
6. 首次启动后，在 Safari 的 **设置 → 扩展** 中启用 Pocket Evo。

项目不包含开发者的签名身份。使用者需在自己的 Xcode 中配置签名；直接下载源码不会自动安装 Safari 扩展。

## 权限说明

扩展需要访问标签页、Cookie、本地存储，以及 HTTP/HTTPS 网页，以便读取已登录站点的信息并完成扩展功能。Safari 会在启用扩展时显示权限提示。

## 发布前隐私检查

- 不要提交 Pocket Evo 导出的 JSON 备份：其中包含站点地址、Cookie、Passkey、API Token、TMDB/OMDb Key、下载器账号密码、搜索历史、缓存与本机设置。
- 不要提交 `Build/` 下的编译产物和 DerivedData；它们包含本机签名信息、缓存和本地构建记录。
- Xcode 项目应使用发布者自己的 Team ID；本项目源码不需要包含个人开发团队标识。使用者在 Xcode 里选择自己的签名团队即可构建。
- Safari 的站点凭据保存在浏览器扩展本地存储中，不应出现在源代码、提交记录或公开问题截图里。

## 项目结构

- `Pocket Evo 站点导入/`：Xcode App 工程、Safari 扩展和内置网页资源。
- `Pocket Evo 站点导入/Pocket Evo 站点导入 Extension/SafariWebExtensionHandler.swift`：Safari 原生消息处理与网络请求桥接。

## 问题排查

- **Safari 中没有扩展**：先从 Xcode 启动 App，再到 Safari 的 **设置 → 扩展** 中启用。
- **Xcode 提示签名错误**：确认 App 和 Extension 两个 Target 都选择了自己的开发团队，并启用自动签名。
- **站点无法读取**：确认 Safari 已登录该站点，并检查该站点当前是否受支持。

## 致谢

本项目基于以下开源项目开发，感谢原作者与贡献者：

- [Kxmrg/pocket-evo-extension](https://github.com/Kxmrg/pocket-evo-extension)：Pocket Evo 浏览器扩展。本 Safari 项目以该项目 **v1.5** 作为开发起点，随后独立适配和迭代。
- [pt-plugins/PT-depiler](https://github.com/pt-plugins/PT-depiler)：感谢其 PT 站点适配与分类数据，为本项目提供参考。

第三方项目的许可信息见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。


