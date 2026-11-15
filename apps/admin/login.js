// Tela de login do backoffice (a única página entregue sem sessão de admin).
'use strict';

const TOKEN_KEY = 'line.admin.token';
const APP = 'https://useline.tech/app/';
/** Domínio principal: o "Entrar com Google" começa por lá e volta para esta página. */
const MAIN = location.hostname.startsWith('backoffice.') ? `${location.protocol}//${location.host.slice(11)}` : '';
const error = document.getElementById('login-error');

/** Entra no painel. Quem não é admin vai para o app. */
async function enter(body) {
  error.textContent = '';
  const res = await fetch('/api/admin/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => null);
  if (res.status === 403 && data?.error === 'not_admin') return location.replace(data.redirect || APP);
  if (!res.ok) throw new Error(data?.message || `Erro ${res.status}`);
  try {
    localStorage.setItem(TOKEN_KEY, data.token);
  } catch {
    /* sem localStorage */
  }
  location.replace('/');
}

document.getElementById('login-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  enter({ username: f.get('username'), password: f.get('password') }).catch((err) => (error.textContent = err.message));
});

(async () => {
  const qs = new URLSearchParams(location.search);
  if (qs.get('msg')) error.textContent = qs.get('msg');
  if (qs.get('googleError')) error.textContent = qs.get('googleError');
  const code = qs.get('google');
  if (qs.toString()) history.replaceState(null, '', location.pathname);
  if (code) enter({ googleCode: code }).catch((err) => (error.textContent = err.message));
  try {
    const cfg = await (await fetch('/api/auth/config')).json();
    if (cfg.google) {
      const btn = document.getElementById('google');
      btn.href = `${MAIN}/api/auth/google/start?admin=1`;
      btn.hidden = false;
    }
  } catch {
    /* sem Google */
  }
})();
