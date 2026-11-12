# 阿拉克涅 Windows x64 桌面版

安装版从「开始」菜单打开阿拉克涅。便携版需解压完整 ZIP，再双击 `Arachne.exe`。工作台会在独立窗口打开，首次运行会载入示例工程。示例的绘制、4K 烘焙、GLB 与贴图导出可以直接使用。

工程、个人库和应用设置保存在 `%LOCALAPPDATA%\Arachne\Workbench`。通过「文件 → 显示工程目录」可以在资源管理器中打开工程数据目录。「文件」菜单还提供工程副本、ZIP 导入和导出。

已登记模型的渲染预览在桌面窗口内执行 GPU 路径追踪，无需启动 Blender。「渲染 → 路径追踪出图」使用工程相机、灯光、材质和分辨率生成 PNG 或 OpenEXR。GLB 导入、建模后的映射重建和完整交付 ZIP 均使用内置工具，无需启动 Blender。旧 .blend 涂装工程可在「文件 → 迁移为 GLB 工程」使用 Blender 一次；迁移后的工程独立运行。默认包可使用系统安装的 Blender 迁移旧工程，也可通过 `ARACHNE_BLENDER` 指定路径。

在材质区选中蒙版，在「蒙版效果」添加磨损、噪声或其他效果，按面板显示的顺序从下到上合成。要让手绘修正直接作用于结果，将「手绘修正」设为「在效果后」。在绘制区用 Shift 或 Ctrl 多选图层，再拖入图层组，或通过右键菜单批量移动、复制和删除。每次批量操作可以一次撤销。

如果顶栏显示「笔触未保存」，请保留当前窗口并点击「重试保存笔触」。应用先核对工程修订和已经写入的笔触，再尝试保存剩余笔触。「布局未保存」时使用面板内的「重试保存布局」；若另一窗口保存了布局，界面会让你选择保留哪一份。

使用本机 MCP 时，先打开桌面版，再启动 `ArachneMCP.cmd`。加 `--write` 可启用工程写入。

应用源码许可和第三方说明位于 `resources/workspace`。Electron 与 Chromium 的许可随应用分发，Python 及其库的许可位于 `resources/runtime/python`。包含 Blender 5.2.3 的构建随附其许可证，位于 `resources/runtime/blender/license`。 [Blender 官方源码归档](https://download.blender.org/source/blender-5.2.3.tar.xz)
