# Mavic 4 Pro 外观习作源稿

在 Arachne 的「文件 → 打开涂装 ZIP…」中打开[已配好材质、灯光和机位的工程 ZIP](../mavic-4-pro-studio.zip)。

`model.mjs` 保存了原创的机身截面、机臂、镜头组和各部件材质。`lettering.json` 提供机臂和镜组字样的轮廓。按照片估形的比例适用于外观展示。

要修改几何并生成 GLB，在仓库根目录执行以下命令，然后打开[本地模型生成页](http://127.0.0.1:8090/examples/mavic-4-pro-studio/)，点击「生成 GLB」。回到已打开的工程，选择「文件 → 更新工程模型…」并选取 GLB。一次更新对应一次撤销。

```sh
npm ci --prefix workbench/console
python3 -m http.server 8090 --bind 127.0.0.1
```

## 三摄主镜返工

上方主摄的镜座后移，消光内壁沿原开口延长。两枚长焦镜头用于同机位对照。新版 ZIP 与本目录源稿对应。[修改前的工程](https://github.com/AvroraCL/arachne/raw/601e48f55e0895ff35297ab88c23adbd6e0a1577/examples/mavic-4-pro-studio.zip) · [同机位对照](../../docs/images/mavic-4-pro-optics-revision.webp)

可用上面的修改前工程练习返工。打开 ZIP，生成本目录的 GLB，在原工程内更新。机壳粗糙度蒙版、自定义灯光和两个相机书签会保留。「编辑 → 撤销」可切回旧镜座；重做后可继续编辑。

此入口适用于从同一源稿导出的原生 GLB。导出时保留节点名称与层级、网格和材质槽对应关系、三角形索引与原 UV。已有工作台建模步骤或绑定过旧建模状态的涂装时，请使用建模前的副本。本例的 127 个网格均沿用原 UV。
