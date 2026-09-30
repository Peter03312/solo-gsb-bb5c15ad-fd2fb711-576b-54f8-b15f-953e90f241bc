import { api } from './api.js';
import { esc, toast } from './ui.js';
import { mountWorkspace } from './workspace.js';

async function renderHome() {
  const view = document.getElementById('view');
  const projects = await api.listProjects();
  view.innerHTML = `
    <div class="home-wrap">
      <h1>考古陶片拼接方案</h1>
      <p class="kv">在同一方案中上传陶片照片、标定毫米比例尺，并以“接缝”记录片间旋转、平移与断口说明。画布按已采纳接缝拼出连通组；成环超差会被拒绝。</p>

      <div class="new-project">
        <label class="field">方案名称
          <input type="text" id="np-name" placeholder="例如：2026 秋 · H3 灰陶罐" />
        </label>
        <label class="field">闭合环毫米容差
          <input type="number" id="np-tol" min="0.01" step="0.1" value="2" />
        </label>
        <button id="np-create">新建方案</button>
      </div>

      <table class="list">
        <thead><tr><th>ID</th><th>名称</th><th>容差</th><th>版本</th><th>更新时间</th><th></th></tr></thead>
        <tbody>
          ${projects.map((p) => `
            <tr>
              <td>${p.id}</td>
              <td><a href="#/project/${p.id}">${esc(p.name)}</a></td>
              <td>${p.tolerance_mm} mm</td>
              <td>v${p.version}</td>
              <td>${esc(p.updated_at)}</td>
              <td><a href="#/project/${p.id}">进入</a></td>
            </tr>`).join('') ||
            '<tr><td colspan="6" class="kv" style="text-align:center;padding:24px">还没有方案，先新建一个。</td></tr>'}
        </tbody>
      </table>
    </div>`;

  document.getElementById('topbar-right').innerHTML = '';
  document.getElementById('np-create').onclick = async () => {
    const name = document.getElementById('np-name').value.trim() || `方案 ${new Date().toLocaleString()}`;
    const tol = parseFloat(document.getElementById('np-tol').value);
    if (!(tol > 0)) return toast('容差必须是正数（毫米）', 'error');
    const state = await api.createProject(name, tol);
    location.hash = `#/project/${state.project.id}`;
  };
}

async function route() {
  const hash = location.hash || '#/';
  const m = hash.match(/^#\/project\/(\d+)/);
  if (m) {
    try {
      await mountWorkspace(parseInt(m[1], 10));
    } catch (e) {
      const view = document.getElementById('view');
      view.innerHTML = `<div class="home-wrap"><div class="conflict-box">加载方案失败：${esc(e.message)}</div>
        <a href="#/">← 返回方案列表</a></div>`;
    }
  } else {
    await renderHome();
  }
}

window.addEventListener('hashchange', route);
route();
