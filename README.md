# Hobby Atlas

Hobby Atlas 是一个在 Obsidian 内使用的个人兴趣白板。

## 白板功能

- 白板中心是 ROOT，周围是 Hobby 节点。
- 每个 Hobby 继续向外连接一个或多个 Todo 卡片；当前默认创建一个主卡片。
- Todo 卡片位于 Hobby 节点下方，卡片内显示对应的 Todo 列表，并保持 Markdown 文档关联。
- 未完成 Todo 使用正常颜色并位于上层；已完成 Todo 自动变灰并位于下层。
- 在白板工具栏直接新建 Hobby / Todo。
- 在 Hobby 节点上直接新增 Todo。
- Todo 节点上直接完成、取消完成、编辑、删除。
- 点击 Hobby 或 Todo 节点打开对应的 Obsidian 文档。
- 节点位置、白板平移和缩放状态会保存。
- 文档被外部修改后，白板会自动刷新。
- 兼容第一版及手动整理过的 `Hobbies` 子目录，避免旧 Hobby 因目录差异消失。
- 拖动 Hobby 后松开鼠标不会误打开文档。
- Hobby 与 Todo 卡片均可拖动，Hobby 移动时其下方卡片和连线一起移动。
- 白板界面首选 Excalifont，并提供系统手写字体回退。
- 触摸板双指滑动默认平移白板；按住 `⌘` / `Ctrl` / `Alt` 滑动可缩放，也可以使用工具栏的放大和缩小按钮。
- 拖动 Hobby 会保留鼠标在卡片上的抓取位置，不会在按下时跳位。

## 构建与安装

```bash
cd obsidian-plugin
npm install
npm run build
```

将 `main.js`、`manifest.json`、`styles.css` 放入 vault 的 `.obsidian/plugins/hobby-atlas/`，然后在 Obsidian 设置中启用插件。

文档结构示例：

```text
Hobbies/
  摄影.md
  摄影/
    Todos/
      拍一组城市光影.md
```

Hobby 文档里的任务行使用双链：

```markdown
- [ ] [[Hobbies/摄影/Todos/拍一组城市光影|拍一组城市光影]]
```
