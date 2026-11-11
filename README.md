# 阿拉克涅 · Arachne

本地三维涂装工作台。支持建模、编辑 PBR 材质、绘制贴图、GPU 路径追踪预览、PNG 和 OpenEXR 出图以及本机 MCP。提供 Apple Silicon Mac 应用、Windows x64 桌面版及浏览器工作台。

## 工作台快捷入口

按 `F3` 或 `⌘/Ctrl + K` 搜索命令，可用方向键选择并按 Enter 执行。「文件 → 打开工程」按最近修改时间排列，可搜索工程名或 ID。按 `⌘/Ctrl + O` 也能打开该窗口。修订号和保存时间在「文件 → 工程详情」。首次打开工作台或上次工程无法打开时，可从启动页选择最近的工程、新建工程或打开涂装 ZIP。

「窗口 → 工作区布局」可以导出建模、材质和绘制的面板布局，导入前会显示分区预览。布局文件保存编辑器类型、分割方向和比例。

资源库支持搜索名称中的多个词，用方向键在缩略图间移动。双击个人库资源可导入独立副本，双击项目材质可创建引用该材质的填充层。

「渲染 → 后台任务」可查看当前工程的烘焙、路径追踪和导出状态、运行日志及已完成产物，并可取消或重试任务。

## Windows x64 桌面版

安装版从开始菜单启动。便携版解压完整 ZIP 后双击 `Arachne.exe`。应用在独立窗口打开，内置 Electron、Python 和出图用 Chromium。工程和设置保存在 `%LOCALAPPDATA%\Arachne\Workbench`。

构建时先安装工作台依赖、生成示例并安装 Playwright Chromium，再运行 `npm run package:win`。构建器会下载并验证固定版本的 Windows 运行时，生成便携 ZIP 和 SHA-256 校验文件。从其他系统交叉构建时，用 `ARACHNE_PACKAGE_WIN_BROWSER` 指向 Windows x64 Chromium Headless Shell 目录。安装 NSIS 3.13 后，可用 `npm run package:win:installer` 生成安装程序。

将 `ARACHNE_PACKAGE_INCLUDE_BLENDER` 设为 `0` 后运行 `npm run package:win`，可以生成不内置 Blender 的便携 ZIP。该构建使用已经生成的示例缓存。

已登记模型的渲染预览在桌面窗口或浏览器内执行 GPU 路径追踪，使用 WebGL 2 和浮点颜色缓冲。旋转、平移和缩放时显示实时材质，停手后累积采样。在「渲染 → 路径追踪出图」可按工程相机、灯光、材质和分辨率后台渲染，下载 8 位 PNG 或 16／32 位浮点 OpenEXR。EXR 保留场景线性的 RGB 和透明度，色调映射用于 PNG 预览。正式出图使用已登记模型和当前修订的 4K 烘焙贴图，缺少表面缓存时会自动重建。

## 从源码运行

### Apple Silicon macOS

验收环境为 Apple Silicon、macOS 14 或更新版本、Node.js 24 和 Python 3.12。如需生成旧版示例或迁移旧 `.blend` 工程，安装 Blender 到「应用程序」，或设置 `ARACHNE_BLENDER` 指向 Blender 可执行文件。构建 Mac 应用还需安装 Xcode Command Line Tools。

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

导入自有 GLB 时可跳过 `npm run seed:demo`。打开 [本机工作台](http://127.0.0.1:8766/)。端口可通过 `npm start -- --port 8770` 修改。生成器会在本地创建原创示例模型、原 UV、视口 GLB 和投影缓存。工程默认保存在 `workbench/console/data`。再次运行生成器会复用通过校验的示例，保留已保存的工程。

从源码正式出图前运行 `npm --prefix workbench/console exec -- playwright-core install --only-shell chromium`。桌面包内置所需运行时。模型和映射已登记的工程可编辑、合成 4K 贴图和导出工程 ZIP。「文件 → 导出」可生成当前修订的 4K 预览。确认后选择「导出交付 ZIP」，包内包括自包含的 `model.glb`、`materials.json`、独立的八张 4K PBR 贴图、路径追踪 PNG（可选同时保存浮点 EXR）、可编辑工程和 SHA-256 校验报告。GLB 写入工程的建模修改并保留原 UV；高度通道保存在独立贴图中。也可以单独导出 GLB 或「工程与贴图」ZIP。

路径追踪支持摄影棚、柔光和日光布光，源场景模式采用默认摄影棚灯光。它使用烘焙后的颜色、金属度、粗糙度、法线、发光和不透明度贴图。高度和环境遮蔽贴图随包交付，当前不作为内置出图的独立输入。

在「文件 → 新建涂装工程」选择自包含的静态 GLB 即可导入，工作台会使用第一个具有有效 0–1 UV 的材质作为涂装目标。GLB 导入、拓扑生成、表面缓存重建和 PNG 出图使用本机工作台，不需要 Blender。涂装目标以 GLB 材质的基础色、金属度和粗糙度为起点，其他材质保留原有显示。

GLB 工程的完整交付 ZIP 含原始登记数据，可用「文件 → 打开涂装 ZIP」在没有原模型或缓存的本机恢复。旧工程已有登记 GLB 时也可生成原生交付包；旧工程的可编辑数据和仅工程／贴图 ZIP 回导仍需本机有对应的原登记模型。旧版示例生成和历史 Cycles 接口仍使用 Blender。

旧 `.blend` 涂装工程可在「文件 → 迁移为 GLB 工程」创建原生副本，无需事先生成视口缓存。迁移时本机 Blender 只读取源模型一次，原工程与历史保留。迁移会核对原 UV，保留 GLB 支持的材质，并复制原投影表面、保护区、图层、蒙版和素材。新工程的打开、建模、涂装、烘焙、出图与导出均不再使用 Blender；完整 ZIP 可在空数据目录恢复。Blender 专有材质节点不属于 GLB 材质格式。

### Windows x64 开发环境

安装 Node.js 24、Python 3.12 x64 和 Blender 5.2 x64。Python 安装时启用 Python 启动器或将 Python 加入 PATH。工作台会查找 Blender 的默认安装目录和 PATH。使用便携版时，在 PowerShell 里把 `$env:ARACHNE_BLENDER` 设为 `blender.exe` 的完整路径。

在仓库根目录打开 PowerShell：

```powershell
npm.cmd run setup:win
npm.cmd run start:win
```

首次运行 `setup:win` 会安装依赖、建立 `.venv` 并生成示例模型。后续用 `start:win` 启动，打开 [本机工作台](http://127.0.0.1:8766/)，按 Ctrl+C 退出。可以通过 `npm.cmd run start:win -- --port 8770` 更换端口。工程默认保存在 `workbench/console/data`。

Windows 验收覆盖示例、4K 烘焙、贴图和工程 ZIP 回导、建模后原 UV 校验及路径追踪出图。

## 构建 Mac 应用

运行 `npm --prefix workbench/console exec -- playwright-core install chromium` 安装 Chromium。将 `ARACHNE_PACKAGE_BROWSER` 设为 Playwright 安装的 `chrome-headless-shell-mac-arm64` 目录。保持上面的 Python 环境已激活，运行 `npm run package:mac`。应用、压缩包和校验文件生成在 `workbench/console/release`。

MCP 使用 stdio，运行 `node workbench/console/paint-mcp.mjs --write` 可启用写入。省略 `--write` 时只读。非默认服务端口用 `ARACHNE_PORT` 指定。

运行 `npm test` 执行单元测试，`npm run verify:demo` 用隔离数据验收无需 Blender 的视口路径追踪、正式 PNG 出图、烘焙及导出回导，以及已有登记 GLB 的旧工程原生交付。运行 `npm --prefix workbench/console run verify:model-import` 可从空数据目录验收 GLB 导入、原 UV 保留、编辑后重建表面、正式出图、完整 ZIP 导出及在空数据目录恢复。运行 `npm --prefix workbench/console run verify:blend-migration` 可验收无视口缓存的旧工程迁移、同版 4K 哈希、原模型离线后的编辑和完整导出。若要额外回归历史 Cycles 接口，可在已安装 Blender 的环境下设置 `ARACHNE_VERIFY_LEGACY_CYCLES=1`。

## 许可

阿拉克涅自有源码采用 **GPL-3.0-only**，详见 [LICENSE](LICENSE)。第三方依赖和字体保留各自许可证，见 [第三方说明](THIRD_PARTY.md)。
