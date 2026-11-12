# 阿拉克涅 Windows x64 桌面版

解压完整 ZIP 后，双击 `Arachne.exe`。工作台会在独立窗口打开，首次运行会载入示例工程。示例的绘制、4K 烘焙、GLB 与贴图导出可以直接使用。

工程、个人库和应用设置保存在 `%LOCALAPPDATA%\Arachne\Workbench`。通过「文件 → 显示工程目录」可以在资源管理器中打开工程数据目录。「文件」菜单还提供工程副本、ZIP 导入和导出。

已登记模型的渲染预览在桌面窗口内执行 GPU 路径追踪，无需启动 Blender。「渲染 → 路径追踪出图」使用工程相机、灯光、材质和分辨率生成 PNG 或 OpenEXR。GLB 导入、建模后的映射重建和完整交付 ZIP 均使用内置工具，无需启动 Blender。旧 .blend 涂装工程可在「文件 → 迁移为 GLB 工程」使用 Blender 一次；迁移后的工程独立运行。默认包可使用系统安装的 Blender 迁移旧工程，也可通过 `ARACHNE_BLENDER` 指定路径。

使用本机 MCP 时，先打开桌面版，再启动 `ArachneMCP.cmd`。加 `--write` 可启用工程写入。

应用源码许可和第三方说明位于 `resources/workspace`。Electron 与 Chromium 的许可随应用分发，Python 及其库的许可位于 `resources/runtime/python`。包含 Blender 5.2.3 的构建随附其许可证，位于 `resources/runtime/blender/license`。 [Blender 官方源码归档](https://download.blender.org/source/blender-5.2.3.tar.xz)
