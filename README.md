# 译桥 · IT 会议助手

面向中文与英国、美国参会者的技术交流。支持中英混说、双语文字、英文点击播报或自动播报，以及附原文引用的会议纪要。

默认使用 Qwen 实时同传。工作台上方可选「实时翻译」或「线上会议助手」。实时翻译用麦克风听对方的英文，显示双语字幕。线上会议助手用电脑会议音频生成对方的中文字幕，并可同时将实体麦克风里的中文或英语输出为英文语音。原文和译文随模型事件更新，延迟取决于模型与网络。设置中也可使用「短句模式」。

## 启动

### Windows 免安装版

双击 `release/译桥-免安装-0.1.0-x64.exe` 即可运行，不需要安装 Node.js 或其他运行环境。面向 Windows x64，首次打开会在临时目录展开内置运行环境。

配置和会议记录保存到 **EXE 同目录的 `译桥数据/`**，其中 `service-settings.dpapi` 保存加密服务设置，`desktop-profile/` 保存会议历史、术语和界面偏好。重启或替换新版 EXE 不会清除这些数据；移动程序时将这个文件夹一并移动。加密 Key 仍绑定保存时的 Windows 账户，换电脑或账户后需要重新配置。

EXE 本身不包含 API Key、`.env` 或个人会议记录。重复打开同一份便携版会切回已有窗口。源码版和便携版默认使用同一个本机端口 `4319`，请先关闭源码版，再运行便携版。

从源码重新生成免安装 EXE：

```powershell
npm ci
npm run build:portable
```

构建后可运行 `node scripts/check-portable.mjs`。它在独立测试目录实际启动 EXE，验证中文路径、两个场景、加密设置和会议历史在重启后保留，以及重复打开只保留一个窗口。测试使用占位 Key 和隔离数据。

构建只打包应用代码和运行依赖，不复制本机配置。已有源码版数据可在关闭应用后，将 `.local/service-settings.dpapi` 和 `.local/desktop-profile/` 分别复制到 `release/译桥数据/` 下。请保留原文件作为备份，不要覆盖另一份已有会议数据。

### 从源码启动

需要 Node.js 22 或更高版本。项目已安装依赖时可以直接启动。

```powershell
npm install
npm run desktop
```

Windows 桌面版会打开独立窗口，支持系统音频采集。后台服务固定使用 `127.0.0.1:4319`，会议文字保存在项目 `.local/desktop-profile/` 内的浏览器数据中。不要删除该目录，否则会丢失本机会议历史。

也可在文件资源管理器中双击项目内的 `启动会议助手.cmd`。同一端口已被占用时请使用已有窗口，避免重复启动。

浏览器版：

```powershell
npm start
```

打开 <http://127.0.0.1:4318>。Windows 上建议使用新版 Edge 或 Chrome。共享会议所在标签页或屏幕时，需要勾选“共享音频”；没有音轨时应用会明确提示。浏览器版与桌面版的本机记录分别保存，当前不跨设备同步。

## 配置 OpenAI / Qwen

在「服务与音频设置」中选择音频模式。默认「实时同传」使用 Qwen / 百炼 API Key，由专用同传模型一起返回原文、译文和英文音频。默认模型是 `qwen3.8-livetranslate-flash-realtime`，也适配 `qwen3.5-livetranslate-flash-realtime`；普通 ASR 模型不能替代它。

展开 Qwen 高级设置可修改实时模型、音色及 WebSocket 地址。地址默认沿用 Qwen Base URL 的主机；如果账号使用业务空间专属端点，填写控制台对应地域的完整地址，例如 `wss://你的WorkspaceId.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime`（新加坡为 `ap-southeast-1`）。填写时替换业务空间 ID，不附加 `?model=...`；应用会自动添加模型参数。密钥、地域、业务空间和模型权限需要匹配，连接失败会在界面显示原因。[实时同传接口说明](https://help.aliyun.com/zh/model-studio/qwen3-5-livetranslate-flash-realtime)

**Qwen 英文播报默认使用 Aiden（艾登）美式男声**，实时同传与普通点击播报分别读取「实时同传音色」和「短句语音音色」。对应环境变量是 `QWEN_REALTIME_VOICE`、`QWEN_VOICE`。两种接口都支持此音色：[同传音色](https://help.aliyun.com/zh/model-studio/omni-voice-list)、[普通 TTS 音色](https://help.aliyun.com/zh/model-studio/qwen-tts-voice-list)。

「短句翻译」以及文字输入、历史译文重播、会议总结仍使用下面的服务商配置，可全部选 Qwen、全部选 OpenAI，也可混用。点击「测试翻译连接」只调用一次真实短文本翻译，产生相应 API 费用；它不验证实时同传或语音权限。

**Windows 上只需输入并保存一次 Key，之后重启会自动恢复。** 服务商、模型、地址、音色和 Key 一起保存在项目 `.local/service-settings.dpapi`，使用 Windows 当前用户加密；只有相同 Windows 账户可以解密。桌面版与同一项目的浏览器版共用此服务配置，会议历史仍分别保存。密钥不写入浏览器存储，不在接口响应中返回，加密文件已被 Git 忽略。保存失败会明确提示，不会假装保存成功。

Key 输入框留空表示保留已有 Key；点击「清除这家的密钥」会同步更新本机保存项，重启后仍为空。`.env` 可提供初始配置，界面已保存的配置优先（包括清除 Key 的结果）。如果需要重新从 `.env` 初始化，先关闭应用，再移走 `.local/service-settings.dpapi`。非 Windows 环境暂不提供界面配置的加密保存，可在本机复制 `.env.example` 为 `.env` 后填写。`.env` 同样被 Git 忽略。[Windows 用户范围的数据保护](https://learn.microsoft.com/en-us/dotnet/api/system.security.cryptography.dataprotectionscope)

| 能力 | OpenAI 默认模型 / 接口 | Qwen 默认模型 / 接口 |
| --- | --- | --- |
| 短句语音识别 | `gpt-transcribe` / Audio Transcriptions | `qwen3-asr-flash` / Chat Completions 音频输入 |
| 翻译、总结 | `gpt-6.1-sol` / Responses 结构化输出 | `qwen-plus` / Chat Completions JSON 输出 |
| 英文语音 | `gpt-realtime-2.1-mini` / Realtime WebSocket | `qwen3-tts-flash` / DashScope HTTP |

模型、Base URL 和音色可在各服务的高级设置中修改，实际可用性以你的 API 账号权限为准。Qwen 的 Key、兼容模式地址和 TTS 地址必须属于同一地域；默认北京，新加坡需同时修改两个地址。百炼 workspace 专属域名也可填写。Qwen TTS 适配的是 `qwen3-tts-flash` 的 multimodal-generation 协议，不能只改模型名就换用不同协议的语音模型。

OpenAI 的语音使用 Realtime API，避免依赖已公告即将停止服务的旧 Speech API。为了避免朗读时改写技术含义，程序核对返回的播报转写，不一致时拒绝播放。数字与缩写的读法差异也可能导致检查失败，此时可重试或改用 Qwen。Qwen 的口音主要由音色决定；英美口音偏好仅作为 OpenAI 朗读提示，不能保证特定地区口音。

部分 Qwen ASR 服务会拒绝带术语上下文的输入，并返回 `The dedicated task asr ... does not support this input`。遇到这一特定错误时，应用会保留原音频并自动改用纯音频请求重试一次；成功后，后续识别沿用纯音频模式，直到服务配置被重新保存或应用重启。术语库仍用于翻译。权限、额度及其他输入错误不会触发此兼容重试。

## 使用流程

| 使用场景 | 电脑会议音频 | 实体麦克风 |
| --- | --- | --- |
| 实时翻译 | | 点击「开始麦克风翻译」，查看对方的英文原文和中文字幕。 |
| 线上会议助手 | 点击「接入会议音频」，查看对方的英文原文和中文字幕。 | 开启「实时说话转英文」，自动接入麦克风，将中文、英文或中英混合发言按英文语音送到已选设备。 |

- 会议中只想看自己的字幕时，可以单独点击「开启我的麦克风」。关闭「实时说话转英文」或点击「停止英文语音」会停止并清空英文播放，麦克风字幕和会议字幕继续。点击「关闭我的麦克风」结束自己的采集。「停止采集」结束两路，收取最后的字幕。场景选择会保存，英文输出每次手动开启。
- 实时同传按约 100ms 的音频帧上传，原文和译文随模型事件更新。实时更新的字幕可能被修正，收到最终结果后显示「同传已完成」。Qwen 3.8 可将同一路对方音频标记为发言者 1、2 等。
- 会议麦克风在同传期间持续请求英文语音，静音只停止本机向会议输出。音频积压超过 8 秒时会静音，字幕继续。需要结束云端请求时关闭麦克风。已完成的历史记录可以点击「本机播放英文」或「编辑后播放」。
- 「结束并总结」可整理纪要，引用可以回到原文。中断时会保留字幕并标记未完整确认。确认过的原文可重试文字翻译。「导出记录」下载包含原文、译文、纪要和采集中断的 Markdown 文件。

「短句模式」在停顿约 650ms 后开始识别，连续讲话每段最长约 8 秒，随后生成翻译和语音。切换场景、更改模型、音色或设备前请停止采集。修改术语库后重新接入音频，新连接会使用更新的术语。

## 把英文传给线上会议

普通扬声器播放仅在本机发声。为了让 Teams、Zoom 等接收到合成的英文，需要虚拟音频设备或会议软件支持的独立音频输入。

Windows 上使用 VB-CABLE 的连接方式：

```text
实体麦克风 → 译桥识别与翻译 → 英文语音 → CABLE Input（播放设备）
                                            ↓
                                   CABLE Output（录音设备）
                                            ↓
                                    Teams / Zoom 的麦克风

Teams / Zoom 的扬声器 → Windows 默认耳机 → 译桥的系统音频采集 → 中文字幕
```

在译桥的「音频设备」中将会议英文输出设为 **CABLE Input**，麦克风选实体麦克风。会议软件选 **CABLE Output** 作麦克风，扬声器选 Windows 默认播放设备（建议耳机）。保持虚拟声卡与 Windows 默认播放设备分开。使用会议软件的麦克风测试确认英文可以收到。驱动安装说明见 [VB-CABLE 官方页面](https://vb-audio.com/Cable/)。

**实时同传时，两路持续采集。** 如果会议英文输出缺失，或选到了 Windows 默认播放设备，应用会提示修正设备。系统音频采集可能包含通知及其他应用声音。

「短句翻译」仍在英文播放期间暂停两路采集，暂停区间写入导出记录；这时对方同时发言可能遗漏。

## 手机使用

网页已适配手机尺寸，可以输入文字、调用麦克风、播放英文、查看纪要。手机浏览器不能保证读取另一款会议 App 的内部声音，同机开会还可能争用麦克风；授权本身不能消除系统限制。可用独立电脑开会、手机录入自己的发言。请保持页面在前台，锁屏和切换 App 可能中断采集。

手机访问电脑服务时，麦克风需要 **可信的 HTTPS**。HTTP 局域网地址不能直接提供麦克风权限。默认服务仅开放本机，未部署公网，也未生成或安装证书。要启用局域网：

1. 准备手机信任且匹配访问域名/IP 的 TLS 证书与私钥，放在 `certs/`（已忽略）。不要绕过证书警告。
2. 在 `.env` 设置 `HOST=0.0.0.0`、`TLS_CERT`、`TLS_KEY`、足够长的 `ACCESS_TOKEN`、精确的 `PUBLIC_ORIGIN=https://你的访问地址:4318`。
3. 重新运行 `npm start`，手机和电脑处于可互通的网络，打开 `PUBLIC_ORIGIN` 并输入访问密码。

没有可信证书与网络配置前，手机真实录音接入仍待完成。不要把本服务直接公开到互联网；这是个人本机工具，没有多用户隔离、账号管理或生产级限流。

## 数据与限制

- 原始音频只在内存中处理，不落盘。实时模式开启后持续发送至 Qwen，停止后关闭连接，不保存可重放的录音；短句模式分段发送至所选识别服务，失败音频只可在当前页面重试。
- 转写文字和最近的上下文会发送给翻译服务；生成纪要时发送当前会议中处理成功的原文。纪要会提示未包含的失败记录。
- 文字与术语库保存在当前浏览器的本地存储中，未加密。可导出备份；空间不足会提示。API Key 不放在其中。
- 按音频来源标记“我 / 对方”，同一路中的匿名说话人编号依赖模型返回，不会凭声音推断姓名。混音、串音、多人重叠发言可能影响识别。
- 尚无跨设备同步、会议机器人、账户系统或原声克隆。API 调用会产生服务商费用；实时连接包含持续音频发送，使用后应停止采集。
- 本机测试验证了流式协议、字幕更新与音频调度；真实云端同传准确率、首字及首音延迟、声音效果和设备路由仍需使用实际音频确认。

## 开发验证

```powershell
npm run check
npm test
# 独立隐藏窗口，使用合成输入和模拟同传服务，不访问麦克风或云端
node node_modules/electron/cli.js tests/realtime-ui.cjs
```

测试不使用真实密钥，不访问模型服务。覆盖 WAV 编码、静音过滤、断句和尾段保留、连续 PCM 重采样、两版同传协议、原文与译文乱序关联、多人交错事件、音频分片播放、最后一段收尾、失败草稿保留、男声音色配置、密钥脱敏、WebSocket 同源与访问控制、纪要引用和中断恢复。独立窗口测试使用 `.local/realtime-ui-check/` 下的隔离数据，不影响实际会议历史，并输出进行中与完成状态截图。

如需复现浏览器全流程测试，运行 `node tests/ui-fixture.mjs` 后打开 `http://127.0.0.1:4321`。该页面明确标记为本机流程测试，返回固定的模拟译文，语音输出为短测试音调，用于验证输入、播放、结束和总结流程；不要用于实际会议。

代码入口：`server/index.mjs`（本机服务）、`server/live-translation.mjs`（同传网关及事件关联）、`server/providers.mjs`（普通识别、翻译、播报）、`public/app.mjs`（工作台）、`public/live.mjs`（同传连接与连续播放）、`public/capture.mjs`（浏览器音频）、`desktop/main.cjs`（Windows 桌面接入）。

接口依据：[OpenAI 文件转写](https://developers.openai.com/api/docs/guides/speech-to-text)、[OpenAI Realtime](https://developers.openai.com/api/docs/guides/realtime-conversations)、[Qwen ASR](https://help.aliyun.com/en/model-studio/qwen-asr-api-reference)、[Qwen TTS](https://help.aliyun.com/en/model-studio/qwen-tts-api)、[Electron 系统音频采集](https://www.electronjs.org/docs/latest/api/desktop-capturer)、[VB-CABLE](https://vb-audio.com/Cable/)。
