# Discord VC Guest Voice Bridge

Discordアカウントを持たないゲストが、ブラウザからDiscordのボイスチャンネルに音声参加するための試作アプリです。

## できること

- Discord Botが指定VCに接続
- Discord側のスラッシュコマンドでVC専用の参加コードを発行
- ゲストはWebページでニックネームとコードを入力して参加
- 複数ゲストのマイク音声をミックスしてDiscordへ送信
- Discord参加者と他のゲストの音声をブラウザへ中継
- ゲスト側のマイクミュート、スピーカー音量調整、退出
- コードの期限・累計参加回数制限・失効

## 現在の制限

- 1つのDiscordサーバーにつき、Botが同時に接続できるVCは1つです。
- Discord側からは、ゲスト全員の音声がBot 1人の音声として聞こえます。ゲスト個人のDiscordユーザー名としては表示されません。
- 参加コードの上限は「累計参加回数」です。再接続も1回として数えます。
- ブラウザ音声はWebSocketでPCM音声を転送する試作方式です。WebRTC/SFU方式より遅延やネットワーク負荷が大きくなる場合があります。
- Discordの音声受信機能は @discordjs/voice 側でも未保証の機能として扱われています。利用環境やDiscord側の変更で動作しなくなる可能性があります。
- これは初期実装です。公開運用前に実際のDiscordサーバー・スマートフォン・PCで音声テストと負荷テストを行ってください。

## 必要なもの

- Node.js 24.17.0 以上
- DiscordアプリケーションとBotトークン
- Botを追加できるDiscordサーバー
- HTTPSで公開できる常時稼働サーバー
- SQLiteファイルを保持できる永続ストレージ

## Discord Botの準備

1. Discord Developer Portalでアプリケーションを作成します。
2. Botを作成し、Botトークンを取得します。トークンはGitHubに登録せず、サーバーの環境変数だけに設定してください。
3. OAuth2のURL Generatorで `bot` と `applications.commands` を選び、対象サーバーにBotを追加します。
4. Botに対象VCの「チャンネルを見る」「接続」「発言」権限を付与します。
5. コマンドを実行する管理者にはDiscordサーバーの「サーバー管理」権限が必要です。

## ローカル起動

リポジトリ内の `discord-guest-voice-bridge` ディレクトリで実行します。

1. `npm install`
2. `.env.example` を `.env` にコピー
3. `DISCORD_BOT_TOKEN` にBotトークンを設定
4. `DISCORD_GUILD_ID` にテスト用サーバーIDを設定（任意。指定するとそのサーバーにコマンドを登録）
5. `PUBLIC_BASE_URL` をブラウザからアクセスするURLに設定
6. `npm start`

ローカルでマイクを使う場合も、ブラウザのセキュアコンテキスト要件によりHTTPS環境が必要です（localhostは例外として扱われます）。

## Discordコマンド

### /guest-create

指定したVCにBotを接続し、そのVC専用コードを発行します。

- `channel`: 接続先VC
- `expires_minutes`: 有効期限（10〜1440分、既定180分）
- `max_uses`: 累計参加回数（1〜30、既定5回）

発行時にコードと参加URLが管理者だけに表示されます。コードはハッシュ化して保存するため、後から元のコードを表示することはできません。

### /guest-list

サーバー内の有効なコードについて、対象VC・使用回数・期限を表示します。コードそのものは表示しません。

### /guest-revoke

指定したコードを無効化します。

### /guest-close

指定VCに紐づくコードをすべて無効化し、BotをVCから退出させ、接続中のゲストも切断します。

## 環境変数

| 変数 | 説明 |
| --- | --- |
| DISCORD_BOT_TOKEN | 必須。Botトークン |
| DISCORD_GUILD_ID | 任意。コマンドを登録するテストサーバーID |
| PUBLIC_BASE_URL | ゲストに共有するHTTPS URL |
| PORT | Webサーバーのポート。既定3000 |
| HOST | バインド先。既定0.0.0.0 |
| DATABASE_PATH | SQLiteファイルの保存先 |
| TRUST_PROXY | 信頼できるHTTPSリバースプロキシの背後で使う場合のみ1 |

本番では `DATABASE_PATH` を永続ディスク上に設定してください。コンテナの一時領域に保存すると、再デプロイ時にコード情報が消える可能性があります。

## 音声・プライバシーについて

この仕組みではBotがDiscord VCの参加者として動作し、Discord側の音声を受信してブラウザへ転送します。ブラウザからの音声もサーバーで受信し、Discordへ送ります。

DiscordのDAVE暗号化はDiscord VCとBotの接続区間で利用されますが、Botは音声ブリッジの終端です。ブラウザ参加者とDiscord参加者の間でエンドツーエンド暗号化される仕組みではありません。音声は中継サーバー上で処理されます。参加者にこの点を説明し、全員の同意を得てから利用してください。

HTTPS/WSSを必須にし、Botトークンや参加コードをログへ出さず、参加URL・コードを公開チャンネルへ不用意に貼らないでください。音声データはアプリ側で録音・保存しません。

## 技術構成

- Node.js / Express
- discord.js
- @discordjs/voice（DAVE対応）
- prism-media / @discordjs/opus
- WebSocket
- AudioWorklet
- SQLite

## ライセンス

このリポジトリの利用・再配布条件は、運用者が別途定めてください。