# kyyProxy

将火山方舟 Seedance 官方任务接口格式转换为 kyyReactApi 的 Seedance 2.0 请求。Node.js 24，零第三方运行依赖，支持 Docker Compose 部署。

客户端 → POST /api/v3/contents/generations/tasks → kyy 素材登记及审核 → kyy 视频任务

## 部署

在项目目录复制配置：

~~~powershell
Copy-Item .env.example .env
~~~

Linux/macOS 使用 cp .env.example .env。编辑 .env：

~~~dotenv
KYY_API_KEY=你的kyyReactApi密钥
PROXY_API_KEY=你自行生成的代理访问密钥
HOST_PORT=8080
# 仅图片 Base64 输入需要，必须通过公网 HTTPS 反向代理到本服务
PUBLIC_BASE_URL=https://video.example.com
~~~

可以使用以下命令生成代理密钥：

~~~sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
~~~

启动和查看日志：

~~~sh
docker compose up -d --build
docker compose ps
docker compose logs -f --tail=100
~~~

默认端口 8080，健康检查为 GET /healthz。KYY_BASE_URL 默认是 https://zcbservice.aizfw.cn/kyyReactApiServer。客户端使用 PROXY_API_KEY，上游使用服务器配置的 KYY_API_KEY。密钥缺失时 Compose 会拒绝启动。

任务和临时图片保存在 kyy-data 命名卷。docker compose down 保留数据；**docker compose down -v 会删除任务记录和图片**。更新代码后执行 docker compose up -d --build。

## 客户端接入

| 配置 | 内容 |
| --- | --- |
| 接口类型 | 火山引擎官方（Ark / Seedance） |
| Base URL | http://localhost:8080/api/v3 |
| API Key | PROXY_API_KEY |
| 模型 | doubao-seedance-2-0-260128，或下面列出的 kyy 模型 ID |

image-video-flow 的模型设置可以使用以上配置。如果客户端运行在其他容器中，localhost 指它自身，应使用可访问的代理地址。公网访问应使用 HTTPS。

| 方法 | 路径 | 返回 |
| --- | --- | --- |
| POST | /api/v3/contents/generations/tasks | {"id":"cgt-..."} |
| GET | /api/v3/contents/generations/tasks/{id} | 官方任务结构，成功时包含 content.video_url |
| GET | /healthz | 服务健康状态，不调用上游 |

业务接口均要求 Authorization: Bearer <PROXY_API_KEY>。健康检查和限时图片链接无需 Bearer。单个代理密钥对应单个上游账户，持有该密钥的客户端共享任务访问权限。

## 创建与查询示例

请求 Content-Type 必须为 application/json。创建示例：

~~~json
{
  "model": "doubao-seedance-2-0-260128",
  "content": [
    {
      "type": "text",
      "text": "镜头缓慢推进，海边日落，电影质感"
    }
  ],
  "duration": 8,
  "ratio": "16:9",
  "resolution": "720p",
  "generate_audio": true,
  "watermark": false
}
~~~

PowerShell 完整调用：

~~~powershell
$base = 'http://localhost:8080/api/v3'
$headers = @{ Authorization = 'Bearer YOUR_PROXY_KEY' }
$body = @{
    model = 'doubao-seedance-2-0-260128'
    content = @(@{ type = 'text'; text = '海边日落，镜头缓慢推进' })
    duration = 8
    ratio = '16:9'
    resolution = '720p'
    generate_audio = $true
} | ConvertTo-Json -Depth 5
$created = Invoke-RestMethod -Method Post -Uri "$base/contents/generations/tasks" -Headers $headers -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body))
do {
    Start-Sleep -Seconds 5
    $task = Invoke-RestMethod -Uri "$base/contents/generations/tasks/$($created.id)" -Headers $headers
    $task | Select-Object id, status
} while ($task.status -in @('queued', 'running'))
if ($task.status -eq 'succeeded') {
    Invoke-WebRequest -Uri $task.content.video_url -OutFile result.mp4
} else {
    $task.error
}
~~~

创建成功仅返回任务 ID：

~~~json
{"id":"cgt-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"}
~~~

查询成功响应示例：

~~~json
{
  "id": "cgt-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "model": "doubao-seedance-2-0-260128",
  "status": "succeeded",
  "created_at": 1793090000,
  "updated_at": 1793090060,
  "content": {
    "video_url": "https://example.com/result.mp4"
  },
  "duration": 8,
  "ratio": "16:9",
  "resolution": "720p",
  "generate_audio": true,
  "error": null
}
~~~

状态使用 queued、running、succeeded、failed、cancelled、expired。素材准备期间为 queued。视频直接从 content.video_url 下载，地址有效期由 kyy 决定，请及时转存。只有上游明确提供 token 用量时才返回 usage，不估算用量或帧率；ratio、resolution 在上游未返回实际值时表示请求的档位，adaptive 不代表已知的最终宽高比。

## 素材格式

在 content 数组中追加以下对象：

~~~json
{"type":"image_url","image_url":{"url":"https://example.com/first.png"},"role":"first_frame"}
~~~

| content.type | role | kyy 字段 |
| --- | --- | --- |
| text | 不填写 | text 文本按顺序用换行连接为 prompt |
| image_url | first_frame，或省略 | first_image |
| image_url | last_frame | last_image |
| image_url | reference_image | reference_images |
| video_url | reference_video，必填 | reference_videos |
| audio_url | reference_audio，必填 | reference_audios |

首尾帧模式最多首帧和尾帧各一张，尾帧必须配首帧；与多模态参考互斥。多模态最多 9 张图片、3 个视频、3 段音频；音频不能单独使用。

url 支持公网 HTTP(S) URL；图片还支持 data:image/png;base64,...、JPEG、WebP Base64。也可引用 kyy 自己的 assetId://ID。**火山的 asset://ID 不能跨平台使用**，请换成原始素材 URL。

Base64 图片会保存为 24 小时有效的随机 URL，kyy 通过该地址获取素材。因此需配置 PUBLIC_BASE_URL，并让公网能够访问代理的 /assets/*。已有公网 URL 和 kyy 素材 ID 无需此配置。限时 URL 包含 192 位随机令牌，拥有完整链接的人可在有效期内读取图片，请勿公开分享。

图片单张最大 30 MiB，整个 JSON 请求最大 42 MiB；过期图片在启动时及每小时清理。图片尺寸、视频/音频时长等要求由上游素材审核检查。审核通过后使用 assetId://ID 提交视频生成任务。

## 模型与参数

官方模型 ID 的对应关系：

| 请求 model | kyy 模型 |
| --- | --- |
| doubao-seedance-2-0-260128 | sd_2.0_special |
| doubao-seedance-2-0-fast-260128 | sd_2.0_fast_special |
| doubao-seedance-2-0-mini-260615 | sd_2.0_mini_special |

也可直接填写 sd_2.0_special、sd_2.0_fast_special、sd_2.0_mini_special、sd_2.0_discount、sd_2.0_fast_discount、sd_2.0_mini_discount。实际生成、计费与可用性由 kyy 决定。

- model、content 必填；kyy 要求至少一个非空 text 提示词，合计不超过 32000 字符。
- duration：4–15 的整数，默认 5；映射到 kyy duration。
- ratio：16:9、9:16、1:1、4:3、3:4、21:9、adaptive，默认 adaptive；映射到 aspect_ratio。
- resolution：720p、1080p、4k，默认 720p；具体模型可用档位仍受上游限制。
- generate_audio：布尔值，默认 true。
- watermark：布尔值，默认 false。
- seed：-1 至 2147483647 的整数，传递给上游。
- tools：支持 [{"type":"web_search"}]，传递给上游。

覆盖官方创建和单任务查询协议。kyy 能力与火山官方不同，下列功能明确返回错误：duration=-1、480p、无文本输入、音频 Base64、官方素材库 ID、frames、camera_fixed、return_last_frame、callback_url、draft、service_tier、execution_expires_after、priority、safety_identifier 等未映射字段，以及提示词中追加 --dur / --ratio 等弱校验参数。请使用顶层 JSON 参数。任务列表、取消和删除返回 501。

## 任务恢复与升级

任务元数据保存在磁盘，不保存上游或代理密钥。已登记的素材 ID 会保存，重启后继续准备；已提交的任务继续查询。素材审核最长等待约 10 分钟，单次上游 HTTP 超时 60 秒。

提交过程中断线或重启而未拿到上游 ID 时，任务失败并返回 submission_uncertain。代理不自动重新提交，应在 kyy 控制台核对记录后再决定是否新建任务。创建请求没有幂等键去重，请勿对 POST 配置无条件重试。若创建响应丢失，可以从数据卷 jobs/*.json 找回本地 ID；其中 remoteId 是 kyy 上游任务 ID。

从旧版升级：

- 已移除 /v1/videos、/v1/video、/v1/models 和 /content 下载接口，不再接收 OpenAI 的 prompt、seconds、size、input_reference 或 multipart。
- 客户端 Base URL 改为 /api/v3，使用 content、duration、ratio、resolution；成功状态改为 succeeded，地址位于 content.video_url。
- 旧版 video_... 任务记录保留，可用原 ID 通过新的任务查询路径读取，旧状态自动转换，未完成的素材准备继续恢复。
- 模型由请求中的 model 选择；旧 .env 中的 KYY_MODEL 已不再使用，可移除。

单进程部署，最多同时准备 4 个任务，准备队列总数达到 100 时返回 429；不要让多个实例共用数据卷。任务 JSON 长期保留，按需备份并维护磁盘空间。

## 本地验证

安装 Node.js 24，填写 .env 后：

~~~sh
npm start
npm test
~~~

没有第三方 npm 依赖，无需 npm install。本地端口用 PORT 配置，默认 8080；HOST_PORT 仅用于 Docker。测试使用模拟上游和临时端口，不产生付费任务，结束后自动关闭测试服务。

## 协议参考

- [火山方舟：创建视频生成任务](https://www.volcengine.com/docs/82379/1520757)
- [火山方舟：查询视频生成任务](https://www.volcengine.com/docs/82379/1521309)
- [Seedance 2.0 系列](https://docs.volcengine.com/docs/ark/seedance-2-0?lang=zh)
- [kyy 视频生成](https://docs.globalaiopc.com/api-reference/model-center/video-gen/sd_2.0_special)
- [kyy 素材提交](https://docs.globalaiopc.com/api-reference/video/seedance-assets/seedance-asset-upload)
- [kyy 素材查询](https://docs.globalaiopc.com/api-reference/video/seedance-assets/seedance-asset-detail)
