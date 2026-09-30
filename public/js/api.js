// 极简 fetch 封装。所有写请求带 Base-Version，触发乐观锁版本冲突检查。

async function parseJson(res) {
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
  return body;
}

async function request(method, url, { body, headers, version } = {}) {
  const h = { ...(headers || {}) };
  if (version !== undefined && version !== null) h['Base-Version'] = String(version);

  let payload = body;
  if (body && !(body instanceof FormData) && (method === 'POST' || method === 'PATCH' || method === 'PUT')) {
    h['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  const res = await fetch(url, { method, headers: h, body: payload });
  const data = await parseJson(res);
  if (!res.ok) {
    const err = new Error((data && data.error && data.error.message) || `请求失败 (${res.status})`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return { status: res.status, data };
}

export const api = {
  listProjects: () => request('GET', '/api/projects').then((r) => r.data.projects),
  createProject: (name, toleranceMm) =>
    request('POST', '/api/projects', { body: { name, tolerance_mm: toleranceMm } }),
  getProject: (id) => request('GET', `/api/projects/${id}`).then((r) => r.data),
  patchProject: (id, version, body) =>
    request('PATCH', `/api/projects/${id}`, { version, body }).then((r) => r.data),
  deleteProject: (id, version) =>
    request('DELETE', `/api/projects/${id}`, { version }),
  uploadSherd: (pid, version, formData) =>
    request('POST', `/api/projects/${pid}/sherds`, { version, body: formData }).then((r) => r.data),
  setScale: (sherdId, version, scalePx, scaleMm) =>
    request('PATCH', `/api/sherds/${sherdId}/scale`, { version, body: { scale_px: scalePx, scale_mm: scaleMm } }).then((r) => r.data),
  deleteSherd: (sherdId, version) =>
    request('DELETE', `/api/sherds/${sherdId}`, { version }),
  addSeam: (pid, version, payload) =>
    request('POST', `/api/projects/${pid}/seams`, { version, body: payload }).then((r) => ({ data: r.data, status: r.status })),
  deleteSeam: (seamId, version) =>
    request('DELETE', `/api/seams/${seamId}`, { version }).then((r) => r.data),
  // 接缝修订：预览为只读、不带版本；确认必须带当前 Base-Version。
  reviseSeamPreview: (seamId, payload) =>
    request('POST', `/api/seams/${seamId}/revision-preview`, { body: payload }).then((r) => r.data),
  reviseSeam: (seamId, version, payload) =>
    request('PATCH', `/api/seams/${seamId}`, { version, body: payload }).then((r) => r.data),
};
