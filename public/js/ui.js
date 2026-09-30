export function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function toast(message, kind = '') {
  const host = document.getElementById('toast-host');
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  host.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity .4s';
    setTimeout(() => el.remove(), 450);
  }, 4200);
}

// 打开一个模态框。renderContent(hostEl) 写入内容；返回 { close }。
export function openModal({ wide = false, title } = {}) {
  const modalHost = document.getElementById('modal-host');
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  const modal = document.createElement('div');
  modal.className = 'modal' + (wide ? ' wide' : '');
  mask.appendChild(modal);
  modalHost.appendChild(mask);

  modal.innerHTML = title ? `<h2>${esc(title)}</h2>` : '';
  const bodyHost = document.createElement('div');
  modal.appendChild(bodyHost);

  const close = () => mask.remove();
  mask.addEventListener('mousedown', (e) => { if (e.target === mask) close(); });

  return { mask, modal, body: bodyHost, close };
}

export function confirmAsync(message, danger = true) {
  return new Promise((resolve) => {
    const { modal, body, close } = openModal({ title: '请确认' });
    const p = document.createElement('p');
    p.textContent = message;
    body.appendChild(p);
    const actions = document.createElement('div');
    actions.className = 'actions';
    const cancel = document.createElement('button');
    cancel.className = 'secondary';
    cancel.textContent = '取消';
    const ok = document.createElement('button');
    ok.className = danger ? 'danger' : '';
    ok.textContent = '确定';
    actions.append(cancel, ok);
    body.appendChild(actions);
    cancel.onclick = () => { close(); resolve(false); };
    ok.onclick = () => { close(); resolve(true); };
  });
}
