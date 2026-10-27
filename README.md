# kyyProxy

把 OpenAI Videos API 请求转换为 kyyReactApi 的 Seedance 2.0 请求。Node.js 24，零第三方运行依赖，支持 `docker compose up -d --build`。

客户端 → `kyyProxy /v1/videos` → 素材登记/审核 → `kyyReactApi /v2/model-center/tasks`

## Docker Compose 部署

在本项目目录执行：

```powershell
Copy-Item .env.example .env
```

Linux/macOS 使用 `cp .env.example .env`。编辑 `.env`：

```dotenv
KYY_API_KEY=你的kyyReactApi密钥
PROXY_API_KEY=你自行生成的代理访问密钥
KYY_MODEL=sd_2.0_special
HOST_PORT=8080
# 仅上传文件/Base64 图片需要，公网域名须反向代理到本服务。
PUBLIC_BASE_URL=https://video.example.com
```

可用 `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"` 生成代理密钥。客户端只使用 `PROXY_API_KEY`，上游密钥保留在服务器。两项密钥必填；Compose 会在缺失时拒绝启动。

```sh
docker compose up -d --build
docker compose ps
docker compose logs -f --tail=100
```

默认访问 `http://localhost:8080`，健康检查为 `GET /healthz`。这是服务健康检查，不会调用付费上游。公网部署时通过 HTTPS 反向代理访问。

任务记录和临时图片保存在 `kyy-data` 命名卷。`docker compose down` 保留数据；**`docker compose down -v` 会删除任务记录和上传图片**。更新后重新执行 `docker compose up -d --build`。

## 客户端配置

| 配置 | 值 |
| --- | --- |
| 接口类型 | OpenAI Video |
| Base URL | `http://localhost:8080/v1` 或 `https://你的代理域名/v1` |
| API Key | `.env` 中的 `PROXY_API_KEY` |
| 推荐模型 | `sd_2.0_special` |

`image-video-flow` 的模型设置可以直接填写上述配置。若客户端运行在别的容器中，`localhost` 指该容器自身，应改用可访问的代理服务地址。

支持 `sora-2`、`sora-2-pro` 作为兼容别名，两者都映射到 `KYY_MODEL`，实际运行的是 Seedance。也可以直接指定以下上游模型：

- `sd_2.0_special`、`sd_2.0_fast_special`、`sd_2.0_mini_special`
- `sd_2.0_discount`、`sd_2.0_fast_discount`、`sd_2.0_mini_discount`

`GET /v1/models` 返回这些模型及别名。

## 接口与示例

视频接口使用标准路径 `/v1/videos`。

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| POST | `/v1/videos` | 创建任务，立即返回本地 `video_...` ID |
| GET | `/v1/videos/{id}` | 查询状态并转换为 OpenAI Video 对象 |
| GET | `/v1/videos/{id}/content` | 流式下载 MP4，未完成时返回 409 |
| GET | `/v1/models` | 查询可用模型 |
| GET | `/healthz` | 无需鉴权的健康检查 |

除健康检查和限时素材地址外，所有接口要求 `Authorization: Bearer <PROXY_API_KEY>`。这是单个上游账户、单个代理密钥的部署；持有该代理密钥的客户端共享任务访问权限。

以下 curl 示例为 Bash 写法。Windows PowerShell 可使用 `curl.exe`，或使用后面的 PowerShell 示例。

```sh
curl http://localhost:8080/v1/videos \
  -H 'Authorization: Bearer YOUR_PROXY_KEY' \
  -H 'Content-Type: application/json' \
  -d '{"model":"sd_2.0_special","prompt":"镜头缓慢推进，海边日落，电影质感","seconds":"8","size":"1280x720"}'
```

参考图 URL：

```json
{
  "model": "sd_2.0_special",
  "prompt": "让图中的人物缓慢转身",
  "seconds": "8",
  "size": "720x1280",
  "input_reference": { "image_url": "https://example.com/input.png" }
}
```

上传参考图文件：

```sh
curl http://localhost:8080/v1/videos \
  -H 'Authorization: Bearer YOUR_PROXY_KEY' \
  -F 'model=sd_2.0_special' \
  -F 'prompt=让图中的人物缓慢转身' \
  -F 'seconds=8' \
  -F 'size=720x1280' \
  -F 'input_reference=@input.png;type=image/png'
```

查询、下载：

```sh
curl http://localhost:8080/v1/videos/video_YOUR_ID \
  -H 'Authorization: Bearer YOUR_PROXY_KEY'
curl http://localhost:8080/v1/videos/video_YOUR_ID/content \
  -H 'Authorization: Bearer YOUR_PROXY_KEY' -o result.mp4
```

PowerShell 完整示例：

```powershell
$base = 'http://localhost:8080/v1'
$headers = @{ Authorization = 'Bearer YOUR_PROXY_KEY' }
$body = @{ model = 'sd_2.0_special'; prompt = '海边日落，镜头缓慢推进'; seconds = '8'; size = '1280x720' } | ConvertTo-Json
$job = Invoke-RestMethod -Method Post -Uri "$base/videos" -Headers $headers -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body))
do {
    Start-Sleep -Seconds 5
    $job = Invoke-RestMethod -Uri "$base/videos/$($job.id)" -Headers $headers
    $job | Select-Object id, status, progress
} while ($job.status -in @('queued', 'in_progress'))
if ($job.status -eq 'completed') {
    Invoke-WebRequest -Uri "$base/videos/$($job.id)/content" -Headers $headers -OutFile result.mp4
} else {
    $job.error
}
```

创建响应包含 `id/object/model/status/progress/created_at/seconds/size/prompt/error` 等 OpenAI Video 字段；查询状态为 `queued`、`in_progress`、`completed` 或 `failed`。素材准备期间保持 `queued`；只有上游提供进度时才更新进度，不虚构百分比。提交成功后额外返回 `upstream_id`，完成后额外返回 `video_url`。视频 URL 有有效期，请及时下载。

## 参数转换与边界

| OpenAI 输入 | kyyReactApi 输入 |
| --- | --- |
| `model` | 原样传递 Seedance 模型；Sora 别名映射到 `KYY_MODEL` |
| `prompt` | `prompt` |
| `seconds` | 整数 `duration`，支持 4–15 秒，默认 4 秒 |
| `size` | `aspect_ratio` + `resolution` 档位 |
| `input_reference` | 审核后的素材 ID → `first_image` |

尺寸映射：

| size | 比例 | 分辨率 |
| --- | --- | --- |
| `720x1280` / `1280x720` | 9:16 / 16:9 | 720p |
| `1080x1920` / `1920x1080` | 9:16 / 16:9 | 1080p |
| `1024x1792` / `1792x1024` | 9:16 / 16:9 | 1080p（近似映射） |
| `720x720` / `1080x1080` | 1:1 | 720p / 1080p |

kyy 只接受比例和分辨率档位，因此 **1024×1792、1792×1024 无法保证原始像素尺寸或精确比例**；代理不转码、不裁切。响应的 `size` 保留请求尺寸，实际像素以生成文件为准。

`input_reference` 支持 `{ "image_url": "..." }`、URL 字符串、`assetId://ID` 字符串、Base64 data URL，以及 multipart 图片文件。文件/Base64 仅支持 PNG、JPEG、WebP，单图最大 30 MiB，请求体最大 42 MiB。图片分辨率、视频/音频时长等上游条件由素材审核验证。

扩展字段支持 `first_image`、`last_image`、`reference_images`（最多 9）、`reference_videos`（最多 3）、`reference_audios`（最多 3）、`generate_audio`、`watermark`、`seed`。扩展素材字段使用 URL 或 `assetId://ID`；multipart 的数组和布尔值用 JSON 字符串。首尾帧与多模态参考互斥，音频不能单独使用。`input_reference` 与扩展素材字段互斥。未指定音频和水印时使用上游默认值。

## 素材访问与恢复

kyy 不接受原始 Base64 图片。代理把上传图片保存为随机限时地址，由上游读取，因此上传时必须配置 `PUBLIC_BASE_URL`，并让 kyy 能通过公网 HTTPS 访问 `/assets/*`。仅填写域名不会自动建立公网通道。URL 或既有素材 ID 输入不需要此配置。

素材地址使用 192 位随机令牌，有效期 24 小时，不要求 Bearer Key。拥有完整地址的人可在有效期内读取该图片；不要公开分享素材地址。过期图片在启动时和每小时清理一次。上游审核通过后使用 `assetId://ID` 提交生成任务，准备阶段最长等待约 10 分钟，单次上游 HTTP 请求超时 60 秒。

任务元数据保存在磁盘，不保存上游或代理密钥。已登记的素材 ID 会保存，重启后继续准备；提交成功的任务继续查询。提交过程中断线或重启而没有拿到上游 ID 时，返回 `submission_uncertain`，不会自动再提交。此时应在 kyy 控制台核对记录，确认未计费后再新建任务。

创建请求没有幂等键去重；不要对 POST 开启无条件重试。若客户端在接收创建响应时断线，可查看数据卷 `jobs/*.json` 查找本地任务 ID。没有管理后台、任务列表、删除、Remix、OpenAI Files API、缩略图和多租户账户管理。单进程部署，最多同时准备 4 个任务，等待队列满 100 时返回 429；不要让多个实例共用此数据卷。任务 JSON 长期保留，按需备份和维护磁盘空间。

## 本地运行和验证

安装 Node.js 24，复制并填写 `.env` 后：

```sh
npm start
npm test
```

没有第三方 npm 依赖，无需执行 `npm install`。本地端口用 `PORT` 配置，默认 8080；`HOST_PORT` 仅用于 Docker。测试用内存模拟上游和临时端口验证创建、轮询、下载、文件/Base64 上传、素材审核、错误映射与重启恢复，不产生付费生成。测试结束自动关闭服务、删除测试临时目录。

## 协议参考

- [OpenAI Create a video](https://developers.openai.com/api/reference/resources/videos/methods/create)：兼容其 Videos 请求/响应格式。官方页面已标记原服务停用；本项目实际调用 kyy，不依赖 OpenAI 视频服务可用性。
- [kyy sd_2.0_special](https://docs.globalaiopc.com/api-reference/model-center/video-gen/sd_2.0_special)
- [kyy 素材提交](https://docs.globalaiopc.com/api-reference/video/seedance-assets/seedance-asset-upload)
- [kyy 素材查询](https://docs.globalaiopc.com/api-reference/video/seedance-assets/seedance-asset-detail)
