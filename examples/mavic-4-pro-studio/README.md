# Mavic 4 Pro 外观习作源稿

在 Arachne 的「文件 → 打开涂装 ZIP…」中打开[已配好材质、灯光和机位的工程 ZIP](../mavic-4-pro-studio.zip)。

`model.mjs` 保存了原创的机身截面、机臂、镜头组和各部件材质。`lettering.json` 提供机臂和镜组字样的轮廓。按照片估形的比例适用于外观展示。

要修改几何并生成 GLB，在仓库根目录执行以下命令，然后打开[本地模型生成页](http://127.0.0.1:8090/examples/mavic-4-pro-studio/)，点击「生成 GLB」。可在工作台新建工程时选择生成的文件。

```sh
npm ci --prefix workbench/console
python3 -m http.server 8090 --bind 127.0.0.1
```
