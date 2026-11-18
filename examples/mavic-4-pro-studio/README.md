# Mavic 4 Pro 外观习作源稿

在 Arachne 的「文件 → 打开涂装 ZIP…」中打开[已配好材质、灯光和机位的工程 ZIP](../mavic-4-pro-studio.zip)。

`model.mjs` 保存了原创的机身截面、机臂、镜头组和各部件材质。`lettering.json` 提供机臂和镜组字样的轮廓。按照片估形的比例适用于外观展示。

要修改几何并生成 GLB，在仓库根目录执行以下命令，然后打开[本地模型生成页](http://127.0.0.1:8090/examples/mavic-4-pro-studio/)，点击「生成 GLB」。回到已打开的工程，选择「文件 → 更新工程模型…」并选取 GLB。一次更新对应一次撤销。

```sh
npm ci --prefix workbench/console
python3 -m http.server 8090 --bind 127.0.0.1
```

## 用侧盖标记检查返工

打开工程的「Infinity · 镜组」机位。右侧云台轴盖保留了一条工作台建模步骤，直径为初版的 78%。轴盖外缘有一枚白色和琥珀色的校准标记。主摄镜座在源稿中的内缩量由 1.8 改为 2.5 个源稿单位。[同机位对照](../../docs/images/mavic-4-pro-projection-update.webp)

要从投放标记开始复现，打开[上一版工程](https://raw.githubusercontent.com/AvroraCL/arachne/fd14d3b3bac529fa14f0902ce36e819c8bc49edc/examples/mavic-4-pro-studio.zip)。将[校准标记 PNG](calibration-mark.png) 导入图像资源库，拖到三维视口里右侧轴盖露出的外缘。选中轴盖后，物体属性的材质区域会显示标记名称。再次投放会替换该材质的标记，也可以单独移除。此入口适用于有独立可写 UV 的纯色附属材质。

生成本目录的 GLB，再选择「文件 → 更新工程模型…」。主摄凹槽会加深，侧盖上的标记沿用投放时的 UV 覆盖。撤销一次可回到已有标记、尚未加深凹槽的版本。机壳涂层、灯光和两个机位保存在同一工程中。

GLB 更新要求物体层级、网格、材质槽、三角形索引和原 UV 保持对应。工作台重放已有建模步骤，并为旧的空间笔触、投影蒙版和贴花保留各自的原始模型及投影机位。可编辑 ZIP 会携带被引用的登记模型，在另一数据目录重开时自动重建表面缓存。若源稿也修改了绝对顶点编辑所覆盖的位置，更新会指出发生冲突的物体。

[侧盖缩放和镜座返工](../../docs/images/mavic-4-pro-modeled-update.webp) · [首次主摄凹槽返工](../../docs/images/mavic-4-pro-optics-revision.webp)
