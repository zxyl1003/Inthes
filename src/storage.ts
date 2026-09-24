import type { Profile, Session, State, MinerUSettings, SourceImage } from './types.ts';
import { mineruCredential } from './mineru.ts';
import { validateSessions, validateState } from './validation.ts';
import { PdfCache } from './cache.ts';
import { figureAssetName, figureMetadata, saveFigure } from './figure-assets.ts';
export class Storage {
  dir = PathUtils.join(Zotero.Profile.dir, 'folio');
  state: State = { version: 1, profiles: [], selected: '', remember: true, sessions: [], historyFormat: 2 };
  historyError = '';
  historyWarning = '';
  cache = new PdfCache(() => this.state.cachePath || PathUtils.join(this.dir, 'pdf-cache'), () => this.state.cacheEnabled !== false);
  private queue = Promise.resolve();
  async init() {
    await IOUtils.makeDirectory(this.dir, { ignoreExisting: true });
    const path = PathUtils.join(this.dir, 'state.json');
    if (!await IOUtils.exists(path)) return;
    const saved = validateState(await IOUtils.readJSON(path));
    this.state = saved;
    try { this.state.sessions = !saved.historyPath && !await IOUtils.exists(PathUtils.join(this.dir, 'folio-history.json')) ? [] : await this.readHistory(saved.historyPath || this.dir); }
    catch (error) { this.state.sessions = []; this.historyError = `无法读取对话历史，请检查保存位置：${(error as Error).message}`; }
    try {await this.cache.pruneOldBundles();}
    catch(error){Zotero.debug(`Inthes cache cleanup: ${(error as Error).message}`);}
  }

  private async readHistory(directory: string): Promise<Session[]> {
    const saved = await IOUtils.readJSON(PathUtils.join(directory, 'folio-history.json'));
    if (saved.version !== 1) throw new Error('该文件夹中的 Inthes 历史格式不兼容');
    const sessions = validateSessions(saved.sessions);
    for (const session of sessions) for (const source of session.sources) if (source.image) {
      source.image = { ...figureMetadata(source.image), directory: PathUtils.join(directory, 'folio-history-images') };
    }
    for (const session of sessions) for (const message of session.messages) if (message.generatedImages) message.generatedImages=message.generatedImages.map(image=>({...figureMetadata(image),directory:PathUtils.join(directory,'folio-history-images')}));
    return sessions;
  }
  private async writeState() {
    const path = PathUtils.join(this.dir, 'state.json');
    await IOUtils.writeUTF8(path, JSON.stringify({ ...this.state, historyFormat: 2, sessions: [] }), { tmpPath: path + '.tmp' });
  }
  private async writeHistory() {
    if (this.historyError) throw new Error(this.historyError);
    const directory = this.state.historyPath || this.dir;
    const path = PathUtils.join(directory, 'folio-history.json');
    const snapshot = this.state.sessions, sessions: Session[] = [];
    const imageErrors = new Map<string, string>();
    const saveImage = async <T extends SourceImage>(image: T) => {
      try { return await saveFigure(image, PathUtils.join(directory, 'folio-history-images')); }
      catch (error) {
        imageErrors.set(image.asset, (error as Error).message);
        return image;
      }
    };
    for (const session of snapshot) {
      const sources = [];
      for (const source of session.sources) sources.push(source.image ? { ...source, image: await saveImage(source.image) } : source);
      const messages=[];
      for(const message of session.messages){const generatedImages=[];for(const image of message.generatedImages||[])generatedImages.push(await saveImage(image));messages.push({...message,...(message.generatedImages?{generatedImages}:{})});}
      sessions.push({ ...session, sources, messages });
    }
    await IOUtils.makeDirectory(directory, { ignoreExisting: true, createAncestors: true });
    await IOUtils.writeUTF8(path, JSON.stringify({ version: 1, sessions: sessions.map(session => ({ ...session, messages:session.messages.map(message=>({...message,...(message.generatedImages?{generatedImages:message.generatedImages.map(figureMetadata)}:{})})), sources: session.sources.map(source => source.image ? { ...source, image: figureMetadata(source.image) } : source) })) }), { tmpPath: path + '.tmp' });
    if (this.state.sessions === snapshot) for (let i = 0; i < sessions.length; i++) snapshot[i] = sessions[i];
    this.historyWarning = imageErrors.size ? `对话记录已保存，但 ${imageErrors.size} 张图片未能保存或找回。请检查原图片文件及保存目录。${[...imageErrors.values()][0]}` : '';
  }
  private enqueue(work: () => Promise<void>) { this.queue = this.queue.catch(() => {}).then(work); return this.queue; }
  save() { return this.enqueue(() => this.writeState()); }
  updateSession(id: string, patch: Pick<Session, 'title' | 'renamed'> | Partial<Pick<Session, 'pinned' | 'archived'>>) {
    return this.enqueue(async () => {
      const previous = this.state.sessions;
      if (!previous.some(s => s.id === id)) throw new Error('这条对话已不存在');
      this.state.sessions = previous.map(s => s.id === id ? { ...s, ...patch } : s);
      try { await this.writeHistory(); }
      catch (error) { this.state.sessions = previous; throw error; }
    });
  }
  storeSession(session: Session) {
    const snapshot = structuredClone(session);
    const generated = session.messages.map(message => ({ message, images: [...(message.generatedImages || [])] }));
    return this.enqueue(async () => {
      const previous = this.state.sessions, saved = previous.find(s => s.id === snapshot.id);
      if (saved) {
        snapshot.pinned = saved.pinned; snapshot.archived = saved.archived; snapshot.renamed = saved.renamed;
        if (saved.renamed) snapshot.title = saved.title;
      }
      this.state.sessions = [snapshot, ...previous.filter(s => s.id !== snapshot.id)];
      try { await this.writeHistory(); }
      catch (error) { this.state.sessions = previous; throw error; }
      const stored = this.state.sessions.find(s => s.id === snapshot.id)!;
      for (const [index, entry] of generated.entries()) {
        if (session.messages[index] !== entry.message || !entry.message.generatedImages) continue;
        entry.message.generatedImages = entry.message.generatedImages.map(image => {
          const i = entry.images.indexOf(image);
          return i < 0 ? image : stored.messages[index].generatedImages![i];
        });
      }
    });
  }
  deleteSessions(ids: string[], openSessions: () => Session[] = () => []) {
    return this.enqueue(async () => {
      const previous = this.state.sessions;
      this.state.sessions = previous.filter(s => !ids.includes(s.id));
      try { await this.writeHistory(); }
      catch (error) { this.state.sessions = previous; throw error; }
      const directory = PathUtils.join(this.state.historyPath || this.dir, 'folio-history-images');
      const retained = new Set<string>();
      for (const session of [...this.state.sessions, ...openSessions()]) {
        for (const source of session.sources) if (source.image) retained.add(source.image.asset);
        for (const message of session.messages) for (const image of message.generatedImages || []) retained.add(image.asset);
      }
      try {
        if (await IOUtils.exists(directory)) for (const file of await IOUtils.getChildren(directory)) {
          const name = PathUtils.filename(file);
          if (figureAssetName.test(name.replace(/\.tmp$/, '')) && !retained.has(name.replace(/\.tmp$/, '')) && (await IOUtils.stat(file)).type === 'regular') await IOUtils.remove(file);
        }
      } catch (error) { throw new Error(`对话记录已删除，但部分无引用图片未能清理：${(error as Error).message}`); }
    });
  }
  setHistoryPath(value: string) {
    const directory = value.trim();
    if (directory && !PathUtils.isAbsolute(directory)) throw new Error('请填写文件夹的完整路径，或留空使用默认位置');
    return this.enqueue(async () => {
      if (directory === (this.state.historyPath || '') && !this.historyError) return;
      const destination = directory || this.dir;
      const existing = (await IOUtils.exists(PathUtils.join(destination, 'folio-history.json')) || (!!this.historyError && directory === (this.state.historyPath || ''))) ? await this.readHistory(destination) : [];
      const previousPath = this.state.historyPath, previousSessions = this.state.sessions, previousError = this.historyError;
      const merged = new Map<string, Session>();
      for (const session of [...existing, ...this.state.sessions]) {
        const old = merged.get(session.id);
        if (!old || session.updated >= old.updated) merged.set(session.id, session);
      }
      const sessions = [...merged.values()].sort((a, b) => b.updated - a.updated);
      this.state.historyPath = directory || undefined; this.state.sessions = sessions; this.historyError = '';
      try { await this.writeHistory(); await this.writeState(); }
      catch (error) {
        this.state.historyPath = previousPath; this.historyError = previousError;
        if (this.state.sessions === sessions) this.state.sessions = previousSessions;
        throw error;
      }
    });
  }
  setCacheEnabled(enabled: boolean) {
    return this.enqueue(async () => {
      const previous = this.state.cacheEnabled;
      this.state.cacheEnabled = enabled; this.cache.invalidate();
      try { await this.writeState(); }
      catch (error) { this.state.cacheEnabled = previous; this.cache.invalidate(); throw error; }
    });
  }
  setMinerU(settings: MinerUSettings, token: string) {
    return this.enqueue(async () => {
      const previous = this.state.mineru, oldKey = this.getKey(mineruCredential);
      if (settings.enabled && !token.trim()) throw new Error('请先填写 MinerU API Token');
      await this.setKey(mineruCredential, token.trim()); this.state.mineru = settings;
      try { await this.writeState(); this.cache.invalidate(); }
      catch (error) { this.state.mineru = previous; await this.setKey(mineruCredential, oldKey); throw error; }
    });
  }
  setCachePath(value: string) {
    const directory = value.trim();
    if (directory && !PathUtils.isAbsolute(directory)) throw new Error('请填写缓存文件夹的完整路径，或留空使用默认位置');
    return this.enqueue(async () => {
      const old = this.state.cachePath;
      await IOUtils.makeDirectory(directory || PathUtils.join(this.dir, 'pdf-cache'), { ignoreExisting: true, createAncestors: true });
      this.state.cachePath = directory || undefined;
      try { await this.writeState(); this.cache.invalidate(); }
      catch (error) { this.state.cachePath = old; throw error; }
    });
  }
  private logins(id: string) { return Services.logins.findLogins('chrome://folio', null, 'Folio API').filter((l: any) => l.username === id); }
  getKey(id: string): string { return this.logins(id)[0]?.password || ''; }
  async setKey(id: string, key: string) {
    const old = this.logins(id)[0];
    if (!key) { if (old) Services.logins.removeLogin(old); return; }
    const login = Cc['@mozilla.org/login-manager/loginInfo;1'].createInstance(Ci.nsILoginInfo);
    login.init('chrome://folio', null, 'Folio API', id, key, '', '');
    if (old) Services.logins.modifyLogin(old, login);
    else await Services.logins.addLoginAsync(login);
  }
  private changeProfile(change: () => void, id: string, key: string) {
    return this.enqueue(async () => {
      const profiles = this.state.profiles, selected = this.state.selected, oldKey = this.getKey(id);
      await this.setKey(id, key);
      change();
      try { await this.writeState(); }
      catch (error) {
        this.state.profiles = profiles; this.state.selected = selected;
        try { await this.setKey(id, oldKey); }
        catch { throw new Error('连接配置保存失败，且凭据恢复失败；请重新填写此连接的 API Key'); }
        throw error;
      }
    });
  }
  saveProfile(p: Profile, key: string) {
    return this.changeProfile(() => {
      this.state.profiles = this.state.profiles.some(x => x.id === p.id) ? this.state.profiles.map(x => x.id === p.id ? p : x) : [...this.state.profiles, p];
      if (!this.state.selected) this.state.selected = p.id;
    }, p.id, key);
  }
  deleteProfile(p: Profile) {
    return this.changeProfile(() => {
      this.state.profiles = this.state.profiles.filter(x => x.id !== p.id);
      if (this.state.selected === p.id) this.state.selected = this.state.profiles[0]?.id || '';
    }, p.id, '');
  }
}
