# 不重启 Web 的前端发布

简体中文 | [English](frontend-releases.en.md)

纯前端更新使用独立资源发布流程：Web 从 `GPUMON_ROOT/frontend/current` 选择不可变资源版本，
每份 HTML 的脚本和样式固定到 `/_frontend/<版本>/...`。发布原子替换链接，已打开的页面仍能
读取旧资源，不重启 Web 或采集器，也不修改数据库、虚拟环境、服务配置及后端代码链接。

前提是正在运行的 Web 已支持 `/api/frontend-release` 协议。旧后端须先单独升级；
后端源码、依赖锁文件或部署模板变化也须走后端发布。静态导出和 GitHub Pages 继续使用原始资源。

## 标准流程

1. 本地完成前端检查、相关浏览器回归，提交源码并记录 Git SHA。
2. 读取当前前端版本和后端兼容指纹，保留回滚版本；仅文档变化无需部署。
3. 构建并校验独立资源包，确认与运行中的后端兼容，再原子激活。
4. 检查页面、带版本号的资源、关键接口及 Web PID；失败使用原资源版本回滚。

不要原地覆盖运行目录。兼容性检查失败时停止发布，不能自动改走重启或全量部署路径。
版本记录应区分源码提交、运行后端提交、前端内容版本和回滚版本。

## 构建与激活

从不可变源码目录构建。清单包含所有资源的 SHA-256，以及 `src`、`deploy`、`pyproject.toml`
和 `uv.lock` 的兼容指纹。包限制为 32 MiB / 2048 个文件，禁止软链接。
哈希用于检查内容完整性；传输及发布账户权限仍由部署层控制。

```bash
python3 src/gpumon/frontend_release.py build --source /path/to/candidate --bundle /path/to/new-bundle

# 读取 version 字段；它是前端内容版本，不是 Git SHA。
curl --fail --max-time 5 http://127.0.0.1:8848/api/frontend-release
python3 /path/to/running-source/src/gpumon/frontend_release.py activate \
  --source /path/to/running-source --bundle /path/to/new-bundle \
  --store /path/to/state/frontend --expected <当前前端完整版本> \
  --url http://127.0.0.1:8848
```

以具有资源库写权限的部署账户激活，Web 仅需读权限。store 必须是 `<GPUMON_ROOT>/frontend`。
激活前校验协议、后端指纹、预期版本和完整资源，并经正在运行的 Web 验证待发布页面。
切换后验证失败会恢复旧指针。

## 回滚与并发

把 `--bundle` 指向 `frontend/previous`，并将当前前端版本作为 `--expected`，即可按相同流程回滚。
首次切换前会保留随代码发布的原始前端。不自动清理旧资源，以免仍打开的标签页遇到 404。

所有发布、回滚入口必须使用同一 `frontend/.lock` 非阻塞锁。连接中断时先读取版本再重试，
不能假定切换没有发生。后端升级后若兼容指纹变化，Web 会使用新后端自带前端；
跨后端升级的旧标签页兼容性不属于纯前端发布的保证范围。

本地集成测试覆盖三次升级、三次回滚期间按 HTML 读取版本化 JS/CSS、PID 与健康状态，以及
不完整资源、后端不兼容和切换失败。测试不代表对网络、代理或后端独立故障的可用性保证。
