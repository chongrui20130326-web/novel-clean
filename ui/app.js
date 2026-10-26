/* global localStorage, fetch, TextEncoder */

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

// DSH 右侧栏用 iframe 嵌入时，页面可能拿到比面板更宽的布局视口。
// 用 data-embed 强制单列窄版，避免标题和导入卡被面板裁掉。
try {
  if (window.self !== window.top) document.documentElement.dataset.embed = '1';
} catch {
  document.documentElement.dataset.embed = '1';
}
if (new URLSearchParams(location.search).has('embed') || /Electron/i.test(navigator.userAgent)) {
  document.documentElement.dataset.embed = '1';
}

const TYPE_META = {
  truncation: { no: '01', label: '语句截断', short: '截断', color: 'rust' },
  chapter: { no: '02', label: '章节连续', short: '章节', color: 'amber' },
  irrelevant: { no: '03', label: '无关内容', short: '广告', color: 'violet' },
  blank: { no: '04', label: '多余空行', short: '空行', color: 'mute' },
  indent: { no: '05', label: '段落缩进', short: '缩进', color: 'jade' },
  encoding: { no: '06', label: '文本编码', short: '编码', color: 'jade' },
  invisible: { no: '07', label: '不可见字符', short: '不可见', color: 'violet' },
};

const TYPE_ORDER = ['truncation', 'chapter', 'irrelevant', 'blank', 'indent', 'encoding', 'invisible'];

const state = {
  health: null,
  selectedModel: localStorage.getItem('novelclean.model') || '',
  useAi: localStorage.getItem('novelclean.useAi') !== '0',
  jobId: '',
  summary: null,
  issues: [],
  blocks: [],
  filter: 'all',
  railFilter: 'all',
  onlyChanged: false,
  showSpaces: true,
  q: '',
  offset: 0,
  limit: 'all',
  disabled: new Set(),
  activeIssue: '',
  busy: false,
  pollTimer: null,
  pollToken: 0,
  logs: [],
  lastScroll: 0,
  renderToken: 0,
  pendingImport: null,
};

let applyTimer = null;
let searchTimer = null;
let toastTimer = null;

/* ============================================================
   Tiny helpers
   ============================================================ */

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString('zh-CN');
}

function formatDuration(ms) {
  if (!ms) return '0.0s';
  return `${(ms / 1000).toFixed(1)}s`;
}

function toast(message, kind = '') {
  const element = $('#toast');
  element.textContent = message;
  element.className = `toast ${kind}`.trim();
  element.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { element.hidden = true; }, kind === 'error' ? 8000 : 3200);
}

function showImportError(message) {
  const element = $('#importError');
  element.textContent = message;
  element.hidden = false;
  element.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  console.error('[import]', message);
}

function clearImportError() {
  const element = $('#importError');
  element.hidden = true;
  element.textContent = '';
}

async function api(path, options = {}) {
  const response = await fetch(path, options);
  const contentType = response.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) {
    const message = typeof data === 'object' ? data.error : data;
    throw new Error(message || `请求失败（${response.status}）`);
  }
  return data;
}

function statusIcon(status) {
  if (status === 'fixed') return '✓';
  if (status === 'warn') return '!';
  if (status === 'review') return '◌';
  return '·';
}

function checkShortDetail(check) {
  switch (check.type) {
    case 'truncation': return check.found ? `${check.found} 处已合并` : '未发现断句';
    case 'chapter':
      if (check.status === 'warn') return `${check.warnCount || 0} 处编号异常`;
      if (check.status === 'fixed') return `${check.formatCount || 0} 个标题已统一`;
      return '编号连续';
    case 'irrelevant': return check.found ? `${check.found} 段已移除` : '未发现广告';
    case 'blank': return check.found ? `${check.found} 组已清理` : '空行正常';
    case 'indent': return check.found ? `${check.found} 段已校正` : '全部 5 空格';
    case 'encoding': return check.found ? '已转为 UTF-8' : '已是 UTF-8';
    case 'invisible': return check.found ? `${check.found} 个已清除` : '未发现';
    default: return check.detail;
  }
}

function layerLabel(issue) {
  if (issue.severity === 'info') return { label: 'AI 保留', className: 'layer-info' };
  if (issue.layer === 'ai') return { label: 'AI 复核', className: 'layer-ai' };
  return { label: '规则', className: 'layer-rule' };
}

function issueTypeLabel(type) {
  return TYPE_META[type]?.label || type;
}

/* ============================================================
   Boot + health
   ============================================================ */

async function boot() {
  bindEvents();
  if (new URLSearchParams(location.search).get('ai') === '0') {
    state.useAi = false;
    localStorage.setItem('novelclean.useAi', '0');
  }
  $('#useAi').checked = state.useAi;
  if (document.documentElement.dataset.embed === '1') {
    // 侧栏里不是浏览器下载，而是服务端写入 Downloads；按钮文案说清楚。
    $('#exportBtn').innerHTML = '导出工程 <span class="btn-arrow">↓</span>';
    $('#exportBtn').title = '导出源文件、目标文件、索引、报告和可重新加载的状态';
  }
  await loadHealth();

  // 服务重启后可以用 ?job=<id> 直接恢复到磁盘里的任务，避免重新导入。
  const jobParam = new URLSearchParams(location.search).get('job');
  if (jobParam) {
    try {
      state.jobId = jobParam;
      const job = await api(`/api/jobs/${jobParam}`);
      await loadWorkspace(job, job.disabled || []);
    } catch (error) {
      showImportError(`恢复任务失败：${error.message}`);
    }
  }
}

async function loadHealth() {
  try {
    const health = await api('/api/health?force=1');
    state.health = health;
    if (!state.selectedModel || !health.models?.some((model) => model.name === state.selectedModel)) {
      state.selectedModel = health.model || health.models?.[0]?.name || '';
    }
    renderHealth();
  } catch (error) {
    state.health = null;
    $('#modelPillText').textContent = '模型路由未连接';
    $('#modelDot').className = 'status-dot bad';
    $('#modelState').innerHTML = '<span class="status-dot bad"></span>未连接';
    $('#modelMeta').textContent = error.message;
    $('#popoverModelMeta').textContent = error.message;
    console.warn(error);
  }
}

function renderHealth() {
  const health = state.health;
  if (!health) return;
  // 先找当前选中的模型。health.modelInfo 是服务端默认模型（9B），
  // 不能让它覆盖用户刚选中的 strata-q*。
  const info = health.models?.find((model) => model.name === state.selectedModel)
    || health.modelInfo
    || null;
  const embedded = document.documentElement.dataset.embed === '1';
  const running = info?.status === 'active' || health.running;
  $('#modelPillText').textContent = embedded
    ? `${info?.parameters || info?.backend || '本地'} · ${health.ok ? '就绪' : '离线'}`
    : `${state.selectedModel.split(':')[0] || '本地'} ${info?.parameters || ''} · ${health.ok ? '就绪' : '未就绪'}`;
  $('#modelDot').className = `status-dot ${health.ok ? 'ok' : 'warn'}`;
  $('#modelState').innerHTML = `<span class="status-dot ${health.ok ? 'ok' : 'warn'}"></span>${health.ok ? (running ? '已加载' : '按需加载') : '未找到模型'}`;
  $('#modelName').textContent = state.selectedModel || health.model || '—';
  $('#modelMeta').textContent = info
    ? [info.backend, info.parameters, info.quantization, info.status].filter(Boolean).join(' · ')
    : (health.gateway?.error || health.ollama?.error || '正在连接本地模型路由…');
  $('#modelCount').textContent = `${(health.models || []).length}`;
  $('#popoverModelName').textContent = state.selectedModel || health.model || '—';
  $('#popoverModelMeta').textContent = health.ok
    ? `${info?.backend || 'router'} · ${info?.parameters || '—'} · ${info?.quantization || '—'} · ${running ? '当前已激活' : '首次调用会加载模型'}`
    : (health.gateway?.error || health.ollama?.error || '模型路由不可达');
  const models = health.models || [];
  $('#popoverModels').innerHTML = models.length
    ? models.map((model) => `
      <button type="button" class="popover-model ${model.name === state.selectedModel ? 'current' : ''}" data-model="${escapeHtml(model.name)}">
        <strong>${escapeHtml(model.name)}</strong>
        <span>${escapeHtml(model.backend || '')}${model.parameters ? ` · ${escapeHtml(model.parameters)}` : ''}${model.quantization ? ` · ${escapeHtml(model.quantization)}` : ''}${model.status === 'active' ? ' · 已激活' : ''}</span>
      </button>`).join('')
    : `<div class="ai-empty">${escapeHtml(health.gateway?.error || health.ollama?.error || '没有发现本地模型')}</div>`;
}

/* ============================================================
   Import
   ============================================================ */

function bindEvents() {
  $('#brandBtn').addEventListener('click', resetToHome);
  $('#backBtn').addEventListener('click', resetToHome);
  $('#newBtn').addEventListener('click', resetToHome);

  $('#chooseBtn').addEventListener('click', () => $('#fileInput').click());
  $('#dropTarget').addEventListener('click', () => $('#fileInput').click());
  $('#dropTarget').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      $('#fileInput').click();
    }
  });
  $('#fileInput').addEventListener('change', (event) => {
    const file = event.target.files?.[0];
    if (file) handleFile(file);
    event.target.value = '';
  });

  for (const eventName of ['dragenter', 'dragover']) {
    $('#dropTarget').addEventListener(eventName, (event) => {
      event.preventDefault();
      $('#dropTarget').classList.add('dragover');
    });
  }
  for (const eventName of ['dragleave', 'drop']) {
    $('#dropTarget').addEventListener(eventName, (event) => {
      event.preventDefault();
      $('#dropTarget').classList.remove('dragover');
    });
  }
  $('#dropTarget').addEventListener('drop', (event) => {
    const file = event.dataTransfer?.files?.[0];
    if (file) handleFile(file);
  });
  document.addEventListener('dragover', (event) => event.preventDefault());
  document.addEventListener('drop', (event) => event.preventDefault());

  $('#useAi').addEventListener('change', (event) => {
    state.useAi = event.target.checked;
    localStorage.setItem('novelclean.useAi', state.useAi ? '1' : '0');
  });

  $$('.sample-link').forEach((button) => {
    button.addEventListener('click', () => loadSample(button.dataset.sample));
  });

  $('#bookStart').addEventListener('click', () => confirmBook(false));
  $('#bookSkip').addEventListener('click', () => confirmBook(true));
  $('#bookClose').addEventListener('click', () => confirmBook(true));
  $('#bookModal').addEventListener('click', (event) => {
    if (event.target === $('#bookModal')) confirmBook(true);
  });
  $('#bookNameInput').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      confirmBook(false);
    }
  });

  $('#openProjectBtn').addEventListener('click', openProject);
  $('#projectPathInput').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      openProject();
    }
  });

  $('#pathBtn').addEventListener('click', startPathAnalysis);
  $('#pathInput').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      startPathAnalysis();
    }
  });

  $('#pasteBtn').addEventListener('click', openPaste);
  $('#pasteClose').addEventListener('click', closePaste);
  $('#pasteCancel').addEventListener('click', closePaste);
  $('#pasteModal').addEventListener('click', (event) => {
    if (event.target === $('#pasteModal')) closePaste();
  });
  $('#pasteText').addEventListener('input', updatePasteCount);
  $('#pasteStart').addEventListener('click', startPaste);

  $('#modelPill').addEventListener('click', toggleModelPopover);
  $('#modelClose').addEventListener('click', closeModelPopover);
  $('#modelRefresh').addEventListener('click', async () => {
    await loadHealth();
    renderHealth();
  });
  document.addEventListener('click', (event) => {
    if ($('#modelPopover').hidden) return;
    if (event.target.closest('#modelPopover') || event.target.closest('#modelPill')) return;
    closeModelPopover();
  });
  $('#popoverModels').addEventListener('click', (event) => {
    const button = event.target.closest('[data-model]');
    if (!button) return;
    state.selectedModel = button.dataset.model;
    localStorage.setItem('novelclean.model', state.selectedModel);
    renderHealth();
    closeModelPopover();
    toast(`已选择 ${state.selectedModel}，下次清洗生效`);
  });

  $('#checkStrip').addEventListener('click', (event) => {
    const button = event.target.closest('[data-check]');
    if (button) setFilter(button.dataset.check);
  });
  $('#filterChips').addEventListener('click', (event) => {
    const button = event.target.closest('[data-filter]');
    if (button) setFilter(button.dataset.filter);
  });
  $('#railTabs').addEventListener('click', (event) => {
    const button = event.target.closest('[data-rail]');
    if (!button) return;
    state.railFilter = button.dataset.rail;
    $$('#railTabs button').forEach((item) => item.classList.toggle('active', item === button));
    renderIssueRail();
  });
  $('#onlyChanged').addEventListener('change', (event) => {
    state.onlyChanged = event.target.checked;
    refreshBlocks(true);
  });
  $('#showSpaces').addEventListener('change', (event) => {
    state.showSpaces = event.target.checked;
    renderRows();
  });
  $('#searchInput').addEventListener('input', (event) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.q = event.target.value.trim();
      refreshBlocks(true);
    }, 320);
  });
  $('#issueToggleBtn').addEventListener('click', openIssueDrawer);
  $('#issueCloseBtn').addEventListener('click', closeIssueDrawer);
  $('#issueBackdrop').addEventListener('click', closeIssueDrawer);

  $('#issueList').addEventListener('click', handleIssueRailClick);
  $('#issueList').addEventListener('change', handleIssueRailChange);
  $('#rows').addEventListener('click', handleRowsClick);

  $('#exportBtn').addEventListener('click', exportText);
  $('#saveClose').addEventListener('click', closeSaveModal);
  $('#saveDone').addEventListener('click', closeSaveModal);
  $('#saveCancel').addEventListener('click', closeSaveModal);
  $('#saveConfirm').addEventListener('click', confirmSave);
  $('#saveCopy').addEventListener('click', () => copySavePath('#savePath'));
  $('#saveCopyReport').addEventListener('click', () => copySavePath('#saveReportPath'));
  $('#saveDirInput').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      confirmSave();
    }
  });
  $('#saveModal').addEventListener('click', (event) => {
    if (event.target === $('#saveModal')) closeSaveModal();
  });

  $('#toggleLogBtn').addEventListener('click', openLog);
  $('#logClose').addEventListener('click', closeLog);
  $('#logDrawer').addEventListener('click', (event) => {
    if (event.target === $('#logDrawer')) closeLog();
  });

  $('#progressErrorBtn').addEventListener('click', () => {
    hideOverlay();
    resetToHome();
  });

  window.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'o') {
      event.preventDefault();
      if (!$('#homeView').hidden) $('#fileInput').click();
    }
    if (event.key === 'Escape') {
      if (!$('#bookModal').hidden) {
        confirmBook(true);
        return;
      }
      closeIssueDrawer();
      closePaste();
      closeModelPopover();
      closeLog();
      closeSaveModal();
    }
  });
}

async function handleFile(file) {
  if (!file) return;
  clearImportError();
  if (file.size > 32 * 1024 * 1024) {
    const message = `「${file.name}」有 ${(file.size / 1024 / 1024).toFixed(1)} MB，超过 32 MB 上限。\n请拆分文件；或者用「粘贴文本」只贴正文部分。`;
    showImportError(message);
    toast('文件超过 32 MB，请拆分后再导入', 'error');
    return;
  }
  if (!file.size) {
    showImportError(`「${file.name}」是空文件（0 字节）。`);
    return;
  }
  try {
    const buffer = await file.arrayBuffer();
    openBookModal({ buffer, name: file.name, contentType: 'application/octet-stream' });
  } catch (error) {
    const message = `读取「${file.name}」失败：${error.message || '浏览器没有返回文件内容'}。\n可以改用「粘贴文本」再试一次。`;
    showImportError(message);
    toast('读取文件失败', 'error');
  }
}

async function loadSample(format) {
  try {
    state.pendingImport = null;
    closeBookModal();
    const response = await fetch(`/api/sample?format=${format}`);
    if (!response.ok) throw new Error('示例加载失败');
    const buffer = await response.arrayBuffer();
    const name = format === 'gbk' ? '雾城来信-GBK旧稿.txt' : '雾城来信-UTF8.txt';
    await startAnalysis(buffer, name, 'application/octet-stream', '', '雾城来信');
  } catch (error) {
    showImportError(`加载示例失败：${error.message}\n可以直接用「粘贴文本」测试。`);
    toast(error.message, 'error');
  }
}

async function openProject() {
  const projectPath = $('#projectPathInput').value.trim();
  if (!projectPath) {
    showImportError('请填写工程目录，例如 C:\\Users\\win\\Documents\\雾城来信-工程');
    return;
  }
  clearImportError();
  const button = $('#openProjectBtn');
  const original = button.textContent;
  button.disabled = true;
  button.textContent = '正在打开…';
  try {
    const response = await fetch(`/api/projects/open?path=${encodeURIComponent(projectPath)}`, { method: 'POST' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `打开工程失败（${response.status}）`);
    state.jobId = data.jobId;
    state.pollToken += 1;
    const job = await api(`/api/jobs/${data.jobId}`);
    await loadWorkspace(job, data.disabled || []);
    toast('工程已加载，可以继续二次优化');
  } catch (error) {
    showImportError(`打开工程失败：${error.message}`);
    toast(error.message || '打开工程失败', 'error');
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

async function startPathAnalysis() {
  const localPath = $('#pathInput').value.trim();
  if (!localPath) {
    showImportError('请先填写文件的完整路径，例如 C:\\Users\\win\\Documents\\小说.txt');
    return;
  }
  const name = localPath.replace(/^file:\/\//, '').split(/[\\/]/).filter(Boolean).pop() || '本地文件.txt';
  openBookModal({ buffer: new ArrayBuffer(0), name, contentType: 'application/octet-stream', sourcePath: localPath });
}

function openBookModal(pending) {
  const fallback = String(pending.name || '未命名').replace(/\.[^.]+$/, '') || '未命名';
  state.pendingImport = pending;
  $('#bookFileName').textContent = pending.name || '—';
  $('#bookNameInput').value = fallback;
  $('#bookModal').hidden = false;
  setTimeout(() => {
    $('#bookNameInput').focus();
    $('#bookNameInput').select();
  }, 40);
}

function closeBookModal() {
  $('#bookModal').hidden = true;
}

function confirmBook(skip) {
  const pending = state.pendingImport;
  if (!pending) {
    closeBookModal();
    return;
  }
  const fallback = String(pending.name || '未命名').replace(/\.[^.]+$/, '') || '未命名';
  const bookName = skip ? fallback : ($('#bookNameInput').value.trim() || fallback);
  state.pendingImport = null;
  closeBookModal();
  startAnalysis(pending.buffer, pending.name, pending.contentType, pending.sourcePath, bookName);
}

async function startAnalysis(buffer, name, contentType, sourcePath = '', bookName = '') {
  if (state.busy) {
    showImportError('当前页面已有一个清洗任务在进行。等进度条结束，或返回首页后重新导入。');
    toast('已有一个清洗任务在进行');
    return;
  }
  if (!sourcePath && buffer.byteLength < 10) {
    showImportError(`「${name}」解码后只有 ${buffer.byteLength} 字节，太短，不像是小说正文。`);
    toast('文本太短，至少需要 10 个字节', 'error');
    return;
  }
  clearImportError();
  state.busy = true;
  state.jobId = '';
  state.disabled = new Set();
  state.issues = [];
  state.blocks = [];
  state.activeIssue = '';
  state.filter = 'all';
  state.railFilter = 'all';
  state.onlyChanged = false;
  state.q = '';
  $('#onlyChanged').checked = false;
  $('#searchInput').value = '';
  showOverlay();
  updateProgress({ percent: 0, stage: 'decode', label: '读取原稿', detail: '检查文件大小与编码…' });

  const query = new URLSearchParams({
    name,
    ai: state.useAi ? '1' : '0',
    model: state.selectedModel || '',
  });
  if (sourcePath) query.set('path', sourcePath);
  if (bookName) query.set('bookName', bookName);
  const token = ++state.pollToken;
  try {
    const response = await fetch(`/api/analyze?${query.toString()}`, {
      method: 'POST',
      headers: {
        'Content-Type': contentType,
        'X-File-Name': encodeURIComponent(name),
      },
      body: sourcePath ? undefined : buffer,
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `提交失败（${response.status}）`);
    state.jobId = data.jobId;
    await pollJob(token);
  } catch (error) {
    state.busy = false;
    const message = error.message || '清洗失败';
    showProgressError(message);
    showImportError(`导入「${name}」失败：${message}`);
  }
}

async function pollJob(token) {
  if (token !== state.pollToken) return;
  try {
    const job = await api(`/api/jobs/${state.jobId}`);
    updateProgress(job.progress || {});
    if (job.status === 'done') {
      state.busy = false;
      try {
        await loadWorkspace(job);
        hideOverlay();
      } catch (error) {
        showProgressError(error.message || '结果加载失败');
      }
      return;
    }
    if (job.status === 'error') {
      state.busy = false;
      showProgressError(job.error || '清洗失败');
      return;
    }
    state.pollTimer = setTimeout(() => pollJob(token), 850);
  } catch (error) {
    // 网络抖动时重试两次；任务本身过期则返回错误。
    if (String(error.message).includes('不存在')) {
      state.busy = false;
      showProgressError('任务已过期，请重新导入');
      return;
    }
    state.pollTimer = setTimeout(() => pollJob(token), 1400);
  }
}

/* ============================================================
   Paste
   ============================================================ */

function openPaste() {
  $('#pasteModal').hidden = false;
  updatePasteCount();
  setTimeout(() => $('#pasteText').focus(), 50);
}

function closePaste() {
  $('#pasteModal').hidden = true;
}

function updatePasteCount() {
  const value = $('#pasteText').value;
  $('#pasteCount').textContent = `${formatNumber(value.length)} 字符`;
  $('#pasteStart').disabled = !value.trim();
}

async function startPaste() {
  const text = $('#pasteText').value;
  if (!text.trim()) return;
  const name = ($('#pasteName').value || '粘贴稿.txt').trim();
  closePaste();
  openBookModal({ buffer: new TextEncoder().encode(text), name, contentType: 'application/octet-stream' });
}

/* ============================================================
   Progress overlay
   ============================================================ */

function showOverlay() {
  $('#progressOverlay').hidden = false;
  $('#progressErrorBtn').hidden = true;
  $('#progressBar').style.width = '0%';
  $('#progressPercent').textContent = '0%';
  $$('.progress-steps li').forEach((item) => item.className = '');
  $('#progressAi').textContent = '—';
  $('#progressSpeed').hidden = true;
}

function hideOverlay() {
  $('#progressOverlay').hidden = true;
}

function updateProgress(progress) {
  const percent = Math.max(0, Math.min(100, Number(progress.percent || 0)));
  $('#progressBar').style.width = `${percent}%`;
  $('#progressPercent').textContent = `${Math.round(percent)}%`;
  $('#progressTitle').textContent = progress.label || '正在处理';
  $('#progressDetail').textContent = progress.detail || '';
  const stage = progress.stage || '';
  const order = ['decode', 'rules', 'ai', 'render'];
  let active = 0;
  if (stage === 'scan' || stage === 'parse') active = 0;
  else if (stage === 'rules' || stage === 'decide') active = 1;
  else if (stage === 'ai' || stage === 'ai-check') active = 2;
  else if (stage === 'render' || stage === 'done') active = 3;
  $$('.progress-steps li').forEach((item, index) => {
    item.className = index < active ? 'done' : index === active ? 'active' : '';
  });
  if (progress.ai?.total) {
    $('#progressAi').textContent = `模型 ${progress.ai.done || 0}/${progress.ai.total}`;
  } else if (stage === 'ai' || stage === 'ai-check') {
    $('#progressAi').textContent = '模型复核中';
  } else if (stage === 'done') {
    $('#progressAi').textContent = '本地模型完成';
  } else {
    $('#progressAi').textContent = '—';
  }

  const speed = Number(progress.ai?.tokensPerSecond || 0);
  if (speed > 0) {
    $('#progressSpeed').hidden = false;
    $('#progressSpeedValue').textContent = speed.toFixed(1);
    const tokens = formatNumber(progress.ai?.completionTokens || 0);
    const seconds = ((progress.ai?.durationMs || 0) / 1000).toFixed(1);
    const source = progress.ai?.speedSource === 'backend' ? '后端实测' : '估算 · 含加载';
    $('#progressSpeedMeta').textContent = `${tokens} tokens · ${seconds}s · ${source}`;
  } else {
    $('#progressSpeed').hidden = true;
  }
}

function showProgressError(message) {
  $('#progressOverlay').hidden = false;
  $('#progressTitle').textContent = '清洗没有完成';
  $('#progressDetail').textContent = message;
  $('#progressErrorBtn').hidden = false;
  $('#progressAi').textContent = '任务已停止';
  $('#progressSpeed').hidden = true;
  $('#progressBar').style.width = '100%';
  $('#progressPercent').textContent = '!';
}

/* ============================================================
   Workspace loading
   ============================================================ */

async function loadWorkspace(job, disabled = []) {
  state.summary = job.summary;
  state.jobId = job.id;
  state.disabled = new Set(disabled);
  state.filter = 'all';
  state.railFilter = 'all';
  state.onlyChanged = false;
  state.q = '';
  $('#onlyChanged').checked = false;
  $('#searchInput').value = '';
  $('#homeView').hidden = true;
  $('#workView').hidden = false;
  $('#newBtn').hidden = false;
  closeIssueDrawer();
  $('#topbarContext').innerHTML = `<span class="context-kicker">CLEANING DESK</span><span class="context-sep">/</span><span>${escapeHtml(job.name)}</span>`;
  document.title = `${job.summary.title} · 墨净`;
  window.scrollTo({ top: 0, behavior: 'instant' });

  renderSummary();
  renderChecks();
  await refreshIssues();
  renderFilterChips();
  await refreshBlocks(true);
  renderIssueRail();
  buildLog();

  // 侧栏很窄：处理完成后把“原稿 / 清洗后”正文对比直接推到视野里，
  // 不让人先看到一屏统计和检查卡片。
}

function renderSummary() {
  const summary = state.summary;
  if (!summary) return;
  const before = summary.input?.chars || 0;
  const after = summary.output?.chars || 0;
  const delta = after - before;
  $('#docTitle').textContent = summary.title || summary.name || '未命名稿件';
  $('#fileName').textContent = summary.name || '—';
  $('#fileEncoding').textContent = `${summary.input?.encodingLabel || '—'} → UTF-8`;
  $('#fileMeta').textContent = `${formatNumber(summary.input?.paragraphs)} 段 · ${formatNumber(summary.input?.chapters)} 章 · ${formatDuration(summary.durationMs)}`;
  $('#charsBefore').textContent = formatNumber(before);
  $('#charsAfter').textContent = formatNumber(after);
  $('#charDelta').textContent = delta === 0 ? '0' : delta > 0 ? `+${formatNumber(delta)}` : `−${formatNumber(Math.abs(delta))}`;
  $('#charDelta').title = `净删除 ${formatNumber(summary.stats?.removedChars || 0)} 字`;

  const warnings = (summary.checks || []).filter((check) => check.status === 'warn' || check.status === 'review');
  const runDot = $('#runDot');
  runDot.className = `status-dot ${warnings.length ? 'warn' : 'ok'}`;
  $('#runTitle').textContent = warnings.length
    ? `7 项检查完成 · ${warnings.length} 项需确认`
    : '7 项检查完成';
  const ai = summary.ai || {};
  $('#runDetail').textContent = ai.enabled
    ? `模型复核 ${formatNumber(ai.truncatedReviewed + ai.irrelevantReviewed)} 条 · 确认 ${formatNumber(ai.aiApplied || 0)} 处 · ${formatDuration(summary.durationMs)}`
    : `规则模式 · ${formatDuration(summary.durationMs)} · 未调用模型`;
  $('#aiModel').textContent = ai.model || state.selectedModel || '—';
  const speed = Number(ai.tokensPerSecond || 0);
  $('#aiMeta').textContent = ai.enabled
    ? `${formatNumber(ai.calls)} 次调用 · ${formatNumber((ai.promptTokens || 0) + (ai.evalTokens || 0))} tokens${speed > 0 ? ` · 最近 ${speed.toFixed(1)} token/s` : ''}`
    : '本次未启用模型';
  $('#origMeta').textContent = `${formatNumber(summary.input?.paragraphs)} 段 · ${formatNumber(before)} 字`;
  $('#cleanMeta').textContent = `${formatNumber(summary.output?.paragraphs)} 段 · ${formatNumber(after)} 字`;
}

function renderChecks() {
  const summary = state.summary;
  if (!summary) return;
  $('#checkStrip').innerHTML = (summary.checks || []).map((check) => `
    <button type="button" class="check-tile status-${check.status} ${state.filter === check.type ? 'active' : ''}" data-check="${check.type}" title="${escapeHtml(check.detail)}">
      <span class="check-no">${TYPE_META[check.type]?.no || check.index}</span>
      <span class="check-body">
        <span class="check-label">${escapeHtml(check.label)}</span>
        <span class="check-detail">${escapeHtml(checkShortDetail(check))}</span>
      </span>
      <span class="check-mark">${statusIcon(check.status)}</span>
    </button>`).join('');
}

function renderFilterChips() {
  const summary = state.summary;
  if (!summary) return;
  const counts = {};
  for (const issue of state.issues) {
    if (issue.severity === 'info') continue;
    counts[issue.type] = (counts[issue.type] || 0) + 1;
  }
  const chips = [
    `<button type="button" class="chip ${state.filter === 'all' ? 'active' : ''}" data-filter="all">全部 <span class="chip-count">${state.issues.length}</span></button>`,
  ];
  for (const type of TYPE_ORDER) {
    const count = counts[type] || 0;
    chips.push(`<button type="button" class="chip ${state.filter === type ? 'active' : ''}" data-filter="${type}">${TYPE_META[type].short} <span class="chip-count">${count}</span></button>`);
  }
  $('#filterChips').innerHTML = chips.join('');
}

function setFilter(filter) {
  state.filter = filter;
  state.activeIssue = '';
  renderChecks();
  renderFilterChips();
  renderIssueRail();
  refreshBlocks(true);
}

async function refreshIssues() {
  if (!state.jobId) return;
  const data = await api(`/api/jobs/${state.jobId}/issues?info=1`);
  state.issues = data.issues || [];
}

async function refreshBlocks() {
  if (!state.jobId) return;
  const token = ++state.renderToken;
  const serverFilter = ['blank', 'encoding', 'invisible'].includes(state.filter) ? 'all' : state.filter;
  const params = new URLSearchParams({
    filter: serverFilter,
    changed: state.onlyChanged ? '1' : '0',
    q: state.q,
    offset: '0',
    limit: 'all',
  });
  const scrollTop = $('#compareScroll').scrollTop;
  try {
    const data = await api(`/api/jobs/${state.jobId}/blocks?${params.toString()}`);
    if (token !== state.renderToken) return;
    // 默认一次拿全量，不再分页、不再出现“加载更多”。
    state.blocks = data.blocks || [];
    state.offset = state.blocks.length;
    renderRows();
    $('#compareScroll').scrollTop = scrollTop;
  } catch (error) {
    toast(error.message || '对比结果加载失败', 'error');
  }
}

/* ============================================================
   Issue rail
   ============================================================ */

function openIssueDrawer() {
  renderIssueRail();
  $('#issueRail').classList.add('open');
  $('#issueBackdrop').hidden = false;
}

function closeIssueDrawer() {
  $('#issueRail').classList.remove('open');
  $('#issueBackdrop').hidden = true;
}

function issueMatchesRail(issue) {
  if (state.railFilter === 'ai') return issue.layer === 'ai' && issue.severity !== 'info';
  if (state.railFilter === 'rule') return issue.layer === 'rule' && issue.severity !== 'info';
  if (state.railFilter === 'warn') return issue.severity === 'warn';
  return true;
}

function aggregateIssue(type, issues) {
  const first = issues[0];
  const detail = type === 'blank'
    ? `${issues.length} 组空行 · 共删除 ${issues.reduce((sum, issue) => sum + (issue.removed || 0), 0)} 行`
    : `${issues.length} 段正文缩进已统一为 5 个半角空格`;
  return {
    id: `aggregate-${type}`,
    type,
    layer: 'rule',
    severity: 'fix',
    title: type === 'blank' ? `段落之间 / 章节前的多余空行` : `段落缩进已全部校正`,
    detail,
    count: issues.length,
    blockIds: [],
    aggregate: true,
    toggle: false,
    applied: true,
    before: first?.before || '',
    after: first?.after || '',
  };
}

function buildRailEntries() {
  let issues = state.issues;
  if (state.filter !== 'all') issues = issues.filter((issue) => issue.type === state.filter);
  issues = issues.filter(issueMatchesRail);
  const info = issues.filter((issue) => issue.severity === 'info');
  const main = issues.filter((issue) => issue.severity !== 'info');
  const entries = [];

  const blanks = main.filter((issue) => issue.type === 'blank');
  const indents = main.filter((issue) => issue.type === 'indent');
  if (blanks.length) entries.push(aggregateIssue('blank', blanks));
  if (indents.length) entries.push(aggregateIssue('indent', indents));

  for (const type of TYPE_ORDER) {
    if (type === 'blank' || type === 'indent') continue;
    const list = main.filter((issue) => issue.type === type);
    entries.push(...list);
  }
  return { entries, info };
}

function renderIssueRail() {
  if (!state.summary) return;
  const { entries, info } = buildRailEntries();
  const cardCount = entries.length;
  $('#issueCount').textContent = `${cardCount}${info.length ? ` +${info.length}` : ''}`;
  $('#issueCount').title = '主记录 + AI 判定保留备注';
  $('#issueToggleCount').textContent = `${cardCount}`;
  const cards = entries.map((issue) => renderIssueCard(issue)).join('');
  const infoBlock = info.length
    ? `<details class="ai-notes"><summary>AI 判定保留 / 已排除 ${info.length} 条</summary>${info.map((issue) => `
        <div class="ai-note-row"><b>${escapeHtml(issue.title)}</b>${escapeHtml(issue.detail || '')}</div>`).join('')}</details>`
    : '';
  $('#issueList').innerHTML = cards || `<div class="ai-empty">这一筛选下没有记录。<br />七项检查都已完成。</div>`;
  if (infoBlock) $('#issueList').insertAdjacentHTML('beforeend', infoBlock);
}

function renderIssueCard(issue) {
  const meta = TYPE_META[issue.type] || { label: issue.type, no: '--' };
  const layer = layerLabel(issue);
  const open = state.activeIssue === issue.id;
  const classes = [
    'issue-card',
    issue.severity === 'info' ? 'is-info' : '',
    issue.severity === 'warn' ? 'is-pending' : '',
    open ? 'active' : '',
  ].filter(Boolean).join(' ');
  const snippet = issue.type === 'encoding' || issue.type === 'invisible'
    ? `<div class="issue-snippet">${escapeHtml(issue.before || '')} <span style="color:var(--ink-faint)">→</span> ${escapeHtml(issue.after || '')}</div>`
    : issue.before
      ? `<div class="issue-snippet">${escapeHtml(String(issue.before).replace(/\n/g, ' ↵ ')).slice(0, 150)}${issue.after && issue.after !== '（保留）' ? ` <span style="color:var(--ink-faint)">→</span> <ins>${escapeHtml(String(issue.after).replace(/\n/g, '')).slice(0, 90)}</ins>` : ''}</div>`
      : '';
  const toggle = issue.toggle
    ? `<label class="issue-toggle"><input type="checkbox" data-toggle="${issue.id}" ${issue.applied ? 'checked' : ''} /> 应用</label>`
    : `<span class="issue-state ${issue.severity === 'warn' ? 'pending' : ''}">${issue.aggregate ? '点击筛选' : issue.severity === 'warn' ? '需人工确认' : '已自动修复'}</span>`;
  return `
    <article class="${classes}" data-id="${escapeHtml(issue.id)}" data-type="${issue.type}" data-aggregate="${issue.aggregate ? '1' : '0'}">
      <div class="issue-top">
        <span class="issue-kicker">${meta.no} ${escapeHtml(meta.label)}</span>
        <span class="layer ${layer.className}">${layer.label}</span>
      </div>
      <h4>${escapeHtml(issue.title || meta.label)}</h4>
      <p class="issue-detail">${escapeHtml(issue.detail || '')}</p>
      ${snippet}
      <div class="issue-foot">
        ${toggle}
        <button type="button" class="issue-jump" data-jump="${escapeHtml(issue.id)}">定位 →</button>
      </div>
    </article>`;
}

function handleIssueRailClick(event) {
  if (event.target.closest('input, summary, .issue-toggle')) return;
  const card = event.target.closest('.issue-card');
  if (!card) return;
  const aggregate = card.dataset.aggregate === '1';
  const type = card.dataset.type;
  if (aggregate) {
    setFilter(type);
    return;
  }
  const issue = state.issues.find((item) => item.id === card.dataset.id);
  if (issue) jumpToIssue(issue);
}

function handleIssueRailChange(event) {
  const input = event.target.closest('[data-toggle]');
  if (!input) return;
  toggleIssue(input.dataset.toggle, input.checked);
}

function toggleIssue(id, enabled) {
  if (enabled) state.disabled.delete(id);
  else state.disabled.add(id);
  const issue = state.issues.find((item) => item.id === id);
  if (issue) issue.applied = enabled;
  state.activeIssue = id;
  document.querySelectorAll(`[data-id="${CSS.escape(id)}"]`).forEach((card) => {
    card.classList.toggle('is-disabled', !enabled);
    const checkbox = card.querySelector('[data-toggle]');
    if (checkbox) checkbox.checked = enabled;
  });
  clearTimeout(applyTimer);
  applyTimer = setTimeout(applyDisabled, 280);
}

async function applyDisabled() {
  if (!state.jobId) return;
  const token = ++state.renderToken;
  const scrollTop = $('#compareScroll').scrollTop;
  try {
    const result = await api(`/api/jobs/${state.jobId}/render`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ disabled: [...state.disabled] }),
    });
    if (token !== state.renderToken) return;
    state.summary = result.summary;
    await refreshIssues();
    renderSummary();
    renderChecks();
    renderFilterChips();
    await refreshBlocks(true);
    renderIssueRail();
    $('#compareScroll').scrollTop = scrollTop;
    buildLog();
  } catch (error) {
    toast(error.message || '更新对比失败', 'error');
  }
}

async function jumpToIssue(issue) {
  state.activeIssue = issue.id;
  renderIssueRail();
  let block = state.blocks.find((item) => item.issueIds?.includes(issue.id) || issue.blockIds?.includes(item.id));
  if (!block) {
    const type = issue.type;
    if (type && state.filter !== type) {
      setFilter(type);
      await new Promise((resolve) => setTimeout(resolve, 260));
      block = state.blocks.find((item) => item.issueIds?.includes(issue.id) || issue.blockIds?.includes(item.id));
    }
  }
  if (!block) {
    toast('该记录没有对应的正文段落（可能是全文级检查）');
    return;
  }
  const selector = `[data-block="${CSS.escape(block.id)}"]`;
  const element = document.querySelector(selector);
  if (!element) return;
  closeIssueDrawer();
  const scroller = $('#compareScroll');
  const elementRect = element.getBoundingClientRect();
  const scrollerRect = scroller.getBoundingClientRect();
  const top = scroller.scrollTop + elementRect.top - scrollerRect.top - 54;
  scroller.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  element.classList.remove('flash');
  void element.offsetWidth;
  element.classList.add('flash');
}

/* ============================================================
   Compare rows
   ============================================================ */

function renderRows() {
  const rows = $('#rows');
  if (!state.blocks.length) {
    rows.innerHTML = `<div class="empty-rows">这一筛选下没有可对比的段落。<br />试试“全部”或关闭“只看改动”。</div>`;
    return;
  }
  rows.innerHTML = state.blocks.map((block) => block.kind === 'chapter' ? renderChapterRow(block) : renderParagraphRow(block)).join('');
}

function renderChapterRow(block) {
  const gap = (state.summary?.chapter?.gaps || []).find((item) => item.from === block.chapterNumber);
  const gapLabel = gap ? `<span class="chapter-gap">缺第 ${escapeHtml(gap.missing.join('、'))} 章</span>` : '';
  const tags = (block.issueTypes || []).map((type) => `<span class="tag amber">${escapeHtml(TYPE_META[type]?.short || type)}</span>`).join('');
  const originalTitle = block.coreOriginal || block.original || '';
  const cleanedTitle = block.coreCleaned || block.cleaned || originalTitle;
  const changed = originalTitle !== cleanedTitle;
  return `
    <article class="diff-row chapter-row ${changed ? 'changed' : ''}" data-block="${escapeHtml(block.id)}">
      <div class="pane original">
        <div class="line-meta"><span class="line-no">L${block.lineNo}</span><span class="indent-badge neutral">标题顶格</span>${tags}${changed ? '<span class="tag rust">原格式</span>' : ''}</div>
        <div class="chapter-line"><span class="chapter-ornament">§</span><h3 class="chapter-text">${escapeHtml(originalTitle)}</h3>${gapLabel}</div>
      </div>
      <div class="pane cleaned">
        <div class="line-meta"><span class="line-no">L${block.lineNo}</span><span class="indent-badge neutral">标题顶格</span>${gap ? '<span class="tag amber">编号待确认</span>' : ''}${changed ? '<span class="tag jade">已统一</span>' : ''}</div>
        <div class="chapter-line"><span class="chapter-ornament">§</span><h3 class="chapter-text">${escapeHtml(cleanedTitle)}</h3></div>
      </div>
    </article>`;
}

function renderParagraphRow(block) {
  const deleted = Boolean(block.deleted);
  const merged = Boolean(block.merged);
  const changed = Boolean(block.changed || deleted || merged);
  const tags = (block.issueTypes || []).map((type) => {
    const cls = type === 'truncation' ? 'rust' : type === 'irrelevant' ? 'amber' : '';
    return `<span class="tag ${cls}">${escapeHtml(TYPE_META[type]?.short || type)}</span>`;
  }).join('');
  const mergeTag = merged ? '<span class="tag rust">换行合并</span>' : '';
  const deletedTag = deleted ? '<span class="tag rust">整段移除</span>' : '';
  const issueForDelete = deleted
    ? state.issues.find((issue) => issue.toggle && issue.blockIds?.includes(block.id) && issue.type === 'irrelevant' && issue.applied)
    : null;

  const originalBody = merged
    ? `<div class="merge-original">
        ${block.parts.map((part) => `
          <div class="merge-line">
            <span class="merge-line-meta"><span class="line-no">L${part.lineNo}</span>${indentBadge(part.indent, 5)}</span>
            <span class="merge-line-text">${indentGuide(part.indent, true)}${decorateText(escapeHtml(part.displayOriginal || part.original || ''))}</span>
          </div>`).join('')}
      </div>`
    : `<div class="line-meta"><span class="line-no">L${block.lineNo}</span>${indentBadge(block.indentBefore, 5)}${tags}${mergeTag}${deletedTag}</div>
       <p class="paragraph-text">${indentGuide(block.indentBefore, true)}${renderDiff(block.displayOriginal || block.original || '', block.coreCleaned || '')}</p>`;

  const cleanedBody = deleted
    ? `<div class="removed-ghost">
        <span class="removed-x">×</span>
        <div class="removed-copy"><strong>已移除</strong><span>${escapeHtml(block.deleteReason || '广告 / 作者留言 / 无关内容')}</span></div>
        ${issueForDelete ? `<button type="button" class="text-btn removed-undo" data-undo="${issueForDelete.id}">保留</button>` : ''}
      </div>`
    : `<div class="line-meta"><span class="line-no">L${block.lineNo}</span>${indentBadge(5, 5)}${merged ? '<span class="tag rust">换行已合并</span>' : ''}${!merged && changed ? '<span class="tag rust">已修正</span>' : ''}</div>
       <p class="paragraph-text">${indentGuide(5)}${decorateText(escapeHtml(block.coreCleaned || ''))}</p>`;

  const mergeMeta = merged
    ? `<div class="line-meta"><span class="line-no">L${block.parts[0].lineNo}–L${block.parts[block.parts.length - 1].lineNo}</span><span class="tag rust">${block.parts.length} 行合并</span>${tags}${deletedTag}</div>`
    : '';
  return `
    <article class="diff-row ${changed ? 'changed' : ''} ${deleted ? 'deleted' : ''}" data-block="${escapeHtml(block.id)}">
      <div class="pane original ${deleted ? 'deleted-pane' : ''}">
        ${mergeMeta}
        ${originalBody}
      </div>
      <div class="pane cleaned">
        ${cleanedBody}
      </div>
    </article>`;
}

function indentBadge(count, expected) {
  const number = Number(count || 0);
  const good = number === expected;
  return `<span class="indent-badge ${good ? '' : 'bad'}">${number} 空格</span>`;
}

function indentGuide(count, highlightOnly = false) {
  const number = Math.min(Number(count || 0), 12);
  if (!number) return '';
  // 正确的 5 空格只占位，不画点；异常缩进才用朱砂点标出来。
  if (!highlightOnly || number === 5) return ' '.repeat(number);
  if (!state.showSpaces) return ' '.repeat(number);
  return `<span class="ws-guide" aria-hidden="true">${'·'.repeat(number)}</span>`;
}

function decorateText(html) {
  return html.replace(/⟨([^⟨⟩]{1,12})⟩/g, '<span class="inv-token">⟨$1⟩</span>');
}

function renderDiff(original, cleaned) {
  const left = String(original || '');
  const right = String(cleaned || '');
  if (!left && !right) return '';
  if (left === right) return decorateText(escapeHtml(right));
  const leftChars = [...left];
  const rightChars = [...right];
  const prefix = commonPrefix(leftChars, rightChars);
  const suffix = commonSuffix(leftChars, rightChars, prefix);
  const middleLeft = leftChars.slice(prefix, leftChars.length - suffix);
  const middleRight = rightChars.slice(prefix, rightChars.length - suffix);
  let middle = '';
  if (middleLeft.length * middleRight.length <= 60000) {
    const ops = diffOps(middleLeft, middleRight);
    middle = ops.map((op) => {
      if (op.type === 'eq') return decorateText(escapeHtml(op.text));
      if (op.type === 'del') return `<del>${decorateText(escapeHtml(op.text))}</del>`;
      return `<ins>${decorateText(escapeHtml(op.text))}</ins>`;
    }).join('');
  } else {
    if (middleLeft.length) middle += `<del>${decorateText(escapeHtml(middleLeft.join('')))}</del>`;
    if (middleRight.length) middle += `<ins>${decorateText(escapeHtml(middleRight.join('')))}</ins>`;
  }
  return `${decorateText(escapeHtml(leftChars.slice(0, prefix).join('')))}${middle}${decorateText(escapeHtml(leftChars.slice(leftChars.length - suffix).join('')))}`;
}

function commonPrefix(a, b) {
  let index = 0;
  while (index < a.length && index < b.length && a[index] === b[index]) index += 1;
  return index;
}

function commonSuffix(a, b, prefix) {
  let count = 0;
  while (count < a.length - prefix && count < b.length - prefix
    && a[a.length - 1 - count] === b[b.length - 1 - count]) count += 1;
  return count;
}

function diffOps(a, b) {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dp = Array.from({ length: rows }, () => new Uint16Array(cols));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      pushOp(ops, 'eq', a[i]);
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      pushOp(ops, 'del', a[i]);
      i += 1;
    } else {
      pushOp(ops, 'ins', b[j]);
      j += 1;
    }
  }
  while (i < a.length) { pushOp(ops, 'del', a[i]); i += 1; }
  while (j < b.length) { pushOp(ops, 'ins', b[j]); j += 1; }
  return ops;
}

function pushOp(ops, type, char) {
  const last = ops[ops.length - 1];
  if (last && last.type === type) last.text += char;
  else ops.push({ type, text: char });
}

function handleRowsClick(event) {
  const undo = event.target.closest('[data-undo]');
  if (undo) {
    toggleIssue(undo.dataset.undo, false);
    toast('已恢复这一段，对比将在片刻后更新');
    return;
  }
  const row = event.target.closest('.diff-row');
  if (!row) return;
  const block = state.blocks.find((item) => item.id === row.dataset.block);
  if (block?.issueIds?.length) {
    const issue = state.issues.find((item) => block.issueIds.includes(item.id));
    if (issue) {
      state.activeIssue = issue.id;
      renderIssueRail();
    }
  }
}

/* ============================================================
   Export / log
   ============================================================ */

const LAST_SAVE_DIR = 'novel-clean.saveDir';

function lastSaveDir() {
  try { return localStorage.getItem(LAST_SAVE_DIR) || ''; } catch { return ''; }
}

function rememberSaveDir(value) {
  try { localStorage.setItem(LAST_SAVE_DIR, value || ''); } catch { /* ignore */ }
}

function exportText() {
  if (!state.jobId) return;
  const title = state.summary?.title || '未命名稿件';
  $('#saveTitle').textContent = '导出工程';
  $('#saveNote').textContent = '会创建一套工程：source.*、target.utf8.txt、project.json、report.json、state.json、README.md。留空则使用 Downloads。';
  $('#saveDirInput').value = lastSaveDir();
  $('#saveFileName').textContent = `${title}-工程/`;
  $('#saveError').hidden = true;
  $('#saveResult').hidden = true;
  $('#saveCopy').hidden = true;
  $('#saveCopyReport').hidden = true;
  $('#saveCancel').hidden = false;
  $('#saveConfirm').hidden = false;
  $('#saveDone').hidden = true;
  $('#saveModal').hidden = false;
  setTimeout(() => $('#saveDirInput').focus(), 40);
}

async function confirmSave() {
  if (!state.jobId) return;
  const dir = $('#saveDirInput').value.trim();
  const button = $('#saveConfirm');
  const original = button.textContent;
  button.disabled = true;
  button.textContent = '正在导出…';
  $('#saveError').hidden = true;
  try {
    const query = dir ? `?dir=${encodeURIComponent(dir)}` : '';
    const response = await fetch(`/api/jobs/${state.jobId}/project${query}`, { method: 'POST' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `导出工程失败（${response.status}）`);

    rememberSaveDir(dir || data.parent || '');
    $('#saveTitle').textContent = '工程已导出';
    $('#saveNote').textContent = `工程目录：${data.dir}`;
    $('#saveFileName').textContent = data.dir.split(/[\\/]/).filter(Boolean).pop() || '';
    $('#saveProjectPath').textContent = data.dir;
    $('#savePath').textContent = data.targetPath;
    $('#saveReportPath').textContent = data.reportPath;
    $('#saveIndexPath').textContent = data.projectPath;
    $('#saveResult').hidden = false;
    $('#saveCopy').hidden = false;
    $('#saveCopyReport').hidden = false;
    $('#saveCancel').hidden = true;
    $('#saveConfirm').hidden = true;
    $('#saveDone').hidden = false;
    toast('工程已导出，可以重新加载');
  } catch (error) {
    $('#saveError').textContent = error.message || '保存失败';
    $('#saveError').hidden = false;
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

function closeSaveModal() {
  $('#saveModal').hidden = true;
}

async function copySavePath(selector) {
  const value = $(selector)?.textContent || '';
  try {
    await navigator.clipboard.writeText(value);
    toast('路径已复制');
  } catch {
    const area = document.createElement('textarea');
    area.value = value;
    document.body.appendChild(area);
    area.select();
    document.execCommand('copy');
    area.remove();
    toast('路径已复制');
  }
}

function buildLog() {
  const summary = state.summary;
  if (!summary) return;
  const ai = summary.ai || {};
  const entries = [
    ['读取', summary.name, `${summary.input?.encodingLabel || '—'} · ${formatNumber(summary.input?.bytes)} bytes`],
    ['切分', `${formatNumber(summary.input?.chapters)} 章 / ${formatNumber(summary.input?.paragraphs)} 段`, `${formatNumber(summary.input?.chars)} 字`],
    ['规则', '七项扫描完成', (summary.checks || []).map((check) => `${check.label} ${check.found}`).join(' · ')],
    ['模型', ai.enabled ? `${formatNumber(ai.calls)} 次调用` : '未启用', ai.enabled ? `复核 ${formatNumber(ai.truncatedReviewed + ai.irrelevantReviewed)} 条 · 确认 ${formatNumber(ai.aiApplied || 0)} 处${Number(ai.tokensPerSecond) > 0 ? ` · 最近 ${Number(ai.tokensPerSecond).toFixed(1)} token/s` : ''}` : ai.error || '—'],
    ['输出', 'UTF-8（无 BOM）', `${formatNumber(summary.output?.chars)} 字 · ${formatNumber(summary.output?.bytes)} bytes`],
  ];
  $('#logBody').innerHTML = entries.map(([time, title, detail]) => `
    <div class="log-entry"><time>${escapeHtml(time)}</time><div><strong>${escapeHtml(title)}</strong><span>${escapeHtml(detail)}</span></div></div>`).join('');
}

function openLog() {
  $('#logDrawer').hidden = false;
}

function closeLog() {
  $('#logDrawer').hidden = true;
}

/* ============================================================
   Model popover
   ============================================================ */

async function toggleModelPopover() {
  const popover = $('#modelPopover');
  if (!popover.hidden) {
    closeModelPopover();
    return;
  }
  popover.hidden = false;
  renderHealth();
  // 打开时重新拉一次模型列表，避免页面打开后路由新增/切换了模型却看不到。
  await loadHealth();
  renderHealth();
}

function closeModelPopover() {
  $('#modelPopover').hidden = true;
}

/* ============================================================
   Reset
   ============================================================ */

function resetToHome() {
  state.pollToken += 1;
  clearTimeout(state.pollTimer);
  state.busy = false;
  state.jobId = '';
  state.summary = null;
  state.issues = [];
  state.blocks = [];
  state.disabled = new Set();
  state.activeIssue = '';
  state.filter = 'all';
  state.railFilter = 'all';
  state.onlyChanged = false;
  state.q = '';
  state.pendingImport = null;
  hideOverlay();
  closeBookModal();
  closeIssueDrawer();
  closePaste();
  closeLog();
  closeModelPopover();
  $('#workView').hidden = true;
  $('#homeView').hidden = false;
  $('#newBtn').hidden = true;
  $('#topbarContext').innerHTML = '<span class="context-kicker">LOCAL-FIRST</span><span class="context-sep">/</span><span>小说数据清洗台</span>';
  document.title = '墨净 · 小说清洗台';
  window.scrollTo({ top: 0, behavior: 'instant' });
}

boot().then(() => {
  // ?demo=1 可直接跑通“导入 → 9B 复核 → 前后对比”的演示链路。
  const params = new URLSearchParams(location.search);
  if (params.has('demo')) {
    loadSample(params.get('demo') === 'utf8' ? 'utf8' : 'gbk');
  }
});
