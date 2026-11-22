# 译桥 · 实时会议助手

译桥是一个中英会议助手。它把会议里的英文转成中文字幕，也可以把你说的话转成英文语音，送进 Teams、Zoom 等会议软件。

[下载 Windows x64 免安装版](https://github.com/taigeerniubi/bridge-meeting-assistant/releases/latest/download/BridgeMeeting-windows-x64.exe) · [所有版本](https://github.com/taigeerniubi/bridge-meeting-assistant/releases) · [从源码运行](#从源码运行)

## 功能

| 场景 | 音频来源 | 输出 |
| --- | --- | --- |
| 实时翻译 | 麦克风采集身边的英文 | 英文原文和中文字幕 |
| 线上会议助手 | 电脑会议音频和你的实体麦克风 | 对方的双语字幕，以及你的英文字幕和语音 |

- 实时同传会随模型返回更新原文、译文和英文语音。语音输出支持中文或中英混合发言，也可以用英文音色复述直接说出的英文。
- 支持文字翻译、IT 术语库、编辑后重播，以及带原文引用的会议纪要。记录和纪要可以导出为 Markdown。
- 「短句模式」在停顿后分段识别和翻译。实时英文语音依赖网络和模型，实际延迟随使用环境变化。

## Windows 免安装版

1. 在 [GitHub Releases](https://github.com/taigeerniubi/bridge-meeting-assistant/releases/latest) 的 **Assets** 中下载 `BridgeMeeting-windows-x64.exe`。
2. 将 EXE 放在 Windows x64 电脑上有写入权限的文件夹，双击运行。运行环境随 EXE 提供。
3. 打开「服务与音频设置」，填入有实时同传权限的 Qwen / 百炼 API Key 并保存。配置前可以先点「体验示例」查看演示记录。

便携版在 EXE 同目录创建 `译桥数据/`，存放加密的服务设置、会议历史和术语。升级时保留这个文件夹，用新版 EXE 替换旧版即可。API Key 绑定保存时的 Windows 账户。

## 从源码运行

源码运行需要 **Node.js 22.12 或更高版本**和 npm。Windows 桌面版支持系统音频采集。在 PowerShell 中运行以下命令即可克隆、安装依赖和启动。

```powershell
git clone https://github.com/taigeerniubi/bridge-meeting-assistant.git
cd bridge-meeting-assistant
npm ci
npm run desktop
```

桌面版会打开独立窗口，默认服务地址为 `127.0.0.1:4319`。安装依赖后也可双击 `启动会议助手.cmd`。源码桌面版与免安装版共用默认端口，可在关闭其中一个后启动另一个。

浏览器版在同一项目目录运行以下命令，然后打开 <http://127.0.0.1:4318>。

```powershell
npm start
```

浏览器采集会议声音时，在 Chrome 或 Edge 的共享界面选择会议标签页或屏幕，并勾选共享音频。可用音源取决于浏览器和系统。浏览器与桌面版分别保存会议记录。

## 服务配置

- **实时同传**使用 Qwen / 百炼。默认模型是 `qwen3.8-livetranslate-flash-realtime`，也支持 `qwen3.5-livetranslate-flash-realtime`，默认英文音色为 Aiden。密钥、模型权限与端点地域需要匹配。使用工作空间专属端点时，在高级设置填写完整的实时 WebSocket 地址，模型参数由应用添加。[百炼实时同传文档](https://help.aliyun.com/zh/model-studio/qwen3-5-livetranslate-flash-realtime)
- **短句模式、文字翻译、会议纪要和手动重播**按用途选择 OpenAI 或 Qwen。只配置一家服务时，将相应的「语音识别」「翻译与总结」「英文语音」路由也选为该服务。
- **从源码配置**可以复制 [`.env.example`](.env.example) 为 `.env`，填写 `DASHSCOPE_API_KEY` 或 `OPENAI_API_KEY`。在 Windows 上通过界面保存的设置会加密存储，并优先于 `.env`。源码版的服务设置和桌面记录保存在 `.local/`。

| 用途 | OpenAI 默认模型 | Qwen 默认模型 |
| --- | --- | --- |
| 短句语音识别 | `gpt-transcribe` | `qwen3-asr-flash` |
| 翻译与总结 | `gpt-6.1-sol` | `qwen-plus` |
| 英文语音 | `gpt-realtime-2.1-mini` | `qwen3-tts-flash` |

点击「测试翻译连接」会发起一次文本翻译请求。实时同传和英文输出可以分别用一段短音频确认。

## 把英文语音送进会议

只看字幕时，选择「实时翻译」并开启麦克风，或在「线上会议助手」中点击「接入会议音频」。

要让会议里的其他人听到合成英文，可以在 Windows 安装 [VB-CABLE](https://vb-audio.com/Cable/)，再按下表选择设备。

| 位置 | 设置 | 选择 |
| --- | --- | --- |
| 译桥「音频设备」 | 实体麦克风 | 你的真实麦克风 |
| 译桥「音频设备」 | 会议英文输出 | **CABLE Input** |
| Teams / Zoom 等会议软件 | 麦克风 | **CABLE Output** |
| Teams / Zoom 等会议软件 | 扬声器 | Windows 默认播放设备，例如耳机 |

在译桥选择「线上会议助手」，点击「接入会议音频」获取对方字幕，再打开「实时说话转英文」。这两路在实时同传模式下可以同时运行。关闭英文开关会静音输出，点「关闭我的麦克风」结束自己的采集。短句模式会在播放英文时暂停采集。

## 构建与测试

在 Windows x64 的项目根目录运行以下命令。构建产物是 `release/译桥-免安装-<version>-x64.exe`。

```powershell
npm ci
npm run build:portable
```

```powershell
npm run check
npm test
node node_modules/electron/cli.js tests/realtime-ui.cjs
node scripts/check-portable.mjs
```

前两条检查源码和本机测试。实时 UI 测试使用合成音频与模拟服务。最后一条需要先完成打包，会启动独立的便携版，验证两种场景、配置与记录重启恢复。

## 数据与局域网

原始音频在内存中处理，采集时会发送给所选云服务。会议文字和术语保存在本机。实时采集、翻译、纪要和语音生成按服务商规则计费。

<details>
<summary>在手机浏览器访问</summary>

用 `npm start` 启动浏览器版。局域网录音需要手机信任的 HTTPS 证书。在 `.env` 设置 `HOST=0.0.0.0`、`TLS_CERT`、`TLS_KEY`、`ACCESS_TOKEN` 和与证书匹配的 `PUBLIC_ORIGIN`，重启后用手机打开该地址并输入访问密码。桌面版按本机模式运行。

</details>

## 许可证

译桥源码采用 [MIT 许可证](LICENSE)。
