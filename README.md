# 阿拉克涅 · Arachne

本地三维涂装工作台。支持在 Web 和 Apple Silicon Mac 上建模、编辑 PBR 材质、绘制贴图、使用 Cycles 预览，并通过本机 MCP 读取和编辑工程。

## 从源码运行

验收环境为 Apple Silicon、macOS 14 或更新版本、Node.js 24、Python 3.12 和 Blender 5.2.3。安装 Blender 到「应用程序」，或设置 `ARACHNE_BLENDER` 指向 Blender 可执行文件。构建 Mac 应用还需安装 Xcode Command Line Tools。

在仓库根目录执行：

```sh
npm --prefix workbench/console ci
python3.12 -m venv .venv
. .venv/bin/activate
python -m pip install -r workbench/console/requirements.txt
export ARACHNE_PYTHON="$PWD/.venv/bin/python"
npm run seed:demo
npm start
```

打开 [本机工作台](http://127.0.0.1:8766/)。端口可通过 `npm start -- --port 8770` 修改。生成器会在本地创建原创示例模型、原 UV、视口 GLB 和投影缓存。工程默认保存在 `workbench/console/data`。再次运行生成器会复用通过校验的示例，保留已保存的工程。

编辑和已经生成映射的 4K 涂装合成可在 Blender 不可用时运行。首次生成示例、缺少的模型或拓扑缓存、建模后的映射重建、Cycles 和含 Blender 副本的正式交付需要 Blender。首发使用已登记的示例，通用模型导入和脱离 Blender 的渲染仍在开发。工程与贴图 ZIP 回导需要匹配的登记模型及 UV。

## 构建 Mac 应用

运行 `npm --prefix workbench/console exec -- playwright-core install chromium` 安装 Chromium。将 `ARACHNE_PACKAGE_BROWSER` 设为 Playwright 安装的 `chrome-headless-shell-mac-arm64` 目录。保持上面的 Python 环境已激活，运行 `npm run package:mac`。应用、压缩包和校验文件生成在 `workbench/console/release`。

MCP 使用 stdio，运行 `node workbench/console/paint-mcp.mjs --write` 可启用写入。省略 `--write` 时只读。非默认服务端口用 `ARACHNE_PORT` 指定。

运行 `npm test` 执行单元测试，`npm run verify:demo` 用隔离数据验收示例、烘焙、导出、回导和 Cycles。

## 许可

阿拉克涅自有源码采用 **GPL-3.0-only**，详见 [LICENSE](LICENSE)。第三方依赖和字体保留各自许可证，见 [第三方说明](THIRD_PARTY.md)。
