# Mavic 4 Pro 外观习作源稿

在 Arachne 的「文件 → 打开涂装 ZIP…」中打开[已配好材质、灯光和机位的工程 ZIP](../mavic-4-pro-studio.zip)。

`model.mjs` 保存了原创的机身截面、机臂、镜头组和各部件材质。`lettering.json` 提供机臂和镜组字样的轮廓。按照片估形的比例适用于外观展示。

要修改几何并生成 GLB，在仓库根目录执行以下命令，然后打开[本地模型生成页](http://127.0.0.1:8090/examples/mavic-4-pro-studio/)，点击「生成 GLB」。回到已打开的工程，选择「文件 → 更新工程模型…」并选取 GLB。一次更新对应一次撤销。

```sh
npm ci --prefix workbench/console
python3 -m http.server 8090 --bind 127.0.0.1
```

## 侧盖和主摄凹槽返工

当前工程 ZIP 有一条可编辑的工作台建模步骤，右侧云台轴盖沿直径方向缩至 78%，厚度保持原值。主摄镜座的修改保存在源稿中，内缩量从 3.2 调到 1.8 个源稿单位。三枚镜片仍分别绑定各自的玻璃材质。[原机位三步对照](../../docs/images/mavic-4-pro-modeled-update.webp)

要复现这次返工，打开[上一版工程](https://raw.githubusercontent.com/AvroraCL/arachne/2f3ddcaec147b58ebaf3153696f401cd583e651d/examples/mavic-4-pro-studio.zip)，在大纲中选中 `Starboard · recessed pivot cover`，在全局坐标下以物体中心缩放，X 为 1，Y 和 Z 均为 0.78。再从本目录生成 GLB，选择「文件 → 更新工程模型…」。用「Infinity · 镜组」书签对照两处造型，用「展臂 · 整机」检查机壳和机臂字样。撤销一次即可回到侧盖已缩小、主摄仍为旧镜座的状态。

更新适用于从同一源稿导出的原生 GLB。请保留节点、网格、材质槽、三角形索引和原 UV 的对应关系。工作台会核对目标并在新源模型上重放建模步骤。若源稿也改了被绝对顶点编辑覆盖的位置，更新会指出冲突物体，原工程可继续编辑。使用历史建模表面投影的涂装目前仍需沿用原模型。

[首次主摄凹槽返工对照](../../docs/images/mavic-4-pro-optics-revision.webp)
