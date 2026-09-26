import { App, ItemView, Notice, Plugin, PluginSettingTab, Setting, TFile, WorkspaceLeaf, normalizePath, setIcon } from 'obsidian';

export const VIEW_TYPE_HOBBY_ATLAS = 'hobby-atlas-view';
const HOBBY_FOLDER = 'Hobbies';
const TODOS_FOLDER = 'Todos';
type HobbyAtlasSettings = { rootFolder: string };
const DEFAULT_SETTINGS: HobbyAtlasSettings = { rootFolder: HOBBY_FOLDER };

type Position = { x: number; y: number };
type TodoNode = { id: string; text: string; done: boolean; path: string; x: number; y: number };
type HobbyNode = { name: string; path: string; x: number; y: number; todos: TodoNode[] };
type ViewState = { panX: number; panY: number; zoom: number; positions: Record<string, Position> };
const DEFAULT_STATE: ViewState = { panX: 0, panY: 0, zoom: 1, positions: {} };

export default class HobbyAtlasPlugin extends Plugin {
  data: { viewState?: ViewState; settings?: Partial<HobbyAtlasSettings> } = {};
  settings: HobbyAtlasSettings = { ...DEFAULT_SETTINGS };

  async onload() {
    this.data = (await this.loadData()) ?? {};
    this.settings = { ...DEFAULT_SETTINGS, ...this.data.settings, rootFolder: this.normalizeRootFolder(this.data.settings?.rootFolder ?? DEFAULT_SETTINGS.rootFolder) };
    this.addSettingTab(new HobbyAtlasSettingTab(this.app, this));
    this.registerView(VIEW_TYPE_HOBBY_ATLAS, (leaf) => new HobbyAtlasView(leaf, this.app, this));
    this.addRibbonIcon('git-branch', '打开 Hobby Atlas 白板', () => this.activateView());
    this.addCommand({ id: 'open-hobby-atlas', name: '打开 Hobby Atlas 白板', callback: () => this.activateView() });
  }

  normalizeRootFolder(value: string) {
    const normalized = normalizePath(value.trim().replace(/^\/+|\/+$/g, ''));
    return normalized && normalized !== '.' ? normalized : DEFAULT_SETTINGS.rootFolder;
  }

  async saveSettings() {
    this.data.settings = this.settings;
    await this.saveData(this.data);
  }

  async refreshViews() {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_HOBBY_ATLAS)) {
      const view = leaf.view;
      if (view instanceof HobbyAtlasView) await view.refresh();
    }
  }

  async activateView() {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_HOBBY_ATLAS);
    if (existing.length) { await this.app.workspace.revealLeaf(existing[0]); return; }
    const leaf = this.app.workspace.getLeaf('tab');
    await leaf.setViewState({ type: VIEW_TYPE_HOBBY_ATLAS, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }
}

class HobbyAtlasSettingTab extends PluginSettingTab {
  plugin: HobbyAtlasPlugin;

  constructor(app: App, plugin: HobbyAtlasPlugin) { super(app, plugin); this.plugin = plugin; }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'Hobby Atlas 设置' });
    new Setting(containerEl)
      .setName('根节点文件夹')
      .setDesc('Hobby 文档和 Todo 文档都会保存在这里。支持多级路径，例如：兴趣/Hobbies。已有文档不会自动移动。')
      .addText((text) => text
        .setPlaceholder(DEFAULT_SETTINGS.rootFolder)
        .setValue(this.plugin.settings.rootFolder)
        .onChange(async (value) => {
          const next = this.plugin.normalizeRootFolder(value);
          if (next === this.plugin.settings.rootFolder) return;
          this.plugin.settings.rootFolder = next;
          await this.plugin.saveSettings();
          await this.plugin.refreshViews();
        }));
  }
}

class HobbyAtlasView extends ItemView {
  private appRef: App;
  private pluginRef: HobbyAtlasPlugin;
  private canvasEl!: HTMLElement;
  private worldEl!: HTMLElement;
  private edgesEl!: SVGSVGElement;
  private zoomLabel!: HTMLElement;
  private state: ViewState = { ...DEFAULT_STATE, positions: {} };
  private panDrag: { startX: number; startY: number; panX: number; panY: number } | null = null;
  private nodeDrag: { key: string; grabX: number; grabY: number; x: number; y: number } | null = null;
  private dragMoved = false;
  private suppressClick = false;
  private refreshTimer: number | null = null;
  private refreshGeneration = 0;

  constructor(leaf: WorkspaceLeaf, app: App, plugin: HobbyAtlasPlugin) { super(leaf); this.appRef = app; this.pluginRef = plugin; }
  getViewType() { return VIEW_TYPE_HOBBY_ATLAS; }
  getDisplayText() { return 'Hobby Atlas'; }

  async onOpen() {
    this.state = await this.loadState();
    this.contentEl.empty();
    this.contentEl.addClass('hobby-atlas-view');
    this.renderShell();
    this.registerVaultListeners();
    await this.refresh();
  }

  async onClose() { await this.saveState(); }

  private renderShell() {
    const toolbar = this.contentEl.createDiv({ cls: 'hobby-atlas-toolbar' });
    const title = toolbar.createDiv({ cls: 'hobby-atlas-title' });
    const logo = title.createSpan({ cls: 'hobby-atlas-logo' }); setIcon(logo, 'git-branch');
    const titleText = title.createDiv(); titleText.createDiv({ text: 'Hobby Atlas' }); titleText.createSpan({ text: '我的兴趣白板 · 卡片版', cls: 'hobby-atlas-subtitle' });

    const controls = toolbar.createDiv({ cls: 'hobby-atlas-controls' });
    const addTodoButton = controls.createEl('button', { cls: 'hobby-atlas-button' }); setIcon(addTodoButton, 'check-square'); addTodoButton.createSpan({ text: '新建 Todo' }); addTodoButton.onclick = () => void this.createTodo();
    const addHobbyButton = controls.createEl('button', { cls: 'hobby-atlas-button mod-cta' }); setIcon(addHobbyButton, 'plus'); addHobbyButton.createSpan({ text: '新建 Hobby' }); addHobbyButton.onclick = () => void this.createHobby();
    const arrangeButton = controls.createEl('button', { cls: 'hobby-atlas-button' }); setIcon(arrangeButton, 'refresh-cw'); arrangeButton.createSpan({ text: '重新排列' }); arrangeButton.onclick = () => void this.rearrange();
    const zoomOut = controls.createEl('button', { cls: 'hobby-atlas-icon-button', attr: { 'aria-label': '缩小' } }); setIcon(zoomOut, 'minus'); zoomOut.onclick = () => this.adjustZoom(-0.1);
    const zoomIn = controls.createEl('button', { cls: 'hobby-atlas-icon-button', attr: { 'aria-label': '放大' } }); setIcon(zoomIn, 'plus'); zoomIn.onclick = () => this.adjustZoom(0.1);
    const resetButton = controls.createEl('button', { cls: 'hobby-atlas-icon-button', attr: { 'aria-label': '重置视图' } }); setIcon(resetButton, 'maximize'); resetButton.onclick = () => { this.state.panX = 0; this.state.panY = 0; this.state.zoom = 1; this.applyTransform(); };
    this.zoomLabel = controls.createSpan({ cls: 'hobby-atlas-zoom-label', text: '100%' });

    this.canvasEl = this.contentEl.createDiv({ cls: 'hobby-atlas-canvas' });
    this.canvasEl.setAttribute('aria-label', 'Hobby Atlas 无限白板');
    this.worldEl = this.canvasEl.createDiv({ cls: 'hobby-atlas-world' });
    this.edgesEl = this.worldEl.createSvg('svg', { cls: 'hobby-atlas-edges' });
    this.worldEl.createDiv({ cls: 'hobby-atlas-grid' });
    this.canvasEl.onpointerdown = (event) => this.onCanvasPointerDown(event);
    this.canvasEl.onpointermove = (event) => this.onCanvasPointerMove(event);
    this.canvasEl.onpointerup = () => this.onPointerUp();
    this.canvasEl.onpointercancel = () => this.onPointerUp();
    this.canvasEl.onwheel = (event) => this.onWheel(event);
  }

  private registerVaultListeners() {
    const refresh = () => {
      if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
      this.refreshTimer = window.setTimeout(() => void this.refresh(), 120);
    };
    this.registerEvent(this.appRef.vault.on('create', refresh));
    this.registerEvent(this.appRef.vault.on('modify', refresh));
    this.registerEvent(this.appRef.vault.on('delete', refresh));
    this.registerEvent(this.appRef.vault.on('rename', refresh));
  }

  async refresh() {
    if (!this.worldEl) return;
    const generation = ++this.refreshGeneration;
    const hobbies = await this.readHobbies();
    // Vault events can start another refresh while this one is still reading
    // files. Never let an older read clear a newer render.
    if (generation !== this.refreshGeneration || !this.worldEl) return;
    this.worldEl.querySelectorAll('.hobby-atlas-node').forEach((node) => node.remove());
    this.edgesEl.empty();
    this.renderRoot();
    const hobbyRadius = Math.max(280, Math.min(410, 210 + hobbies.length * 22));
    const occupied: Position[] = [];
    hobbies.forEach((hobby, index) => {
      const saved = this.finitePosition(this.getPosition(`hobby:${hobby.name}`, hobby.name));
      const hobbyPosition = this.uniquePosition(saved, index, hobbies.length, hobbyRadius, occupied);
      hobby.x = hobbyPosition.x; hobby.y = hobbyPosition.y;
      occupied.push(hobbyPosition);
      this.state.positions[`hobby:${hobby.name}`] = hobbyPosition;
      try {
        this.renderEdge(`edge:hobby:${hobby.name}`, 0, 0, hobby.x, hobby.y, 'hobby-atlas-edge');
        this.renderHobby(hobby);
        this.renderHobbyCard(hobby);
      } catch (error) {
        // Keep one malformed node from preventing every other Hobby from rendering.
        console.error('[Hobby Atlas] failed to render Hobby', hobby.name, error);
        new Notice(`无法显示 Hobby「${hobby.name}」，请查看开发者控制台`);
      }
    });
    this.applyTransform();
    if (generation === this.refreshGeneration) await this.saveState();
  }

  private renderRoot() {
    const root = this.worldEl.createDiv({ cls: 'hobby-atlas-node hobby-atlas-root' });
    root.createDiv({ cls: 'hobby-atlas-root-orbit' });
    root.createDiv({ text: '我的世界', cls: 'hobby-atlas-root-label' });
    root.createSpan({ text: 'ROOT', cls: 'hobby-atlas-root-kicker' });
    root.ondblclick = () => void this.createHobby();
  }

  private renderHobby(hobby: HobbyNode) {
    const node = this.worldEl.createDiv({ cls: 'hobby-atlas-node hobby-atlas-hobby' });
    node.setAttr('data-node-key', `hobby:${hobby.name}`);
    node.style.left = `${hobby.x}px`; node.style.top = `${hobby.y}px`;
    const head = node.createDiv({ cls: 'hobby-atlas-hobby-head' });
    head.createDiv({ cls: 'hobby-atlas-hobby-glyph', text: this.emojiFor(hobby.name) });
    const label = head.createDiv(); label.createDiv({ text: hobby.name, cls: 'hobby-atlas-hobby-name' }); label.createDiv({ text: `${hobby.todos.filter((todo) => !todo.done).length} 待办 · ${hobby.todos.filter((todo) => todo.done).length} 完成`, cls: 'hobby-atlas-hobby-count' });
    const add = node.createEl('button', { cls: 'hobby-atlas-node-action', attr: { 'aria-label': `为 ${hobby.name} 新建 Todo` } }); setIcon(add, 'plus'); add.createSpan({ text: 'Todo' }); add.onclick = (event) => { event.stopPropagation(); void this.createTodo(hobby.name); };
    node.createDiv({ text: '点击打开文档 · 拖动调整位置', cls: 'hobby-atlas-hobby-hint' });
    node.onclick = () => { if (this.consumeSuppressedClick()) return; void this.openDocument(hobby.path); };
    node.ondblclick = (event) => { event.stopPropagation(); if (this.consumeSuppressedClick()) return; void this.openDocument(hobby.path); };
    node.onpointerdown = (event) => this.onNodePointerDown(event, `hobby:${hobby.name}`, hobby.x, hobby.y, node);
  }

  private renderHobbyCard(hobby: HobbyNode) {
    const key = `card:${hobby.name}:main`;
    const saved = this.getPosition(key);
    const position = this.finitePosition(saved) ?? this.defaultCardPosition(hobby);
    this.state.positions[key] = position;
    this.renderEdge(`edge:${key}`, hobby.x, hobby.y, position.x, position.y, 'hobby-atlas-edge hobby-atlas-card-edge', `hobby:${hobby.name}`);
    const card = this.worldEl.createDiv({ cls: 'hobby-atlas-node hobby-atlas-card' });
    card.setAttr('data-node-key', key);
    card.style.left = `${position.x}px`; card.style.top = `${position.y}px`;
    const cardHead = card.createDiv({ cls: 'hobby-atlas-card-head' });
    cardHead.createDiv({ text: 'TODO CARD', cls: 'hobby-atlas-card-kicker' });
    cardHead.createDiv({ text: hobby.name, cls: 'hobby-atlas-card-title' });
    const add = card.createEl('button', { cls: 'hobby-atlas-card-add', attr: { 'aria-label': `为 ${hobby.name} 添加 Todo` } }); setIcon(add, 'plus'); add.createSpan({ text: '添加' }); add.onclick = (event) => { event.stopPropagation(); void this.createTodo(hobby.name); };
    const list = card.createDiv({ cls: 'hobby-atlas-card-list' });
    const active = hobby.todos.filter((todo) => !todo.done);
    const completed = hobby.todos.filter((todo) => todo.done);
    [...active, ...completed].forEach((todo) => this.renderTodo(hobby, todo, list));
    if (!hobby.todos.length) list.createDiv({ text: '暂无 Todo', cls: 'hobby-atlas-empty-todo' });
    card.onclick = () => { if (this.consumeSuppressedClick()) return; void this.openDocument(hobby.path); };
    card.onpointerdown = (event) => this.onNodePointerDown(event, key, position.x, position.y, card);
  }

  private renderTodo(hobby: HobbyNode, todo: TodoNode, parent: HTMLElement) {
    const node = parent.createDiv({ cls: `hobby-atlas-todo ${todo.done ? 'is-completed' : 'is-active'}` });
    const status = node.createEl('button', { cls: 'hobby-atlas-todo-status', attr: { 'aria-label': todo.done ? '标记为未完成' : '标记为完成' } }); status.textContent = todo.done ? '✓' : '○'; status.onclick = (event) => { event.stopPropagation(); void this.toggleTodo(hobby, todo); };
    const body = node.createDiv({ cls: 'hobby-atlas-todo-body' }); body.createDiv({ text: todo.text, cls: 'hobby-atlas-todo-text' }); body.createDiv({ text: todo.done ? '已完成' : `Todo · ${hobby.name}`, cls: 'hobby-atlas-todo-meta' });
    const actions = node.createDiv({ cls: 'hobby-atlas-todo-actions' });
    const edit = actions.createEl('button', { attr: { 'aria-label': '编辑 Todo' } }); setIcon(edit, 'pencil'); edit.onclick = (event) => { event.stopPropagation(); void this.editTodo(hobby, todo); };
    const remove = actions.createEl('button', { attr: { 'aria-label': '删除 Todo' } }); setIcon(remove, 'trash-2'); remove.onclick = (event) => { event.stopPropagation(); void this.deleteTodo(hobby, todo); };
    node.onclick = (event) => { event.stopPropagation(); if (this.consumeSuppressedClick()) return; void this.openTodoDocument(hobby, todo); };
    node.ondblclick = (event) => { event.stopPropagation(); if (this.consumeSuppressedClick()) return; void this.openTodoDocument(hobby, todo); };
    node.onpointerdown = (event) => event.stopPropagation();
  }

  private renderEdge(key: string, x1: number, y1: number, x2: number, y2: number, cls: string, parentKey?: string) {
    // Obsidian versions differ in how createSvg handles a space-separated `cls`.
    // Create the element without classes, then add each class independently.
    const edge = this.edgesEl.createSvg('line');
    cls.split(/\s+/).filter(Boolean).forEach((name) => edge.addClass(name));
    edge.setAttr('data-edge-key', key);
    if (parentKey) edge.setAttr('data-parent-key', parentKey);
    edge.setAttr('x1', `${x1}`); edge.setAttr('y1', `${y1}`); edge.setAttr('x2', `${x2}`); edge.setAttr('y2', `${y2}`);
  }

  private async readHobbies(): Promise<HobbyNode[]> {
    const rootFolder = this.pluginRef.settings.rootFolder;
    // 只读取设置指定根目录下的文档，避免把 Vault 其他位置的笔记误识别为 Hobby。
    const files = this.appRef.vault.getMarkdownFiles().filter((file) => {
      if (!file.path.startsWith(`${rootFolder}/`)) return false;
      if (file.path.includes(`/${TODOS_FOLDER}/`)) return false;
      const relative = file.path.slice(`${rootFolder}/`.length).split('/');
      return relative.length === 1 || relative.length === 2;
    });
    const hobbies: HobbyNode[] = [];
    const seen = new Set<string>();
    for (const file of files) {
      const content = await this.appRef.vault.read(file);
      const relative = file.path.slice(`${rootFolder}/`.length).split('/');
      const name = relative.length > 1 ? relative[0] : file.basename;
      const hasTodoSection = /^##\s+Todos\s*$/im.test(content) || /^\s*-\s*\[[ xX]\]\s+.+$/m.test(content);
      const hasHobbyFrontmatter = /^type:\s*hobby\s*$/im.test(content);
      const childName = relative.length === 2 ? relative[1].replace(/\.md$/i, '').toLowerCase() : '';
      const canonicalChild = relative.length === 2 && ['index', 'readme', relative[0].toLowerCase()].includes(childName);
      if (relative.length === 2 && !canonicalChild && !hasTodoSection && !hasHobbyFrontmatter) continue;
      const identity = name.normalize('NFKC').trim().toLocaleLowerCase();
      if (seen.has(identity)) continue;
      seen.add(identity);
      hobbies.push({ name, path: file.path, x: 0, y: 0, todos: this.parseTodos(name, content) });
    }
    return hobbies.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  }

  private parseTodos(hobbyName: string, content: string): TodoNode[] {
    const todos: TodoNode[] = [];
    for (const line of content.split(/\r?\n/)) {
      const match = line.match(/^\s*-\s*\[([ xX])\]\s+(.+?)\s*$/);
      if (!match) continue;
      const done = match[1].toLowerCase() === 'x';
      const raw = match[2];
      const link = raw.match(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/);
      const target = link?.[1] ? this.resolveTodoTarget(hobbyName, link[1]) : `${this.pluginRef.settings.rootFolder}/${hobbyName}/${TODOS_FOLDER}/${this.fileSafeName(raw)}.md`;
      const text = (link?.[2] ?? link?.[1]?.split('/').pop() ?? raw).replace(/\.md$/, '').trim();
      const path = normalizePath(target.endsWith('.md') ? target : `${target}.md`);
      todos.push({ id: path, text, done, path, x: 0, y: 0 });
    }
    return todos;
  }

  private async createHobby() {
    const name = await this.askForText('新建 Hobby', '例如：摄影、植物、音乐', '创建');
    if (!name) return;
    const path = normalizePath(`${this.pluginRef.settings.rootFolder}/${name}.md`);
    const existing = await this.readHobbies();
    if (this.appRef.vault.getAbstractFileByPath(path) || existing.some((hobby) => hobby.name.normalize('NFKC').trim().toLocaleLowerCase() === name.normalize('NFKC').trim().toLocaleLowerCase())) { new Notice('这个 Hobby 已经存在'); return; }
    await this.appRef.vault.create(path, `# ${name}\n\n## 简介\n\n\n## Todos\n\n`);
    new Notice(`已创建 Hobby：${name}`); await this.refresh();
  }

  private async rearrange() {
    Object.keys(this.state.positions).filter((key) => key.startsWith('hobby:') || key.startsWith('card:')).forEach((key) => delete this.state.positions[key]);
    await this.refresh();
  }

  private async createTodo(initialHobby?: string) {
    const hobbies = await this.readHobbies();
    if (!hobbies.length) { new Notice('请先创建一个 Hobby'); return; }
    const details = await this.askForTodo(hobbies, initialHobby);
    if (!details) return;
    const hobby = hobbies.find((item) => item.name === details.hobbyName);
    if (!hobby) return;
    const path = normalizePath(`${this.pluginRef.settings.rootFolder}/${hobby.name}/${TODOS_FOLDER}/${this.fileSafeName(details.text)}.md`);
    if (this.appRef.vault.getAbstractFileByPath(path)) { new Notice('这个 Todo 文档已经存在'); return; }
    await this.ensureFolder(`${this.pluginRef.settings.rootFolder}/${hobby.name}/${TODOS_FOLDER}`);
    await this.appRef.vault.create(path, this.todoMarkdown(hobby, details.text, false));
    const updated = [...hobby.todos, { id: path, text: details.text, done: false, path, x: 0, y: 0 }];
    await this.writeHobbyTodos(hobby, updated);
    new Notice(`已创建 Todo：${details.text}`); await this.refresh();
  }

  private async toggleTodo(hobby: HobbyNode, todo: TodoNode) {
    todo.done = !todo.done;
    await this.updateTodoDocument(todo, hobby);
    await this.writeHobbyTodos(hobby, hobby.todos);
    await this.refresh();
  }

  private async editTodo(hobby: HobbyNode, todo: TodoNode) {
    const text = await this.askForText('编辑 Todo', todo.text, '保存');
    if (!text || text === todo.text) return;
    const nextPath = normalizePath(`${this.pluginRef.settings.rootFolder}/${hobby.name}/${TODOS_FOLDER}/${this.fileSafeName(text)}.md`);
    if (nextPath !== todo.path && this.appRef.vault.getAbstractFileByPath(nextPath)) { new Notice('这个 Todo 文档已经存在'); return; }
    const oldFile = this.appRef.vault.getAbstractFileByPath(todo.path);
    if (oldFile instanceof TFile && oldFile.path !== nextPath) await this.appRef.vault.rename(oldFile, nextPath);
    else if (!oldFile) { await this.ensureFolder(`${this.pluginRef.settings.rootFolder}/${hobby.name}/${TODOS_FOLDER}`); await this.appRef.vault.create(nextPath, this.todoMarkdown(hobby, text, todo.done)); }
    todo.text = text; todo.path = nextPath; todo.id = nextPath;
    await this.updateTodoDocument(todo, hobby); await this.writeHobbyTodos(hobby, hobby.todos); await this.refresh();
  }

  private async deleteTodo(hobby: HobbyNode, todo: TodoNode) {
    if (!window.confirm(`删除 Todo“${todo.text}”及其文档？`)) return;
    const file = this.appRef.vault.getAbstractFileByPath(todo.path);
    if (file instanceof TFile) await this.appRef.vault.delete(file);
    hobby.todos = hobby.todos.filter((item) => item.path !== todo.path);
    delete this.state.positions[`todo:${todo.path}`];
    await this.writeHobbyTodos(hobby, hobby.todos); await this.refresh();
  }

  private async updateTodoDocument(todo: TodoNode, hobby: HobbyNode) {
    const file = this.appRef.vault.getAbstractFileByPath(todo.path);
    const markdown = this.todoMarkdown(hobby, todo.text, todo.done);
    if (file instanceof TFile) await this.appRef.vault.modify(file, markdown);
    else { await this.ensureFolder(`${this.pluginRef.settings.rootFolder}/${hobby.name}/${TODOS_FOLDER}`); await this.appRef.vault.create(todo.path, markdown); }
  }

  private async writeHobbyTodos(hobby: HobbyNode, todos: TodoNode[]) {
    const file = this.appRef.vault.getAbstractFileByPath(hobby.path);
    if (!(file instanceof TFile)) return;
    const original = await this.appRef.vault.read(file);
    const before = original.split(/^##\s+Todos\s*$/im)[0].trimEnd();
    const lines = todos.map((todo) => `- [${todo.done ? 'x' : ' '}] [[${todo.path.replace(/\.md$/, '')}|${todo.text}]]`);
    await this.appRef.vault.modify(file, `${before}\n\n## Todos\n\n${lines.join('\n')}${lines.length ? '\n' : ''}`);
  }

  private todoMarkdown(hobby: HobbyNode, text: string, done: boolean) { return `---\ntype: hobby-todo\nhobby: "[[${hobby.path.replace(/\.md$/, '')}]]"\nstatus: ${done ? 'done' : 'todo'}\n---\n\n# ${text}\n\n所属 Hobby：[[${hobby.path.replace(/\.md$/, '')}]]\n`; }
  private async ensureFolder(path: string) { const parts = normalizePath(path).split('/'); let current = ''; for (const part of parts) { current = current ? `${current}/${part}` : part; if (!this.appRef.vault.getAbstractFileByPath(current)) await this.appRef.vault.createFolder(current); } }
  private fileSafeName(text: string) { return text.trim().replace(/[\\/:*?"<>|#\[\]]/g, ' ').replace(/\s+/g, ' ').slice(0, 80) || '未命名 Todo'; }

  private askForText(title: string, placeholder: string, action: string): Promise<string | null> { return new Promise((resolve) => { const modal = this.contentEl.createDiv({ cls: 'hobby-atlas-modal-backdrop' }); const card = modal.createDiv({ cls: 'hobby-atlas-modal' }); card.createEl('h3', { text: title }); const input = card.createEl('input', { type: 'text', placeholder }); const actions = card.createDiv({ cls: 'hobby-atlas-modal-actions' }); const cancel = actions.createEl('button', { text: '取消' }); const confirm = actions.createEl('button', { text: action, cls: 'mod-cta' }); const close = (value: string | null) => { modal.remove(); resolve(value); }; cancel.onclick = () => close(null); confirm.onclick = () => close(input.value.trim() || null); modal.onclick = (event) => { if (event.target === modal) close(null); }; input.onkeydown = (event) => { if (event.key === 'Enter') confirm.click(); if (event.key === 'Escape') close(null); }; input.focus(); }); }

  private askForTodo(hobbies: HobbyNode[], initialHobby?: string): Promise<{ hobbyName: string; text: string } | null> { return new Promise((resolve) => { const modal = this.contentEl.createDiv({ cls: 'hobby-atlas-modal-backdrop' }); const card = modal.createDiv({ cls: 'hobby-atlas-modal' }); card.createEl('h3', { text: '新建 Todo' }); const select = card.createEl('select', { cls: 'hobby-atlas-select' }); hobbies.forEach((hobby) => select.createEl('option', { text: hobby.name, value: hobby.name })); if (initialHobby) select.value = initialHobby; const input = card.createEl('input', { type: 'text', placeholder: '例如：完成第一次观鸟记录' }); const actions = card.createDiv({ cls: 'hobby-atlas-modal-actions' }); const cancel = actions.createEl('button', { text: '取消' }); const confirm = actions.createEl('button', { text: '创建', cls: 'mod-cta' }); const close = (value: { hobbyName: string; text: string } | null) => { modal.remove(); resolve(value); }; cancel.onclick = () => close(null); confirm.onclick = () => close(input.value.trim() ? { hobbyName: select.value, text: input.value.trim() } : null); modal.onclick = (event) => { if (event.target === modal) close(null); }; input.onkeydown = (event) => { if (event.key === 'Enter') confirm.click(); if (event.key === 'Escape') close(null); }; input.focus(); }); }

  private onCanvasPointerDown(event: PointerEvent) { if (event.target !== this.canvasEl && event.target !== this.worldEl) return; this.canvasEl.setPointerCapture(event.pointerId); this.panDrag = { startX: event.clientX, startY: event.clientY, panX: this.state.panX, panY: this.state.panY }; this.canvasEl.addClass('is-panning'); }
  private onCanvasPointerMove(event: PointerEvent) { if (this.nodeDrag) { const point = this.pointerWorldPoint(event); const previousX = this.nodeDrag.x; const previousY = this.nodeDrag.y; const nextX = point.x - this.nodeDrag.grabX; const nextY = point.y - this.nodeDrag.grabY; const deltaX = nextX - previousX; const deltaY = nextY - previousY; if (Math.abs(deltaX) + Math.abs(deltaY) > 1) this.dragMoved = true; this.nodeDrag.x = nextX; this.nodeDrag.y = nextY; const node = Array.from(this.worldEl.querySelectorAll<HTMLElement>('.hobby-atlas-node')).find((item) => item.dataset.nodeKey === this.nodeDrag?.key); if (node) { node.style.left = `${this.nodeDrag.x}px`; node.style.top = `${this.nodeDrag.y}px`; } const edge = Array.from(this.edgesEl.querySelectorAll<SVGLineElement>('line')).find((item) => item.dataset.edgeKey === `edge:${this.nodeDrag?.key}`); if (edge) { edge.setAttr('x2', `${this.nodeDrag.x}`); edge.setAttr('y2', `${this.nodeDrag.y}`); } if (this.nodeDrag.key.startsWith('hobby:')) { this.edgesEl.querySelectorAll<SVGLineElement>(`line[data-parent-key="${CSS.escape(this.nodeDrag.key)}"]`).forEach((childEdge) => { childEdge.setAttr('x1', `${this.nodeDrag!.x}`); childEdge.setAttr('y1', `${this.nodeDrag!.y}`); const childKey = childEdge.dataset.edgeKey?.replace(/^edge:/, ''); if (!childKey) return; const childNode = this.worldEl.querySelector<HTMLElement>(`[data-node-key="${CSS.escape(childKey)}"]`); if (childNode) { const left = Number.parseFloat(childNode.style.left) || 0; const top = Number.parseFloat(childNode.style.top) || 0; childNode.style.left = `${left + deltaX}px`; childNode.style.top = `${top + deltaY}px`; this.state.positions[childKey] = { x: left + deltaX, y: top + deltaY }; childEdge.setAttr('x2', `${left + deltaX}`); childEdge.setAttr('y2', `${top + deltaY}`); } }); } return; } if (!this.panDrag) return; this.state.panX = this.panDrag.panX + event.clientX - this.panDrag.startX; this.state.panY = this.panDrag.panY + event.clientY - this.panDrag.startY; this.applyTransform(); }
  private onNodePointerDown(event: PointerEvent, key: string, fallbackX: number, fallbackY: number, node: HTMLElement) {
    if ((event.target as HTMLElement).closest('button')) return;
    event.stopPropagation();
    if (event.button !== 0) return;
    // The handler is created during render, so its fallback coordinates can be
    // stale after a previous drag. Always prefer the latest saved/DOM position.
    const saved = this.finitePosition(this.state.positions[key]);
    const domX = Number.parseFloat(node.style.left);
    const domY = Number.parseFloat(node.style.top);
    const x = saved?.x ?? (Number.isFinite(domX) ? domX : fallbackX);
    const y = saved?.y ?? (Number.isFinite(domY) ? domY : fallbackY);
    node.setPointerCapture(event.pointerId);
    const point = this.pointerWorldPoint(event);
    this.dragMoved = false;
    this.nodeDrag = { key, grabX: point.x - x, grabY: point.y - y, x, y };
    node.addClass('is-dragging');
  }
  private onPointerUp() { this.canvasEl.removeClass('is-panning'); this.worldEl.querySelectorAll('.is-dragging').forEach((el) => el.removeClass('is-dragging')); if (this.nodeDrag) { this.state.positions[this.nodeDrag.key] = { x: this.nodeDrag.x, y: this.nodeDrag.y }; if (this.dragMoved) { this.suppressClick = true; window.setTimeout(() => { this.suppressClick = false; }, 0); } void this.saveState(); } this.panDrag = null; this.nodeDrag = null; }
  private onWheel(event: WheelEvent) { event.preventDefault(); if (event.ctrlKey || event.metaKey || event.altKey) { this.adjustZoom(event.deltaY > 0 ? -0.08 : 0.08); return; } this.state.panX -= event.deltaX; this.state.panY -= event.deltaY; this.applyTransform(); void this.saveState(); }
  private applyTransform() { this.worldEl.style.transform = `translate(${this.state.panX}px, ${this.state.panY}px) scale(${this.state.zoom})`; this.zoomLabel.textContent = `${Math.round(this.state.zoom * 100)}%`; }
  private adjustZoom(delta: number) { this.state.zoom = Math.max(0.35, Math.min(2.2, this.state.zoom + delta)); this.applyTransform(); void this.saveState(); }
  private pointerWorldPoint(event: PointerEvent): Position { const rect = this.canvasEl.getBoundingClientRect(); return { x: (event.clientX - rect.left - rect.width / 2 - this.state.panX) / this.state.zoom, y: (event.clientY - rect.top - rect.height / 2 - this.state.panY) / this.state.zoom }; }
  private consumeSuppressedClick() { if (!this.suppressClick) return false; this.suppressClick = false; return true; }

  private getPosition(key: string, legacyKey?: string) { return this.state.positions[key] ?? (legacyKey ? this.state.positions[legacyKey] : undefined); }
  private finitePosition(position: Position | undefined) { return position && Number.isFinite(position.x) && Number.isFinite(position.y) ? position : undefined; }
  private uniquePosition(saved: Position | undefined, index: number, count: number, radius: number, occupied: Position[]) {
    // Saved positions belong to the user; only auto-place newly created nodes.
    if (saved) return saved;
    for (let attempt = 0; attempt < 40; attempt++) {
      const candidate = this.radialPosition(index + attempt * 0.23, count, radius + Math.floor(attempt / 8) * 80, -Math.PI / 2);
      if (!occupied.some((item) => Math.hypot(item.x - candidate.x, item.y - candidate.y) < 190)) return candidate;
    }
    return this.radialPosition(index, count, radius, -Math.PI / 2);
  }
  private radialPosition(index: number, count: number, radius: number, offset: number): Position { const angle = offset + index * (Math.PI * 2 / Math.max(count, 1)); return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius }; }
  private todoPosition(hobby: HobbyNode, index: number, count: number, radius: number): Position { const angle = -Math.PI / 2 + index * (Math.PI * 2 / Math.max(count, 1)); return { x: hobby.x + Math.cos(angle) * radius, y: hobby.y + Math.sin(angle) * radius }; }
  private defaultCardPosition(hobby: HobbyNode): Position {
    const distance = Math.hypot(hobby.x, hobby.y);
    if (distance < 1) return { x: hobby.x, y: hobby.y + 225 };
    const directionX = hobby.x / distance;
    const directionY = hobby.y / distance;
    return { x: hobby.x + directionX * 235, y: hobby.y + directionY * 235 };
  }
  private resolveTodoTarget(hobbyName: string, target: string) {
    const rootFolder = this.pluginRef.settings.rootFolder;
    if (target.startsWith(`${rootFolder}/`)) return target;
    if (target.startsWith(`${HOBBY_FOLDER}/`)) return `${rootFolder}/${target.slice(`${HOBBY_FOLDER}/`.length)}`;
    if (target.startsWith(`${hobbyName}/`)) return `${rootFolder}/${target}`;
    return `${rootFolder}/${hobbyName}/${TODOS_FOLDER}/${target}`;
  }
  private async openDocument(path: string) { await this.appRef.workspace.openLinkText(path.replace(/\.md$/, ''), '', true); }
  private async openTodoDocument(hobby: HobbyNode, todo: TodoNode) {
    if (!this.appRef.vault.getAbstractFileByPath(todo.path)) {
      await this.ensureFolder(`${this.pluginRef.settings.rootFolder}/${hobby.name}/${TODOS_FOLDER}`);
      await this.appRef.vault.create(todo.path, this.todoMarkdown(hobby, todo.text, todo.done));
    }
    await this.openDocument(todo.path);
  }
  private pluginData() { return (this.appRef as App & { plugins: { getPlugin: (id: string) => Plugin & { saveData?: (data: unknown) => Promise<void>; data?: Record<string, unknown> } | null } }).plugins.getPlugin('hobby-atlas'); }
  private async loadState(): Promise<ViewState> { const raw = this.pluginData()?.data as { viewState?: Partial<ViewState> } | undefined; const saved = raw?.viewState; return { panX: saved?.panX ?? DEFAULT_STATE.panX, panY: saved?.panY ?? DEFAULT_STATE.panY, zoom: saved?.zoom ?? DEFAULT_STATE.zoom, positions: saved?.positions ?? {} }; }
  private async saveState() { const plugin = this.pluginData(); if (!plugin?.saveData) return; const next = { ...(plugin.data ?? {}), viewState: this.state }; plugin.data = next; await plugin.saveData(next); }
  private emojiFor(name: string) { if (/鸟|动物|龙/.test(name)) return '🪶'; if (/植物|花|园艺/.test(name)) return '🌿'; if (/摄影|照片/.test(name)) return '◉'; if (/音乐|乐器/.test(name)) return '♫'; if (/技术|编程|代码/.test(name)) return '⌘'; return '✦'; }
}
